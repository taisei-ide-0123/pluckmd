import type {
  AdapterSpec,
  ArticleRef,
  PageAnalysisInput,
  RenderMode,
} from "@pluckmd/shared";
import {
  ConsoleDownloadReporter,
  type DownloadReporter,
} from "./download-reporter.js";
import {
  type ArticleDownloadOutcome,
  type DownloadResult,
  summarizeDownload,
} from "./download-result.js";
import { ExtensionFetcher } from "../core/extension-fetcher.js";
import { resolveGenericAdapterSpec } from "../core/generic-resolver.js";
import { GenericLinkCollector } from "../core/link-collector.js";
import { assertArticlePageOk, assertNotBotChallenge } from "../core/bot-challenge.js";
import { RenderingPageAcquirer } from "../core/page-acquirer.js";
import { ReadabilityArticleExtractor } from "../core/heuristic-analyzer.js";
import { discoverArticlesFromSitemap, type SitemapFetcher } from "../core/sitemap-discovery.js";
import { convertHtmlToMarkdown } from "../pipeline/converter.js";
import { readDownloadedSources, writeArticle } from "../pipeline/writer.js";
import pLimit from "p-limit";

export interface DownloadCommandOptions {
  output: string;
  concurrency: number;
  delay: number;
  limit: number;
  paginationTimeoutMs: number;
  noLlm?: boolean;
  render?: RenderMode;
  refreshAdapter?: boolean;
  activeTab?: boolean;
  /** true = discover via robots.txt/well-known sitemap; string = explicit sitemap URL. */
  sitemap?: boolean | string;
  since?: Date;
}

type ArticleAcquirer = (url: string) => Promise<PageAnalysisInput>;

interface DownloadSource {
  readonly label: string;
  readonly url?: string;
  /** Raw fetch for sitemaps; absent when the source cannot fetch arbitrary files. */
  readonly fetchBytes?: SitemapFetcher;
  readonly listingDescription?: string;
  acquireListing(): Promise<PageAnalysisInput>;
  acquireArticle: ArticleAcquirer;
  close(): Promise<void>;
}

export async function downloadCommand(
  url: string | undefined,
  options: DownloadCommandOptions,
): Promise<void> {
  const source = createDownloadSource(url, options);
  const reporter = new ConsoleDownloadReporter();

  try {
    const result = await runGenericDownload(source, options, reporter);
    reporter.finished(result);
  } finally {
    await source.close();
  }
}

function createDownloadSource(
  url: string | undefined,
  options: DownloadCommandOptions,
): DownloadSource {
  if (options.activeTab) {
    const extensionFetcher = new ExtensionFetcher();
    return {
      label: "generic active tab",
      listingDescription: "Active tab",
      acquireListing: () => extensionFetcher.acquireActiveTab(),
      acquireArticle: (articleUrl) => acquireArticleThroughExtension(extensionFetcher, articleUrl),
      close: () => extensionFetcher.close(),
    };
  }

  if (!url) throw new Error("URL is required unless --active-tab is set");

  const acquirer = new RenderingPageAcquirer({ render: options.render ?? "auto" });
  return {
    label: "generic",
    url,
    fetchBytes: (fileUrl, maxBytes) => acquirer.fetchBytes(fileUrl, maxBytes),
    acquireListing: () => acquirer.acquire(url),
    acquireArticle: (articleUrl) => acquirer.acquire(articleUrl),
    close: () => acquirer.close(),
  };
}

const ARTICLE_ONLY_SPEC: AdapterSpec = {
  listing: { articleLinkSelector: "a[href]", articleLinkHrefPattern: ".*" },
  article: { method: "readability" },
  pagination: { method: "none" },
  evidence: "Article URLs supplied directly (sitemap or single-article fallback)",
};

type CollectedArticles =
  | { readonly kind: "articles"; readonly links: readonly ArticleRef[]; readonly spec: AdapterSpec }
  // The URL was not a listing; download the already-fetched page itself.
  | { readonly kind: "single-article"; readonly page: PageAnalysisInput };

