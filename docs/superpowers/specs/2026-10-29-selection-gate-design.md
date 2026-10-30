# Selection gate for explainable posts

## Intent

Understory's promise is "explain the mechanism, not the announcement." The
pipeline currently explains almost every discovered post over 220 words. On
2026-10-29 the public index had 413 explainers. The 50 most recent API items
were all marked 2 minutes read, and eight sampled bodies were 255-517 words
with three sections and two tradeoffs. The lead story was an APNIC
conference-host process update. Recent items included a Node.js LTS release
note, an Elastic Forrester placement, and two Vercel virtual-model
announcements about the same launch.

That is a selection problem, not a generation problem. The pipeline spends
AI budget on posts with no mechanism to explain, and the public index reads
like a summary feed rather than a reading layer.

This design adds a deterministic selection gate after extraction and before
generation. It decides whether a source has enough mechanism to justify an
explainer, records the score and reason, and skips low-value or duplicate
posts. It also ranks the lead by selection score so the first sheet is the
best recent one, not simply the newest.

## Goals

- Stop low-mechanism posts from reaching generation: release notes, product
  announcements, analyst or award posts, podcasts, roundups, thinly rewritten
  marketing pages, and sources with no mechanism evidence.
- Skip near-duplicate stories from the same publisher within a 14-day window.
- Record a 0-100 selection score and a short human-readable reason for every
  extracted article.
- Choose the lead explainer by score within a 14-day window.
- Make skipped items visible to the editor so false negatives can be found.
- Keep the gate deterministic. No extra model call, no added AI budget.
- Preserve existing reading, admin, API, RSS, and cache behavior.

## Non-goals

- No retroactive unpublish, noindex, or rewrite of existing content in this
  change. The audit script reports scores. Changing published status is a
  separate owner decision.
- No cross-publisher story clustering in v1. Duplicate detection is limited
  to the same source.
- No model-based classifier in v1.
- No manual "generate anyway" button in v1.
- No public exposure of selection scores.
- No change to the generated-explanation schema or prompt in this change.

## Anti-goals

- A gate that silently drops good mechanism posts. False negatives must be
  visible in the admin desk and the audit report, and recoverable without a
  schema rewrite.
- A gate that rewards length alone. Word count is one signal, not the
  decision.
- A gate that treats docs pages, changelogs, or tag archives as articles.
- A gate that changes published data or fixtures automatically.

## Constraints

- Cloudflare free tier. No new service. Bounded D1 reads and writes.
- The gate runs inside the existing extract job under the existing lease
  fencing. A stale worker must not write a score or status.
- `AUTO_PUBLISH` stays as it is. The gate runs before generation, not at
  publish time.
- Migrations are append-only.
- TypeScript strict, Vitest, and the existing SQLite test helper.

## How it works

### 1. Score after extraction

`runExtractJob` already fetches, extracts, validates, and stores a snapshot.
After `saveSnapshot`, it calls:

```ts
scoreSource({
  title: article.originalTitle,
  url: article.canonicalUrl,
  blocks: parsed.data.blocks,
  wordCount: parsed.data.wordCount,
})
```

The pure function returns:

```ts
{
  score: number;            // 0-100, higher is more explainable
  decision: "generate" | "skip";
  reasons: string[];        // top contributing signals, human-readable
  signals: Record<string, number>;
}
```

The score is based on the source content, never on the generated explanation.

#### Scoring rubric

Start at 50 and apply the signals below. Clamp the result to 0-100.

| Signal | Adjustment |
| --- | --- |
| Word count 800-1499 | +10 |
| Word count 1500+ | +15 (instead of +10) |
| One or two code blocks | +10 |
| Three or more code blocks | +15 (instead of +10) |
| Three or more metric numbers | +10 |
| Two or more mechanism terms in title or headings | +10 |
| Three or more headings | +5 |
| Ten or more content blocks | +5 |
| Release/announcement title pattern | -30 |
| Docs/reference/manual URL path | -30 |
| Archive/tag/category URL path | -25 |
| Changelog/release/podcast/announcement URL path | -20 |
| Promotional phrase density at or above 3 per 1,000 words | -20 |
| Word count below 500 | -15 |
| No code blocks, no metric numbers, and no mechanism terms | -15 |
| Word count below 220 | already skipped before scoring |

A release-note title penalty is halved when the title also contains a
mechanism word such as "how", "inside", "design", "architecture",
"internals", "implementation", "migration", "scaling", "debugging", or
"lessons".

Decision: `skip` when score is below 45, otherwise `generate`. The score is
additive, so a title pattern alone cannot skip a substantial post: a
release-word title costs 30 points, but a post with strong positive signals
(long, code, metrics, mechanism terms) can still clear 45. A release note
with no positive evidence lands at 0-20. There is no separate "two signals"
rule.

Docs and archives are the exception. A URL classified as docs/reference/
manual or archive/tag/category is skipped by default unless the title also
contains a mechanism word. Code-heavy docs pages must not pass on structure
alone.

