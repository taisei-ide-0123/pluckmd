import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderingPageAcquirer, type BotChallengeBrowser } from "../src/core/page-acquirer.js";

const CHALLENGE_HTML = "<html><head><title>Just a moment...</title></head><body>challenge-platform</body></html>";

let server: Server;
let origin: string;
const staticHits: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    staticHits.push(request.url ?? "");
    if (request.url === "/huge.xml") {
      response.writeHead(200, { "Content-Type": "application/xml" });
      response.end("x".repeat(64 * 1024));
      return;
    }
    if (request.url?.startsWith("/blocked")) {
      response.writeHead(403, { "Content-Type": "text/html" });
      response.end(CHALLENGE_HTML);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<html><body><main><p>open page</p></main></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function fakeBrowser(): BotChallengeBrowser & { pages: string[]; files: string[] } {
  const pages: string[] = [];
  const files: string[] = [];
  return {
    pages,
    files,
    fetchPage: async (url) => {
      pages.push(url);
      return { finalUrl: url, status: 200, html: "<p>through chrome</p>" };
    },
    fetchBytes: async (url) => {
      files.push(url);
      return { status: 200, body: new TextEncoder().encode("<urlset></urlset>"), finalUrl: url };
    },
    close: async () => undefined,
  };
}

describe("RenderingPageAcquirer bot-challenge escalation", () => {
  it("keeps static results for open pages", async () => {
    const browser = fakeBrowser();
    const acquirer = new RenderingPageAcquirer({ render: "never", realBrowser: browser });

    const page = await acquirer.acquire(`${origin}/open`);
    expect(page.source).toBe("static");
    expect(browser.pages).toEqual([]);
  });

  it("escalates challenged hosts to the real browser and skips static fetch afterwards", async () => {
    const browser = fakeBrowser();
    const acquirer = new RenderingPageAcquirer({ render: "never", realBrowser: browser });
    staticHits.length = 0;

    const first = await acquirer.acquire(`${origin}/blocked/a`);
    const second = await acquirer.acquire(`${origin}/blocked/b`);
    const sitemap = await acquirer.fetchBytes(`${origin}/sitemap.xml`, 1024);

    expect(first).toMatchObject({ source: "rendered", status: 200, html: "<p>through chrome</p>" });
    expect(second.source).toBe("rendered");
    expect(new TextDecoder().decode(sitemap.body)).toBe("<urlset></urlset>");
    expect(staticHits).toEqual(["/blocked/a"]);
    expect(browser.pages).toEqual([`${origin}/blocked/a`, `${origin}/blocked/b`]);
    expect(browser.files).toEqual([`${origin}/sitemap.xml`]);
  });
});

describe("RenderingPageAcquirer.fetchBytes", () => {
  it("returns the final URL and aborts bodies over the byte cap", async () => {
    const acquirer = new RenderingPageAcquirer({ render: "never", realBrowser: fakeBrowser() });

    const small = await acquirer.fetchBytes(`${origin}/open`, 1024 * 1024);
    expect(small.finalUrl).toBe(`${origin}/open`);
    await expect(acquirer.fetchBytes(`${origin}/huge.xml`, 1024)).rejects.toThrow(/exceeds 1024 bytes/);
  });
});
