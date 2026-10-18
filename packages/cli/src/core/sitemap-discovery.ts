import { gunzipSync } from "node:zlib";
import type { ArticleRef } from "@pluckmd/shared";

/**
 * Sitemap-based article discovery.
 *
 * Large publisher sites (consulting firms, news, corporate blogs) often expose
 * only a JS "load more" listing that yields a handful of links, while their
 * sitemap lists every article with a lastmod date. Reading the sitemap gives a
 * complete, date-sortable URL set in a few requests and needs no rendering.
 */

/** Fetches raw bytes for a URL; injected so discovery is testable offline. */
export type SitemapFetcher = (url: string) => Promise<{ status: number; body: Uint8Array }>;

export interface SitemapEntry {
  readonly url: string;
  readonly lastmod?: string;
}

export interface SitemapDiscoveryOptions {
  /** Explicit sitemap URL; skips robots.txt / well-known lookup when set. */
  readonly sitemapUrl?: string;
  /** Only keep entries whose lastmod is on or after this date. */
  readonly since?: Date;
  readonly limit: number;
  /** Upper bound on sitemap documents fetched (index recursion guard). */
  readonly maxSitemaps?: number;
}

export interface SitemapDiscoveryResult {
  readonly sitemapUrls: readonly string[];
  readonly totalEntries: number;
  readonly inScopeEntries: number;
  /** In-scope entries dropped by --since because the sitemap gives no lastmod. */
  readonly undatedEntriesExcluded: number;
  readonly links: readonly ArticleRef[];
}

const WELL_KNOWN_SITEMAP_PATHS = ["/sitemap.xml", "/sitemap_index.xml"];
const DEFAULT_MAX_SITEMAPS = 50;
const GZIP_MAGIC = [0x1f, 0x8b];

export async function discoverArticlesFromSitemap(
  scopeUrl: string,
  fetcher: SitemapFetcher,
  options: SitemapDiscoveryOptions,
): Promise<SitemapDiscoveryResult> {
  const rootSitemaps = options.sitemapUrl
    ? [options.sitemapUrl]
    : await findSitemapUrls(new URL(scopeUrl).origin, fetcher);
  if (rootSitemaps.length === 0) {
    throw new Error(
      `No sitemap found for ${new URL(scopeUrl).origin} (checked robots.txt and ${WELL_KNOWN_SITEMAP_PATHS.join(", ")}). ` +
        "Pass one explicitly with --sitemap <url>.",
    );
  }

  const { entries, fetchedSitemaps } = await collectSitemapEntries(
    rootSitemaps,
    fetcher,
    options.maxSitemaps ?? DEFAULT_MAX_SITEMAPS,
  );
  const scoped = selectArticleEntries(entries, scopeUrl);
  const inScope = options.since ? filterModifiedSince(scoped, options.since) : scoped;
  return {
    sitemapUrls: fetchedSitemaps,
    totalEntries: entries.length,
    inScopeEntries: inScope.length,
    undatedEntriesExcluded: options.since ? scoped.filter((entry) => !entry.lastmod).length : 0,
    // lastmod is a modification date, not a publish date, so it is not passed
    // as publishedAtHint; the article page's own metadata is authoritative.
    links: inScope.slice(0, options.limit).map((entry) => ({ url: entry.url })),
  };
}

/** Reads `Sitemap:` lines from robots.txt, falling back to well-known paths. */
export async function findSitemapUrls(origin: string, fetcher: SitemapFetcher): Promise<string[]> {
  const robots = await fetchText(`${origin}/robots.txt`, fetcher);
  const declared = robots
    ? [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1])
    : [];
  if (declared.length > 0) return declared;

  for (const path of WELL_KNOWN_SITEMAP_PATHS) {
    const candidate = `${origin}${path}`;
    const body = await fetchText(candidate, fetcher);
    if (body && /<(urlset|sitemapindex)\b/i.test(body)) return [candidate];
  }
  return [];
}

/**
 * Breadth-first expansion of sitemap indexes into URL entries. Child sitemaps
 * that fail to load are skipped so one broken shard does not abort discovery.
 */
async function collectSitemapEntries(
  rootSitemaps: readonly string[],
  fetcher: SitemapFetcher,
  maxSitemaps: number,
): Promise<{ entries: SitemapEntry[]; fetchedSitemaps: string[] }> {
  const queue = [...rootSitemaps];
  const visited = new Set<string>();
  const entries: SitemapEntry[] = [];

  while (queue.length > 0 && visited.size < maxSitemaps) {
    const sitemapUrl = queue.shift()!;
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const xml = await fetchText(sitemapUrl, fetcher);
    if (!xml) continue;
    const parsed = parseSitemapXml(xml);
    queue.push(...parsed.childSitemaps);
    entries.push(...parsed.entries);
  }
  return { entries, fetchedSitemaps: [...visited] };
}

