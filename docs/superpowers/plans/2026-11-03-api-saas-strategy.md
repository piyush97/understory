# Hosted explainer API: product, architecture, and delivery proposal

**Status:** Planning only. Not an approved implementation spec, budget, or commercial offer.
**Date:** 2026-11-03
**Rechecked:** 2026-11-06 against repository source and linked vendor docs.
**Decision requested:** Approve discovery and a paid pilot for a hosted read API aimed at newsletter and developer-education teams.

**Evidence labels used below:** **Fact** means observed in this repository or rechecked against a cited vendor page on 2026-11-06. **Proposal** means a recommendation that needs approval. **Estimate** means illustrative arithmetic, not a measurement or quote.

## Recommendation

Build a hosted, versioned read API for teams that publish engineering explainers to developers. The buyer is a newsletter, developer-education, or developer-relations team that already curates technical writing and wants a reliable feed of published explainers with stable IDs, revisions, change sync, attribution, and support. This is **Proposal**.

The public reader and the existing free API at `GET /api/articles` and `GET /api/articles/:slug` remain available and unchanged. Paid access is a separate `/api/v1` contract. Selling access is not a legal prerequisite for paid hosting, and paid hosting is not a legal prerequisite for selling. Paid hosting is recommended before making reliability promises because the current project is constrained to Cloudflare's free tier by [PRODUCT.md](../../../PRODUCT.md), and free-tier limits and support are not a sound basis for a paid integration. Changing that constraint requires explicit approval.

Technical feasibility is high: the product already has precomputed, validated explainers, immutable published revisions, D1 queries, Hono routing, and Workers infrastructure. Demand and rights clearance are **not validated**. The repository contains no customer quotes, usage evidence, or buyer research. Nothing here may be described as customer validation.

## Why this shape

The core asset is not a model endpoint. It is an editorial pipeline that discovers engineering posts, extracts source text, generates structured explanations, validates them, and publishes immutable revisions. A buyer integrating that asset needs predictable delivery more than one-off generation.

The paid value is a stable versioned contract, incremental sync, immutable revisions and review provenance, bundled attribution and license notices, and integration support. A customer portal is **secondary**. The API is the product. The minimal portal exists only for account creation, key management, usage, and billing.

The main commercial risk is that buyers can already read the free API, reuse CC BY content, or self-host the MIT code. A paid subscription must save measurable integration and curation work; charging for the same JSON behind a key is not enough. Compare the pilot against manual curation, direct RSS feeds, the existing free API, and a buyer's own generation workflow. No competitor pricing or market-size claim is established here. Start with newsletter publishers that already have an engineer maintaining a recurring publishing workflow; developer-education tools and internal developer portals are secondary prospects, not simultaneous launch markets.

### Options compared

| Option | Fit | Decision |
| --- | --- | --- |
| Hosted read API for teams | Reuses precomputed content, supports integration, modest marginal read cost | **Recommend pilot** |
| Public content portal or marketplace | Requires consumer acquisition, design, and content marketing; weak fit with current read-only product | Secondary, not in scope |
| On-demand generation API | Adds inference cost per call, latency, rights exposure, and abuse risk; conflicts with precomputed publishing model | Defer |
| Consumer subscription | Requires accounts, payments, retention, and a much larger audience than the evidence supports | Defer |
| Customer-owned generation | Needs tenant isolation, deletion, and prompt-injection defenses not present today | Defer to a later phase |

## Current state and gaps

**Facts observed in the repository:**

