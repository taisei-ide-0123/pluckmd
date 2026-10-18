#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { downloadCommand } from "./commands/download.js";
import { inspectCommand } from "./commands/inspect.js";
import { loginCommand } from "./commands/login.js";
import { setupCommand } from "./commands/setup.js";

const program = new Command();
const DEFAULT_DOWNLOAD_LIMIT = 100;
const DEFAULT_PAGINATION_TIMEOUT_MS = 5 * 60 * 1000;

program
  .name("pluckmd")
  .description("Bulk download blog articles as Markdown files")
  .version("0.1.1");

program
  .command("download [url]")
  .description("Download articles from a blog/magazine URL")
  .option("-o, --output <dir>", "Output directory", "./articles")
  .option("-c, --concurrency <n>", "Parallel downloads", parsePositiveInteger, 2)
  .option("--delay <ms>", "Delay between requests (ms)", parseNonNegativeInteger, 500)
  .option("--limit <n>", "Max articles to download", parsePositiveInteger, DEFAULT_DOWNLOAD_LIMIT)
  .option(
    "--pagination-timeout <ms>",
    "Max time to spend collecting paginated listing links (ms)",
    parsePositiveInteger,
    DEFAULT_PAGINATION_TIMEOUT_MS,
  )
  .option("--no-llm", "Disable LLM fallback for generic extraction")
  .option("--render <mode>", "Generic extraction render mode: auto, never, always", parseRenderMode, "auto")
  .option("--refresh-adapter", "Bypass cached generic adapter specs")
  .option("--active-tab", "Use the current Chrome tab through the pluckmd extension as the listing page")
  .option("--sitemap [url]", "Discover articles from the site's sitemap (scoped to the URL path) instead of the listing page")
  .option("--since <date>", "With --sitemap, only articles modified on or after this date (YYYY-MM-DD)", parseDate)
  .action(async (url: string, opts: DownloadCliOptions) => {
    await downloadCommand(url, {
      output: opts.output,
      concurrency: opts.concurrency,
      delay: opts.delay,
      limit: opts.limit,
      paginationTimeoutMs: opts.paginationTimeout,
      noLlm: opts.llm === false,
      render: opts.render,
      refreshAdapter: Boolean(opts.refreshAdapter),
      activeTab: Boolean(opts.activeTab),
      sitemap: opts.sitemap,
      since: opts.since,
    });
  });

program
  .command("inspect [url]")
  .description("Inspect generic adapter resolution for a listing URL")
  .option("--explain", "Show resolution details", true)
  .option("--no-llm", "Disable LLM fallback")
  .option("--render <mode>", "Render mode: auto, never, always", parseRenderMode, "auto")
  .option("--refresh-adapter", "Bypass cached adapter specs")
  .option("--active-tab", "Inspect the current Chrome tab through the pluckmd extension")
  .option("--agent-request [file]", "Write an agent-readable adapter request when LLM configuration is missing")
  .option("--adapter-spec <file>", "Validate and cache an agent-written AdapterSpec JSON file")
  .action(async (url: string, opts: InspectCliOptions) => {
    await inspectCommand(url, {
      explain: Boolean(opts.explain),
      noLlm: opts.llm === false,
      render: opts.render,
      refreshAdapter: Boolean(opts.refreshAdapter),
      activeTab: Boolean(opts.activeTab),
      agentRequest: opts.agentRequest,
      adapterSpec: opts.adapterSpec,
    });
  });

program
  .command("login <url>")
  .description("Open any login URL in the persistent pluckmd browser profile")
  .action(async (url: string) => {
    await loginCommand(url);
  });

program
  .command("setup")
  .description("Install AI agent skills (Claude Code, Codex, Cursor, etc.)")
  .option(
    "--agent <type>",
    "Agent type: claude-code, agents, all",
    "all",
  )
  .option("--target <dir>", "Target directory for AGENTS.md", ".")
  .action(async (opts: Record<string, string>) => {
    await setupCommand({
      agent: opts.agent as "claude-code" | "agents" | "all",
      target: opts.target,
    });
  });

try {
  await program.parseAsync();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("playwright") || message.includes("Executable doesn't exist")) {
    console.error("\n❌ Playwright is not installed or Chromium is missing.");
    console.error("   Run: npx playwright install chromium\n");
  } else {
    console.error(`\n❌ ${message}\n`);
  }
  process.exit(1);
}

interface DownloadCliOptions {
  output: string;
  concurrency: number;
  delay: number;
  limit: number;
  paginationTimeout: number;
  llm?: boolean;
  render: "auto" | "never" | "always";
  refreshAdapter?: boolean;
  activeTab?: boolean;
  sitemap?: boolean | string;
  since?: Date;
}

interface InspectCliOptions {
  explain?: boolean;
  llm?: boolean;
  render: "auto" | "never" | "always";
  refreshAdapter?: boolean;
  activeTab?: boolean;
  agentRequest?: string | boolean;
  adapterSpec?: string;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return parsed;
}

function parseRenderMode(value: string): "auto" | "never" | "always" {
  if (value === "auto" || value === "never" || value === "always") return value;
  throw new InvalidArgumentError("render mode must be one of: auto, never, always");
}

function parseDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidArgumentError("must be a date such as 2025-01-01");
  }
  return parsed;
}
