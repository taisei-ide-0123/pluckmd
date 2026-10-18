import { describe, expect, it } from "vitest";
import type { PageAnalysisInput } from "@pluckmd/shared";
import { assertArticlePageOk, detectBotChallenge } from "../src/core/bot-challenge.js";

function page(status: number, html: string): PageAnalysisInput {
  return { requestedUrl: "https://example.com/a", finalUrl: "https://example.com/a", status, html, source: "static", renderMode: "auto" };
}

describe("detectBotChallenge", () => {
  it("recognizes a Cloudflare interstitial", () => {
    const html = "<html><head><title>Just a moment...</title></head><body>/cdn-cgi/challenge-platform/</body></html>";
    expect(detectBotChallenge({ status: 403, html })).toBe("Cloudflare");
  });

  it("recognizes an entity-encoded Akamai denial", () => {
    const html = "<TITLE>Access Denied</TITLE>Reference&#32;&#35;18&#46;95<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net/18</P>";
    expect(detectBotChallenge({ status: 403, html })).toBe("Akamai");
  });

  it("ignores challenge-like text on successful pages", () => {
    const html = "<title>Just a moment: a short essay</title>";
    expect(detectBotChallenge({ status: 200, html })).toBeNull();
  });

  it("ignores ordinary error pages", () => {
    expect(detectBotChallenge({ status: 403, html: "<title>Forbidden</title>" })).toBeNull();
  });
});

describe("assertArticlePageOk", () => {
  it("passes successful pages", () => {
    expect(() => assertArticlePageOk(page(200, "<p>ok</p>"))).not.toThrow();
  });

  it("names the provider for challenge pages and the status otherwise", () => {
    expect(() => assertArticlePageOk(page(403, "errors.edgesuite.net"))).toThrow(/Akamai/);
    expect(() => assertArticlePageOk(page(404, "<title>Not found</title>"))).toThrow("HTTP 404");
  });
});
