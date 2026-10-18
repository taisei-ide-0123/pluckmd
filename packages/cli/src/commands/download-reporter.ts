import type { LinkCollectionResult, PageAnalysisInput } from "@pluckmd/shared";
import type { DownloadResult } from "./download-result.js";
import type { GenericResolveResult } from "../core/generic-resolver.js";
import type { SitemapDiscoveryResult } from "../core/sitemap-discovery.js";

export interface DownloadReporter {
  sourceSelected(label: string): void;
  listingAcquired(description: string | undefined, input: PageAnalysisInput): void;
  adapterResolved(result: GenericResolveResult): void;
  articlesCollected(total: number, stoppedBecause: LinkCollectionResult["stoppedBecause"]): void;
  articleSaved(completed: number, total: number, title: string): void;
  articleFailed(completed: number, total: number, url: string, error: string): void;
  listingUnresolved?(reason: string): void;
  sitemapFallback?(listingCount: number): void;
  sitemapNotBetter?(): void;
  sitemapUnavailable?(reason: string): void;
  singleArticleFallback?(): void;
  sitemapDiscovered?(result: SitemapDiscoveryResult): void;
  alreadyDownloadedSkipped?(count: number): void;
  finished(result: DownloadResult): void;
}

export class ConsoleDownloadReporter implements DownloadReporter {
  sourceSelected(label: string): void {
    console.log(`🔍 Adapter: ${label}\n`);
  }

  listingAcquired(description: string | undefined, input: PageAnalysisInput): void {
    if (description) {
      console.log(`   ${description}: ${input.finalUrl}`);
    }
  }

  adapterResolved(result: GenericResolveResult): void {
    console.log(`   Source: ${result.source}`);
    console.log(`   Links: ${result.validation.uniqueUrlCount}`);
    console.log(`   Pagination: ${result.spec.pagination.method}\n`);
  }

  articlesCollected(total: number, stoppedBecause: LinkCollectionResult["stoppedBecause"]): void {
    console.log(`📋 ${total} articles to download (stopped: ${stoppedBecause})\n`);
  }

  articleSaved(completed: number, total: number, title: string): void {
    this.reportArticleProgress("✅", completed, total, title);
  }

  articleFailed(completed: number, total: number, url: string, error: string): void {
    this.reportArticleProgress("❌", completed, total, `${url}: ${error}`);
  }

  listingUnresolved(reason: string): void {
    console.log(`ℹ️  Listing not resolved (${reason})`);
  }

  sitemapFallback(listingCount: number): void {
    const reason = listingCount === 0 ? "No articles from the listing" : `Listing returned only ${listingCount} articles`;
    console.log(`🗺️  ${reason}; checking the site's sitemap for more under this URL\n`);
  }

  sitemapNotBetter(): void {
    console.log("   Sitemap had no more articles; keeping the listing results\n");
  }

  sitemapUnavailable(reason: string): void {
    console.log(`   Sitemap unavailable: ${reason}`);
  }

  singleArticleFallback(): void {
    console.log("   Falling back to single-article extraction\n");
  }

  sitemapDiscovered(result: SitemapDiscoveryResult): void {
    console.log(`   Sitemaps read: ${result.sitemapUrls.length}`);
    console.log(`   URLs in sitemap: ${result.totalEntries}`);
    console.log(`   Articles under this URL: ${result.inScopeEntries}`);
    if (result.undatedEntriesExcluded > 0) {
      console.log(
        `   ⚠️  ${result.undatedEntriesExcluded} articles have no <lastmod> in the sitemap and were excluded by --since`,
      );
    }
    console.log("");
  }

  alreadyDownloadedSkipped(count: number): void {
    console.log(`⏭️  Skipping ${count} articles already in the output directory\n`);
  }

  finished(result: DownloadResult): void {
    console.log(`\n📊 Result: ${result.succeeded} saved, ${result.failed} failed`);

    if (result.errors.length > 0) {
      console.log("\nFailed articles:");
      for (const entry of result.errors) {
        console.log(`  - ${entry.url}: ${entry.error}`);
      }
      process.exitCode = 1;
    }
  }

  private reportArticleProgress(
    icon: string,
    completed: number,
    total: number,
    message: string,
  ): void {
    console.log(`  ${icon} [${completed}/${total}] ${message}`);
  }
}
