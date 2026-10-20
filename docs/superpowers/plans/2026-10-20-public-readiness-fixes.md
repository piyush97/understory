# Public-readiness fixes

## Scope and execution

Fix the verified findings from `/tmp/opencode/understory-public-readiness-review.md`. Preserve Understory's reading design and human publication gate. Work on a dedicated GitButler branch in the existing clean checkout, with disjoint file ownership for parallel agents. No production calls that mutate data, deployment, visibility/settings changes, history rewriting, pushes or PRs. Commit local verified checkpoints only under the repository's checkpoint instructions.

## Checklist

- [ ] Database/pipeline: regression-test stale leases, due timestamps, discovery partial failure, review races and rejected-revision retries; implement atomic, lease-fenced state transitions.
- [ ] Auth/fetch: implementation and 90 tests pass; independent scoped review pending, discovery integration pending.
- [ ] Frontend: implementation and 13 tests pass; 24 local axe checks pass, desktop/mobile light/dark screenshots inspected; independent scoped review pending.
- [x] CI/docs: added least-privilege checks (locked install, Chromium, TypeScript/tests/audit, Worker dry runs); corrected deploy/fork, identifier, Access and snapshot-retention documentation. Remote settings/history/edge analytics remain owner actions. Scoped review approved; CI commands verified locally, hosted execution not performed.
- [ ] Integrate: inspect diffs, run all tests/typecheck/audit and Worker dry runs, perform browser checks, obtain an independent review and fix demonstrated regressions.

## File ownership and test approach

1. **Database and pipeline agent** owns `src/infrastructure/db.ts`, `src/pipeline/run.ts`, new DB/pipeline regression tests and SQLite test support under `tests/helpers/`. Read `migrations/0001_init.sql`; do not rewrite existing migrations. Use real SQLite semantics in test support (Node's SQLite if available), including rollback-aware batches and controlled interleavings. Failing tests first. Pending claims require due timestamps; expired-running recovery stays separate. Revision/article/audit/version updates must all be conditioned on the successful transition/lease, not a preflight read. Published articles must not be demoted. Discover and create the initial job atomically; reconcile missing initial jobs. Existing rejected revisions must not become phantom review entries.

2. **Auth and outbound-fetch agent** owns `src/web/routes/admin.tsx`, `src/web/index.ts`, `src/pipeline/extract.ts`, new `src/shared/access.ts`/`src/shared/fetch.ts` if needed, `src/shared/env.ts` and its own tests. Do not edit `run.ts`; expose a bounded reader/fetch helper for coordinator integration into discovery. Failing tests first. Verify Access signature/issuer/audience/expiry with Web Crypto and public keys; retain token auth. Set `no-store` on all admin paths. Reject local/private literal destinations and unsafe redirects, bound redirect count and streaming bytes, document DNS-rebinding/platform limitations accurately.

3. **Frontend agent** owns `public/assets/styles.css`, `public/assets/app.js`, `src/web/components/layout.tsx`, `src/web/components/diagram.tsx`, `src/domain/diagram.ts` and frontend tests. Read Impeccable harden/audit/craft-floor references before UI edits. Fix WCAG contrast for actual backgrounds in both themes, compatible interactive SVG semantics, labelled focusable horizontal diagrams, working skip link and accessible storage-error feedback. Preserve copy and style unrelated to bugs. Use browser-local fixtures / JS-disabled and denied-storage tests, not production mutations.

4. **Coordinator** owns `.github/workflows/check.yml`, documentation/example env, package scripts only when needed, plan updates and integration. Use pinned action SHAs and read-only token permissions, Node 24, `npm ci`, `npm run check`, `npm audit`, both Wrangler dry-run bundles. No authenticated deploy on PR. Correct README's route/DB/queue replacement order; distinguish identifiers from credentials; clarify private runtime snapshots vs public fixture quotations. Document optional settings and historical excerpts without rewriting history or claiming legal clearance.

## Verification commands

Run focused tests red then green for each code fix. Final gates: `npm run check`, `npm audit`, `npx wrangler deploy --dry-run --config wrangler.web.jsonc --outdir /tmp/opencode/understory-check-web`, and equivalent pipeline bundle. Verify local seeded Worker browser routes at 320/390/768/1440px, light/dark, keyboard skip, no-JS reading, save/remove and denied-storage feedback; axe WCAG A/AA for representative pages. Keep temporary diagnostics outside tracked source. Record counts/results, remaining limitations and owner actions.
