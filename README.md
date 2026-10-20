# Understory

Engineering blogs, explained. Understory watches [engineeringblogs.xyz](https://engineeringblogs.xyz/), turns selected posts into reviewed explainers, and publishes a dense reading index with context, diagrams, an ELI5, trade-offs, and sources.

The public side is read-only and fully server-rendered. Explanations are generated asynchronously, validated against a schema, and held in a private editorial queue until a person approves them.

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

Two Workers share one Cloudflare account and one D1 database. `understory-web` renders the public reading app and the private editorial desk. `understory-pipeline` consumes discovery, extraction, and generation jobs, fetches [engineeringblogs.xyz](https://engineeringblogs.xyz/) and publisher pages, calls Workers AI, and writes draft revisions to D1. A person must approve a draft before it can appear in the public index.

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

Open `http://localhost:8790/admin` and use the token from `.dev.vars`. The queue is empty after a fresh seed because the four fixture explainers are already published. The admin routes can be exercised with a draft revision inserted into D1.

## Checks

```bash
npm run typecheck
npm test
npm run check
```

The tests cover canonical URLs, slugs, feed cursors, discovery parsing, explanation validation, diagram rendering, model output parsing, editorial source checks, and the budget kill switch.

For a visual pass, install Chromium once and use Playwright:

```bash
npx playwright install chromium
```

## How a post becomes a sheet

1. The cron trigger enqueues a discovery message every 15 minutes. Discovery fetches the public listing, parses recent entries, creates source rows, inserts new articles, and queues extract jobs.
2. An extract job fetches one article, pulls readable blocks with `HTMLRewriter`, records a content-hashed snapshot, and queues a generate job.
3. A generate job reserves an estimated slice of the daily neuron budget, asks Workers AI for strict JSON, validates it structurally and semantically, and writes a draft revision.
4. A person reviews the draft against the snapshot. Approval writes an immutable revision, updates the article, and increments the publication version. Rejection keeps the revision for the record.
5. Public pages read only published revisions. A reader request never calls a model.

The daily budget defaults to 8,000 neurons, with roughly 500 neurons reserved per attempt. The pipeline stops before exceeding the budget and defers jobs to the next UTC day. Set `DAILY_NEURON_BUDGET="0"` to pause generation entirely without breaking reading.

## Content and editorial rules

- The seed contains four published explainers based on real engineering blog posts, plus three discovered posts on the bench. The prose was written for Understory, not copied from the publishers.
- Generated content must cite source ids. Citations that point nowhere are rejected before review.
- Sources can only use URLs found in the extracted page or the original canonical URL. The validator rejects invented URLs.
- Diagrams are graph JSON rendered to deterministic SVG. The model never supplies SVG or JavaScript.
- The reader can always reach the original article. Understory does not reproduce the full text.
- `/about` states the editorial policy in public.

## Deployment

Cloudflare credentials are required. The repository ships with placeholder D1 IDs, so deployment is intentionally blocked until a real database and queue exist.

```bash
npx wrangler login

npx wrangler d1 create understory
npx wrangler queues create understory-jobs
```

Copy the D1 `database_id` into both `wrangler.web.jsonc` and `wrangler.pipeline.jsonc`. Set a real `SITE_URL` in both files (the first deploy can use `https://understory-web.<subdomain>.workers.dev`).

Set the editorial secret on both workers:

```bash
npx wrangler secret put ADMIN_TOKEN --config wrangler.web.jsonc
npx wrangler secret put ADMIN_TOKEN --config wrangler.pipeline.jsonc
```

Apply the schema and seed the launch edition:

```bash
npm run db:migrate:remote
npm run db:seed:remote
```

Deploy the pipeline first so the queue consumer exists, then the web worker:

```bash
npm run deploy:pipeline
npm run deploy:web
```

After the first deploy, update `SITE_URL` to the final `workers.dev` URL and redeploy both workers. The cron trigger is part of the pipeline deployment.

Optional hardening: put Cloudflare Access in front of `/admin` and set `REQUIRE_ACCESS_JWT="true"`. The admin code then requires the Access email header in addition to the editorial token. Access itself validates the JWT at the edge.

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
scripts/            seed and font tooling
docs/               architecture diagram and app screenshots
tests/              Vitest coverage
```

## License and attribution

Original articles belong to their authors and publishers. Understory links to every source it uses. The project code is private unless the repository owner says otherwise.
