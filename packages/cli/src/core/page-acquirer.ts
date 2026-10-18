import type {
  DomEvaluationResult,
  DomEvaluator,
  PageAcquirer,
  PageAnalysisInput,
  RenderMode,
} from "@pluckmd/shared";
import { getProfileDir } from "@pluckmd/shared";
import { Agent, fetch as undiciFetch } from "undici";
import { detectBotChallenge } from "./bot-challenge.js";
import { RealBrowserFetcher, type RealBrowserPage } from "./real-browser.js";

// Node's global fetch caps response headers at ~16 KB and throws
// UND_ERR_HEADERS_OVERFLOW on sites that emit large Set-Cookie/consent headers
// (e.g. Yahoo). undici's fetch with a custom Agent lets us raise maxHeaderSize
// while keeping built-in redirect following and gzip/br/deflate decoding.
const staticFetchAgent = new Agent({ maxHeaderSize: 1024 * 1024 });

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RENDER_SETTLE_MS = 1_000;
const CONTENT_RETRY_ATTEMPTS = 3;
const CONTENT_RETRY_DELAY_MS = 250;
const HREF_RETRY_ATTEMPTS = 8;
const HREF_RETRY_DELAY_MS = 500;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PAGINATION_CLICK_SETTLE_MS = 900;
const MAX_PAGINATION_CANDIDATES = 5;

interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

type BrowserEvaluateFunction<T> = (arg?: unknown) => T | Promise<T>;

interface BrowserPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  url(): string;
  evaluate<T = unknown>(fn: string | BrowserEvaluateFunction<T>, arg?: unknown): Promise<T>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
}

/** The subset of RealBrowserFetcher the acquirer uses; injectable for tests. */
export interface BotChallengeBrowser {
  fetchPage(url: string): Promise<RealBrowserPage>;
  fetchBytes(url: string): Promise<{ status: number; body: Uint8Array }>;
  close(): Promise<void>;
}

export interface RenderingPageAcquirerOptions {
  render?: RenderMode;
  timeoutMs?: number;
  profileDir?: string;
  realBrowser?: BotChallengeBrowser;
}

interface StaticFetchResult {
  html: string;
  finalUrl: string;
  status: number;
}

export class RenderingPageAcquirer implements PageAcquirer {
  private readonly render: RenderMode;
  private readonly timeoutMs: number;
  private readonly profileDir: string;
  private browserContext: BrowserContext | null = null;
  // Hosts whose bot protection rejects headless Chromium (e.g. HTTP/2 resets).
  // Remembered so a bulk download does not pay a failed render per article.
  private readonly renderRejectingHosts = new Set<string>();
  // Hosts that served a bot challenge to static fetch; later requests go
  // straight to real Chrome instead of re-triggering the challenge.
  private readonly challengedHosts = new Set<string>();
  private readonly realBrowser: BotChallengeBrowser;

  constructor(options: RenderingPageAcquirerOptions = {}) {
    this.render = options.render ?? "auto";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.profileDir = options.profileDir ?? getProfileDir();
    // Separate profile: Chrome and the bundled Chromium cannot share one, and
    // both contexts may be open at once.
    this.realBrowser =
      options.realBrowser ?? new RealBrowserFetcher(`${this.profileDir}-chrome`, this.timeoutMs);
  }

  async acquire(url: string): Promise<PageAnalysisInput> {
    const host = new URL(url).host;
    if (this.challengedHosts.has(host)) return this.acquireThroughRealBrowser(url);
    if (this.render === "always") {
      return this.acquireRendered(url);
    }

    const staticPage = await this.acquireStatic(url);
    if (detectBotChallenge(staticPage)) {
      this.challengedHosts.add(host);
      return this.acquireThroughRealBrowser(url);
    }
    const staticResult: PageAnalysisInput = {
      requestedUrl: url,
      finalUrl: staticPage.finalUrl,
      status: staticPage.status,
      html: staticPage.html,
      source: "static",
      renderMode: this.render,
    };
    if (this.render === "never" || !shouldRetryWithRendering(staticPage.html)) {
      return staticResult;
    }

    if (this.renderRejectingHosts.has(host)) return staticResult;
    try {
      return await this.acquireRendered(url);
    } catch (renderError) {
      if (!isUsableStaticPage(staticPage) || isPlaywrightMissing(renderError)) throw renderError;
      // Server-rendered frameworks (Next.js etc.) trip shouldRetryWithRendering
      // even when the static HTML is complete; keep it rather than abort.
      this.renderRejectingHosts.add(host);
      console.warn(
        `⚠️  Rendering failed for ${host} (${firstLine(renderError)}); using static HTML instead.`,
      );
      return staticResult;
    }
  }

  /**
   * Raw-bytes fetch for sitemaps and robots.txt, escalating to real Chrome
   * when the static response is a bot challenge.
   */
  async fetchBytes(url: string): Promise<{ status: number; body: Uint8Array }> {
    const host = new URL(url).host;
    if (!this.challengedHosts.has(host)) {
      const response = await fetchStaticBytes(url, this.timeoutMs);
      const html = new TextDecoder().decode(response.body.subarray(0, 64 * 1024));
      if (!detectBotChallenge({ status: response.status, html })) return response;
      this.challengedHosts.add(host);
    }
    return this.realBrowser.fetchBytes(url);
  }

