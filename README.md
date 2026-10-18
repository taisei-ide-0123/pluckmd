# pluckmd

[![npm version](https://img.shields.io/npm/v/pluckmd)](https://www.npmjs.com/package/pluckmd)
[![CI](https://github.com/taisei-ide-0123/pluckmd/actions/workflows/ci.yml/badge.svg)](https://github.com/taisei-ide-0123/pluckmd/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Bulk download blog articles as Markdown files. Works with authenticated and paid content.

**[日本語版はこちら / Japanese version below](#pluckmd-日本語)**

## Quick Start

```bash
# Install globally from npm
npm install -g pluckmd

# Or run directly with npx (no install needed)
npx pluckmd download https://example.com/blog -o ./articles

# Optional: install Playwright for JS-rendered pages
npx playwright install chromium
```

```bash
# Download articles from a listing page
pluckmd download https://example.com/blog -o ./articles

# Inspect how pluckmd resolves selectors for a page
pluckmd inspect https://example.com/blog --no-llm

# Log in when a site requires authentication
pluckmd login https://example.com/login
```

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/taisei-ide-0123/pluckmd.git
cd pluckmd
npm install
npm run build
npm link -w packages/cli
```
</details>

## Demo

![pluckmd download demo](docs/demo.gif)

pluckmd also ships with [AI agent skills](#ai-agent-skills) for Claude Code, Codex, Cursor, and more. Ask your agent to collect articles and build a knowledge base:

```
> Collect articles from https://example.com/blog and build a wiki
```

## How It Works

```
┌──────────────────────────────────────────────────┐
│                   pluckmd CLI                    │
│                                                  │
│  URL → AdapterSpec → Fetcher → Converter → Writer│
│                     │                            │
│            ┌────────┴────────┐                   │
│            │                 │                   │
│     ExtensionFetcher   RenderingPageAcquirer     │
│     (Chrome tab)       (fetch / Playwright)      │
│            │                 │                   │
│     Active session     Generic rendering         │
└──────────────────────────────────────────────────┘
```

By default, pluckmd resolves a runtime AdapterSpec with cache, heuristics, and
optional agent/LLM assistance. Use `--active-tab` when you want to read from the
current Chrome session through the extension.

## Commands

### `pluckmd download <url>`

Download all articles from a listing page.

| Flag | Description | Default |
|------|-------------|---------|
| `-o, --output <dir>` | Output directory | `./articles` |
| `-c, --concurrency <n>` | Parallel downloads | `2` |
| `--delay <ms>` | Delay between requests | `500` |
| `--limit <n>` | Max articles to download | `100` |
| `--pagination-timeout <ms>` | Max time to spend collecting paginated listing links | `300000` |
| `--no-llm` | Disable LLM fallback for generic extraction | off |
| `--render <mode>` | `auto`, `never`, `always` for generic extraction | `auto` |
| `--refresh-adapter` | Bypass cached generic adapter specs | off |
| `--active-tab` | Use the current Chrome tab through the pluckmd extension as the listing page | off |
| `--sitemap [url]` | Discover articles from the site's sitemap, scoped to the URL path, newest first | off |
| `--since <date>` | With `--sitemap`, only articles whose `<lastmod>` is on or after this date | off |

The download path uses runtime-generated AdapterSpecs rather than source-code
site adapters.

Re-running `download` into the same output directory skips articles whose
`source:` URL is already saved, so large downloads can be resumed.

#### Large sites: `--sitemap`

Many publisher sites only show a few articles behind a JavaScript "Load more"
button, but list every article in their sitemap. `--sitemap` reads
`robots.txt` → sitemap (including sitemap indexes and `.gz`), keeps URLs under
the path you passed, and downloads the newest first:

```bash
# The 200 most recent BCG publications
pluckmd download https://www.bcg.com/publications --sitemap --limit 200

# Only articles updated since 2025
pluckmd download https://example.com/blog --sitemap --since 2025-01-01 --limit 1000
```

Without `--sitemap`, `download` still checks the sitemap automatically when the
listing cannot be resolved or yields fewer than `min(--limit, 20)` articles
(typical of "Load more" listings), and uses it if it finds more. Site-root URLs
are excluded from this fallback, since their sitemap covers every page.

#### Bot-protected sites

If a site answers with a bot-protection challenge (Cloudflare, Akamai, ...),
pluckmd switches that host to your installed Google Chrome (launched off-screen
with a separate `~/.pluckmd/chrome-profile-chrome` profile), waits for the
challenge to clear, and fetches pages and sitemaps from there. Requires Google
Chrome; challenge pages are never saved as articles.

### `pluckmd inspect <url>`

Inspect how pluckmd resolves a generic adapter for a listing page.

```bash
pluckmd inspect https://example.com/blog --explain
pluckmd inspect https://example.com/blog --no-llm --render=never
pluckmd inspect https://example.com/blog --refresh-adapter
pluckmd inspect --active-tab --no-llm
```

| Flag | Description | Default |
|------|-------------|---------|
| `--explain` | Show cache, heuristic, LLM, and validation details | on |
| `--no-llm` | Heuristics only; fail if unresolved | off |
| `--render <mode>` | `auto`, `never`, `always` | `auto` |
| `--refresh-adapter` | Re-analyze and ignore cached specs | off |
| `--active-tab` | Inspect the current Chrome tab through the pluckmd extension | off |
| `--agent-request [file]` | Write an agent-readable adapter request when LLM config is missing | auto path |
| `--adapter-spec <file>` | Validate and cache an agent-written AdapterSpec JSON file | off |

`inspect` reports render source, selected selectors, validation results,
pagination mode, and a link preview.

## Chrome Extension

The extension connects automatically to a CLI-hosted localhost relay while a
pluckmd command is running. The CLI never reads Chrome cookies directly, and the
extension returns rendered HTML only for the requested page or the active tab.

Setup:

1. Open `chrome://extensions`, enable Developer mode, and load
   `packages/extension` as an unpacked extension.
2. Run `pluckmd inspect --active-tab --no-llm` or
   `pluckmd download --active-tab`.
3. If Chrome has suspended the extension service worker, reload the extension in
   `chrome://extensions` and run the command again.

The relay listens on `127.0.0.1:7432` by default. Set `PLUCKMD_PORT` before
running the CLI if that port is unavailable. The popup is only a status/manual
connect fallback; the normal workflow does not require token entry.

The extension is intended to be used locally as an unpacked extension. Chrome
Web Store distribution is not required for the normal workflow; if a packaged
distribution is added later, the local relay and permission model should be
reviewed again.

Security and privacy notes:

- The extension asks for broad host access because the CLI may request pages
  from arbitrary article sites. It only sends rendered HTML to a local pluckmd
  CLI relay while a command is running.
- The relay binds to `127.0.0.1` and is intended for local use only. Do not
  expose `PLUCKMD_PORT` through a tunnel or public network interface.
- Set `PLUCKMD_EXTENSION_ID=<chrome-extension-id>` to restrict relay
  connections to one installed extension ID. This is recommended for long-lived
  local setups.
- The CLI does not read browser cookie stores directly. Authenticated access is
  delegated to the active Chrome session or the persistent Playwright profile.
- Downloading paid or private content may be subject to site terms. pluckmd
  provides tooling; users are responsible for using it within their rights.

### `pluckmd login <url>`

Open any login URL in the persistent pluckmd browser profile.

### `pluckmd setup`

Install AI agent skills for building knowledge bases from downloaded articles.

| Flag | Description | Default |
|------|-------------|---------|
| `--agent <type>` | `claude-code`, `agents`, `all` | `all` |
| `--target <dir>` | Directory for AGENTS.md | `.` |

## Generic Extraction

pluckmd is moving from source-code site adapters toward runtime-generated
adapter specs. The target is broad support for common blogs, CMS pages,
newsletters, and article indexes without hardcoded selectors.

Pluckmd does not guarantee automatic extraction for every website. The important
point is that support is not limited to a fixed list of hardcoded sites: unknown
sites are handled by an agentic loop that observes the page, proposes an
AdapterSpec, validates it against the live DOM, executes pagination, and caches
the validated result. Sites with heavy bot protection, unusual navigation, or
inaccessible content may still require login, active-tab rendering,
agent/LLM-assisted spec generation, or a manually edited cached spec.

Resolution order:

1. Validate and reuse a cached adapter spec when available.
2. Run deterministic heuristics for repeated article links, content regions, and pagination.
3. Ask an agent or OpenAI-compatible LLM to select or refine candidates when heuristics are insufficient.
4. Mechanically validate the resulting selectors before use or cache.
5. Execute pagination with scroll and experimental click candidates, accepting a click only when it changes article links, URL, or DOM structure.

LLM configuration:

```bash
export PLUCKMD_LLM_API_KEY=...
export PLUCKMD_LLM_BASE_URL=https://api.openai.com/v1
export PLUCKMD_LLM_MODEL=...
```

Agent-assisted workflow:

When `PLUCKMD_LLM_*` is not set and heuristics cannot resolve a page, `inspect`
writes an agent request JSON under `~/.pluckmd/agent-requests/`. Ask Claude
Code, Codex, or another coding agent to read that file and produce the
suggested AdapterSpec JSON. Then validate and cache it:

```bash
pluckmd inspect https://example.com/blog --adapter-spec ~/.pluckmd/agent-requests/example.com__blog.adapter-spec.json
```

Cached adapter specs are stored under the pluckmd config directory in
`adapters/*.json`. They are revalidated before use and stale or corrupt entries
fall back to fresh analysis.

## Architecture

```
pluckmd/
  packages/
    shared/       # Fetcher interface, protocol types, config
    cli/          # npm package — download, login, setup commands
    extension/    # Chrome Extension — active-tab bridge
  skills/
    claude-code/  # Skills for Claude Code (/pluckmd-wiki, /pluckmd-slides)
    agents/       # AGENTS.md for Codex, Cursor, Windsurf, etc.
```

### Auth Backends

The `Fetcher` interface abstracts HTML acquisition:

```typescript
interface Fetcher {
  fetch(url: string): Promise<{ html: string; finalUrl: string; status: number }>;
  close(): Promise<void>;
}
```

- **ExtensionFetcher** — Starts a localhost WebSocket relay and waits for the Chrome Extension to connect automatically.
- **RenderingPageAcquirer** — Acquires static or rendered pages without domain-specific code.
- **Generic pipeline** — Resolves, validates, caches, and executes AdapterSpecs at runtime.

## Output Format

```markdown
---
title: "Article Title"
date: 2026-01-15
source: https://example.com/blog/article
author: Author Name
tags: [tag1, tag2]
---

# Article Title

Article content in Markdown...
```

## AI Agent Skills

pluckmd ships with skills that let AI agents build structured knowledge bases and interactive slides from downloaded articles.

### Setup

```bash
pluckmd setup                                # All agents
pluckmd setup --agent claude-code            # Claude Code only
pluckmd setup --agent agents --target ./dir  # Codex / Cursor / Windsurf
```

### Included Skills

| Skill | Description |
|-------|-------------|
| **pluckmd-wiki** | Build and maintain an LLM Wiki (init / ingest / query / lint / status) |
| **pluckmd-slides** | Generate interactive HTML slide decks with SVG diagrams |

### Claude Code

```
/pluckmd-wiki init ./my-project
/pluckmd-wiki ingest --batch 10
/pluckmd-wiki query "What is Agility?"
/pluckmd-slides wiki/concepts/agility
```

### Codex / Cursor / Windsurf

Place `AGENTS.md` in your project root. The agent will automatically recognize the skills:

```bash
codex "initialize the wiki and ingest the first 10 articles"
```

## Example Workflow

```bash
# 1. Download articles
pluckmd download https://example.com/blog -o ./project/raw

# 2. Install skills
pluckmd setup --target ./project

# 3. Build knowledge base with your AI agent
#    /pluckmd-wiki init ./project
#    /pluckmd-wiki ingest --batch 10
#    /pluckmd-slides wiki/concepts/key-concept
```

## Development

See [Quick Start](#quick-start) for setup. After cloning:

```bash
npm install
npm run build
npm link -w packages/cli   # makes `pluckmd` command available globally
```

## License

MIT

---

# pluckmd (日本語)

ブログ記事をMarkdownファイルとして一括ダウンロード。認証が必要な有料コンテンツにも対応。

## クイックスタート

```bash
# npmからグローバルインストール
npm install -g pluckmd

# またはnpxで直接実行（インストール不要）
npx pluckmd download https://example.com/blog -o ./articles

# オプション: JS描画が必要なページ用にPlaywrightをインストール
npx playwright install chromium
```

```bash
# 記事を一括ダウンロード
pluckmd download https://example.com/blog -o ./articles

# セレクタの解析結果を確認
pluckmd inspect https://example.com/blog --no-llm

# ログインが必要な場合
pluckmd login https://example.com/login
```

<details>
<summary>ソースからインストール</summary>

```bash
git clone https://github.com/taisei-ide-0123/pluckmd.git
cd pluckmd
npm install
npm run build
npm link -w packages/cli
```
</details>

## デモ

![pluckmd download デモ](docs/demo.gif)

pluckmdはClaude Code、Codex、Cursorなど向けの[AIエージェントスキル](#aiエージェントスキル)も同梱しています。エージェントに話しかけるだけで記事収集からWiki構築まで実行できます：

```
> https://example.com/blog から記事を集めてWikiを構築して
```

## 仕組み

```
┌──────────────────────────────────────────────────┐
│                   pluckmd CLI                    │
│                                                  │
│  URL → AdapterSpec → Fetcher → Converter → Writer│
│                     │                            │
│            ┌────────┴────────┐                   │
│            │                 │                   │
│     ExtensionFetcher   RenderingPageAcquirer     │
│    （Chromeタブ）      （fetch / Playwright）     │
│            │                 │                   │
│     現在のセッション   汎用レンダリング           │
└──────────────────────────────────────────────────┘
```

デフォルトでは cache、heuristics、必要に応じた agent/LLM 支援で
runtime AdapterSpec を解決します。現在のChromeセッションを使う場合は
`--active-tab` を指定します。

## コマンド

### `pluckmd download <url>`

一覧ページから記事をダウンロード。取得数は `--limit` とページネーション停止条件に従います。

| フラグ | 説明 | デフォルト |
|--------|------|-----------|
| `-o, --output <dir>` | 出力ディレクトリ | `./articles` |
| `-c, --concurrency <n>` | 並列ダウンロード数 | `2` |
| `--delay <ms>` | リクエスト間隔 | `500` |
| `--limit <n>` | 最大記事数 | `100` |
| `--pagination-timeout <ms>` | ページネーションされた一覧リンク収集の最大時間 | `300000` |

### `pluckmd login <url>`

任意のログインURLを永続 pluckmd ブラウザプロファイルで開きます。

## Chrome Extension

Extension は CLI 実行中に localhost relay へ自動接続します。CLI が Chrome
Cookie を直接読むことはなく、Extension は要求されたページまたは active tab
のHTMLだけを返します。

セットアップ:

1. `chrome://extensions` を開き、Developer mode を有効にして
   `packages/extension` を unpacked extension として読み込む。
2. `pluckmd inspect --active-tab --no-llm` または
   `pluckmd download --active-tab` を実行する。
3. Chrome が Extension service worker を停止している場合は、`chrome://extensions`
   で pluckmd Bridge を Reload してから再実行する。

relay はデフォルトで `127.0.0.1:7432` を使います。ポートを変える場合は CLI
実行前に `PLUCKMD_PORT` を指定します。popup は状態確認と手動接続用のfallbackで、
通常フローでは token 入力は不要です。

Extension はローカルの unpacked extension として使う想定です。通常フローでは
Chrome Web Store 配布は不要です。将来 packaged distribution を追加する場合は、
local relay と permission model を改めてレビューしてください。

セキュリティとプライバシー:

- Extension は未知の記事サイトに対応するため `http/https` の広い host
  permission を要求しますが、CLI実行中の local relay に対して要求された
  HTMLだけを返します。
- relay は `127.0.0.1` にのみbindされる前提です。`PLUCKMD_PORT` を tunnel
  や公開ネットワークに露出しないでください。
- `PLUCKMD_EXTENSION_ID=<chrome-extension-id>` を指定すると、relay への接続を
  特定のExtension IDに制限できます。
- 有料・非公開コンテンツの取得や再配布は、利用者自身が権利とサイト規約を
  確認したうえで行ってください。

### `pluckmd setup`

AIエージェント向けスキルをインストール。

| フラグ | 説明 | デフォルト |
|--------|------|-----------|
| `--agent <type>` | `claude-code`, `agents`, `all` | `all` |
| `--target <dir>` | AGENTS.mdの配置先 | `.` |

## 汎用抽出

pluckmd は source-code に書いたサイト別 adapter ではなく、runtime に生成される
AdapterSpec を使う方向に寄せています。目的は、固定された対応サイト一覧だけに
閉じず、一般的なブログ、CMS、ニュースレター、記事一覧ページへ広く対応することです。

ただし、全サイトの自動抽出を保証するものではありません。重要なのは、対応が
ハードコードされた特定サイトに限定されていないことです。未知サイトでは、
ページを観察し、AdapterSpec を提案し、live DOM で検証し、ページネーションを実行し、
検証済み結果を cache する agentic なループで対応します。bot protection が強い、
ナビゲーションが特殊、コンテンツにアクセスできない、といった場合は、ログイン、
active tab rendering、agent/LLM による spec 生成、または手動編集した cache spec が
必要になることがあります。

解決順序:

1. cache 済み AdapterSpec を検証して再利用する。
2. 記事リンク、本文領域、ページネーションの繰り返し構造を heuristics で解析する。
3. heuristics だけで足りない場合は agent または OpenAI-compatible LLM で候補を選択・補正する。
4. 生成された selector を使用前または cache 前に機械的に検証する。
5. scroll と実験的な click candidate を使い、記事リンク、URL、DOM構造が変化した操作だけを採用する。

## アーキテクチャ

```
pluckmd/
  packages/
    shared/       # Fetcherインターフェース、プロトコル型、設定
    cli/          # npmパッケージ — download, login, setupコマンド
    extension/    # Chrome Extension — active-tab bridge
  skills/
    claude-code/  # Claude Code用スキル（/pluckmd-wiki, /pluckmd-slides）
    agents/       # Codex, Cursor, Windsurf等向けAGENTS.md
```

### 認証バックエンド

`Fetcher` インターフェースがHTML取得を抽象化:

- **ExtensionFetcher** — localhost WebSocket relay を起動し、Chrome Extensionの自動接続を待機
- **RenderingPageAcquirer** — ドメイン固有コードなしで static/rendered page を取得
- **Generic pipeline** — AdapterSpec を runtime に解決、検証、cache、実行

## 出力形式

```markdown
---
title: "記事タイトル"
date: 2026-01-15
source: https://example.com/blog/article
author: 著者名
tags: [タグ1, タグ2]
---

# 記事タイトル

Markdownに変換された記事本文...
```

## AIエージェントスキル

pluckmdは記事のダウンロードだけでなく、取得した記事から構造化されたナレッジベースやインタラクティブなスライドを構築するAIエージェント向けスキルを同梱しています。

### セットアップ

```bash
pluckmd setup                                # 全エージェント
pluckmd setup --agent claude-code            # Claude Codeのみ
pluckmd setup --agent agents --target ./dir  # Codex / Cursor / Windsurf
```

### 同梱スキル

| スキル | 機能 |
|--------|------|
| **pluckmd-wiki** | LLM Wiki構築・運用（init / ingest / query / lint / status） |
| **pluckmd-slides** | SVG図解付きインタラクティブHTMLスライド生成 |

### Claude Codeでの使い方

```
/pluckmd-wiki init ./my-project
/pluckmd-wiki ingest --batch 10
/pluckmd-wiki query "Agilityとは何か"
/pluckmd-slides wiki/concepts/agility
```

### Codex / Cursor / Windsurf での使い方

`AGENTS.md` をプロジェクトルートに配置すれば、エージェントが自動的にスキルを認識:

```bash
codex "wikiを初期化して、最初の10記事をインジェストして"
```

## ワークフロー例

```bash
# 1. 記事をダウンロード
pluckmd download https://example.com/blog -o ./project/raw

# 2. スキルをセットアップ
pluckmd setup --target ./project

# 3. AIエージェントでWiki構築（Claude Codeの場合）
#    /pluckmd-wiki init ./project
#    /pluckmd-wiki ingest --batch 10
#    /pluckmd-slides wiki/concepts/key-concept
```

## 開発

[クイックスタート](#クイックスタート)を参照。クローン後:

```bash
npm install
npm run build
npm link -w packages/cli   # pluckmd コマンドをグローバルに利用可能にする
```

## ライセンス

MIT
