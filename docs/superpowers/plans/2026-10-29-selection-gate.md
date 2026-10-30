# Selection Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic gate after extraction that scores whether a source has enough mechanism to justify an explainer, skips low-value and same-source duplicate posts, records the score and reason, and ranks the feed lead by score.

**Architecture:** A pure module in `src/domain/selection.ts` owns scoring, URL classification, title normalization, and duplicate matching. `runExtractJob` calls it after the snapshot is saved, then writes the score and either skips or continues to generation through the existing lease-fenced `setArticleStatus`. D1 gains three nullable/defaulted columns, a duplicate requeue helper, a skipped-articles list, and score-first lead ordering. An audit script recomputes scores from stored snapshots without changing publication state.

**Tech Stack:** TypeScript strict, Cloudflare Workers, D1, Hono JSX, Vitest, Node `node:sqlite`, `tsx`, Wrangler.

**Spec:** `docs/superpowers/specs/2026-10-29-selection-gate-design.md`

## Global Constraints

- The gate is deterministic. No extra model call, no model-based classifier.
- Score threshold is `SELECTION_MIN_SCORE = 45`. The score is additive and clamped to 0-100.
- Same-source duplicate window is 14 days. Duplicate matching is title-token based and keeps the earliest article as the survivor.
- Docs, reference, and archive URLs are force-skipped unless the title contains a mechanism term. Release and podcast URLs receive a penalty but can still generate.
- `SELECTION_ENFORCE` defaults to false. The checked-in config stays `"false"`; flipping it is a separate rollout step after the production audit.
- Existing published articles are not unpublished, noindexed, or rewritten. The audit may backfill selection columns only.
- No changes to `src/pipeline/prompt.ts`, `src/domain/explanation.ts`, generation prompts, or the generated-explanation schema.
- Migrations are append-only. Add `migrations/0002_selection.sql`; do not rewrite `0001_init.sql`.
- TypeScript strict, `noUncheckedIndexedAccess`, no new dependencies.
- Public routes, API, RSS, and cache behavior must not expose selection scores or skipped articles.
- Admin continues to use the existing `admin-table` and `admin-queue` classes. No redesign.
- Use GitButler for checkpoints: `but diff` then `but commit -b selection-gate -m "<message>" <ids>`. Pass only the IDs for the files named in the task. Do not commit `.serena/`, `docs/architecture.*`, or unrelated work.
- Run focused tests red then green in each task. Final gate is `npm run check` and `npm run build`.

## Review Focus

These are the input classes most likely to break the promise. Each has a test in the task that owns the code.

1. **A release-word title on a real mechanism post** — e.g. "How we redesigned the release pipeline". It must generate, not be skipped by the title penalty. Tested in Task 2.
2. **A docs or archive URL with code and length** — e.g. an API reference page with ten code blocks. It must not pass on structure alone. Tested in Task 2.
3. **A duplicate whose survivor is later skipped, fails, or is rejected** — the duplicate must come back exactly once, not disappear. Tested in Task 4 and Task 7.
4. **A stale extraction worker after lease replacement** — it must not write a score, skip a live article, or requeue anyone. Tested in Task 3 and Task 7.
5. **Existing published rows with score 0 and an empty 14-day window** — lead behavior must remain newest-first until the audit backfills scores. Tested in Task 5.

---

### Task 1: Schema and article selection fields

**Files:**
- Create: `migrations/0002_selection.sql`
- Modify: `src/domain/article.ts:13-32`
- Modify: `src/infrastructure/db.ts:15-34` (`ArticleRow`) and `src/infrastructure/db.ts:77-98` (`mapArticle`)
- Modify: `tests/helpers/sqlite.ts:1-8`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: existing `sqliteDb()` and `seed()` test helpers.
- Produces: `Article` gains `selectionScore: number`, `selectionReason: string | null`, `duplicateOf: string | null`.
- Produces: `sqliteDb()` loads every `migrations/*.sql` file in lexical order, so later migrations are exercised by every DB test.

- [ ] **Step 1: Write the failing migration test**

Add to `tests/db.test.ts` inside a new `describe("schema", ...)` block:

```ts
it("loads every migration and adds selection columns", () => {
  const db = setup();
  const columns = db.sqlite.prepare("PRAGMA table_info(articles)").all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(["selection_score", "selection_reason", "duplicate_of"]),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db.test.ts -t "loads every migration"`
Expected: FAIL because `selection_score` is not in the current schema.

- [ ] **Step 3: Create the migration**

Create `migrations/0002_selection.sql` with exactly:

```sql
ALTER TABLE articles ADD COLUMN selection_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN selection_reason TEXT;
ALTER TABLE articles ADD COLUMN duplicate_of TEXT;

CREATE INDEX articles_lead_idx
  ON articles (status, selection_score DESC, published_at DESC);

CREATE INDEX articles_selection_idx
  ON articles (status, selection_score);
```

- [ ] **Step 4: Load every migration in the SQLite helper**

In `tests/helpers/sqlite.ts`, replace the single `readFileSync("../../migrations/0001_init.sql")` line with:

```ts
import { readFileSync, readdirSync } from "node:fs";
// ...
const migrations = readdirSync(new URL("../../migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
for (const name of migrations) {
  sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
}
```

Do not wrap the loop in `try/catch`. A broken migration must fail the suite.

- [ ] **Step 5: Add the fields to the domain type and row mapper**

In `src/domain/article.ts`, add to `Article`:

```ts
selectionScore: number;
selectionReason: string | null;
duplicateOf: string | null;
```

In `src/infrastructure/db.ts`, add to `ArticleRow`:

```ts
selection_score: number;
selection_reason: string | null;
duplicate_of: string | null;
```

In `mapArticle`, add:

```ts
selectionScore: row.selection_score,
selectionReason: row.selection_reason,
duplicateOf: row.duplicate_of,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/db.test.ts -t "loads every migration"`
Expected: PASS. Then run `npx vitest run tests/db.test.ts` and expect all existing DB tests to pass with the extra columns.

- [ ] **Step 7: Commit**

```bash
but diff
but commit -b selection-gate -m "feat(selection): add selection columns and migration loading" <ids>
```

Pass only the IDs for `migrations/0002_selection.sql`, `src/domain/article.ts`, `src/infrastructure/db.ts`, `tests/helpers/sqlite.ts`, and `tests/db.test.ts`.

---

### Task 2: Pure scorer, URL classifier, and duplicate matching

**Files:**
- Create: `src/domain/selection.ts`
- Test: `tests/selection.test.ts`

**Interfaces:**
- Consumes: `SourceBlock` from `src/domain/source.ts`.
- Produces:
  - `SelectionInput = { title: string; url: string; blocks: SourceBlock[]; wordCount: number }`
  - `SelectionDecision = { score: number; decision: "generate" | "skip"; reasons: string[]; signals: Record<string, number> }`
  - `SELECTION_MIN_SCORE: 45`, `SELECTION_DUPLICATE_WINDOW_DAYS: 14`, `LEAD_WINDOW_DAYS: 14`
  - `classifyUrl(url: string): "article" | "docs" | "archive" | "release" | "podcast"`
  - `scoreSource(input: SelectionInput): SelectionDecision`
  - `normalizeTitle(title: string): string[]`
  - `isNearDuplicate(a: string, b: string): boolean`
  - `DuplicateCandidate = { id: string; originalTitle: string; slug: string; publishedAt: string }`
  - `findDuplicate(title: string, candidates: DuplicateCandidate[]): DuplicateCandidate | null`
  - `duplicateWindowStart(publishedAt: string, windowDays?: number): string`
  - `formatSelectionReason(reasons: string[]): string`
  - `MECHANISM_TERMS: readonly string[]`, `TITLE_MECHANISM_TERMS: readonly string[]`, `PROMOTIONAL_PHRASES: readonly string[]`, `RELEASE_TITLE_PATTERN: RegExp`

- [ ] **Step 1: Write the failing scorer tests**

Create `tests/selection.test.ts` with a block helper and the following tests. Use decisions and reason matches, not exact scores, except where the boundary itself is the behavior.

