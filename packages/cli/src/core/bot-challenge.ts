import type { PageAnalysisInput } from "@pluckmd/shared";

/**
 * Detects interstitial pages served by bot-protection services instead of the
 * requested content. Without this, a challenge page surfaces as a misleading
 * "heuristics could not resolve" error.
 */

interface ChallengeSignature {
  readonly provider: string;
  readonly markers: readonly RegExp[];
}

const CHALLENGE_SIGNATURES: readonly ChallengeSignature[] = [
  {
    provider: "Cloudflare",
    markers: [/<title>\s*just a moment/i, /cf-browser-verification|challenge-platform|cf_chl_/i],
  },
  {
    provider: "Akamai",
    markers: [/errors\.edgesuite\.net|errors&#46;edgesuite&#46;net/i],
  },
  {
    provider: "DataDome",
    markers: [/captcha-delivery\.com|datadome/i],
  },
  {
    provider: "PerimeterX",
    markers: [/px-captcha|_pxappid/i],
  },
];

const BLOCKING_STATUSES = new Set([401, 403, 429, 503]);

/** Returns the provider name when the page looks like a bot challenge. */
export function detectBotChallenge(page: Pick<PageAnalysisInput, "status" | "html">): string | null {
  if (!BLOCKING_STATUSES.has(page.status)) return null;
  const signature = CHALLENGE_SIGNATURES.find(({ markers }) =>
    markers.some((marker) => marker.test(page.html)),
  );
  return signature?.provider ?? null;
}

/** Throws an actionable error when the listing page is a bot challenge. */
export function assertNotBotChallenge(page: PageAnalysisInput): void {
  const provider = detectBotChallenge(page);
  if (!provider) return;
  throw new Error(
    `${page.finalUrl} returned a ${provider} bot challenge (HTTP ${page.status}) instead of content.\n` +
      "   Open the page in Chrome (with the pluckmd extension enabled) and run:\n" +
      "   pluckmd download --active-tab",
  );
}

/**
 * Rejects error pages fetched for an article, so a 403/challenge body is
 * reported as a failure instead of being saved as "Access Denied.md".
 */
export function assertArticlePageOk(page: PageAnalysisInput): void {
  if (page.status < 400) return;
  const provider = detectBotChallenge(page);
  throw new Error(
    provider
      ? `blocked by ${provider} bot protection (HTTP ${page.status}); try --active-tab`
      : `HTTP ${page.status}`,
  );
}
