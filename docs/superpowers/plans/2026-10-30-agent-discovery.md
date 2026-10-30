# Agent discovery and SEO plan

**Goal:** Help search engines and AI agents find Understory explainers quickly.

**Branch:** `seo/agent-discovery`.

## Constraints

- Public routes read only published revisions; no selection score, skipped, or draft data leaks.
- Cloudflare-managed AI-training blocks in robots.txt stay untouched (they are prepended at the edge).
- IndexNow is off unless `INDEXNOW_KEY` is set. A ping failure never fails a publish.
- No new dependencies.

## Tasks

1. **`/llms.txt`**: Markdown index: site summary, key links (`/api/articles`, `/feed.xml`, `/sitemap.xml`, `/llms-full.txt`), then published explainers grouped by topic with title, URL, and dek. Cached 900s.
2. **`/llms-full.txt`**: Plain text for the newest 50 explainers: headline, URL, source URL, TL;DR, section headings and paragraph text. Cached 900s.
3. **Sitemap and robots dates**: Article `lastmod` comes from the published revision's `reviewed_at` (fallback `published_at`), not `articles.updated_at`, which pipeline jobs touch. robots.txt gains an `llms.txt` pointer comment.
4. **JSON-LD**: Article adds `dateModified`, `mainEntityOfPage`, `image`, `inLanguage`, `publisher.logo`, `about` (topic), and a `BreadcrumbList`. The homepage adds `WebSite` and `Organization`.
5. **IndexNow**: The pipeline pings `https://api.indexnow.org/indexnow` with the article URL after auto-publish, as does admin approval. Serve the key at `/<INDEXNOW_KEY>.txt` from the web Worker. Fire-and-forget through `waitUntil` where available; 5s timeout; errors swallowed and logged.

## Verification

- Vitest route tests for each new route and behavior.
- `npm run check` and `npm run build`.