  async close(): Promise<void> {
    await this.realBrowser.close();
    if (this.browserContext) {
      await this.browserContext.close();
      this.browserContext = null;
    }
  }

  private async acquireThroughRealBrowser(url: string): Promise<PageAnalysisInput> {
    const page = await this.realBrowser.fetchPage(url);
    return {
      requestedUrl: url,
      finalUrl: page.finalUrl,
      status: page.status,
      html: page.html,
      source: "rendered",
      renderMode: this.render,
    };
  }

  private async acquireStatic(url: string): Promise<StaticFetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await undiciFetch(url, {
        dispatcher: staticFetchAgent,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
        },
      });
      return {
        html: await response.text(),
        finalUrl: response.url || url,
        status: response.status,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async acquireRendered(url: string): Promise<PageAnalysisInput> {
    const context = await this.getBrowserContext();
    const page = await context.newPage();

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs,
    });
    await page.waitForTimeout(DEFAULT_RENDER_SETTLE_MS);

    return {
      requestedUrl: url,
      finalUrl: page.url(),
      status: response?.status() ?? 200,
      html: await page.content(),
      source: "rendered",
      renderMode: this.render,
      evaluator: new PlaywrightDomEvaluator(page),
    };
  }

  private async getBrowserContext(): Promise<BrowserContext> {
    if (this.browserContext) return this.browserContext;

    let playwright: typeof import("playwright");
    try {
      playwright = await import("playwright");
    } catch {
      throw new Error(
        "Playwright is not installed. Run: npm install playwright && npx playwright install chromium",
      );
    }

    this.browserContext = await playwright.chromium.launchPersistentContext(this.profileDir, {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 720 },
    });
    return this.browserContext;
  }
}

class PlaywrightDomEvaluator implements DomEvaluator {
  constructor(private readonly page: BrowserPage) {}

  async count(selector: string): Promise<DomEvaluationResult<number>> {
    const value = await this.page.evaluate<number>(
      (sel: unknown) => document.querySelectorAll(sel as string).length,
      selector,
    );
    return { value };
  }

  async text(selector: string): Promise<DomEvaluationResult<string[]>> {
    const value = await this.page.evaluate<string[]>(
      (sel: unknown) =>
        Array.from(document.querySelectorAll(sel as string))
          .map((el) => el.textContent?.trim() || "")
          .filter(Boolean),
      selector,
    );
    return { value };
  }

  async hrefs(selector: string): Promise<DomEvaluationResult<string[]>> {
    let value: string[] = [];
    for (let attempt = 0; attempt < HREF_RETRY_ATTEMPTS; attempt++) {
      value = await this.page.evaluate<string[]>(
        (sel: unknown) =>
          Array.from(document.querySelectorAll<HTMLAnchorElement>(sel as string))
            .map((el) => el.href)
            .filter(Boolean),
        selector,
      );
      if (value.length > 0) break;
      await this.page.waitForTimeout(HREF_RETRY_DELAY_MS);
    }
    return { value };
  }

  async click(selector: string): Promise<DomEvaluationResult<boolean>> {
    try {
      await this.page.click(selector, { timeout: 250 });
      return { value: true };
    } catch {
      return { value: false };
    }
  }

