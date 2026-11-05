# ROI fixes (session plan)

Source: audit of 2026-11-05 recommending highest-ROI hardening. User approved "start fixing these".
Method: TDD (red-green-refactor) per superpowers:test-driven-development. Branch per GitButler session rules.

## Order

1. **#0 Test runner baseline (config only).** Vitest picks up `.cheapag/worktrees/*/tests`, and that stale worktree copy fails (`defaults the pipeline config to shadow mode`). Add a `vitest.config.ts` excluding `.cheapag/**`, add `.cheapag/` to `.gitignore`. TDD exception: configuration file. done-when: `npm run check` green baseline.
2. **#4 Keyset tuple predicates.** `db.ts:149` (feed cursor), `db.ts:316,326` (adjacent articles) use `OR`-form keyset predicates that cannot range-seek. RED test: capture SQL via the test adapter's `prepare`, run `EXPLAIN QUERY PLAN`, assert a range constraint on `(published_at,id)`. GREEN: rewrite as `(a.published_at, a.id) < (?, ?)` / `>`.
3. **#1 Hot-path D1 reads.**
   a. `feed.tsx`: validate `topic` before running feed/pending/lead queries (404 without them).
   b. `getSiteState`: optional `maxAgeMs` memo (WeakMap keyed by D1Database) used by `cache.ts loadSite` and `not-found.tsx siteFor`; admin keeps fresh reads.
4. **#2 Job attempts cap + stale AI budget reconciliation.**
   a. `listReadyJobs`: first terminal-fail `running` jobs whose lease expired at `attempts >= 5` (matches `failJob`'s terminal rule), then exclude `attempts >= 5` from ready/claim; `claimJob` WHERE gains `attempts < 5`.
   b. `reconcileStaleBudgetReservations`: atomically transfer orphaned holds to estimated usage only when no generate job is running, including expired leases. Unknown billed work is never refunded. Called from `runScheduled`; no migration needed.
5. **#3 Generation retry waste.**
   a. Skip the in-job repair attempt when output hit the token limit (truncation cannot be repaired with the same `max_tokens`).
    b. Retryable generation gets 2 job attempts (`job.attempts < 3` → `< 2`): up to 2 calls for consistently truncated output, 4 when repairs are attempted, excluding invocation crashes.
   c. `/no_think` NOT enabled here: needs verification against Workers AI in production; flagged to user instead.

## Rules

- Only commit this session's files (`.plan/roi-fixes.md`, config, `src/`, `tests/` touched here). Other agents' uncommitted `.serena/` and docs changes stay uncommitted.
- Run focused test files during development; full `npm run check` before each checkpoint commit.
- Do not deploy, push, or open PRs.

## PR #12 review follow-up

- [x] Reproduce budget cleanup race; conservatively charge unknown usage instead of refunding it.
- [x] Retire exhausted articles and recover duplicates without touching live jobs, drafts, or publications.
- [x] Check truncation/retry edge cases; `npm run check`: 425 tests; `npm run build`: both Workers dry-run passed.
- [x] Review fixes prepared for local checkpoint commits. Publishing requires user authorization.

Remaining limit: budget holds are aggregate, not per-attempt records. Orphan recovery uses the existing 500-neuron estimate, not measured usage, and waits until all generation jobs leave running state.