```ts
import { describe, expect, it } from "vitest";
import type { SourceBlock } from "../src/domain/source";
import {
  duplicateWindowStart,
  findDuplicate,
  formatSelectionReason,
  isNearDuplicate,
  scoreSource,
} from "../src/domain/selection";

function blocks(spec: Array<{ kind?: SourceBlock["kind"]; text: string }>): SourceBlock[] {
  return spec.map((block, index) => ({
    id: `b${index + 1}`,
    kind: block.kind ?? "paragraph",
    text: block.text,
    sourceUrl: "https://example.com/post",
    headingPath: [],
  }));
}
function words(count: number): string {
  return Array.from({ length: count }, () => "word").join(" ");
}

it("generates for a mechanism-heavy post", () => {
  const result = scoreSource({
    title: "How we rebuilt the query planner",
    url: "https://example.com/blog/query-planner",
    wordCount: 1200,
    blocks: blocks([
      { kind: "heading", text: "Why the old planner failed" },
      { kind: "heading", text: "Latency and throughput" },
      { kind: "heading", text: "The cache and index design" },
      { text: "We measured 42% lower latency at 1200 req/s and 35 ms p99." },
      { kind: "code", text: "SELECT * FROM t WHERE id = 1" },
      { kind: "code", text: "EXPLAIN ANALYZE SELECT * FROM t" },
      ...Array.from({ length: 6 }, () => ({ text: words(80) })),
    ]),
  });
  expect(result.decision).toBe("generate");
  expect(result.score).toBeGreaterThanOrEqual(45);
});

it("skips a release note with no mechanism evidence", () => {
  const result = scoreSource({
    title: "Introducing Node.js 26.13.0",
    url: "https://example.com/blog/introducing-node-js-26-13-0",
    wordCount: 350,
    blocks: blocks([{ text: words(350) }]),
  });
  expect(result.decision).toBe("skip");
  expect(result.score).toBeLessThan(45);
  expect(result.reasons.join(" ")).toMatch(/release/i);
});

it("halves the release-title penalty when the title names a mechanism", () => {
  const result = scoreSource({
    title: "How we redesigned the release pipeline",
    url: "https://example.com/blog/release-pipeline-design",
    wordCount: 1200,
    blocks: blocks([
      { kind: "heading", text: "The old pipeline" },
      { kind: "heading", text: "Queue and cache design" },
      { kind: "heading", text: "Latency results" },
      { text: "We measured 42% lower latency at 1200 req/s and 35 ms p99." },
      { kind: "code", text: "const queue = new Queue()" },
      { kind: "code", text: "await queue.drain()" },
      ...Array.from({ length: 6 }, () => ({ text: words(80) })),
    ]),
  });
  expect(result.decision).toBe("generate");
  expect(result.reasons.join(" ")).toMatch(/release/i);
});

it("force-skips docs and archive URLs without a mechanism title", () => {
  const signalRich = blocks([
    { kind: "heading", text: "Request" },
    { kind: "heading", text: "Response" },
    { kind: "heading", text: "Errors" },
    { kind: "code", text: "GET /v1/items" },
    { kind: "code", text: "POST /v1/items" },
    { kind: "code", text: "DELETE /v1/items/:id" },
    ...Array.from({ length: 8 }, () => ({ text: words(100) })),
  ]);
  expect(scoreSource({
    title: "API reference",
    url: "https://example.com/docs/api",
    wordCount: 2000,
    blocks: signalRich,
  }).decision).toBe("skip");
  expect(scoreSource({
    title: "Notes from the team",
    url: "https://example.com/tags/notes",
    wordCount: 2000,
    blocks: signalRich,
  }).decision).toBe("skip");
});

it("allows a docs page whose title names a mechanism", () => {
  const result = scoreSource({
    title: "How the scheduler works",
    url: "https://example.com/docs/scheduler",
    wordCount: 1200,
    blocks: blocks([
      { kind: "heading", text: "Queue and latency" },
      { kind: "heading", text: "Retry design" },
      { kind: "heading", text: "Failure handling" },
      { text: "We measured 42% lower latency at 1200 req/s and 35 ms p99." },
      { kind: "code", text: "schedule(task)" },
      { kind: "code", text: "await run(task)" },
      ...Array.from({ length: 6 }, () => ({ text: words(80) })),
    ]),
  });
  expect(result.decision).toBe("generate");
});

it("skips podcasts, roundups, promotional pages, and thin posts", () => {
  expect(scoreSource({
    title: "The Changelog Podcast: Episode 42",
    url: "https://example.com/podcast/42",
    wordCount: 500,
    blocks: blocks([{ text: words(500) }]),
  }).decision).toBe("skip");

  expect(scoreSource({
    title: "Weekly roundup: ten links",
    url: "https://example.com/blog/roundup",
    wordCount: 300,
    blocks: blocks([{ text: words(300) }]),
  }).decision).toBe("skip");

  expect(scoreSource({
    title: "The industry-leading platform",
    url: "https://example.com/blog/platform",
    wordCount: 400,
    blocks: blocks([{
      text: "We are excited about this best-in-class, world-class, seamless platform. Unlock what is possible.",
    }]),
  }).decision).toBe("skip");

  expect(scoreSource({
    title: "A short note",
    url: "https://example.com/blog/note",
    wordCount: 300,
    blocks: blocks([{ text: words(300) }]),
  }).decision).toBe("skip");
});
```

Add duplicate tests:

```ts
it("treats generic titles as non-duplicates", () => {
  expect(isNearDuplicate("Weekly update", "Weekly update")).toBe(false);
});

it("matches same-source near-duplicate titles", () => {
  expect(isNearDuplicate(
    "Introducing the Vercel AI SDK 5",
    "Vercel AI SDK 5 is now available",
  )).toBe(true);
  expect(isNearDuplicate("Vercel AI SDK 5", "Vercel edge runtime")).toBe(false);
});

it("returns the earliest duplicate candidate", () => {
  const duplicate = findDuplicate("Vercel AI SDK 5", [
    { id: "new", originalTitle: "Vercel AI SDK 5 is now available", slug: "new", publishedAt: "2026-10-28T00:00:00.000Z" },
    { id: "old", originalTitle: "Introducing the Vercel AI SDK 5", slug: "old", publishedAt: "2026-10-27T00:00:00.000Z" },
  ]);
  expect(duplicate?.id).toBe("old");
});

it("computes the duplicate window start", () => {
  expect(duplicateWindowStart("2026-10-29T12:00:00.000Z")).toBe("2026-10-15T12:00:00.000Z");
  expect(formatSelectionReason(["a", "b", "c", "d"])).toBe("a; b; c");
  expect(formatSelectionReason(["x".repeat(600)])).toHaveLength(500);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/selection.test.ts`
Expected: FAIL because `src/domain/selection.ts` does not exist.

- [ ] **Step 3: Implement `src/domain/selection.ts`**

Use the exact constants and rules below.

```ts
import type { SourceBlock } from "./source";

export type SelectionInput = {
  title: string;
  url: string;
  blocks: SourceBlock[];
  wordCount: number;
};

export type SelectionDecision = {
  score: number;
  decision: "generate" | "skip";
  reasons: string[];
  signals: Record<string, number>;
};

export type UrlKind = "article" | "docs" | "archive" | "release" | "podcast";

export const SELECTION_MIN_SCORE = 45;
export const SELECTION_DUPLICATE_WINDOW_DAYS = 14;
export const LEAD_WINDOW_DAYS = 14;

export const MECHANISM_TERMS = [
  "design", "architecture", "internals", "implementation", "mechanism",
  "pipeline", "protocol", "scheduler", "cache", "index", "migration",
  "consensus", "sharding", "query planner", "runtime", "compiler",
  "storage engine", "consistency", "concurrency", "latency", "throughput",
  "failure", "retry", "backpressure", "partitioning", "replication",
  "coordination", "serialization", "garbage collection", "transaction",
  "lock", "queue",
] as const;

// Title-only mechanism words for the release-note exception. Keep "how" and
// similar words out of MECHANISM_TERMS so they do not count as body evidence.
export const TITLE_MECHANISM_TERMS: readonly string[] = [
  ...MECHANISM_TERMS, "how", "inside", "scaling", "debugging", "lessons",
];

export const PROMOTIONAL_PHRASES = [
  "we are excited", "best-in-class", "world-class", "industry-leading",
  "cutting-edge", "revolutionary", "game-changing", "seamless", "unlock",
  "empower", "trusted by",
] as const;

export const RELEASE_TITLE_PATTERN =
  /\b(release[sd]?|releasing|changelog|what'?s new|now available|general availability|ga|beta|preview|launch(?:ed|es)?|announc(?:e|ed|ing)|introduc(?:e|ed|ing)|unveil(?:ed)?|ships?|rolled out|podcast|episode|webinar|roundup|weekly|newsletter|forrester|gartner|award|recognized|strong performer)\b/i;
```

URL classification:

```ts
export function classifyUrl(url: string): UrlKind {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // Keep the raw string for malformed URLs.
  }
  if (/\/(docs|documentation|reference|manual)(\/|$)/.test(pathname)) return "docs";
  if (/\/(tags?|categories?|archive)(\/|$)/.test(pathname)) return "archive";
  if (/\/(changelog|release-notes|releases|announcements)(\/|$)/.test(pathname)) return "release";
  if (/\/(podcast|podcasts|episodes?|webinars?)(\/|$)/.test(pathname)) return "podcast";
  return "article";
}
```

Scoring algorithm:

1. Start at 50.
2. Count `codeCount` = blocks with `kind === "code"`.
3. Count `headingCount` = blocks with `kind === "heading"`.
4. Count `metricCount` from all block text with:
   `/(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|minutes?|hours?|days?|kb|mb|gb|tb|pb|req\/s|rps|qps|million|billion)|\$\s?\d|€\s?\d)/gi`
5. Count distinct mechanism terms in `title + all heading text` with case-insensitive word-boundary matching. Count distinct mechanism terms in `title + all block text` for the no-evidence check. Escape each term with a small local `escapeRegExp` helper before building the `RegExp`.
6. Count promotional phrase occurrences in all block text, case-insensitively.
7. Apply negative signals first, in this order:
   - release title: `-30`, or `-15` when the title contains a term from `TITLE_MECHANISM_TERMS`;
   - docs URL: `-30`; archive URL: `-25`; release or podcast URL: `-20`;
   - promotional density `>= 3` per 1,000 words: `-20` (use `count / Math.max(wordCount, 1) * 1000`);
   - word count `< 500`: `-15`;
   - `codeCount === 0 && metricCount === 0 && mechanismCountAll === 0`: `-15`.
8. Apply positive signals:
   - word count `1500+`: `+15`; `800-1499`: `+10`;
   - `codeCount >= 3`: `+15`; `codeCount` 1-2: `+10`;
   - `metricCount >= 3`: `+10`;
   - at least two distinct mechanism terms in title or headings: `+10`;
   - `headingCount >= 3`: `+5`;
   - `blocks.length >= 10`: `+5`.
9. Clamp to `0..100`.
10. `forcedSkip` is true when the URL kind is `docs` or `archive` and the title has no term from `MECHANISM_TERMS`.
11. `decision` is `"skip"` when `forcedSkip` or `score < SELECTION_MIN_SCORE`; otherwise `"generate"`.
12. Push one human-readable reason per applied signal, for example `"release/announcement title (-30)"`, `"docs/reference URL (-30)"`, `"350 words (-15)"`, `"no code, metrics, or mechanism terms (-15)"`, `"1200 words (+10)"`. When `forcedSkip`, unshift `"docs/reference URL"` or `"archive/tag URL"`.
13. Set `signals.forcedSkip = forcedSkip ? 1 : 0`.

Normalization and duplicates:

```ts
const TITLE_STOPWORDS = new Set([
  "introducing", "announcing", "now", "available", "new", "update", "release",
  "general", "beta", "the", "a", "an", "on", "in", "for", "with", "via", "to",
  "of", "and", "is", "are", "we", "our", "how", "what", "why",
]);

export function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !TITLE_STOPWORDS.has(token))
    .filter((token) => !/^v?\d+(?:\.\d+)*$/.test(token));
}
```

`isNearDuplicate` uses sets and returns true when either:

- `shared >= 3 && shared / Math.min(left.size, right.size) >= 0.8`, or
- `shared >= 4 && shared / (left.size + right.size - shared) >= 0.6`.

If either normalized set is empty, return false.

`findDuplicate` sorts candidates by `publishedAt` ascending (invalid dates treated as `0`), then `id` ascending, and returns the first `isNearDuplicate` match or `null`.

`duplicateWindowStart` parses `publishedAt`, falls back to `Date.now()` when invalid, subtracts `(windowDays ?? SELECTION_DUPLICATE_WINDOW_DAYS) * 86_400_000`, and returns an ISO string.

`formatSelectionReason` joins the first three reasons with `"; "` and slices to 500 characters. It returns `""` for an empty array.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/selection.test.ts`
Expected: PASS. If a decision is wrong, adjust the fixture, not the decision assertion or the rubric weights, until the behavior matches the rubric.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
but diff
but commit -b selection-gate -m "feat(selection): add deterministic scorer and dedupe rules" <ids>
```

Pass only the IDs for `src/domain/selection.ts` and `tests/selection.test.ts`.

---

### Task 3: Fenced selection writes and duplicate candidate query

**Files:**
- Modify: `src/infrastructure/db.ts:415-440` (after `listReviewQueue` or near the pipeline writes) and `src/infrastructure/db.ts:777-791` (`setArticleStatus`)
- Modify: `tests/helpers/sqlite.ts` (add `seedPublished`)
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: `Article`, `Job`, `PublishedArticle`, `selectionScore` fields from Task 1.
- Produces:

```ts
export type ArticleSelection = {
  score: number;
  reason: string | null;
  duplicateOf: string | null;
};

export async function setArticleStatus(
  db: D1Database,
  articleId: string,
  status: Article["status"],
  error: string | null,
  lease: Job,
  selection?: ArticleSelection,
): Promise<boolean>;

export type RecentSourceArticle = {
  id: string;
  originalTitle: string;
  slug: string;
  publishedAt: string;
  status: string;
};

export async function listRecentSourceArticles(
  db: D1Database,
  sourceId: string,
  articleId: string,
  since: string,
): Promise<RecentSourceArticle[]>;
```

- Produces: `seedPublished(db, input)` test helper for Tasks 3-6. Signature:

```ts
export function seedPublished(
  db: ReturnType<typeof sqliteDb>,
  input: {
    id: string;
    slug?: string;
    originalTitle?: string;
    publishedAt: string;
    selectionScore?: number;
    duplicateOf?: string | null;
    sourceId?: string;
  },
): void;
```

It inserts a source with `INSERT OR IGNORE` (the default `source` and the explicit `other-source` in Task 3 already exist), then an article with `status = 'published'`, a matching snapshot, and a published revision. Defaults: `slug = id`, `originalTitle = "Article " + id`, `selectionScore = 0`, `duplicateOf = null`, `sourceId = "source"`, canonical URL `https://example.com/<id>`, `discoveredAt = publishedAt`, and published date as given. Set `published_revision_id = revision_<id>`. Use per-article ids (`snapshot_<id>`, `revision_<id>`) and a per-article `source_hash` so repeated calls do not collide. Set `content_json = JSON.stringify(explanation)` and `provenance_json = '{}'`; the revision needs `model_id`, `prompt_version`, and `schema_version` strings.

- [ ] **Step 1: Add the `seedPublished` helper**

Implement it in `tests/helpers/sqlite.ts` using direct `sqlite.prepare(...).run(...)` calls. Use `explanation` for the revision `content_json`, `'{}'` for provenance, and `model`/`prompt`/`schema` strings. This helper is test support, not production code. Add `seedPublished` to the `./helpers/sqlite` import in `tests/db.test.ts`.

- [ ] **Step 2: Write the failing selection-write test**

Add to `tests/db.test.ts`:

```ts
it("writes selection fields only through a live lease", async () => {
  const db = setup();
  const job = await lease(db);

  expect(await setArticleStatus(db.db, "article", "generating", null, job, {
    score: 62,
    reason: "1200 words (+10)",
    duplicateOf: null,
  })).toBe(true);
  expect(db.sqlite.prepare(
    "SELECT status, selection_score, selection_reason, duplicate_of FROM articles",
  ).get()).toMatchObject({
    status: "generating",
    selection_score: 62,
    selection_reason: "1200 words (+10)",
    duplicate_of: null,
  });

  db.sqlite.exec("UPDATE jobs SET lease_expires_at = '2000-01-01'");
  expect(await setArticleStatus(db.db, "article", "skipped", "stale", job, {
    score: 99,
    reason: "stale",
    duplicateOf: "other",
  })).toBe(false);
  expect(db.sqlite.prepare("SELECT status, selection_score FROM articles").get()).toMatchObject({
    status: "generating",
    selection_score: 62,
  });
});
```

- [ ] **Step 3: Write the failing candidate-query test**

Add `listRecentSourceArticles` to the `../src/infrastructure/db` import in `tests/db.test.ts`, then add:

```ts
it("returns viable same-source articles inside the duplicate window, excluding the current article", async () => {
  const db = setup();
  db.sqlite.prepare(
    "INSERT INTO sources (id, name, site_url, host) VALUES ('other-source', 'Other', 'https://other.example', 'other.example')",
  ).run();
  seedPublished(db, { id: "recent", originalTitle: "Vercel AI SDK 5", publishedAt: "2026-10-28T00:00:00.000Z" });
  seedPublished(db, { id: "old", originalTitle: "Old post", publishedAt: "2026-09-01T00:00:00.000Z" });
  seedPublished(db, { id: "other", originalTitle: "Other source", publishedAt: "2026-10-28T00:00:00.000Z", sourceId: "other-source" });

  const rows = await listRecentSourceArticles(
    db.db,
    "source",
    "article",
    "2026-10-15T00:00:00.000Z",
  );
  expect(rows.map((row) => row.id)).toEqual(["recent"]);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/db.test.ts -t "selection fields|viable same-source"`
Expected: FAIL. `setArticleStatus` currently returns `void`; `listRecentSourceArticles` does not exist.

- [ ] **Step 5: Implement the fenced selection write**

In `setArticleStatus`, add the optional `selection` parameter. Build the update so the three selection assignments are appended only when `selection` is present:

```sql
UPDATE articles SET status = ?, last_error = ?, updated_at = ?
  , selection_score = ?, selection_reason = ?, duplicate_of = ?
WHERE id = ? AND id = ? AND status != 'published' AND published_revision_id IS NULL
  AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND lease_token = ? AND article_id = ?
    AND state = 'running'
    AND lease_expires_at > MAX(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
```

Keep the existing `CURRENT_LEASE_SQL` and the status-specific `review`/`failed` clauses unchanged; the expanded `EXISTS` above is only the shape of that constant. Bind `selection.score`, `selection.reason`, `selection.duplicateOf` between `updated_at` and `articleId` only when present. Return `(result.meta.changes ?? 0) > 0`. Do not change the behavior of callers that omit `selection`.

- [ ] **Step 6: Implement `listRecentSourceArticles`**

Use exactly this query, mapping snake_case to the camelCase return type:

```sql
SELECT id, original_title, slug, published_at, status
FROM articles
WHERE source_id = ?
  AND id != ?
  AND published_at >= ?
  AND status IN ('discovered', 'extracting', 'generating', 'review', 'published')
ORDER BY published_at DESC, id DESC
LIMIT 50
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS. Existing `setArticleStatus` callers still compile because the new parameter is optional.

- [ ] **Step 8: Commit**

```bash
but diff
but commit -b selection-gate -m "feat(selection): fence selection writes and add duplicate candidates" <ids>
```

Pass only the IDs for `src/infrastructure/db.ts`, `tests/helpers/sqlite.ts`, and `tests/db.test.ts`.

---

### Task 4: Requeue skipped duplicates when the survivor retires

**Files:**
- Modify: `src/infrastructure/db.ts` (add `requeueDuplicates` near the pipeline writes; call it from `rejectRevision`)
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: `articles.duplicate_of`, `articles.status`, the deterministic `extract:<articleId>` job key from `insertArticle`, and `rejectRevision`'s existing article lookup by revision id.
- Produces: `requeueDuplicates(db: D1Database, survivorId: string): Promise<number>` returning the number of duplicate rows moved back to `discovered`.
- Produces: `rejectRevision` keeps its `Promise<boolean>` signature and requeues the rejected article's skipped duplicates when the rejection succeeds.

- [ ] **Step 1: Write the failing requeue test**

Add `requeueDuplicates` to the `../src/infrastructure/db` import in `tests/db.test.ts`, then add:

```ts
it("requeues skipped duplicates exactly once when their survivor is retired", async () => {
  const db = setup();
  db.sqlite.exec(`
    INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, selection_score, selection_reason, duplicate_of)
    VALUES ('dup', 'source', 'https://example.com/dup', 'Widget now available', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'dup', 'skipped', 20, 'duplicate of article', 'article');
    INSERT INTO jobs (id, kind, article_id, payload_json, state, attempts, idempotency_key, next_run_at)
    VALUES ('job_extract_dup', 'extract', 'dup', '{}', 'done', 1, 'extract:dup', '2026-10-28T00:00:00.000Z');
  `);

  expect(await requeueDuplicates(db.db, "article")).toBe(1);
  expect(db.sqlite.prepare(
    "SELECT status, selection_score, selection_reason, duplicate_of FROM articles WHERE id = 'dup'",
  ).get()).toMatchObject({
    status: "discovered",
    selection_score: 0,
    selection_reason: null,
    duplicate_of: null,
  });
  expect(db.sqlite.prepare(
    "SELECT state, attempts, lease_token FROM jobs WHERE id = 'job_extract_dup'",
  ).get()).toMatchObject({ state: "pending", attempts: 0, lease_token: null });

  expect(await requeueDuplicates(db.db, "article")).toBe(0);
  expect(db.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'extract' AND article_id = 'dup'",
  ).get()?.n).toBe(1);
});

it("leaves unrelated skipped articles alone", async () => {
  const db = setup();
  db.sqlite.exec(`
    INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
    VALUES ('unrelated', 'source', 'https://example.com/unrelated', 'Unrelated', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'unrelated', 'skipped', NULL);
  `);
  expect(await requeueDuplicates(db.db, "article")).toBe(0);
  expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'unrelated'").get()?.status).toBe("skipped");
});