async function runGenericDownload(
  source: DownloadSource,
  options: DownloadCommandOptions,
  reporter: DownloadReporter,
): Promise<DownloadResult> {
  const extractor = new ReadabilityArticleExtractor();
  reporter.sourceSelected(options.sitemap ? `${source.label} (sitemap)` : source.label);

  const collected = options.sitemap
    ? await collectFromSitemap(source, options, reporter)
    : await collectFromListingOrSitemap(source, options, reporter);
  if (collected.kind === "single-article") {
    return downloadSingleArticle(collected.page, options, extractor, reporter);
  }

  const pending = await skipAlreadyDownloaded(collected.links, options.output, reporter);
  const concurrencyLimit = pLimit(options.concurrency);
  const tasks = pending.map((articleRef, index) =>
    concurrencyLimit(() => downloadArticleSafely({
      articleRef,
      index,
      options,
      source,
      extractor,
      adapterSpec: collected.spec,
    })),
  );

  const outcomes = await Promise.all(tasks);
  reportArticleOutcomes(outcomes, reporter);
  return summarizeDownload(outcomes);
}

async function collectFromListing(
  source: DownloadSource,
  options: DownloadCommandOptions,
  reporter: DownloadReporter,
): Promise<CollectedArticles> {
  const listing = await source.acquireListing();
  reporter.listingAcquired(source.listingDescription, listing);
  assertNotBotChallenge(listing);

  let resolved: Awaited<ReturnType<typeof resolveGenericAdapterSpec>>;
  try {
    resolved = await resolveGenericAdapterSpec(listing, {
      noLlm: options.noLlm,
      refreshAdapter: options.refreshAdapter,
    });
  } catch (resolveError) {
    // The URL did not look like a listing (no repeated article-link clusters).
    // Fall back to treating the fetched page itself as a single article.
    const message = resolveError instanceof Error ? resolveError.message : String(resolveError);
    reporter.listingUnresolved?.(message);
    return { kind: "single-article", page: listing };
  }
  reporter.adapterResolved(resolved);

  const collected = await new GenericLinkCollector({
    maxElapsedMs: options.paginationTimeoutMs,
  }).collectLinks(listing, resolved.spec, options.limit);
  reporter.articlesCollected(collected.links.length, collected.stoppedBecause);
  return { kind: "articles", links: collected.links, spec: resolved.spec };
}

// Below this many links, a listing has likely shown only its first JS-rendered
// batch ("Load more" not followed), so the sitemap is worth checking. Kept low
// so ordinary blogs whose listings paginate fine never pay for a sitemap read.
const SPARSE_LISTING_THRESHOLD = 20;

/**
 * Large corporate listings often defeat link heuristics or expose only a few
 * links, while their sitemap lists every article under the URL. Use the
 * sitemap when the listing is unresolved or sparse and the sitemap has more.
 */
async function collectFromListingOrSitemap(
  source: DownloadSource,
  options: DownloadCommandOptions,
  reporter: DownloadReporter,
): Promise<CollectedArticles> {
  const fromListing = await collectFromListing(source, options, reporter);
  const listingCount = fromListing.kind === "articles" ? fromListing.links.length : 0;
  if (!shouldTrySitemap(source, listingCount, options.limit)) return fromListing;

  reporter.sitemapFallback?.(listingCount);
  try {
    const fromSitemap = await collectFromSitemap(source, options, reporter);
    if (fromSitemap.kind === "articles" && fromSitemap.links.length > listingCount) return fromSitemap;
    reporter.sitemapNotBetter?.();
  } catch (sitemapError) {
    const message = sitemapError instanceof Error ? sitemapError.message : String(sitemapError);
    reporter.sitemapUnavailable?.(message);
  }
  return fromListing;
}

function shouldTrySitemap(source: DownloadSource, listingCount: number, limit: number): boolean {
  if (!source.url || !source.fetchBytes) return false;
  // A site-root scope would pull every page on the site, not just articles.
  if (new URL(source.url).pathname.replace(/\/+$/, "") === "") return false;
  return listingCount < Math.min(limit, SPARSE_LISTING_THRESHOLD);
}

async function collectFromSitemap(
  source: DownloadSource,
  options: DownloadCommandOptions,
  reporter: DownloadReporter,
): Promise<CollectedArticles> {
  if (!source.url || !source.fetchBytes) {
    throw new Error("--sitemap requires a URL (it cannot be combined with --active-tab)");
  }
  const discovered = await discoverArticlesFromSitemap(source.url, source.fetchBytes, {
    sitemapUrl: typeof options.sitemap === "string" ? options.sitemap : undefined,
    since: options.since,
    limit: options.limit,
  });
  reporter.sitemapDiscovered?.(discovered);
  const stoppedBecause = discovered.inScopeEntries > discovered.links.length ? "limit" : "complete";
  reporter.articlesCollected(discovered.links.length, stoppedBecause);
  return { kind: "articles", links: discovered.links, spec: ARTICLE_ONLY_SPEC };
}