Title patterns (case-insensitive, word boundaries):
`release`, `released`, `releases`, `releasing`, `changelog`, `what's new`,
`now available`, `general availability`, `GA`, `beta`, `preview`,
`launch`, `launched`, `launches`, `announce`, `announced`, `announcing`,
`introduce`, `introduced`, `introducing`, `unveil`, `unveiled`, `ships`,
`rolled out`, `podcast`, `episode`, `webinar`, `roundup`, `weekly`,
`newsletter`, `Forrester`, `Gartner`, `award`, `recognized`,
`strong performer`. "Leader" is deliberately not a title pattern because it
would penalize leader-election articles.

URL classification:
- docs: `/\/(docs|documentation|reference|manual)(\/|$)/`
- archive: `/\/(tags?|categories?|archive)(\/|$)/`
- release: `/\/(changelog|release-notes|releases|announcements)(\/|$)/`
- podcast: `/\/(podcast|podcasts|episodes?|webinars?)(\/|$)/`
- otherwise `article`

The classifier is a pure function and is exported for tests. A docs or
archive URL is skipped by default unless the title contains a mechanism
word. A release or podcast URL applies the penalty above but can still
generate when the content earns enough positive points.

Metric numbers are percentages, durations, sizes, rates, costs, and large
counts. Bare version numbers such as `26.13.0` do not count. Mechanism terms
are concrete engineering nouns and verbs: design, architecture, internals,
implementation, mechanism, pipeline, protocol, scheduler, cache, index,
migration, consensus, sharding, query planner, runtime, compiler, storage
engine, consistency, concurrency, latency, throughput, failure, retry,
backpressure, partitioning, replication, coordination, serialization,
garbage collection, transaction, lock, queue. The full list lives in the
module and is exported for tests.

Promotional phrases include "we are excited", "best-in-class",
"world-class", "industry-leading", "cutting-edge", "revolutionary",
"game-changing", "seamless", "unlock", "empower", and "trusted by".

The reasons array names the strongest signals, for example:
`"release-note title (-30); 350 words (-15); no code, metrics, or mechanism terms (-15)"`.
`selection_reason` stores the first three reasons joined with `; `, capped
at 500 characters.

### 2. Duplicate check

Before generation, query recent articles from the same source:

```sql
SELECT id, original_title, slug, published_at, status
FROM articles
WHERE source_id = ?
  AND id != ?
  AND published_at >= ?
  AND status IN ('discovered', 'extracting', 'generating', 'review', 'published')
ORDER BY published_at DESC
LIMIT 50
```

Compare normalized title tokens. A candidate is a duplicate when either:

- containment `|A ∩ B| / min(|A|, |B|)` is at least 0.8 and at least three
  tokens are shared, or
- Jaccard `|A ∩ B| / |A ∪ B|` is at least 0.6 and at least four tokens are
  shared.

Normalization: lowercase, strip punctuation, remove stopwords and generic
announcement words (`introducing`, `announcing`, `now`, `available`, `new`,
`update`, `release`, `general`, `beta`, `the`, `a`, `an`, `on`, `in`, `for`,
`with`, `via`, `to`, `of`, `and`, `is`, `are`, `we`, `our`, `how`, `what`,
`why`), and remove version-like tokens. The article already in the pipeline
(earliest discovered) is the survivor. Exact URL duplicates are already
prevented by the unique index on `canonical_url`.

If a duplicate is found, the decision is `skip` with reason
`duplicate of <slug>` and `duplicate_of = <id>`, regardless of score.

Survivor policy: a duplicate is skipped only while its survivor is still
viable. If the survivor is later skipped by the selection gate, fails
terminally, or is rejected, every article with `duplicate_of = survivor.id`
and `status = 'skipped'` is moved back to `discovered`, its `duplicate_of`
is cleared, and an extract job is created. The gate then re-evaluates it
without the failed survivor. This runs from one helper,
`requeueDuplicates(db, survivorId)`, called from the terminal paths:
selection skip, extraction failure, terminal generation failure, and
editorial rejection. Without this, a duplicate could be lost because its
survivor never published.

The requeue is idempotent: it only touches rows still marked as skipped
duplicates of that survivor. The existing extract job is reset to `pending`
with `next_run_at = now`, `attempts = 0`, and a cleared lease, rather than
inserted again, because the old `extract:<id>` idempotency key is already
consumed. If no job exists, one is inserted. `requeueDuplicates` must also
be safe when called twice from overlapping terminal paths.

### 3. Record and skip

Extend `setArticleStatus` with an optional selection payload. One
lease-fenced update sets `status`, `last_error`, `selection_score`,
`selection_reason`, and `duplicate_of` together. Existing callers stay
unchanged.

- Decision `skip` and `SELECTION_ENFORCE` is true: set `skipped`, do not
  create a generate job.
- Decision `skip` and `SELECTION_ENFORCE` is false: record the score and
  reason, then continue to `generating` and create the generate job. This is
  shadow mode for calibration.
- Decision `generate`: record the score and reason, set `generating`, and
  create the generate job as today.

The existing `MIN_SOURCE_WORDS` check stays before the scorer. Sources below
220 words are skipped exactly as they are now.