it("requeues skipped duplicates when a draft is rejected", async () => {
  const db = setup();
  seedRevision(db);
  db.sqlite.exec(`
    INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
    VALUES ('dup', 'source', 'https://example.com/dup', 'Widget now available', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'dup', 'skipped', 'article');
    INSERT INTO jobs (id, kind, article_id, payload_json, state, attempts, idempotency_key, next_run_at)
    VALUES ('job_extract_dup', 'extract', 'dup', '{}', 'done', 1, 'extract:dup', '2026-10-28T00:00:00.000Z');
  `);

  expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(true);
  expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({
    status: "discovered",
    duplicate_of: null,
  });
  expect(db.sqlite.prepare("SELECT state FROM jobs WHERE id = 'job_extract_dup'").get()?.state).toBe("pending");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db.test.ts -t "requeues skipped duplicates|leaves unrelated"`
Expected: FAIL because `requeueDuplicates` is not exported.

- [ ] **Step 3: Implement `requeueDuplicates`**

Select up to 50 rows:

```sql
SELECT id FROM articles
WHERE duplicate_of = ? AND status = 'skipped'
ORDER BY discovered_at ASC
LIMIT 50
```

For each id, run one batch with two statements:

1. `UPDATE articles SET status = 'discovered', duplicate_of = NULL, selection_score = 0, selection_reason = NULL, updated_at = ? WHERE id = ? AND status = 'skipped' AND duplicate_of = ?`
2. Upsert the extract job with the deterministic id and key:

```sql
INSERT INTO jobs (id, kind, article_id, payload_json, idempotency_key, next_run_at, state, attempts)
VALUES (?, 'extract', ?, '{}', ?, ?, 'pending', 0)
ON CONFLICT (idempotency_key) DO UPDATE SET
  state = 'pending',
  attempts = 0,
  lease_token = NULL,
  lease_expires_at = NULL,
  next_run_at = excluded.next_run_at,
  last_error = NULL,
  updated_at = excluded.next_run_at
```

The update binds `now`, `id`, and `survivorId`. The upsert binds `job_extract_<id>`, `id`, `extract:<id>`, and the same `now`. Accumulate the first statement's `meta.changes` and return that sum, so a concurrent requeue is not double-counted. Do not select or update `status = 'failed'`, published, or non-duplicate skipped rows.

- [ ] **Step 4: Requeue from `rejectRevision`**

After `rejectRevision`'s existing batch returns, compute `const rejected = (results[0]?.meta.changes ?? 0) > 0;`. If `rejected`, read the article id and status:

```ts
const row = await db
  .prepare(
    `SELECT a.id, a.status
     FROM explanation_revisions r
     JOIN articles a ON a.id = r.article_id
     WHERE r.id = ?`,
  )
  .bind(revisionId)
  .first<{ id: string; status: string }>();
if (row && row.status !== "published") await requeueDuplicates(db, row.id);
```

Return `rejected` instead of the raw expression. Do this only after the rejection batch succeeded; do not requeue when the draft was already approved or rejected, or when the article is still published.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
but diff
but commit -b selection-gate -m "feat(selection): requeue skipped duplicates when survivors retire" <ids>
```

Pass only the IDs for `src/infrastructure/db.ts` and `tests/db.test.ts`.

---

### Task 5: Rank the feed lead by selection score

**Files:**
- Modify: `src/infrastructure/db.ts:180-203` (`getFeedLead`)
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: `Article.selectionScore`, `Article.duplicateOf`, `LEAD_WINDOW_DAYS` from Task 2.
- Produces: no signature change. `getFeedLead(db)` returns the highest-scoring non-duplicate published article inside the 14-day window, tie-breaking by `published_at DESC, id DESC`. If no article is inside the window, it returns the latest published article regardless of score or duplicate flag.

- [ ] **Step 1: Write the failing lead tests**

Add `getFeedLead` to the `../src/infrastructure/db` import in `tests/db.test.ts`, then add:

```ts
it("leads with the highest-scoring recent published article", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
  const db = setup();
  seedPublished(db, { id: "new-low", publishedAt: "2026-10-29T10:00:00.000Z", selectionScore: 20 });
  seedPublished(db, { id: "old-high", publishedAt: "2026-10-20T10:00:00.000Z", selectionScore: 80 });
  seedPublished(db, { id: "ancient", publishedAt: "2026-09-01T10:00:00.000Z", selectionScore: 100 });

  expect((await getFeedLead(db.db))?.id).toBe("old-high");
});

it("falls back to the newest published article when the window is empty", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
  const db = setup();
  seedPublished(db, { id: "older", publishedAt: "2026-09-01T10:00:00.000Z", selectionScore: 100 });
  seedPublished(db, { id: "newer", publishedAt: "2026-09-02T10:00:00.000Z", selectionScore: 0 });

  expect((await getFeedLead(db.db))?.id).toBe("newer");
});

it("breaks lead score ties by newest", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
  const db = setup();
  seedPublished(db, { id: "tie-old", publishedAt: "2026-10-27T10:00:00.000Z", selectionScore: 60 });
  seedPublished(db, { id: "tie-new", publishedAt: "2026-10-28T10:00:00.000Z", selectionScore: 60 });

  expect((await getFeedLead(db.db))?.id).toBe("tie-new");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db.test.ts -t "leads with|falls back to the newest published|breaks lead score"`
Expected: FAIL on the first test because the current query orders by newest.

- [ ] **Step 3: Implement the two-step lead query**

Add `import { LEAD_WINDOW_DAYS } from "../domain/selection";` to `src/infrastructure/db.ts`.

Compute `windowStart = new Date(Date.now() - LEAD_WINDOW_DAYS * 86_400_000).toISOString()`. Use the existing `SELECT a.*, ... JOIN explanation_revisions` projection.

Primary query:

```sql
WHERE a.status = 'published'
  AND a.duplicate_of IS NULL
  AND a.published_at >= ?
ORDER BY a.selection_score DESC, a.published_at DESC, a.id DESC
LIMIT 1
```

If that returns `null`, run the same projection with:

```sql
WHERE a.status = 'published'
ORDER BY a.published_at DESC, a.id DESC
LIMIT 1
```

Map the chosen row once and return it. Do not add `duplicate_of IS NULL` to the fallback; the fallback exists so an empty recent window never returns `null` while published articles exist.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
but diff
but commit -b selection-gate -m "feat(selection): rank the feed lead by selection score" <ids>
```

Pass only the IDs for `src/infrastructure/db.ts` and `tests/db.test.ts`.

---

### Task 6: Show recently skipped articles in the admin desk

**Files:**
- Modify: `src/infrastructure/db.ts` (add `listRecentSkippedArticles` near `listReviewQueue`)
- Modify: `src/web/routes/admin.tsx:6-11` (import) and `src/web/routes/admin.tsx:128-176` (insert the section after the review queue)
- Modify: `tests/security.test.ts:6-12` and `tests/feed.test.ts:5-11` (mock shape)
- Test: `tests/db.test.ts` and new `tests/admin.test.ts`

**Interfaces:**
- Consumes: `articles.selection_score`, `articles.selection_reason`, `articles.updated_at`, `sources.name`.
- Produces:

```ts
export type SkippedArticle = {
  id: string;
  originalTitle: string;
  canonicalUrl: string;
  sourceName: string;
  selectionScore: number;
  selectionReason: string | null;
  skippedAt: string;
};

export async function listRecentSkippedArticles(
  db: D1Database,
  limit = 20,
): Promise<SkippedArticle[]>;
```

The admin surface is a server route, so its route-level test lives in `tests/admin.test.ts`. `tests/frontend.test.ts` is the Playwright component suite and does not exercise this route.

- [ ] **Step 1: Write the failing DB test**

Add `listRecentSkippedArticles` to the `../src/infrastructure/db` import in `tests/db.test.ts`, then add:

```ts
it("lists the most recently skipped articles first", async () => {
  const db = setup();
  db.sqlite.exec(`
    INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, selection_score, selection_reason, updated_at)
    VALUES
      ('skip-old', 'source', 'https://example.com/skip-old', 'Old skip', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'skip-old', 'skipped', 10, 'thin', '2026-10-01T00:00:00.000Z'),
      ('skip-new', 'source', 'https://example.com/skip-new', 'New skip', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'skip-new', 'skipped', 30, 'release', '2026-10-02T00:00:00.000Z');
  `);

  const rows = await listRecentSkippedArticles(db.db, 1);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: "skip-new",
    originalTitle: "New skip",
    sourceName: "Source",
    selectionScore: 30,
    selectionReason: "release",
  });
});
```

- [ ] **Step 2: Write the failing admin route test**

Create `tests/admin.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";

const db = vi.hoisted(() => ({
  approveRevision: vi.fn(),
  getRevisionDetail: vi.fn(),
  listReviewQueue: vi.fn(),
  listRecentSkippedArticles: vi.fn(async () => []),
  rejectRevision: vi.fn(),
}));
vi.mock("../src/infrastructure/db", () => ({
  ...db,
  getSiteState: vi.fn(async () => ({ published: 1, sources: 1, topics: 0, inReview: 0, publicationVersion: "1" })),
  getPublicationVersion: vi.fn(async () => "1"),
}));

const env = {
  ADMIN_TOKEN: "test-token",
  REQUIRE_ACCESS_JWT: "false",
  ENVIRONMENT: "production",
  SITE_NAME: "Understory",
  SITE_URL: "https://example.com",
  DB: {},
  ASSETS: {},
  PIPELINE_QUEUE: {},
} as unknown as Bindings;

function request() {
  return app.fetch(
    new Request("https://example.com/admin", { headers: { authorization: "Bearer test-token" } }),
    env,
    {} as ExecutionContext,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.listReviewQueue.mockResolvedValue([]);
  db.listRecentSkippedArticles.mockResolvedValue([]);
});

