import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliArgs = ["--import", "tsx", "packages/cli/src/index.ts"];

interface FixtureServer {
  readonly origin: string;
  close(): Promise<void>;
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()?.();
  }
});

describe("pluckmd CLI fixture E2E", () => {
  it("downloads a paginated local article index as Markdown", async () => {
    const server = await startFixtureServer();
    const outputDir = await makeTempDir("pluckmd-output-");
    const homeDir = await makeTempDir("pluckmd-home-");

    const result = await runPluckmd([
      "download",
      `${server.origin}/blog`,
      "--no-llm",
      "--render",
      "never",
      "--refresh-adapter",
      "--pagination-timeout",
      "10000",
      "--delay",
      "0",
      "--limit",
      "5",
      "-o",
      outputDir,
    ], homeDir);

    expect(result.stdout).toContain("5 articles to download");
    expect(result.stdout).toContain("Result: 5 saved, 0 failed");

    const files = await readdir(outputDir);
    expect(files).toHaveLength(5);

    const firstArticle = await readFile(join(outputDir, "Fixture_Article_1.md"), "utf-8");
    expect(firstArticle).toContain('title: "Fixture Article 1"');
    expect(firstArticle).toContain(`source: ${server.origin}/posts/fixture-1`);
    expect(firstArticle).toContain("This fixture article has deterministic body text number 1.");

    const fifthArticle = await readFile(join(outputDir, "Fixture_Article_5.md"), "utf-8");
    expect(fifthArticle).toContain("This fixture article has deterministic body text number 5.");
  });

  it("switches to the sitemap when the listing exposes only a few articles", async () => {
    const server = await startFixtureServer();
    const outputDir = await makeTempDir("pluckmd-output-");
    const homeDir = await makeTempDir("pluckmd-home-");

    const result = await runPluckmd([
      "download",
      `${server.origin}/news`,
      "--no-llm",
      "--render",
      "never",
      "--refresh-adapter",
      "--delay",
      "0",
      "--limit",
      "50",
      "-o",
      outputDir,
    ], homeDir);

    expect(result.stdout).toContain("Listing returned only 3 articles");
    expect(result.stdout).toContain("Articles under this URL: 8");
    expect(result.stdout).toContain("Result: 8 saved, 0 failed");
    expect(await readdir(outputDir)).toHaveLength(8);
  });

  it("keeps listing results when the listing already satisfies the limit", async () => {
    const server = await startFixtureServer();
    const outputDir = await makeTempDir("pluckmd-output-");
    const homeDir = await makeTempDir("pluckmd-home-");

    const result = await runPluckmd([
      "download",
      `${server.origin}/news`,
      "--no-llm",
      "--render",
      "never",
      "--refresh-adapter",
      "--delay",
      "0",
      "--limit",
      "3",
      "-o",
      outputDir,
    ], homeDir);

    expect(result.stdout).not.toContain("sitemap");
    expect(result.stdout).toContain("Result: 3 saved, 0 failed");
  });

  it("inspects a local fixture without LLM configuration", async () => {
    const server = await startFixtureServer();
    const homeDir = await makeTempDir("pluckmd-home-");

    const result = await runPluckmd([
      "inspect",
      `${server.origin}/blog`,
      "--no-llm",
      "--render",
      "never",
      "--refresh-adapter",
    ], homeDir);

    expect(result.stdout).toContain("Validation: passed");
    expect(result.stdout).toContain("Article links: 3/3");
    expect(result.stdout).toContain("Pagination: next-url");
    expect(result.stdout).toContain("Link preview (5, stopped: complete)");
  });
});

async function runPluckmd(args: readonly string[], homeDir: string): Promise<{ stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    HOME: homeDir,
  };
  delete env.PLUCKMD_LLM_API_KEY;
  delete env.PLUCKMD_LLM_BASE_URL;
  delete env.PLUCKMD_LLM_MODEL;

  return execFileAsync(process.execPath, [...cliArgs, ...args], {
    cwd: process.cwd(),
    env,
  });
}

async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    response.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url === "/blog") {
      response.end(listingPage([1, 2, 3], "/blog/page/2"));
      return;
    }

    if (url === "/blog/page/2") {
      response.end(listingPage([4, 5]));
      return;
    }

    if (url === "/news") {
      response.end(listingPage([1, 2, 3], undefined, "/news/item-"));
      return;
    }

    if (url === "/robots.txt") {
      response.setHeader("Content-Type", "text/plain");
      response.end(`User-agent: *\nSitemap: http://${request.headers.host}/sitemap.xml\n`);
      return;
    }

    if (url === "/sitemap.xml") {
      response.setHeader("Content-Type", "application/xml");
      response.end(newsSitemap(`http://${request.headers.host}`, 8));
      return;
    }

    const match = url.match(/^\/(?:posts\/fixture|news\/item)-(\d+)$/);
    if (match) {
      response.end(articlePage(Number(match[1])));
      return;
    }

    response.statusCode = 404;
    response.end("<main>not found</main>");
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP port");
  }

  cleanupTasks.push(() => closeServer(server));
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function listingPage(ids: readonly number[], nextPath?: string, articlePathPrefix = "/posts/fixture-"): string {
  const links = ids
    .map((id) => `<li><a href="${articlePathPrefix}${id}">Fixture Article ${id}</a></li>`)
    .join("");
  const next = nextPath ? `<a rel="next" href="${nextPath}">Older articles</a>` : "";
  return `<!doctype html>
    <html>
      <head><title>Fixture Blog</title></head>
      <body>
        <main>
          <h1>Fixture Blog</h1>
          <ol class="article-list">${links}</ol>
          ${next}
        </main>
      </body>
    </html>`;
}

function newsSitemap(origin: string, count: number): string {
  const urls = Array.from({ length: count }, (_, index) =>
    `<url><loc>${origin}/news/item-${index + 1}</loc><lastmod>2026-05-${String(index + 1).padStart(2, "0")}</lastmod></url>`,
  ).join("");
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

function articlePage(id: number): string {
  return `<!doctype html>
    <html>
      <head>
        <title>Fixture Article ${id}</title>
        <meta name="author" content="Fixture Author">
      </head>
      <body>
        <main>
          <article>
            <h1>Fixture Article ${id}</h1>
            <time datetime="2026-05-${String(id).padStart(2, "0")}">May ${id}, 2026</time>
            <p>This fixture article has deterministic body text number ${id}.</p>
            <p>It is served by an in-process HTTP server, not a real website.</p>
          </article>
        </main>
      </body>
    </html>`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function makeTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupTasks.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