### 4. Lead ranking

`getFeedLead` selects the highest `selection_score` among published articles
in the last 14 days that do not have a recorded duplicate, tie-breaking by
newest. If the window is empty, it falls back to the latest published
article. This makes the lead the best recent sheet, not the newest.

Existing rows start at score 0. The audit script is run with `--apply` to
backfill scores before the lead ranking is relied on. Without the backfill,
all scores are 0 and the fallback preserves current behavior.

### 5. Audit script

`scripts/selection-audit.ts` with `--local`, `--remote`, `--apply`, `--json`,
and `--limit`.

- Reads articles with their latest snapshot.
- Recomputes the score with the same pure function.
- Prints the score distribution, the lowest 20, the highest 20, and duplicate
  clusters.
- `--apply` writes `selection_score`, `selection_reason`, and `duplicate_of`
  only. It never changes `status`, publication, or revisions.
- Used to calibrate thresholds before enforcement and to answer the
  existing-content question.

### 6. Admin visibility

Add a "Recently skipped" section to `/admin` showing the last 20 skipped
articles: original title, source, score, reason, and a link to the original.
No override action in v1. This makes false negatives visible.

## Data model

Migration `migrations/0002_selection.sql`:

```sql
ALTER TABLE articles ADD COLUMN selection_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN selection_reason TEXT;
ALTER TABLE articles ADD COLUMN duplicate_of TEXT;

CREATE INDEX articles_lead_idx
  ON articles (status, selection_score DESC, published_at DESC);

CREATE INDEX articles_selection_idx
  ON articles (status, selection_score);
```

Update `Article` and `ArticleRow` with `selectionScore`, `selectionReason`,
and `duplicateOf`. Update `mapArticle`. `insertArticle` relies on the default
score of 0.

`tests/helpers/sqlite.ts` currently loads only `0001_init.sql`. Change it to
load every file in `migrations/` in lexical order so new migrations are
tested.

## Configuration and rollout

- `SELECTION_ENFORCE` boolean binding, default false. Set `"true"` in
  `wrangler.pipeline.jsonc` after the audit is reviewed.
- `SELECTION_MIN_SCORE` constant, exported for tests. Initial value 45.
- `LEAD_WINDOW_DAYS` constant, initial value 14.
- Rollout:
  1. Migration, scorer, duplicate check, audit script, tests. Shadow mode,
     enforcement off.
  2. Run the audit against production read-only. Inspect the lowest and
     highest scores and the duplicate clusters. Adjust weights only if the
     evidence shows a clear false positive or false negative.
  3. Set `SELECTION_ENFORCE="true"` and deploy.
  4. Run the audit with `--apply` to backfill existing scores.
  5. Treat existing-content cleanup as a separate decision.

## Tests

- `tests/selection.test.ts`: scoring decisions for release note, mechanism
  post, podcast/roundup, promotional vendor post, thin source, docs/archive
  page, and hand-written fixture-like content. Assert decisions, not exact
  scores, so weights can be tuned.
- `tests/selection.test.ts`: duplicate detection (same source, similar title,
  inside window; different source; outside window; generic titles).
- `tests/pipeline.test.ts`: low score sets `skipped` and creates no generate
  job when enforcement is on; shadow mode still creates the job; high score
  creates the job; duplicate sets `duplicate_of`; stale lease cannot write
  selection or status.
- `tests/pipeline.test.ts`: requeue when a survivor is skipped, fails
  terminally, or is rejected; requeue is idempotent and does not touch
  unrelated skipped rows.
- `tests/db.test.ts`: lead ranking picks the higher score inside the window
  and falls back to the newest when the window is empty.
- `tests/frontend.test.ts`: admin page renders the recently skipped section.
- Migration test via the updated SQLite helper.

## Calls made in this design

- Threshold: skip below 45. A release-word title alone cannot skip a
  substantial post because the score is additive.
- Scope: same-source duplicate detection only. Cross-publisher clustering is
  a follow-up.
- Survivor safety: skipped duplicates are requeued if their survivor is
  skipped, fails, or is rejected.
- Lead window: 14 days. Fall back to newest when the window is empty.
- Docs and archive pages: skip by default unless the title has a mechanism
  word. This is a deliberate exception to the score-only rule.
- Link density: not a v1 signal. The audit reads only stored snapshots, so
  the backfilled score matches the live score. A link-density signal needs a
  persisted link count and is deferred.
- No admin override in v1. The recently skipped list and the audit report are
  the recovery path.

## Decisions

- Existing 413 published sheets: audit first, no automatic changes. The
  owner chose the read-only audit. Scores are backfilled, the worst offenders
  are inspected, and any noindex, unpublish, or re-generation is a separate
  decision. This change does not alter published status.
- Cross-source duplicates: same-source only in v1. This is a design call,
  confirmed during the builder check.

## What is left to the builder

- Exact weights and threshold tuning after the audit.
- Admin layout details for the skipped list.
- Audit script output format.
- Whether to expose the threshold as an environment override later.
