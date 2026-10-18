import { mkdir, writeFile, access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArticleMetadata } from "@pluckmd/shared";

const MAX_FILENAME_LENGTH = 100;

function buildFrontmatter(metadata: ArticleMetadata): string {
  const lines = ["---"];
  lines.push(`title: "${metadata.title.replace(/"/g, '\\"')}"`);
  if (metadata.publishedAt) lines.push(`date: ${metadata.publishedAt}`);
  lines.push(`source: ${metadata.url}`);
  if (metadata.author) lines.push(`author: ${metadata.author}`);
  if (metadata.tags?.length) {
    lines.push(`tags: [${metadata.tags.join(", ")}]`);
  }
  lines.push("---");
  return lines.join("\n");
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, MAX_FILENAME_LENGTH);
}

async function findUniquePath(directory: string, baseName: string): Promise<string> {
  let candidate = join(directory, `${baseName}.md`);
  let counter = 1;
  while (true) {
    try {
      await access(candidate);
      counter++;
      candidate = join(directory, `${baseName}-${counter}.md`);
    } catch {
      return candidate;
    }
  }
}

export async function writeArticle(
  outputDir: string,
  metadata: ArticleMetadata,
  markdownBody: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const baseName = sanitizeFilename(metadata.title);
  const filepath = await findUniquePath(outputDir, baseName);

  const frontmatter = buildFrontmatter(metadata);
  const content = `${frontmatter}\n\n# ${metadata.title}\n\n${markdownBody}\n`;

  await writeFile(filepath, content, "utf-8");
  return filepath;
}

/**
 * Collects `source:` URLs from Markdown files already in the output directory,
 * so an interrupted bulk download can resume without re-fetching or writing
 * `-2.md` duplicates.
 */
export async function readDownloadedSources(outputDir: string): Promise<Set<string>> {
  let filenames: string[];
  try {
    filenames = await readdir(outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }

  const sources = await Promise.all(
    filenames
      .filter((filename) => filename.endsWith(".md"))
      .map(async (filename) => readFrontmatterSource(await readFile(join(outputDir, filename), "utf-8"))),
  );
  return new Set(sources.filter((source): source is string => Boolean(source)));
}

function readFrontmatterSource(content: string): string | undefined {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  return frontmatter?.[1].match(/^source:\s*(\S+)\s*$/m)?.[1];
}
