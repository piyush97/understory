# Understory

Engineering blogs, explained. Understory watches [engineeringblogs.xyz](https://engineeringblogs.xyz/), turns selected posts into validated explainers, and publishes a dense reading index with context, diagrams, an ELI5, trade-offs, and sources.

The public side is read-only and fully server-rendered. Explanations are generated asynchronously and validated. With `AUTO_PUBLISH="true"`, new valid generations publish automatically; existing drafts still require manual approval. Automated checks are not human fact-checking.

## Stack

- Cloudflare Workers, free plan only
- Hono with server-rendered JSX
- D1 for articles, snapshots, revisions, reviews, jobs, and the AI budget
- Queues for extraction and generation jobs
- Workers AI (`@cf/qwen/qwen3-30b-a3b-fp8`)
- Cron Triggers for discovery
- Workers Static Assets for CSS, client-side bookmarks, fonts, and icons

Two Workers share one D1 database:

| Worker | Entry | Responsibility |
| --- | --- | --- |
| `understory-web` | `src/web/index.ts` | Public pages, JSON API, RSS/sitemap, admin review surface |
| `understory-pipeline` | `src/pipeline/index.ts` | Discovery, extraction, generation, validation, queue consumer, cron |

## Architecture

[![Understory system architecture](docs/architecture.png)](docs/architecture.html)

Two Workers share one Cloudflare account and one D1 database. `understory-web` renders the public reading app and the auth-gated editorial desk. `understory-pipeline` consumes discovery, extraction, and generation jobs, fetches [engineeringblogs.xyz](https://engineeringblogs.xyz/) and publisher pages, calls Workers AI, and writes revisions to D1. New valid generations publish automatically when `AUTO_PUBLISH="true"`; existing drafts stay in the editorial queue.

The image above is a static export. The [interactive diagram](docs/architecture.html) supports route focus, lens, and source links; download it and open it in a browser because GitHub displays HTML files as source, not as a rendered page.

## Screenshots

| Index | Article |
| --- | --- |
| [![The Understory index](docs/screenshots/home-desktop.png)](docs/screenshots/home-desktop.png) | [![An Understory article](docs/screenshots/article-desktop.png)](docs/screenshots/article-desktop.png) |
| **Index.** A dense feed with topic filters, a lead explainer, and the same drawing-sheet system used throughout the app. | **Article.** Context first, a one-sentence summary, TL;DR, and a calm reading column with a source record in the margin. |

| Editorial review | Mobile |
| --- | --- |
| [![The Understory editorial desk](docs/screenshots/admin-review.png)](docs/screenshots/admin-review.png) | <a href="docs/screenshots/home-mobile.png"><img src="docs/screenshots/home-mobile.png" alt="Understory on a phone" width="300"></a> |
| **Editorial desk.** Drafts wait for a person to approve or reject them against the source snapshot. | **Mobile.** The reading index collapses to a single column without losing the sheet hierarchy. |

## Local setup

Requires Node 20+ and a Cloudflare account only for deployment. Local D1, Queues, and static assets run in Wrangler without an account.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:setup
npm run dev
```

The web app runs at `http://localhost:8790`. The pipeline worker runs separately:

```bash
npm run dev:pipeline
```

Pipeline endpoints are authenticated with the same `ADMIN_TOKEN`:

```bash
curl -X POST http://localhost:8791/run/discovery \
  -H "Authorization: Bearer dev-understory-token"

curl -X POST http://localhost:8791/run/jobs \
  -H "Authorization: Bearer dev-understory-token"
```

Workers AI is not available in local Wrangler. Generation jobs will reach the budget reservation and then fail with a binding error locally. That is expected; use the seeded, reviewed fixtures for local UI work.

### Local review

Open `http://localhost:8790/admin` and use the token from `.dev.vars`. The queue is empty after a fresh seed because the ten fixture explainers are already published. The admin routes can be exercised with a draft revision inserted into D1.

## Checks

```bash
npm run typecheck
npm test
npm run check
```

The tests cover canonical URLs, slugs, feed cursors, discovery parsing, explanation validation, diagram rendering, model output parsing, editorial source checks, and the budget kill switch.

GitHub Actions runs a locked dependency install, Chromium regression tests,
checks, dependency audit and
both Worker dry-run bundles on pull requests and pushes to `main`. It has
read-only permissions and no deployment credentials. Configure branch
protection to require the `check` job before merging; the workflow alone does
not prevent unchecked merges.

For a visual pass, install Chromium once and use Playwright:

```bash
npx playwright install chromium
```

## How a post becomes a sheet

1. The cron trigger enqueues a discovery message every 15 minutes. Discovery fetches the public listing, parses recent entries, creates source rows, inserts new articles, and queues extract jobs.
2. An extract job fetches one article, pulls readable blocks with `HTMLRewriter`, records a content-hashed snapshot, and queues a generate job.
3. A generate job reserves an estimated slice of the daily neuron budget, asks Workers AI for strict JSON, validates it structurally and semantically, and writes a draft revision.
4. With `AUTO_PUBLISH="true"` (enabled in the production pipeline config), a newly generated valid revision publishes in the same transaction that creates it, with an automated-validation audit record. Existing drafts are never auto-approved. Set `AUTO_PUBLISH="false"` and redeploy the pipeline to hold new drafts for manual review. Publication updates the article and increments the publication version; failed validation stays unpublished.
5. Public pages read only published revisions. A reader request never calls a model.

Before generation, the extract job scores the source on mechanism evidence and checks for near-duplicate stories from the same publisher (14-day window, earliest story survives). With `SELECTION_ENFORCE="true"`, low-scoring or duplicate posts are recorded as skipped and never reach the model. `SELECTION_ENFORCE` stays `"false"` in the checked-in config until the production audit is reviewed. Nothing is unpublished, hidden, or rewritten automatically.

`npm run selection:audit -- --local|--remote [--json] [--limit <n>]` is read-only by default: it prints the score distribution, lowest and highest 20, and duplicate clusters. Only `--apply` writes, and only `selection_score`, `selection_reason`, and `duplicate_of`. Never `status`, revisions, or content.

Enforcement and backfill are owner rollout steps, in this order:

1. Shadow: apply the migration, deploy both Workers with `SELECTION_ENFORCE="false"`. New posts get scores; nothing is skipped.
2. Read-only audit: `npm run selection:audit -- --remote --json`. Review lowest, highest, and clusters before changing weights.
3. Enforce: set `SELECTION_ENFORCE` to `"true"` in `wrangler.pipeline.jsonc` and deploy the pipeline.
4. Backfill: `npm run selection:audit -- --remote --apply`.

Existing published sheets stay as they are. Any noindex, unpublish, or regeneration is a separate owner decision.

The daily budget defaults to 8,000 neurons, with roughly 500 neurons reserved per attempt. The pipeline stops before exceeding the budget and defers jobs to the next UTC day. Set `DAILY_NEURON_BUDGET="0"` to pause generation entirely without breaking reading.

## Content and editorial rules

- The seed contains ten published explainers based on real engineering blog posts, plus three discovered posts on the bench. The prose was written for Understory, not copied from the publishers. Live editorial approvals may increase the published count independently of these fixtures.
- Public seed snapshots contain two or three short quotations and the canonical link per source. Runtime extraction stores a larger, bounded private snapshot for generation/review; it is not served through public routes. No automatic retention/deletion policy is implemented, so operators must manage that storage separately.
- Generated content must cite source ids. Citations that point nowhere are rejected before review.
- Sources can only use URLs found in the extracted page or the original canonical URL. The validator rejects invented URLs.
- Diagrams are graph JSON rendered to deterministic SVG. The model never supplies SVG or JavaScript.
- The reader can always reach the original article. Understory does not reproduce the full text.
- `/about` states the editorial policy in public.
- Publisher articles are not covered by Understory's content license. See [CONTENT-LICENSE.md](CONTENT-LICENSE.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Deployment

Cloudflare credentials are required. The checked-in configs describe the live
Understory deployment, not a reusable environment. Database IDs are nonsecret,
but forks must replace them. **Do not deploy unchanged configs into another
account.** First choose your own Worker, database and queue names and domain.
The commands below use the default names; substitute yours consistently.

```bash
npx wrangler login

npx wrangler d1 create understory
npx wrangler queues create understory-jobs
```

Before applying migrations or deploying:

- Replace the D1 `database_id` and `database_name` in both configs with the new
  database. Keep the `DB` binding unchanged.
- Replace Worker names and queue names in both producer bindings and the
  pipeline consumer if you chose different names. The created queue must match.
- Replace `understory.piyushmehta.com` in the web `routes` entry with a hostname
  in your Cloudflare zone, or remove `routes` to start on `workers.dev`.
- Set `SITE_URL` in both configs to your final URL. For `workers.dev`, use
  `https://<web-worker-name>.<account-subdomain>.workers.dev`.

Apply the schema and seed the launch edition into the **new database only**:

```bash
npm run db:migrate:remote
npm run db:seed:remote
```

The seed script upserts fixture articles and publication metadata; it is not
a production upgrade or restore command. Do not rerun it against live edited
content without reviewing its effects.

Deploy the pipeline first so the queue consumer exists, then the web worker:

```bash
npm run deploy:pipeline
npm run deploy:web
```

For Cloudflare Workers Builds, use `npm run build` (or `bun run build`) as the build
command. It typechecks and bundles both Workers without deploying. For the web
Worker, set the deploy command to `npm run deploy:web` and the preview/non-production
command to `npx wrangler versions upload --config wrangler.jsonc`.
For a separate pipeline build integration, use `npm run deploy:pipeline` as its
production deploy command.

Install a strong, randomly generated editorial secret on both deployed Workers
using Wrangler's interactive secret prompt (never commit or paste it into logs):

```bash
npx wrangler secret put ADMIN_TOKEN --config wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN --config wrangler.pipeline.jsonc
```

If your URL changed during initial deployment, update both `SITE_URL` values and
redeploy. The pipeline deployment activates the existing `*/15 * * * *` cron
in UTC (the next quarter-hour). To remove automatic discovery, remove its
`triggers.crons` entry and redeploy the pipeline. A zero neuron budget pauses
generation, not discovery.

Optional hardening: put Cloudflare Access in front of `/admin`, set the
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` values in `wrangler.jsonc` (the
`ACCESS_AUD` value is the application audience tag shown in the Access
application overview), then set `REQUIRE_ACCESS_JWT="true"` on the web Worker.
The Worker requires both the editorial token and a valid signed Access
assertion. Missing settings or invalid assertions fail closed. Protect every
enabled hostname, not just the custom domain.

### Release and operations checklist

- Enable required checks on `main` and private vulnerability reporting when
  available. These are repository settings, not changes the workflow applies.
- Check `/health` on the pipeline, a public article, RSS/sitemap, anonymous
  admin login, and the authenticated review queue after deploying.
- For code rollback use `npx wrangler rollback --config <worker-config>` after
  checking its deployment history. Worker rollback does not undo D1 writes;
  arrange and test D1 backup/recovery before schema or destructive data changes.
- Cloudflare may inject its Insights beacon at the edge. The current CSP blocks
  it. Disable unused edge analytics injection rather than weakening CSP; if you
  intentionally enable analytics, document the data collected first.
- Earlier Git history contains longer publisher excerpts than current fixture
  limits. Before changing repository visibility, decide whether that history
  is acceptable; do not rewrite shared history without owner approval. Quote
  limits and attribution do not establish legal permission.

## Free-tier notes

- Workers: 100,000 requests/day, 10 ms CPU per invocation on the free plan.
- Workers AI: 10,000 neurons/day; Understory reserves 8,000 and leaves headroom.
- D1: 5 million rows read/day, 100,000 rows written/day, 500 MB per database.
- Queues: 10,000 operations/day, 24-hour retention.
- Discovery HTML is capped before parsing, snapshots are bounded, and pages are cached in the Cache API keyed by publication version.
- There are no accounts, comments, votes, public submissions, or chat with articles in v1.

## Repository map

```text
src/domain/         schemas, canonical URLs, cursors, diagram renderer
src/infrastructure/ D1 queries and writes
src/pipeline/       discovery, extraction, prompt, generation, queue runner
src/web/            Worker entry, routes, JSX components, cache, client helpers
src/content/        reviewed fixtures and the fixed topic set
public/assets/      stylesheet, client JS, fonts, icons
migrations/         D1 schema
scripts/            seed tooling
docs/               architecture diagram and app screenshots
tests/              Vitest coverage
```

## Contributing

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the schema, the editorial pipeline, or the published fixtures. Security reports should follow [SECURITY.md](SECURITY.md), not a public issue.

## License and attribution

Understory is open source.

- **Code:** MIT. See [LICENSE](LICENSE).
- **Original explainer prose and diagrams:** CC BY 4.0. See [CONTENT-LICENSE.md](CONTENT-LICENSE.md).
- **Publisher articles, quotations, fonts, and trademarks:** excluded from those licenses and remain with their owners. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The project is independent and not affiliated with the publishers it covers. If you are a rights holder and believe a quotation or attribution is wrong, open an issue with the URL and the specific passage.