  async clickByText(patterns: readonly string[]): Promise<DomEvaluationResult<boolean>> {
    const marker = `pluckmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const marked = await this.page.evaluate<boolean>(
      (arg: unknown) => {
        const { patterns, marker } = arg as { patterns: readonly string[]; marker: string };
        const elements = document.querySelectorAll("button, a, [role='button']");
        for (const element of elements) {
          if (!(element instanceof HTMLElement)) continue;
          const text = element.textContent?.trim() || "";
          const isVisible = Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
          const isDisabled = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
          if (!isVisible || isDisabled || !patterns.some((pattern) => text.includes(pattern))) continue;
          element.setAttribute("data-pluckmd-click-target", marker);
          element.scrollIntoView({ block: "center", inline: "center" });
          return true;
        }
        return false;
      },
      { patterns, marker },
    );
    if (!marked) return { value: false };

    try {
      await this.page.click(`[data-pluckmd-click-target="${marker}"]`, { timeout: 5000 });
      return { value: true };
    } catch {
      return { value: false };
    } finally {
      await this.page.evaluate(
        (currentMarker: unknown) => {
          document
            .querySelector(`[data-pluckmd-click-target="${currentMarker as string}"]`)
            ?.removeAttribute("data-pluckmd-click-target");
        },
        marker,
      );
    }
  }

  async clickPaginationCandidate(articleLinkSelector: string): Promise<DomEvaluationResult<boolean>> {
    try {
      const value = await this.page.evaluate<boolean>(
        clickPaginationCandidateInBrowser,
        {
          articleLinkSelector,
          settleMs: PAGINATION_CLICK_SETTLE_MS,
          maxCandidates: MAX_PAGINATION_CANDIDATES,
        },
      );
      return { value };
    } catch {
      return { value: false };
    }
  }

  async scrollToBottom(): Promise<DomEvaluationResult<boolean>> {
    const value = await this.page.evaluate<boolean>(() => {
      const target = document.scrollingElement || document.documentElement || document.body;
      if (!target) return false;
      window.scrollTo(0, target.scrollHeight);
      return true;
    });
    return { value };
  }

  async navigate(url: string): Promise<DomEvaluationResult<boolean>> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(DEFAULT_RENDER_SETTLE_MS);
    return { value: true };
  }

  async content(): Promise<DomEvaluationResult<string>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < CONTENT_RETRY_ATTEMPTS; attempt++) {
      try {
        return { value: await this.page.content() };
      } catch (error) {
        lastError = error;
        await this.page.waitForTimeout(CONTENT_RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }

  async currentUrl(): Promise<DomEvaluationResult<string>> {
    return { value: this.page.url() };
  }

  async wait(milliseconds: number): Promise<void> {
    await this.page.waitForTimeout(milliseconds);
  }
}

async function fetchStaticBytes(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: Uint8Array }> {
  const response = await undiciFetch(url, {
    dispatcher: staticFetchAgent,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "application/xml,text/xml,text/plain,*/*" },
  });
  return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
}

function isUsableStaticPage(page: StaticFetchResult): boolean {
  return page.status >= 200 && page.status < 300 && page.html.length > 0;
}

function isPlaywrightMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Playwright is not installed") || message.includes("Executable doesn't exist");
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

export function shouldRetryWithRendering(html: string): boolean {
  const lowerHtml = html.toLowerCase();
  if (
    lowerHtml.includes('id="__next"') ||
    lowerHtml.includes("id='__next'") ||
    lowerHtml.includes('id="root"') ||
    lowerHtml.includes("id='root'") ||
    lowerHtml.includes("data-reactroot")
  ) {
    return true;
  }

  const linkCount = countMatches(lowerHtml, /<a\b/g);
  const scriptCount = countMatches(lowerHtml, /<script\b/g);
  const textLength = stripTags(lowerHtml).replace(/\s+/g, "").length;

  return scriptCount >= 8 && (linkCount < 5 || textLength < 800);
}

async function clickPaginationCandidateInBrowser(arg?: unknown): Promise<boolean> {
  const {
    articleLinkSelector,
    settleMs,
    maxCandidates,
  } = arg as { articleLinkSelector: string; settleMs: number; maxCandidates: number };

  const before = paginationSignature(articleLinkSelector);
  const candidates = paginationCandidates(articleLinkSelector);
  for (const candidate of candidates) {
    candidate.element.scrollIntoView({ block: "center", inline: "center" });
    candidate.element.click();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const after = paginationSignature(articleLinkSelector);
    if (advancedPagination(before, after)) return true;
  }
  return false;

  function paginationCandidates(selector: string): Array<{ element: HTMLElement; score: number }> {
    const articleLinks = visibleElements(selector);
    const articleRects = articleLinks.map((element) => element.getBoundingClientRect());
    const lastArticleBottom = articleRects.reduce((max, rect) => Math.max(max, rect.bottom), 0);
    const articleLinkSet = new Set(articleLinks);

    return Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"))
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => !articleLinkSet.has(element))
      .filter((element) => isVisible(element))
      .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true")
      .filter((element) => !element.closest("nav, header, footer, aside"))
      .filter((element) => !element.closest(selector))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        const belowArticles = lastArticleBottom === 0 || rect.top >= lastArticleBottom - 120;
        const centered = 1 - Math.min(Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) / window.innerWidth, 1);
        const sizeScore = Math.min(area / 8000, 1);
        const distance = lastArticleBottom === 0 ? 0 : Math.abs(rect.top - lastArticleBottom);
        const proximity = 1 - Math.min(distance / Math.max(window.innerHeight, 1), 1);
        return { element, score: (belowArticles ? 4 : 0) + centered + sizeScore + proximity };
      })
      .filter((candidate) => candidate.score >= 3.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCandidates);
  }

  function paginationSignature(selector: string): { hrefs: string[]; height: number; url: string } {
    return {
      hrefs: visibleElements(selector)
        .map((element) => element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href") || "")
        .filter(Boolean),
      height: document.documentElement.scrollHeight,
      url: window.location.href,
    };
  }

  function advancedPagination(
    previous: { hrefs: string[]; height: number; url: string },
    next: { hrefs: string[]; height: number; url: string },
  ): boolean {
    const previousSet = new Set(previous.hrefs);
    const newHrefCount = next.hrefs.filter((href) => !previousSet.has(href)).length;
    return newHrefCount > 0 || next.hrefs.length > previous.hrefs.length || next.height > previous.height + 200 || next.url !== previous.url;
  }

  function visibleElements(selector: string): HTMLElement[] {
    try {
      return Array.from(document.querySelectorAll(selector))
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
        .filter(isVisible);
    } catch {
      return [];
    }
  }

  function isVisible(element: HTMLElement): boolean {
    return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ");
}