- Public JSON endpoints already exist at [src/web/routes/api.ts](../../../src/web/routes/api.ts#L11) and are routed in [src/web/index.ts](../../../src/web/index.ts#L122).
- The feed supports topic filters and cursor pagination through [src/infrastructure/db.ts](../../../src/infrastructure/db.ts#L133) and [src/domain/pagination.ts](../../../src/domain/pagination.ts#L1).
- Published articles join an immutable explanation payload in `explanation_revisions`; review/status metadata can change. The schema is in [migrations/0001_init.sql](../../../migrations/0001_init.sql#L90).
- The explanation schema includes structured sections, diagrams with a description, sources, and provenance fields in [src/domain/explanation.ts](../../../src/domain/explanation.ts#L104).
- The code is MIT licensed in [LICENSE](../../../LICENSE). Original editorial content is CC BY 4.0 in [CONTENT-LICENSE.md](../../../CONTENT-LICENSE.md). Third-party quotations, images, and snapshots are excluded from that license.
- There are no customer accounts, API keys, tenancy, quotas, metering, billing, or change feed.
- The existing API has no `schema_version`, ETag contract, request ID, `429` semantics, revision history route, usage route, or license/attribution payload.
- `GET /api/articles/:slug` returns the whole explanation object, including quotation blocks if present, and source `evidenceIds`. That is not a rights-filtered paid DTO.
- Published revision timestamps exist as `reviewed_at`, and generated timestamps as revision `created_at`, but the API does not label automated versus human review explicitly.
- Snapshot bodies are not public, which is correct and must remain true.
- `PRODUCT.md` mandates free tier only and no accounts or arbitrary URL ingestion.

**Gaps to close before a paid promise:**

1. Customer identity, organizations, scoped keys, rotation, and revocation.
2. D1-backed entitlement, atomic quota, usage reporting, and a burst limiter.
3. Versioned API contract and a rights-filtered DTO.
4. Transactional change log with tombstones and cursor expiry.
5. Stripe subscription lifecycle and webhook reconciliation.
6. SSR account panel and accessible forms.
7. Operational monitoring, backups, runbooks, and a support process.
8. Rights review and merchant/tax decisions.

## Product scope for the MVP

**Proposal:** Sell read access to published, validated, original explainers only.

Each item exposes:

- Stable article ID and slug.
- Context headline, dek, TL;DR, sections, trade-offs, caveats, and reading time.
- Topic and source label, with canonical source URL.
- `schema_version`, `revision_id`, and `etag`.
- Diagram JSON plus an explicit `text_alternative` field.
- Provenance: model ID, prompt version, schema version, and source reference IDs that point to public source URLs only.
- Separate `source_published_at`, `generated_at`, and `published_at` timestamps in UTC.
- A review object: `mode` is `automated` or `human`, with reviewer label only when human.
- Attribution and license block, including modification notice and a link to the license.

The paid DTO **excludes** publisher quotations, publisher images, source snapshot bodies, `blocks_json`, `evidenceIds`, selection scores, job errors, drafts, review notes, and any private data. The `quote` block type is filtered out or transformed. If a quotation is essential to comprehension, the response links to the source instead of reproducing it. **Rights review is still required** for derivative works and source terms. CC BY 4.0 permits commercial reuse of original editorial content with attribution, but it does not grant rights to third-party material.

Published content remains under CC BY 4.0. A subscription buys service, integration, and support; it does not buy exclusive rights to the content, and it cannot revoke rights already granted. Cancellation stops future API access and updates. It does not withdraw the CC BY license from copies already obtained, and the product must not replace that license with exclusive terms. Takedown requests remove content from future responses and emit a withdrawal tombstone in the change feed. Item and historical revision routes return `410` for withdrawn content; caches must not bypass that check. This does not claw back lawful copies. Apply an approved takedown across public delivery paths too, without otherwise changing the free API contract.

## API design

**Proposal:** Add a versioned API parallel to the free endpoints.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/articles` | Published feed with topic, source, and cursor filters |
| `GET /api/v1/articles/{id}` | Current published revision |
| `GET /api/v1/articles/{id}/revisions/{revision_id}` | Immutable historical revision |
| `GET /api/v1/changes?cursor=...` | Publications, corrections, and withdrawals |
| `GET /api/v1/usage` | Current period usage and limits |

Default page size is 20, maximum 50, matching the existing database helper. Cursors are opaque, validated, and bound to filters. Timestamps are ISO 8601 UTC. Errors use a stable envelope with `code`, `message`, and `request_id`. Responses support `ETag` and `If-None-Match`; list validators cover the complete filtered page representation, not a single revision. Rate-limited responses use `429` with `Retry-After`. Revision responses are content-stable and privately cacheable with revalidation, not permanent cache freshness that could bypass a withdrawal. Only revisions with a recorded publication event are eligible, never drafts or merely approved rows. Pin OpenAPI and sanitized-response schema fixtures; additive changes are allowed within v1, breaking changes require a new version and a communicated migration window.

Illustrative request:

```http
GET /api/v1/articles?limit=2&topic=databases
Authorization: Bearer us_live_...
If-None-Match: "page_example"
```

Illustrative response:

```json
{
  "data": [
    {
      "id": "art_01JABC",
      "slug": "how-a-queue-survives-a-region-failure",
      "schema_version": "1",
      "revision_id": "rev_01JXYZ",
      "title": "How a queue survives a region failure",
      "tldr": ["..."],
      "topic": "distributed-systems",
      "source": {
        "name": "Example Engineering",
        "url": "https://source.example/post"
      },
      "diagram": {
        "kind": "flow",
        "nodes": [],
        "edges": [],
        "text_alternative": "Requests enter a regional queue..."
      },
      "provenance": {
        "model_id": "cf/qwen/qwen3-30b-a3b-fp8",
        "prompt_version": "2026-10-01",
        "schema_version": "1",
        "source_refs": ["s1"]
      },
      "sources": [
        {
          "id": "s1",
          "label": "Example Engineering",
          "url": "https://source.example/post"
        }
      ],
      "review": {
        "mode": "automated",
        "reviewer": null
      },
      "source_published_at": "2026-10-28T09:00:00Z",
      "generated_at": "2026-10-29T02:14:00Z",
      "published_at": "2026-10-29T02:15:00Z",
      "license": {
        "name": "CC BY 4.0",
        "url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": "Based on Understory, licensed under CC BY 4.0.",
        "modified": false
      }
    }
  ],
  "next_cursor": "eyJwdWJsaXNoZWRBdCI6..."
}
```

Illustrative change feed:

```json
{
  "changes": [
    {
      "sequence": 1042,
      "type": "published",
      "article_id": "art_01JABC",
      "revision_id": "rev_01JXYZ",
      "occurred_at": "2026-10-29T02:15:00Z"
    },
    {
      "sequence": 1043,
      "type": "withdrawn",
      "article_id": "art_01JOLD",
      "revision_id": null,
      "occurred_at": "2026-10-29T06:00:00Z",
      "tombstone": true
    }
  ],
  "next_cursor": "..."
}
```

**Sync model:** capture a starting change sequence, scan the catalog with stable article-ID pagination, capture an ending sequence, then replay all intervening changes before checkpointing the ending cursor. This avoids relying on mutable source-date pagination as a snapshot. Read these operations with primary/session consistency; replay must cover every catalog mutation. Publications, corrections, and withdrawals append monotonically in the same D1 transaction as publication state. The shared `publicationStatements` path covers manual and automatic publication; extend it once, not separate route-specific hooks. Store a rights-filtered publication record with the revision's metadata so historical responses do not mix old text with current headlines or review state. Bootstrap publication records for existing published revisions before enabling v1. Deliver the global change stream and let clients filter locally, so a topic/source change cannot leave a stale matching item behind. Changes are retained 90 days. An expired cursor returns `409 cursor_expired` and requires a full resync. Withdrawn articles return `410 gone`. The change feed never implies that a license was revoked.

**Timestamp mapping:** existing `articles.published_at` is the source post date, not Understory's publication time. Use revision `created_at` for `generated_at`; record the publication event time for `published_at`. Existing `reviewed_at` can backfill publication time where its provenance is known; otherwise return an explicit unknown rather than inventing a date. Map automated review from authoritative publication records, not the presence of a reviewer string alone.

**Illustrative errors:**

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "Request allowance exhausted for this billing period.",
    "request_id": "req_01J..."
  }
}
```

```json
{
  "error": {
    "code": "invalid_key",
    "message": "The API key is missing, revoked, or not valid for this organization.",
    "request_id": "req_01J..."
  }
}
```

**Authentication:** high-entropy, scoped keys, hashed at rest, shown once, with rotation and revocation. Two active keys per organization. GitHub OAuth is proposed for account access using maintained tooling, with secure sessions, `state` validation, and CSRF protection. `ADMIN_TOKEN` remains editorial administration only and is never customer authentication.

**Quota and caching rules:** authenticate, check entitlement, and meter every request, including cache hits and `304` responses. The quota counter is incremented with an exact D1 conditional update, `used = used + 1 WHERE used < limit`, before a prepared successful `200` or `304` is returned. Concurrent requests that lose the race receive `429`; there is no overage. A network loss after admission may count because the increment is durable. Error responses, docs, and the usage endpoint are exempt from the allowance but still throttled. If the quota database is unavailable, fail closed with `503`. The burst limiter is an approximate edge limit targeting 60 requests per minute per organization and is not financial truth. Verify the selected binding's supported window sizes before implementation; do not promise an exact global rolling window. Internal caches may store sanitized shared catalog bodies only. Authenticated account responses are never publicly cached. Key revocation invalidates cached authentication immediately.

## Pricing hypothesis

There is exactly one hypothesis. It is not validated.

| Term | Value |
| --- | --- |
| Price | `$99` per organization per month |
| Allowance | `25,000` countable requests per billing period |
| Burst | `60` requests per minute per organization |
| Keys | `2` active keys |
| Support | Email support, no SLA |
| Trial | `14` days, `1,000` requests, verified account |
| Overages | None automatic; hard cap with manual upgrade |
| Annual deals | Not offered in the MVP |
| Generation credits | Not offered |

Arithmetic: `$99 / 25,000 = $0.00396` per countable request, roughly `$0.004`. The average daily allowance is `25,000 / 30 = 833`, about `0.58` requests per minute. The burst limit is far above the average and is intended for legitimate integration spikes, not sustained traffic. The trial averages `1,000 / 14 = 71` requests per day.

A countable request is an authenticated request for article data that returns `200` or `304`, including a cache hit. Authentication failures, validation errors, `429` responses, docs, and the usage endpoint do not consume the allowance. The billing period follows the Stripe subscription period. Trial usage is separate and does not roll over. A manual upgrade changes the subscription and starts the new allowance according to the resulting subscription period. No automatic overage, no annual discount, and no generation credits are in scope.

**Subscription lifecycle (Proposal):**

1. Trial starts after account verification. It ends after 14 days or 1,000 requests, whichever comes first, with no automatic charge.
2. Checkout is created server-side with organization, customer, and price bound on the server. Redirect never activates access.
3. Paid access activates only after server-side reconciliation confirms a paid invoice for the expected organization, subscription, price, and service period plus an active subscription. A signed webhook triggers reconciliation; `active` status alone or a paid unrelated invoice never grants access.
4. `cancel_at_period_end` keeps access until the period ends, then disables keys.
5. A renewal failure gets a 3-day grace period. An initial payment failure gets no access.
6. Duplicate webhooks are acknowledged after durable deduplication. Out-of-order events are reconciled against the latest Stripe subscription state and serialized so an older event cannot overwrite a newer state. A scheduled reconciliation repairs missed events; local `paid_through` and grace deadlines are checked on every request, even if a cancellation webhook is delayed.
7. Refunds, chargebacks, tax treatment, and dunning copy remain open decisions.

**Account panel (Proposal):** minimal SSR pages for sign-in, organization, keys, usage, and billing. The key page creates, rotates, and revokes keys and shows the secret once. The usage page shows used, limit, remaining, period dates, burst rejects, and recent errors. The billing page links to the Stripe customer portal. Forms must work without client JavaScript, use labels and fieldsets, expose visible focus, announce errors, and include table captions. Account responses use `Cache-Control: private, no-store`.

**Merchant decisions unresolved:** country and legal entity, tax registration and collection, Stripe account ownership, applicable payment fees, refund policy, privacy policy, terms of service, and whether a data processing agreement is required. These must be resolved before accepting money.

## Unit economics

**Vendor prices rechecked 2026-11-06:**

- Workers Paid is `$5/month`, including 10M requests and 30M CPU-ms, then `$0.30/M` requests and `$0.02/M` CPU-ms, per [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- D1 paid includes 25B reads, 50M writes, and 5GB storage, per [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
- Workers AI includes 10,000 neurons per day free, then `$0.011` per 1,000 neurons on Paid, per [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- `@cf/qwen/qwen3-30b-a3b-fp8` is `$0.051/M` input tokens and `$0.335/M` output tokens on the same page.
- Queues Paid includes 1M operations/month, then `$0.40/M`; a small successful message typically uses three operations, retries add reads, per [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).
- Workers Logs Paid currently retains logs for 7 days. Logs pricing changes on 2026-12-01 and must be rechecked before launch; a longer retention policy requires separately budgeted storage/export.

**Illustrative inference math:** 6,000 input tokens plus 2,000 output tokens costs `(6,000 × 0.051 / 1,000,000) + (2,000 × 0.335 / 1,000,000) = 0.000306 + 0.00067 = $0.000976` per inference before the free neuron allowance and retries. This is **not** an observed per-article cost. The token-to-neuron conversion, retry rate, prompt size, and validation failures are not measured. Generation is shared once and reused across all reads. Marginal read cost is Worker execution, D1 reads, and cache serving, not inference.

**Illustrative monthly pilot costs:**

| Item | Estimate | Basis |
| --- | --- | --- |
| Workers Paid base | `$5` | Verified base price |
| 25,000 requests per org | `$0.0075` request overage if outside included 10M | `25,000 / 1,000,000 × $0.30` |
| Worker CPU | Included at pilot volume | 30M CPU-ms included; per-request CPU not measured |
| D1 reads and writes | Included at pilot volume | 25B reads and 50M writes included; quota increments are writes |
| D1 indexes and storage | Included at pilot volume | 5GB included; snapshot bodies are not public |
| Queues and retries | Expected `$0` incremental | Subject to shared 1M included operations; measure discovery and retry traffic |
| Workers AI | `$0.06` to `$0.35` before free allowance | 60 to 300 illustrative generations at `$0.000976`, plus retries; actual incremental bill may be `$0` within the daily allocation |
| Auth | `$0` for GitHub OAuth | Email delivery cost not verified |
| Email and support tooling | Unresolved | Vendor and volume not chosen |
| Logs and storage | Low single digits | Pricing changes 2026-12-01 |
| Payment fees | Unresolved | Depends on merchant country and entity |

**Provisional small-pilot infrastructure allowance: `$25` to `$75` per month.** This is not a quote, budget authorization, or forecast. It excludes editorial labor, support labor, legal review, tax, and payment processing fees. At a hypothetical 10 organizations, revenue is `$990` per month before payment fees, infrastructure, and labor; that is arithmetic on the hypothesis, not a demand forecast. Payment fees alone could be material. As an explicitly unverified sensitivity, a `3% + $0.30` card fee would be `$3.27` per `$99` charge, or `$32.70` for ten charges, before tax and currency differences. The actual rate is unresolved.

The existing `9,000` neuron daily cap stays in place pending budget approval. Alerts are separate from caps: notify at 50, 80, and 100 percent of usage, on billing failures, and on quota reject spikes, but do not automatically suspend a paying organization unless an explicit operational cap or entitlement decision says so. Exhausting AI budget pauses generation, not reading, and the published archive keeps serving.

## Delivery plan

**Estimate:** 6 to 8 weeks for one experienced developer, excluding legal review, design partner recruitment, and payment account approval. This is an estimate, not a commitment.

### Milestone 1: customer, rights, and sample validation (weeks 1 to 2)

**Deliverables:** ten buyer interviews; three design-partner candidates; a written rights checklist; one sample newsletter integration against a mock `/api/v1`; a go/no-go note. No production billing.

**Touchpoints:** read-only inspection of [src/web/routes/api.ts](../../../src/web/routes/api.ts), [src/domain/explanation.ts](../../../src/domain/explanation.ts), and [CONTENT-LICENSE.md](../../../CONTENT-LICENSE.md). Proposed artifacts: `docs/superpowers/specs/api-v1-rights-checklist.md` and `examples/newsletter-sample.ts`.

**Acceptance:** at least three teams confirm the integration shape is useful; rights counsel identifies no blocker for the filtered DTO; no claim of demand is made from fewer than ten interviews.

### Milestone 2: read API, auth, quota, sync (weeks 2 to 4)

**Deliverables:** versioned routes, rights-filtered DTO, account and key schema, OAuth sessions, entitlement middleware, atomic quota, burst limiter, change log, usage endpoint, cursor expiry, tombstones.

**Existing files likely touched:** [src/web/index.ts](../../../src/web/index.ts), [src/infrastructure/db.ts](../../../src/infrastructure/db.ts), [src/web/lib/cache.ts](../../../src/web/lib/cache.ts), [src/web/lib/content.ts](../../../src/web/lib/content.ts), [src/domain/explanation.ts](../../../src/domain/explanation.ts), [migrations/0001_init.sql](../../../migrations/0001_init.sql) read-only.

**Proposed files:** `migrations/0003_saas.sql`, `src/domain/api-v1.ts`, `src/infrastructure/accounts.ts`, `src/infrastructure/changes.ts`, `src/infrastructure/usage.ts`, `src/web/routes/api-v1.ts`, `src/web/lib/api-auth.ts`, `src/web/lib/quota.ts`, `tests/api-v1.test.ts`, `tests/auth.test.ts`, `tests/quota.test.ts`, `tests/sync.test.ts`.

**Acceptance gates:** existing free reader and `/api/articles` contract unchanged; no draft, snapshot, quotation, or private-field leakage; tenant isolation on every object lookup; concurrent requests at the limit never exceed it; revoked keys fail immediately even on cached paths; full sync and change sync produce identical published sets; withdrawals return `410` and tombstones; cursor expiry returns `409`.

### Milestone 3: billing, panel, docs (weeks 4 to 5)

**Deliverables:** Stripe Checkout subscription, Billing, and Portal; signed raw webhook verification; durable event deduplication; subscription reconciliation; trial; 3-day renewal grace; SSR account pages; API reference and TypeScript examples.

**Proposed files:** `src/infrastructure/billing.ts`, `src/web/routes/billing.ts`, `src/web/routes/account.tsx`, `src/web/lib/billing.ts`, `migrations/0004_billing.sql`, `docs/api-v1.md`, `examples/newsletter.ts`, `examples/curl.md`, `tests/billing.test.ts`, `tests/panel.test.ts`.

**External references:** [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks), [Checkout subscriptions](https://docs.stripe.com/payments/checkout/build-subscriptions), and [customer portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal).

**Acceptance gates:** access never activates from a redirect; duplicate and out-of-order billing events converge to the latest state; initial payment failure grants no access; renewal failure grants exactly three days; cancellation at period end disables keys at the boundary; panel is keyboard accessible and works without client JavaScript; no secret is logged.

### Milestone 4: staging and hardening (weeks 6 to 7)

**Deliverables:** staging environment, canary and `SAAS_API_ENABLED` feature flag, backups and restore drill, load test at twice the burst target, monitoring dashboards, alert routing, runbooks, retention jobs, and a rollback plan.

**Proposed files:** `src/web/lib/observability.ts`, `scripts/restore-drill.md`, `docs/runbooks/api-v1.md`, `tests/security.test.ts` additions, `tests/restore.test.ts`.

**Acceptance gates:** restore and rollback rehearsed; tenant isolation and secret redaction re-tested; quota and billing behavior unchanged under load; dashboards show latency, errors, freshness, queue backlog, usage, and billing state.

### Milestone 5: paid pilot (weeks 7 to 8)

**Deliverables:** two paying pilot organizations or a documented stop decision, onboarding checklist, support rota, monthly usage report, and a pricing/retention review.

**Acceptance:** both pilots complete a first sync and one incremental sync; time-to-integrate is recorded; no unresolved rights, tax, or privacy blocker remains.

**Future tests are targeted files only.** Do not add broad end-to-end suites or run application tests as part of this planning step.

## Reliability and operations

**Proposal:** internal targets of 99.5 percent monthly availability and p95 under 500 ms for cached list and item reads. These are unmeasured and are **not an SLA**. They imply about 3 hours 39 minutes of monthly downtime on a 30-day month, but no measurement exists to support the claim. There is no freshness guarantee. The archive must continue serving when AI generation is paused because explainers are precomputed.

Monitor request latency, 5xx rate, source freshness lag, queue backlog, quota rejects, usage versus billing state, and webhook failures. Use a canary, feature flag, and scheduled D1 export or backup. Keep redacted native logs for 7 days under current Paid retention; recheck the December pricing change before launch. Keep the change feed for 90 days. Apply lawful retention and deletion requests, including key revocation and organization deletion, while retaining billing records only where law or tax rules require it. A privacy policy, terms, and DPA are unresolved and may be required.

## Go-to-market validation

**Proposal:** before any expansion, conduct ten buyer interviews, recruit three design partners, and obtain two paid commitments. A design partner may receive a documented pilot discount, but no free permanent access is promised. "Paid commitment" means a signed order or paid invoice, not verbal interest.

Recruit through direct, personalized outreach to newsletter operators with public engineering coverage and developer-education teams that already publish curated reading. Ask who selects content, what their current feed-to-publication workflow costs in time, who owns the budget, whether automated review is acceptable, what attribution they can display, and why the free API is insufficient. Show one real, rights-reviewed explainer and a mock response. Ask for a pilot integration and the proposed `$99/month` purchase, not a hypothetical willingness-to-pay survey. Record objections and purchasing constraints. Use the public reader as a sample library; defer paid ads and marketplace launches until repeat usage and renewals exist.

Assets: a sample newsletter integration, `curl` examples, and a TypeScript client that performs a full sync and then polls changes. Measure first-sync completion time, time-to-integrate, weekly active organizations, trial conversion, renewal, reported usefulness, support minutes per organization, and gross margin after infrastructure and payment fees. Shipping metrics are not demand metrics.

**Stop rule:** if ten interviews and three design partners do not produce two paid commitments by the end of the paid pilot, stop expansion, keep the free reader and free API, and document the negative result. Do not add features to manufacture demand.

## Later, explicitly deferred

Customer-owned generation would require per-tenant privacy, deletion, data isolation, and prompt-injection defenses. URL ingestion and outbound webhooks would require SSRF controls, redirect and DNS rebinding defenses, size and time limits, request signatures, idempotency, and retry policies. Chat, RAG, MCP, SSO, and marketplace listings are deferred. None of these belongs in the MVP.

## Open decisions and sources

Decisions needed before implementation or charging money:

1. Approve a scope change to `PRODUCT.md` that permits customer accounts and a paid API while preserving the free reader and existing free API.
2. Approve or reject paid Cloudflare hosting, the provisional `$25` to `$75` pilot allowance, and any change to the `9,000` neuron cap.
3. Complete rights review for the filtered DTO, derivative use, source terms, attribution, and takedown handling.
4. Resolve merchant country, legal entity, tax, Stripe account, payment fees, refunds, privacy, terms, and DPA applicability.
5. Validate or reject the single `$99` pricing hypothesis through interviews and paid commitments.
6. Approve retention, deletion, and support-response expectations.

Local sources: [PRODUCT.md](../../../PRODUCT.md), [CONTENT-LICENSE.md](../../../CONTENT-LICENSE.md), [LICENSE](../../../LICENSE), [src/web/routes/api.ts](../../../src/web/routes/api.ts), [src/infrastructure/db.ts](../../../src/infrastructure/db.ts), [src/domain/explanation.ts](../../../src/domain/explanation.ts), [src/domain/pagination.ts](../../../src/domain/pagination.ts), [src/web/index.ts](../../../src/web/index.ts), [migrations/0001_init.sql](../../../migrations/0001_init.sql), and existing tests in [tests](../../../tests).

External sources rechecked 2026-11-06: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), and [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).