describe("admin skipped list", () => {
  it("renders recently skipped posts with score and reason", async () => {
    db.listRecentSkippedArticles.mockResolvedValue([{
      id: "skip-1",
      originalTitle: "Introducing Widget 2.0",
      canonicalUrl: "https://example.com/widget",
      sourceName: "Example",
      selectionScore: 32,
      selectionReason: "release/announcement title (-30)",
      skippedAt: "2026-10-29T00:00:00.000Z",
    }]);

    const html = await (await request()).text();
    expect(html).toContain("Recently skipped");
    expect(html).toContain("Introducing Widget 2.0");
    expect(html).toContain("32");
    expect(html).toContain("release/announcement title (-30)");
    expect(html).toContain("https://example.com/widget");
  });

  it("renders an empty state when nothing has been skipped", async () => {
    const html = await (await request()).text();
    expect(html).toContain("Recently skipped");
    expect(html).toContain("No skipped posts.");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/db.test.ts -t "most recently skipped" tests/admin.test.ts`
Expected: FAIL because `listRecentSkippedArticles` is not exported and the section does not render.

- [ ] **Step 4: Implement the DB list**

Use:

```sql
SELECT a.id, a.original_title, a.canonical_url, s.name AS source_name,
       a.selection_score, a.selection_reason, a.updated_at
FROM articles a
JOIN sources s ON s.id = a.source_id
WHERE a.status = 'skipped'
ORDER BY a.updated_at DESC, a.id DESC
LIMIT ?
```

Clamp `limit` to `1..100` before binding. Map `original_title` to `originalTitle`, `canonical_url` to `canonicalUrl`, `source_name` to `sourceName`, `selection_score` to `selectionScore`, `selection_reason` to `selectionReason`, and `updated_at` to `skippedAt`.

- [ ] **Step 5: Render the admin section**

Import `listRecentSkippedArticles` in `src/web/routes/admin.tsx`. In `renderAdmin`, load it alongside the queue:

```ts
const [queue, skipped] = await Promise.all([
  listReviewQueue(c.env.DB),
  listRecentSkippedArticles(c.env.DB),
]);
```

Insert this section after the review-queue `</section>` and before `<section class="admin-help">`:

```tsx
<section class="admin-queue" aria-labelledby="skipped-title">
  <div class="section-head">
    <h2 id="skipped-title">Recently skipped</h2>
    <span class="section-head__meta">Last 20</span>
  </div>
  {skipped.length === 0 ? (
    <p class="admin-help__fineprint">No skipped posts.</p>
  ) : (
    <div class="admin-table" role="table" aria-label="Recently skipped">
      <div class="admin-table__head" role="row">
        <span role="columnheader">Article</span>
        <span role="columnheader">Source</span>
        <span role="columnheader">Score</span>
        <span role="columnheader">Reason</span>
        <span role="columnheader">Skipped</span>
        <span role="columnheader" />
      </div>
      {skipped.map((article) => (
        <div class="admin-table__row" role="row">
          <span role="cell" class="admin-table__title">{article.originalTitle}</span>
          <span role="cell">{article.sourceName}</span>
          <span role="cell">{article.selectionScore}</span>
          <span role="cell">{article.selectionReason ?? "—"}</span>
          <span role="cell">{relativeDate(article.skippedAt)}</span>
          <span role="cell" class="admin-table__action">
            <a class="text-link" href={article.canonicalUrl} target="_blank" rel="noopener">
              Read source <IconArrowUpRight size={13} />
            </a>
          </span>
        </div>
      ))}
    </div>
  )}
</section>
```

- [ ] **Step 6: Update the route mocks**

Add `listRecentSkippedArticles: vi.fn(async () => [])` to the hoisted DB mock in `tests/security.test.ts` and `tests/feed.test.ts`. The default resolved value matters because `vi.clearAllMocks()` runs between security tests and the admin route awaits the list. Do not change the auth or cache assertions.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/db.test.ts tests/admin.test.ts tests/security.test.ts tests/feed.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
but diff
but commit -b selection-gate -m "feat(admin): show recently skipped articles" <ids>
```

Pass only the IDs for `src/infrastructure/db.ts`, `src/web/routes/admin.tsx`, `tests/db.test.ts`, `tests/admin.test.ts`, `tests/security.test.ts`, and `tests/feed.test.ts`.

---

### Task 7: Wire the gate into extraction and shadow mode

**Files:**
- Modify: `src/shared/env.ts:3-21` (`Bindings`)
- Modify: `src/pipeline/run.ts:169-254` (`runExtractJob`) and `src/pipeline/run.ts:352-360` (terminal generation failure)
- Modify: `wrangler.pipeline.jsonc:38-47` (`vars`)
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes:
  - `scoreSource`, `findDuplicate`, `duplicateWindowStart`, `formatSelectionReason`, `SELECTION_DUPLICATE_WINDOW_DAYS` from Task 2.
  - `setArticleStatus(..., selection)` and `listRecentSourceArticles` from Task 3.
  - `requeueDuplicates` from Task 4.
- Produces: `Bindings.SELECTION_ENFORCE?: string`. The gate runs after `saveSnapshot`, before `setArticleStatus(..., "generating")`.
- Behavior:
  - `skip` + `SELECTION_ENFORCE` true: set `skipped`, record score/reason/duplicate, create no generate job.
  - `skip` + enforcement false: record score/reason/duplicate, then continue to `generating` exactly as today.
  - `generate`: record score/reason/duplicate and continue to `generating`.
  - A duplicate is always a skip decision; it records `duplicate_of` and `reason = "duplicate of <slug>"`.
  - Thin sources below `MIN_SOURCE_WORDS` keep their existing skip, now with `selection_score = 0` and the thin-floor reason.

- [ ] **Step 1: Write the failing pipeline tests**

Add these helpers and tests to `tests/pipeline.test.ts`:

```ts
function snapshotFor(
  blocks: Array<{ kind: SourceBlock["kind"]; text: string }>,
  wordCount: number,
  url: string,
) {
  return {
    articleId: "article",
    title: "Test article",
    url,
    fetchedAt: "2026-10-29T00:00:00.000Z",
    extractorVersion: "test",
    wordCount,
    blocks: blocks.map((block, index) => ({
      id: `b${index + 1}`,
      kind: block.kind,
      text: block.text,
      sourceUrl: url,
      headingPath: [],
    })),
  };
}

async function extractJob(title: string, url: string, wordCount: number, blocks: Array<{ kind: SourceBlock["kind"]; text: string }>) {
  store.sqlite.prepare(
    "UPDATE articles SET status = 'discovered', original_title = ?, canonical_url = ? WHERE id = 'article'",
  ).run(title, url);
  await createJob(store.db, {
    id: "job",
    kind: "extract",
    articleId: "article",
    idempotencyKey: "extract:article",
  });
  mocks.fetchPage.mockResolvedValue({ html: "source", finalUrl: url, status: 200 });
  mocks.extract.mockResolvedValue({
    title,
    author: null,
    summary: null,
    canonicalUrl: null,
    blocks: [],
    wordCount,
    links: [],
  });
  mocks.snapshot.mockReturnValue(snapshotFor(blocks, wordCount, url));
}

function textWords(count: number): string {
  return Array.from({ length: count }, () => "word").join(" ");
}
```

Tests:

```ts
it("skips a release note without creating a generate job when enforcement is on", async () => {
  env.SELECTION_ENFORCE = "true";
  await extractJob(
    "Introducing Widget 2.0",
    "https://example.com/blog/introducing-widget-2-0",
    350,
    [{ kind: "paragraph", text: textWords(350) }],
  );

  expect((await processJob(env, "job")).ok).toBe(true);
  expect(store.sqlite.prepare(
    "SELECT status, selection_score, selection_reason FROM articles",
  ).get()).toMatchObject({ status: "skipped", selection_score: 0 });
  expect(String(store.sqlite.prepare("SELECT selection_reason FROM articles").get()?.selection_reason)).toMatch(/release/i);
  expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
});

it("records a low score but still generates in shadow mode", async () => {
  env.SELECTION_ENFORCE = "false";
  await extractJob(
    "Introducing Widget 2.0",
    "https://example.com/blog/introducing-widget-2-0",
    350,
    [{ kind: "paragraph", text: textWords(350) }],
  );

  await processJob(env, "job");
  expect(store.sqlite.prepare("SELECT status, selection_score FROM articles").get()).toMatchObject({
    status: "generating",
    selection_score: 0,
  });
  expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(1);
});

it("generates a mechanism-heavy post", async () => {
  env.SELECTION_ENFORCE = "true";
  await extractJob(
    "How the query planner works",
    "https://example.com/blog/query-planner",
    1200,
    [
      { kind: "heading", text: "Queue and latency" },
      { kind: "heading", text: "Cache design" },
      { kind: "heading", text: "Retry and failure" },
      { kind: "paragraph", text: "We measured 42% lower latency at 1200 req/s and 35 ms p99." },
      { kind: "code", text: "SELECT * FROM t" },
      { kind: "code", text: "EXPLAIN ANALYZE SELECT * FROM t" },
      ...Array.from({ length: 6 }, () => ({ kind: "paragraph" as const, text: textWords(80) })),
    ],
  );

  await processJob(env, "job");
  expect(store.sqlite.prepare("SELECT status, selection_score FROM articles").get()).toMatchObject({
    status: "generating",
  });
  expect(Number(store.sqlite.prepare("SELECT selection_score FROM articles").get()?.selection_score)).toBeGreaterThanOrEqual(45);
  expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(1);
});

it("skips a near-duplicate and records the survivor", async () => {
  env.SELECTION_ENFORCE = "true";
  seedPublished(store, {
    id: "survivor",
    originalTitle: "Introducing the Vercel AI SDK 5",
    publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  await extractJob(
    "Vercel AI SDK 5 is now available",
    "https://example.com/blog/vercel-ai-sdk-5",
    350,
    [{ kind: "paragraph", text: textWords(350) }],
  );

  await processJob(env, "job");
  expect(store.sqlite.prepare(
    "SELECT status, duplicate_of, selection_reason FROM articles WHERE id = 'article'",
  ).get()).toMatchObject({
    status: "skipped",
    duplicate_of: "survivor",
  });
  expect(String(store.sqlite.prepare("SELECT selection_reason FROM articles WHERE id = 'article'").get()?.selection_reason)).toContain("duplicate of survivor");
});

it("does not write selection when the extract lease is replaced", async () => {
  env.SELECTION_ENFORCE = "true";
  await extractJob(
    "Introducing Widget 2.0",
    "https://example.com/blog/introducing-widget-2-0",
    350,
    [{ kind: "paragraph", text: textWords(350) }],
  );
  mocks.fetchPage.mockImplementationOnce(async () => {
    store.sqlite.exec("UPDATE jobs SET lease_token = 'replacement'; UPDATE articles SET status = 'published', published_revision_id = 'other'");
    return { html: "source", finalUrl: "https://example.com/blog/introducing-widget-2-0", status: 200 };
  });

  await processJob(env, "job");
  expect(store.sqlite.prepare(
    "SELECT status, selection_score, selection_reason FROM articles",
  ).get()).toMatchObject({
    status: "published",
    selection_score: 0,
    selection_reason: null,
  });
});
```

Add the requeue tests:

```ts
it("requeues a skipped duplicate when its survivor is skipped", async () => {
  env.SELECTION_ENFORCE = "true";
  store.sqlite.exec(`
    INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
    VALUES ('dup', 'source', 'https://example.com/dup', 'Widget now available', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'dup', 'skipped', 'article');
    INSERT INTO jobs (id, kind, article_id, payload_json, state, attempts, idempotency_key, next_run_at)
    VALUES ('job_extract_dup', 'extract', 'dup', '{}', 'done', 1, 'extract:dup', '2026-10-28T00:00:00.000Z');
  `);
  await extractJob(
    "Introducing Widget 2.0",
    "https://example.com/blog/introducing-widget-2-0",
    350,
    [{ kind: "paragraph", text: textWords(350) }],
  );

  await processJob(env, "job");
  expect(store.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({
    status: "discovered",
    duplicate_of: null,
  });
  expect(store.sqlite.prepare("SELECT state FROM jobs WHERE id = 'job_extract_dup'").get()?.state).toBe("pending");
});

it("requeues a skipped duplicate when the survivor fails generation terminally", async () => {
  store.sqlite.exec(`
    INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
    VALUES ('dup', 'source', 'https://example.com/dup', 'Widget now available', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'dup', 'skipped', 'article');
    INSERT INTO jobs (id, kind, article_id, payload_json, state, attempts, idempotency_key, next_run_at)
    VALUES ('job_extract_dup', 'extract', 'dup', '{}', 'done', 1, 'extract:dup', '2026-10-28T00:00:00.000Z');
  `);
  await generateJob();
  mocks.generate.mockResolvedValue({
    ok: false,
    explanation: null,
    issues: [{ path: "headline", message: "too long" }],
    rawText: "{}",
    usage: null,
  });

  await processJob(env, "job");
  expect(store.sqlite.prepare("SELECT status FROM articles WHERE id = 'dup'").get()?.status).toBe("discovered");
});

it("requeues a skipped duplicate when extraction fails terminally", async () => {
  store.sqlite.exec(`
    INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
    VALUES ('dup', 'source', 'https://example.com/dup', 'Widget now available', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'dup', 'skipped', 'article');
    INSERT INTO jobs (id, kind, article_id, payload_json, state, attempts, idempotency_key, next_run_at)
    VALUES ('job_extract_dup', 'extract', 'dup', '{}', 'done', 1, 'extract:dup', '2026-10-28T00:00:00.000Z');
  `);
  await createJob(store.db, {
    id: "job",
    kind: "extract",
    articleId: "article",
    idempotencyKey: "extract:article",
  });
  store.sqlite.exec("UPDATE jobs SET attempts = 2 WHERE id = 'job'");
  mocks.fetchPage.mockRejectedValue(new Error("boom"));

  await processJob(env, "job");
  expect(store.sqlite.prepare("SELECT status FROM articles WHERE id = 'dup'").get()?.status).toBe("discovered");
});

it("still skips sources below the 220-word floor before scoring", async () => {
  env.SELECTION_ENFORCE = "true";
  await extractJob(
    "How the query planner works",
    "https://example.com/blog/query-planner",
    150,
    [{ kind: "paragraph", text: textWords(150) }],
  );

  await processJob(env, "job");
  expect(store.sqlite.prepare("SELECT status, selection_score FROM articles").get()).toMatchObject({
    status: "skipped",
    selection_score: 0,
  });
  expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
});
```

`tests/pipeline.test.ts` already imports `createJob` and `processJob`. Extend the `./helpers/sqlite` import with `seedPublished` (added in Task 3) and add `import type { SourceBlock } from "../src/domain/source";` for the snapshot helper.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: FAIL. Low-score posts still generate; `selection_score` stays 0.

- [ ] **Step 3: Add the binding and config**

In `src/shared/env.ts`, add `SELECTION_ENFORCE?: string;` to `Bindings`.

In `wrangler.pipeline.jsonc`, add `"SELECTION_ENFORCE": "false"` inside `vars`, after `"AUTO_PUBLISH"`. Do not set it to `"true"` in this plan.

- [ ] **Step 4: Implement the gate in `runExtractJob`**

First extend the imports in `src/pipeline/run.ts`:

```ts
import {
  duplicateWindowStart,
  findDuplicate,
  formatSelectionReason,
  scoreSource,
  SELECTION_DUPLICATE_WINDOW_DAYS,
} from "../domain/selection";
// add to the existing ../infrastructure/db import:
//   listRecentSourceArticles, requeueDuplicates
```

After the snapshot is saved and `snapshotId` is final, insert:

```ts
const selection = scoreSource({
  title: article.originalTitle,
  url: article.canonicalUrl,
  blocks: parsed.data.blocks,
  wordCount: parsed.data.wordCount,
});
const candidates = await listRecentSourceArticles(
  env.DB,
  article.sourceId,
  article.id,
  duplicateWindowStart(article.publishedAt, SELECTION_DUPLICATE_WINDOW_DAYS),
);
const duplicate = findDuplicate(article.originalTitle, candidates);
const reason = duplicate
  ? `duplicate of ${duplicate.slug}`
  : formatSelectionReason(selection.reasons) || null;
const duplicateOf = duplicate?.id ?? null;
const selectionWrite = { score: selection.score, reason, duplicateOf };
const shouldSkip = Boolean(duplicate) || selection.decision === "skip";
```

Then, before the existing `setArticleStatus(... "generating" ...)`:

```ts
if (shouldSkip && bool(env.SELECTION_ENFORCE)) {
  const written = await setArticleStatus(env.DB, article.id, "skipped", reason, job, selectionWrite);
  if (written) await requeueDuplicates(env.DB, article.id);
  return { ok: true, detail: `Skipped by selection gate: ${reason ?? "low score"}` };
}

await setArticleStatus(env.DB, article.id, "generating", null, job, selectionWrite);
```

The existing `generating` call must be replaced, not duplicated. Keep the existing generate-job creation and queue send below it.

- [ ] **Step 5: Record the thin-source skip and requeue**

Replace the existing thin-source `setArticleStatus(..., "skipped", ...)` with:

```ts
const reason = `Source page yielded ${extracted.wordCount} words, below the ${MIN_SOURCE_WORDS}-word floor.`;
const written = await setArticleStatus(env.DB, article.id, "skipped", reason, job, {
  score: 0,
  reason,
  duplicateOf: null,
});
if (written) await requeueDuplicates(env.DB, article.id);
return { ok: true, detail: `Skipped thin source (${extracted.wordCount} words).` };
```

- [ ] **Step 6: Requeue on terminal extraction failure**

In the `catch` block of `runExtractJob`, after `setArticleStatus(... "failed", ...)`, capture its boolean and requeue only when the job has reached the terminal attempt (`job.attempts >= 3`):

```ts
const written = await setArticleStatus(env.DB, article.id, "failed", message.slice(0, 500), job);
if (written && job.attempts >= 3) await requeueDuplicates(env.DB, article.id);
throw error;
```

- [ ] **Step 7: Requeue on terminal generation failure**

In `runGenerateJob`, the branch that runs when generation is invalid currently calls `setArticleStatus(... "failed", ...)` then `failJob(..., { terminal: true })`. Capture the boolean from `setArticleStatus` and call `requeueDuplicates(env.DB, article.id)` when it returns true:

```ts
const written = await setArticleStatus(env.DB, article.id, "failed", message, job);
if (written) await requeueDuplicates(env.DB, article.id);
await failJob(env.DB, job, message, { terminal: true });
```

Do not change the existing `failJob` signature or terminal threshold.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: PASS. Then run `npx tsc --noEmit` and expect PASS.

- [ ] **Step 9: Commit**

```bash
but diff
but commit -b selection-gate -m "feat(selection): gate extraction before generation" <ids>
```

Pass only the IDs for `src/shared/env.ts`, `src/pipeline/run.ts`, `wrangler.pipeline.jsonc`, and `tests/pipeline.test.ts`.

---

### Task 8: Audit script, package script, and rollout docs

**Files:**
- Create: `scripts/selection-audit.ts`
- Modify: `package.json:15-30` (add `selection:audit`)
- Modify: `README.md:100-109` (pipeline description)
- No unit test: the script is I/O glue over the tested pure functions. It is verified by typecheck and a local smoke run.

**Interfaces:**
- Consumes: `scoreSource`, `findDuplicate`, `duplicateWindowStart`, `formatSelectionReason`, `SELECTION_DUPLICATE_WINDOW_DAYS` from Task 2; `SourceBlock` from `src/domain/source.ts`.
- Produces: `scripts/selection-audit.ts` with flags `--local`, `--remote`, `--apply`, `--json`, `--limit <n>`.
- Produces: `npm run selection:audit` alias for `tsx scripts/selection-audit.ts`.

- [ ] **Step 1: Implement the CLI and queries**

Use `execFileSync` from `node:child_process`, `mkdirSync`/`writeFileSync` from `node:fs`, and the existing `scripts/seed.ts` wrangler invocation pattern.

Argument rules:

- Exactly one of `--local` or `--remote`; default `--local`.
- `--apply` writes selection columns then executes the SQL.
- `--json` prints only a JSON summary.
- `--limit <n>` defaults to 500, clamped to `1..2000`.

Read articles:

```sql
SELECT id, source_id, canonical_url, original_title, slug, published_at, status,
       selection_score, selection_reason, duplicate_of
FROM articles
ORDER BY published_at DESC
LIMIT <limit>
```

Read latest snapshots for those ids:

```sql
SELECT article_id, blocks_json, word_count
FROM (
  SELECT article_id, blocks_json, word_count,
         ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY fetched_at DESC) AS rn
  FROM article_snapshots
  WHERE article_id IN (<quoted ids>)
)
WHERE rn = 1
```

Quote strings with a local `quote()` helper that doubles embedded single quotes (copy the helper from `scripts/seed.ts`). Run wrangler with:

```ts
const args = [
  "wrangler", "d1", "execute", "understory",
  "--config", "wrangler.jsonc",
  remote ? "--remote" : "--local",
  "--json", "--command", sql,
];
if (remote) args.push("--yes");
const output = execFileSync("npx", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
```

Parse from the first `[` to the last `]` of stdout, then read `parsed[0]?.results ?? []`.

- [ ] **Step 2: Recompute scores and duplicates**

For each article with a snapshot, parse `blocks_json` into `SourceBlock[]` and call:

```ts
scoreSource({
  title: article.original_title,
  url: article.canonical_url,
  blocks,
  wordCount: row.word_count,
})
```

For duplicate detection, group by `source_id`, sort each group by `published_at ASC, id ASC`, and for each article build candidates from earlier rows in the same group that:

- are within `SELECTION_DUPLICATE_WINDOW_DAYS` of the current article, and
- have status in `discovered`, `extracting`, `generating`, `review`, or `published`.

Build each candidate as `{ id, originalTitle, slug, publishedAt }` from the same-group row. Call `findDuplicate(article.original_title, candidates)`. A duplicate gets `duplicate_of` and reason `duplicate of <slug>`; otherwise use `formatSelectionReason(reasons) || null`. Do not change `status`.

- [ ] **Step 3: Print the report**

Without `--json`, print:

- total articles, scored articles, skipped decisions, duplicate decisions;
- score distribution buckets `0-19`, `20-34`, `35-44`, `45-59`, `60-74`, `75-100`;
- the lowest 20 and highest 20 with title, source id, score, and reason;
- duplicate clusters grouped by survivor slug.

With `--json`, print one object:

```json
{
  "total": 0,
  "scored": 0,
  "skipped": 0,
  "duplicates": 0,
  "distribution": { "0-19": 0, "20-34": 0, "35-44": 0, "45-59": 0, "60-74": 0, "75-100": 0 },
  "lowest": [],
  "highest": [],
  "clusters": []
}
```

- [ ] **Step 4: Implement `--apply`**

Write one `UPDATE articles SET selection_score = <n>, selection_reason = <string-or-NULL>, duplicate_of = <string-or-NULL> WHERE id = <string>;` per scored row to `.tmp/selection-audit.sql`. Create `.tmp` with `mkdirSync(".tmp", { recursive: true })` first. Use a local `quote()` helper for strings and `NULL` for nulls; do not emit placeholders because `--file` has no bind step. If there are no statements, skip the wrangler call. Otherwise run:

```ts
execFileSync("npx", [
  "wrangler", "d1", "execute", "understory",
  "--config", "wrangler.jsonc",
  remote ? "--remote" : "--local",
  "--file", ".tmp/selection-audit.sql",
  ...(remote ? ["--yes"] : []),
], { stdio: "inherit" });
```

Never write `status`, `published_revision_id`, or revisions. If an article has no snapshot, leave its selection columns unchanged.

- [ ] **Step 5: Add the npm script and README note**

In `package.json`, add after `"db:setup"`:

```json
"selection:audit": "tsx scripts/selection-audit.ts",
```

In `README.md`, after the numbered "How a post becomes a sheet" list and before the daily-budget paragraph, add:

```md
Before generation, the extract job scores the source on mechanism evidence and checks for near-duplicate stories from the same publisher. With `SELECTION_ENFORCE="true"`, low-scoring or duplicate posts are recorded as skipped and never reach the model. The gate is off in the checked-in config until the production audit is reviewed. `npm run selection:audit -- --remote` reports scores without changing published content.
```

- [ ] **Step 6: Verify the script typechecks and runs**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm run db:migrate` then `npm run selection:audit -- --local --limit 5 --json`
Expected: valid JSON with `total`, `scored`, `distribution`, `lowest`, `highest`, and `clusters` keys. An empty local database is acceptable; the command must not prompt or write.

- [ ] **Step 7: Commit**

```bash
but diff
but commit -b selection-gate -m "feat(selection): add audit script and rollout docs" <ids>
```

Pass only the IDs for `scripts/selection-audit.ts`, `package.json`, and `README.md`.

---

## Final Verification

- [ ] Run `npm run check`. Expected: typecheck passes and every Vitest file passes.
- [ ] Run `npm run build`. Expected: both Worker dry-run bundles succeed.
- [ ] Run `npm run selection:audit -- --local --limit 5 --json`. Expected: valid JSON, no writes without `--apply`.
- [ ] Inspect the final diff. Confirm no changes to `src/pipeline/prompt.ts`, `src/domain/explanation.ts`, `src/content/fixtures*.ts`, or published rows. Confirm `SELECTION_ENFORCE` in `wrangler.pipeline.jsonc` is `"false"`.
- [ ] Confirm `docs/architecture.*` and `.serena/` are untouched and uncommitted.

## Rollout

These are owner actions after the branch is reviewed. Do not perform them as part of implementation.

1. **Shadow deploy.** Apply the migration and deploy both Workers with `SELECTION_ENFORCE` at `"false"`:

   ```bash
   npm run db:migrate:remote
   npm run deploy:web
   npm run deploy:pipeline
   ```

   The web Worker gets the admin skipped list and score-ranked lead. New posts get scores; nothing is skipped.

2. **Read-only production audit.** Run:

   ```bash
   npm run selection:audit -- --remote --json > /tmp/opencode/selection-audit-before.json
   ```

   Inspect the lowest and highest scores and duplicate clusters. Adjust weights only if the evidence shows a clear false positive or false negative. Re-run `npm run check` after any weight change.

3. **Enforce.** Set `"SELECTION_ENFORCE": "true"` in `wrangler.pipeline.jsonc` and deploy the pipeline. Low-score and duplicate posts now stop before generation.

4. **Backfill scores.** Run:

   ```bash
   npm run selection:audit -- --remote --apply
   ```

   This writes only `selection_score`, `selection_reason`, and `duplicate_of`. It does not change publication status, revisions, or visibility.

5. **Existing content.** The 413 published sheets stay as they are. Any noindex, unpublish, or re-generation is a separate owner decision after reviewing the audit report.
