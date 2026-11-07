# Understory API v1

Paid, versioned read access to published Understory explainers. The free public
API (`/api/articles`, `/api/articles/:slug`) returns summaries only: headline,
one-sentence summary, TL;DR, topic, source, and a `fullExplainer` link. Full
explainers, stable identifiers, immutable revisions, a change feed, and metering
need a key.

## Getting a key

Start a 14-day trial (1,000 requests, no card) at
[/developers](https://understory.piyushmehta.com/developers). The key is shown once;
Understory stores only its SHA-256 hash and does not email it. One trial per email,
three per network per day.

To subscribe ($99 a month, 25,000 requests), enter the key on the same page. Checkout
runs on Lemon Squeezy, the merchant of record for payment, tax, and invoices. The
subscription upgrades the existing key; no new key is issued.

## Authentication

```
Authorization: Bearer us_live_...
```

Keys belong to an organization. Access follows the organization's billing state:
`trial` until `trial_ends_at`, `active` while `paid_through` covers today,
`past_due` until `grace_ends_at`, then `402 payment_required`.

## Endpoints

| Endpoint | Notes |
| --- | --- |
| `GET /api/v1/articles` | `topic`, `limit` (1-50, default 20), `cursor` |
| `GET /api/v1/articles/:id` | article id from any v1 response |
| `GET /api/v1/articles/:id/revisions/:revisionId` | only revisions recorded in the change feed |
| `GET /api/v1/changes` | `after` (sequence, default 0), `limit` (1-200, default 100) |
| `GET /api/v1/usage` | current period counters; never metered |

Cursors are opaque and bound to the `topic` filter; reusing one with a different
filter returns `400 invalid_cursor`.

## Payload

`data` holds the articles. Fields are snake_case:

```
id, slug, url, schema_version, revision_id, title, dek, one_sentence, tldr[],
sections[], topic, source{name,url}, diagram{kind,title,text_alternative,
conceptual,nodes[],edges[],caption?}, tradeoffs[], when_useful[], caveats[],
reading_minutes, provenance{model_id,prompt_version,schema_version,source_refs[]},
sources[{id,label,url,note?}], review{mode,reviewer}, source_published_at,
generated_at, published_at, license{name,url,attribution,modified}
```

`review.mode` is `automated` unless a named human approved the revision.
`published_at` is when Understory published that revision; `source_published_at`
is the original article date.

Quotation blocks and evidence ids never appear: they reproduce publisher text
and internal snapshots. Content is CC BY 4.0, so keep the `license.attribution`
string when you redistribute it.

## Metering

Every successful request counts one unit; 404s, 401s, 402s, and 429s do not.

- `X-Quota-Limit`, `X-Quota-Remaining`: monthly allowance for the organization.
- `RateLimit-Limit`, `RateLimit-Policy`: 60 requests per minute, fixed window.
- `429` carries `Retry-After` (burst) or `error.code = "quota_exhausted"`.

Responses are `private` and carry an `ETag`. Send `If-None-Match` to get `304`;
revalidations still count against the allowance.

## Error shape

```json
{ "error": { "code": "invalid_api_key", "message": "..." } }
```

Codes: `invalid_api_key` (401), `payment_required` (402), `invalid_topic` /
`invalid_cursor` (400), `not_found` (404), `rate_limited` / `quota_exhausted`
(429 with `Retry-After`), `internal_error` (500).

## Syncing

1. `GET /api/v1/changes?after=lastSequence`.
2. Fetch changed articles by `article_id`, or a specific revision for audit.
3. Store `next_after` and repeat. A future `withdrawn` change means stop serving
   that article and retitle your local copy.

## Billing webhook (operators)

Lemon Squeezy posts subscription events to `POST /api/billing/lemonsqueezy`. The
Worker verifies `X-Signature` (HMAC-SHA256 of the raw body), checks store, variant,
and test mode, and ignores deliveries older than the last applied `updated_at`.

| Lemon Squeezy status | Understory access |
| --- | --- |
| `active` | `active` through `renews_at` |
| `on_trial` | `active` through `trial_ends_at` |
| `cancelled` | `active` through `ends_at` |
| `past_due` | `past_due`, 14-day grace from the first failure |
| `paused`, `unpaid`, `expired` | `canceled` |

Configuration: vars `TURNSTILE_SITE_KEY`, `TURNSTILE_HOSTNAMES` (optional),
`LEMONSQUEEZY_CHECKOUT_URL`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`,
`LEMONSQUEEZY_TEST_MODE`; secrets `TURNSTILE_SECRET`, `LEMONSQUEEZY_WEBHOOK_SECRET`.
Each feature stays closed until its settings exist. Subscribe the webhook to
`subscription_created` and `subscription_updated`.

## Manual provisioning

```bash
npm run api:provision -- --org acme --name "Acme Docs" --status trial --limit 1000 --remote
```

The key is printed once; only its SHA-256 hash is stored. Re-running the command
for an existing `--org` rotates in a new key without dropping the old one, so
revoke stale rows in `api_keys` yourself.
