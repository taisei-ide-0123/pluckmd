import type { BrowserContext, Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { detectBotChallenge } from "./bot-challenge.js";

/**
 * Fetches pages through an installed Google Chrome with automation markers
 * removed. Bot-protection services (Cloudflare, Akamai) reject Node's fetch
 * and headless Chromium by TLS/HTTP2 fingerprint and `navigator.webdriver`,
 * but let a regular headed Chrome through. The window is placed off-screen.
 */

const CHALLENGE_TIMEOUT_MS = 25_000;
const CHALLENGE_POLL_MS = 1_000;
const POST_CHALLENGE_SETTLE_MS = 1_500;
// Sustained bulk fetching can trip rate-based blocks that lift after a pause.
const CHALLENGE_RETRY_BACKOFF_MS = 15_000;

export interface RealBrowserPage {
  readonly finalUrl: string;
  readonly status: number;
  readonly html: string;
}

export class RealBrowserFetcher {
  private contextPromise: Promise<BrowserContext> | null = null;
  // One page per origin that has passed the challenge; in-page fetch() from it
  // reuses the clearance cookie and Chrome's network stack for raw files.
  private readonly clearedOriginPages = new Map<string, Promise<Page>>();

  constructor(
    private readonly profileDir: string,
    private readonly timeoutMs: number,
  ) {}

  async fetchPage(url: string): Promise<RealBrowserPage> {
    try {
      return await this.fetchPageOnce(url);
    } catch (error) {
      if (!(error instanceof ChallengeTimeoutError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, CHALLENGE_RETRY_BACKOFF_MS));
      return this.fetchPageOnce(url);
    }
  }

  private async fetchPageOnce(url: string): Promise<RealBrowserPage> {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      return await this.loadPastChallenge(page, url);
    } finally {
      await page.close();
    }
  }

  /**
   * Fetches a raw resource (sitemap, robots.txt) from inside a cleared page,
   * streaming so an oversize body is cancelled at `maxBytes`.
   */
  async fetchBytes(url: string, maxBytes: number): Promise<{ status: number; body: Uint8Array; finalUrl: string }> {
    const page = await this.getClearedOriginPage(new URL(url).origin);
    const result = await page.evaluate(async ({ target, limit }) => {
      const response = await fetch(target);
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > limit) {
          await reader.cancel();
          return { status: response.status, finalUrl: response.url, base64: null };
        }
        chunks.push(value);
      }
      let binary = "";
      for (const chunk of chunks) {
        for (let offset = 0; offset < chunk.length; offset += 0x8000) {
          binary += String.fromCharCode(...chunk.subarray(offset, offset + 0x8000));
        }
      }
      return { status: response.status, finalUrl: response.url, base64: btoa(binary) };
    }, { target: url, limit: maxBytes });
    if (result.base64 === null) throw new Error(`Response from ${url} exceeds ${maxBytes} bytes`);
    return { status: result.status, finalUrl: result.finalUrl, body: new Uint8Array(Buffer.from(result.base64, "base64")) };
  }

  async close(): Promise<void> {
    if (!this.contextPromise) return;
    const context = await this.contextPromise.catch(() => null);
    this.contextPromise = null;
    this.clearedOriginPages.clear();
    await context?.close();
  }

  private getClearedOriginPage(origin: string): Promise<Page> {
    let pagePromise = this.clearedOriginPages.get(origin);
    if (!pagePromise) {
      pagePromise = this.getContext().then(async (context) => {
        const page = await context.newPage();
        await this.loadPastChallenge(page, `${origin}/`);
        return page;
      });
      this.clearedOriginPages.set(origin, pagePromise);
    }
    return pagePromise;
  }

  private async loadPastChallenge(page: Page, url: string): Promise<RealBrowserPage> {
    let status = 0;
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        status = response.status();
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    const html = await this.waitForChallengeToClear(page, () => status);
    return { finalUrl: page.url(), status, html };
  }

  /**
   * Challenge pages solve themselves and then reload, so poll until the
   * document is no longer a challenge and the reload has settled.
   */
  private async waitForChallengeToClear(page: Page, currentStatus: () => number): Promise<string> {
    const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
    let sawChallenge = false;
    while (Date.now() < deadline) {
      const html = await readContentSafely(page);
      const provider = html === null ? "navigating" : detectBotChallenge({ status: currentStatus(), html });
      if (!provider && html !== null) {
        if (!sawChallenge) return html;
        await page.waitForLoadState("load").catch(() => undefined);
        await page.waitForTimeout(POST_CHALLENGE_SETTLE_MS);
        return (await readContentSafely(page)) ?? html;
      }
      sawChallenge = true;
      await page.waitForTimeout(CHALLENGE_POLL_MS);
    }
    throw new ChallengeTimeoutError(page.url());
  }

  private getContext(): Promise<BrowserContext> {
    this.contextPromise ??= launchRealChrome(this.profileDir);
    return this.contextPromise;
  }
}

class ChallengeTimeoutError extends Error {
  constructor(url: string) {
    super(`Bot challenge did not clear within ${CHALLENGE_TIMEOUT_MS / 1000}s for ${url}`);
    this.name = "ChallengeTimeoutError";
  }
}

async function launchRealChrome(profileDir: string): Promise<BrowserContext> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install playwright");
  }
  await mkdir(profileDir, { recursive: true });
  console.log("🌐 Bot protection detected; fetching through Google Chrome (window kept off-screen)");
  try {
    return await playwright.chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--window-position=-32000,-32000",
        "--window-size=1280,800",
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      `This site needs a real Chrome to pass bot protection, but Google Chrome could not be launched (${message}).\n` +
        "   Install Google Chrome, or open the page in Chrome and use --active-tab.",
    );
  }
}

async function readContentSafely(page: Page): Promise<string | null> {
  try {
    return await page.content();
  } catch {
    // page.content() throws while the challenge triggers its reload.
    return null;
  }
}