async function skipAlreadyDownloaded(
  links: readonly ArticleRef[],
  outputDir: string,
  reporter: DownloadReporter,
): Promise<ArticleRef[]> {
  const downloaded = await readDownloadedSources(outputDir);
  const pending = links.filter((link) => !downloaded.has(link.url));
  const skipped = links.length - pending.length;
  if (skipped > 0) reporter.alreadyDownloadedSkipped?.(skipped);
  return pending;
}

async function downloadSingleArticle(
  page: PageAnalysisInput,
  options: DownloadCommandOptions,
  extractor: ReadabilityArticleExtractor,
  reporter: DownloadReporter,
): Promise<DownloadResult> {
  const articleRef: ArticleRef = { url: page.finalUrl };
  reporter.singleArticleFallback?.();

  reporter.articlesCollected(1, "complete");
  try {
    const parsed = await extractor.extractArticle({
      url: articleRef.url,
      finalUrl: page.finalUrl,
      html: page.html,
    }, ARTICLE_ONLY_SPEC);
    const { markdown } = convertHtmlToMarkdown(parsed.bodyHtml, articleRef.url);
    await writeArticle(options.output, parsed.metadata, markdown);
    const outcome: ArticleDownloadOutcome = { status: "saved", articleRef };
    reportArticleOutcomes([outcome], reporter);
    return summarizeDownload([outcome]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome: ArticleDownloadOutcome = { status: "failed", articleRef, error: message };
    reportArticleOutcomes([outcome], reporter);
    return summarizeDownload([outcome]);
  }
}

async function acquireArticleThroughExtension(
  extensionFetcher: ExtensionFetcher,
  articleUrl: string,
): Promise<PageAnalysisInput> {
  const page = await extensionFetcher.fetch(articleUrl);
  return {
    requestedUrl: articleUrl,
    finalUrl: page.finalUrl,
    status: page.status,
    html: page.html,
    source: "rendered",
    renderMode: "always",
  };
}

async function downloadArticleSafely(args: {
  articleRef: ArticleRef;
  index: number;
  options: DownloadCommandOptions;
  source: DownloadSource;
  extractor: ReadabilityArticleExtractor;
  adapterSpec: AdapterSpec;
}): Promise<ArticleDownloadOutcome> {
  const {
    articleRef,
    index,
    options,
    source,
    extractor,
    adapterSpec,
  } = args;

  try {
    await downloadOneArticle(articleRef, index, options, source.acquireArticle, extractor, adapterSpec);
    return { status: "saved", articleRef };
  } catch (downloadError) {
    const message = downloadError instanceof Error ? downloadError.message : String(downloadError);
    return { status: "failed", articleRef, error: message };
  }
}

function reportArticleOutcomes(
  outcomes: readonly ArticleDownloadOutcome[],
  reporter: DownloadReporter,
): void {
  outcomes.forEach((outcome, index) => {
    const completed = index + 1;
    if (outcome.status === "saved") {
      reporter.articleSaved(completed, outcomes.length, outcome.articleRef.titleHint ?? outcome.articleRef.url);
      return;
    }
    reporter.articleFailed(completed, outcomes.length, outcome.articleRef.url, outcome.error);
  });
}

async function downloadOneArticle(
  articleRef: ArticleRef,
  index: number,
  options: DownloadCommandOptions,
  acquireArticle: ArticleAcquirer,
  extractor: ReadabilityArticleExtractor,
  adapterSpec: AdapterSpec,
): Promise<void> {
  await applyPerArticleDelay(index, options.delay);

  const page = await acquireArticle(articleRef.url);
  assertArticlePageOk(page);
  const parsed = await extractor.extractArticle({
    url: articleRef.url,
    finalUrl: page.finalUrl,
    html: page.html,
    metadataHints: { title: articleRef.titleHint },
  }, adapterSpec);
  const { markdown } = convertHtmlToMarkdown(parsed.bodyHtml, articleRef.url);
  await writeArticle(options.output, parsed.metadata, markdown);
}

async function applyPerArticleDelay(index: number, delayMilliseconds: number): Promise<void> {
  if (delayMilliseconds > 0 && index > 0) {
    await sleep(delayMilliseconds);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