export function parseSitemapXml(xml: string): { entries: SitemapEntry[]; childSitemaps: string[] } {
  const childSitemaps = [...xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)]
    .map((match) => readTag(match[1], "loc"))
    .filter((loc): loc is string => Boolean(loc));
  const entries = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].flatMap((match): SitemapEntry[] => {
    const url = readTag(match[1], "loc");
    return url ? [{ url, lastmod: readTag(match[1], "lastmod") }] : [];
  });
  return { entries, childSitemaps };
}

/**
 * Keeps entries under the scope URL's path, ordered newest first so `--limit`
 * takes the most recent articles.
 */
export function selectArticleEntries(entries: readonly SitemapEntry[], scopeUrl: string): SitemapEntry[] {
  const scope = new URL(scopeUrl);
  const scopePath = normalizePath(scope.pathname);
  const uniqueEntries = dedupeByUrl(entries);
  const structure = analyzeSitemapStructure(uniqueEntries.map((entry) => normalizePath(safePathname(entry.url))));

  return uniqueEntries
    .filter((entry) => sameSite(entry.url, scope))
    .filter((entry) => isArticleCandidate(normalizePath(safePathname(entry.url)), scopePath, structure))
    .sort(compareNewestFirst);
}

/** Entries without lastmod cannot be dated, so they are excluded. */
export function filterModifiedSince(entries: readonly SitemapEntry[], since: Date): SitemapEntry[] {
  return entries.filter((entry) => isOnOrAfter(entry.lastmod, since));
}

// Path segments that CMSs use for taxonomy and index pages rather than articles.
const TAXONOMY_SEGMENTS = new Set([
  "topic", "topics", "tag", "tags", "category", "categories", "collection", "collections",
  "author", "authors", "series", "page", "archive", "archives", "search",
]);
// "ja", "fr-ca", "pt-br", "zh-hant": a translated copy of the parent path.
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2,4})?$/;

/** Structural facts about the whole sitemap, computed once per discovery. */
export interface SitemapStructure {
  readonly paths: ReadonlySet<string>;
  /** Paths that are parents of other (non-translation) paths: index pages. */
  readonly parentPaths: ReadonlySet<string>;
}

export function analyzeSitemapStructure(paths: readonly string[]): SitemapStructure {
  const pathSet = new Set(paths);
  const parentPaths = new Set<string>();
  for (const path of pathSet) {
    if (isLocaleVariant(path, pathSet)) continue;
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) parentPaths.add(parent);
  }
  return { paths: pathSet, parentPaths };
}

/**
 * Decides whether a sitemap path is an article worth downloading, as opposed
 * to the listing itself, an index/taxonomy page, or a translated duplicate.
 *
 * @param entryPath  normalized path of the sitemap entry (no trailing slash)
 * @param scopePath  normalized path of the URL the user passed ("" for site root)
 * @param structure  whole-sitemap facts from analyzeSitemapStructure
 */
export function isArticleCandidate(
  entryPath: string,
  scopePath: string,
  structure: SitemapStructure,
): boolean {
  if (!entryPath.startsWith(`${scopePath}/`)) return false;
  // e.g. /insights/topics/future-of-retail, /publications/collections/x
  const segmentsBelowScope = entryPath.slice(scopePath.length + 1).split("/");
  if (segmentsBelowScope.some((segment) => TAXONOMY_SEGMENTS.has(segment))) return false;
  // e.g. /featured-insights/ai/some-article/fr-ca when /some-article exists
  if (isLocaleVariant(entryPath, structure.paths)) return false;
  // e.g. /publications/2026 or /featured-insights/artificial-intelligence
  return !structure.parentPaths.has(entryPath);
}

function isLocaleVariant(path: string, paths: ReadonlySet<string>): boolean {
  const lastSlash = path.lastIndexOf("/");
  return LOCALE_SEGMENT.test(path.slice(lastSlash + 1)) && paths.has(path.slice(0, lastSlash));
}

function isOnOrAfter(lastmod: string | undefined, since: Date): boolean {
  if (!lastmod) return false;
  const time = Date.parse(lastmod);
  return Number.isFinite(time) && time >= since.getTime();
}

function compareNewestFirst(left: SitemapEntry, right: SitemapEntry): number {
  return parseTimeOrZero(right.lastmod) - parseTimeOrZero(left.lastmod);
}

function parseTimeOrZero(value: string | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function dedupeByUrl(entries: readonly SitemapEntry[]): SitemapEntry[] {
  const byUrl = new Map<string, SitemapEntry>();
  for (const entry of entries) {
    if (!byUrl.has(entry.url)) byUrl.set(entry.url, entry);
  }
  return [...byUrl.values()];
}

function sameSite(url: string, scope: URL): boolean {
  try {
    return stripWww(new URL(url).hostname) === stripWww(scope.hostname);
  } catch {
    return false;
  }
}

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./, "");
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "").toLowerCase();
}

function readTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXmlText(match[1].trim()) : undefined;
}

function decodeXmlText(text: string): string {
  return text
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function fetchText(url: string, fetcher: SitemapFetcher): Promise<string | null> {
  try {
    const { status, body } = await fetcher(url);
    if (status < 200 || status >= 300) return null;
    const bytes = GZIP_MAGIC.every((byte, index) => body[index] === byte) ? gunzipSync(body) : body;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
