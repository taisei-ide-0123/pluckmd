import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  analyzeSitemapStructure,
  discoverArticlesFromSitemap,
  isArticleCandidate,
  filterModifiedSince,
  parseSitemapXml,
  selectArticleEntries,
  type SitemapFetcher,
} from "../src/core/sitemap-discovery.js";

function fakeFetcher(documents: Record<string, string | Uint8Array>): SitemapFetcher {
  return async (url) => {
    const document = documents[url];
    if (document === undefined) return { status: 404, body: new Uint8Array() };
    return { status: 200, body: typeof document === "string" ? new TextEncoder().encode(document) : document };
  };
}

function urlset(entries: Array<[string, string?]>): string {
  const urls = entries
    .map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`)
    .join("");
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

describe("parseSitemapXml", () => {
  it("reads url entries and child sitemaps, decoding XML entities and CDATA", () => {
    const parsed = parseSitemapXml(`
      <sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>
      <urlset>
        <url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2025-01-02</lastmod></url>
        <url><loc><![CDATA[https://example.com/b]]></loc></url>
      </urlset>`);

    expect(parsed.childSitemaps).toEqual(["https://example.com/s1.xml"]);
    expect(parsed.entries).toEqual([
      { url: "https://example.com/a?x=1&y=2", lastmod: "2025-01-02" },
      { url: "https://example.com/b", lastmod: undefined },
    ]);
  });
});

describe("selectArticleEntries", () => {
  const entries = [
    { url: "https://www.example.com/insights/old-post", lastmod: "2020-01-01" },
    { url: "https://www.example.com/insights/new-post", lastmod: "2025-06-01" },
    { url: "https://www.example.com/insights/", lastmod: "2025-07-01" },
    { url: "https://www.example.com/careers/job", lastmod: "2025-07-01" },
    { url: "https://other.com/insights/foreign", lastmod: "2025-07-01" },
  ];

  it("keeps same-site entries strictly under the scope path, newest first", () => {
    const selected = selectArticleEntries(entries, "https://example.com/insights");
    expect(selected.map((entry) => entry.url)).toEqual([
      "https://www.example.com/insights/new-post",
      "https://www.example.com/insights/old-post",
    ]);
  });

  it("applies the since filter and drops undated entries", () => {
    const selected = filterModifiedSince(
      selectArticleEntries([...entries, { url: "https://www.example.com/insights/undated" }], "https://example.com/insights/"),
      new Date("2024-01-01"),
    );
    expect(selected.map((entry) => entry.url)).toEqual(["https://www.example.com/insights/new-post"]);
  });
});

describe("discoverArticlesFromSitemap", () => {
  it("follows robots.txt into a gzipped sitemap index and applies the limit", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/robots.txt": "User-agent: *\nSitemap: https://example.com/index.xml\n",
      "https://example.com/index.xml":
        "<sitemapindex><sitemap><loc>https://example.com/posts.xml.gz</loc></sitemap></sitemapindex>",
      "https://example.com/posts.xml.gz": gzipSync(urlset([
        ["https://example.com/blog/a", "2025-01-01"],
        ["https://example.com/blog/b", "2025-03-01"],
        ["https://example.com/blog/c", "2025-02-01"],
      ])),
    });

    const result = await discoverArticlesFromSitemap("https://example.com/blog", fetcher, { limit: 2 });

    expect(result.sitemapUrls).toEqual(["https://example.com/index.xml", "https://example.com/posts.xml.gz"]);
    expect(result.inScopeEntries).toBe(3);
    expect(result.links).toEqual([
      { url: "https://example.com/blog/b" },
      { url: "https://example.com/blog/c" },
    ]);
  });

  it("falls back to /sitemap.xml when robots.txt declares none", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/robots.txt": "User-agent: *\nDisallow:\n",
      "https://example.com/sitemap.xml": urlset([["https://example.com/blog/a"]]),
    });

    const result = await discoverArticlesFromSitemap("https://example.com/blog", fetcher, { limit: 10 });
    expect(result.links.map((link) => link.url)).toEqual(["https://example.com/blog/a"]);
  });

  it("reports undated entries excluded by --since", async () => {
    const fetcher = fakeFetcher({
      "https://example.com/robots.txt": "Sitemap: https://example.com/s.xml",
      "https://example.com/s.xml": urlset([["https://example.com/blog/a"], ["https://example.com/blog/b"]]),
    });

    const result = await discoverArticlesFromSitemap("https://example.com/blog", fetcher, {
      limit: 10,
      since: new Date("2025-01-01"),
    });
    expect(result.links).toEqual([]);
    expect(result.undatedEntriesExcluded).toBe(2);
  });

  it("fails with guidance when no sitemap exists", async () => {
    await expect(
      discoverArticlesFromSitemap("https://example.com/blog", fakeFetcher({}), { limit: 10 }),
    ).rejects.toThrow(/--sitemap <url>/);
  });
});

describe("isArticleCandidate", () => {
  const paths = [
    "/insights",
    "/insights/plain-article",
    "/insights/topics/future-of-retail",
    "/insights/2026",
    "/insights/2026/dated-article",
    "/insights/ai/translated-article",
    "/insights/ai/translated-article/fr-ca",
    "/insights/destacados/spanish-only/es",
  ];
  const structure = analyzeSitemapStructure(paths);
  const isCandidate = (path: string) => isArticleCandidate(path, "/insights", structure);

  it("keeps leaf articles under the scope", () => {
    expect(isCandidate("/insights/plain-article")).toBe(true);
    expect(isCandidate("/insights/2026/dated-article")).toBe(true);
  });

  it("drops the scope itself and paths outside it", () => {
    expect(isCandidate("/insights")).toBe(false);
    expect(isCandidate("/careers/job")).toBe(false);
  });

  it("drops taxonomy pages", () => {
    expect(isCandidate("/insights/topics/future-of-retail")).toBe(false);
  });

  it("drops index pages that are parents of other paths", () => {
    expect(isCandidate("/insights/2026")).toBe(false);
  });

  it("drops translations of an existing article but keeps the original", () => {
    expect(isCandidate("/insights/ai/translated-article/fr-ca")).toBe(false);
    expect(isCandidate("/insights/ai/translated-article")).toBe(true);
  });

  it("keeps locale-suffixed articles that have no original", () => {
    expect(isCandidate("/insights/destacados/spanish-only/es")).toBe(true);
  });
});
