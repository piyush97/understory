import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { buildApiArticle, decodeApiCursor, encodeApiCursor, type ApiV1Article } from "../../domain/api-v1";
import {
  allowBurst,
  consumeQuota,
  getApiArticle,
  getApiRevision,
  listApiArticles,
  listApiChanges,
  readUsage,
  type ApiArticleRecord,
  type ApiKeyAuth,
} from "../../infrastructure/api";
import { absoluteUrl } from "../lib/format";
import {
  BURST_LIMIT,
  authenticateApiRequest,
  billingPeriodStart,
  retryAfterSeconds,
  sha256Hex,
  windowStart,
} from "../lib/api-auth";

const BASE_HEADERS = {
  "Cache-Control": "private, max-age=0, must-revalidate",
  Vary: "Authorization",
} as const;

type Gate = { auth: ApiKeyAuth; now: Date };

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Authorization",
      ...extra,
    },
  });
}

function quotaHeaders(limit: number, remaining: number): Record<string, string> {
  return {
    "X-Quota-Limit": String(limit),
    "X-Quota-Remaining": String(remaining),
    "RateLimit-Limit": String(BURST_LIMIT),
    "RateLimit-Policy": `${BURST_LIMIT};w=60`,
  };
}

/** Authenticates and applies the per-minute burst limit. */
async function guard(c: Context<AppEnv>): Promise<Gate | Response> {
  const now = new Date();
  const outcome = await authenticateApiRequest(c.env.DB, c.req.header("Authorization"), now);
  if (!outcome.ok) {
    if (outcome.reason === "inactive") {
      return errorResponse(402,
        "payment_required",
        "This organization has no active subscription. Renew in the Understory account panel.",
      );
    }
    return errorResponse(401,
      "invalid_api_key",
      "Send a valid key as: Authorization: Bearer <key>.",
      { "WWW-Authenticate": 'Bearer realm="understory"' },
    );
  }
  const orgId = outcome.auth.org.id;
  if (!(await allowBurst(c.env.DB, orgId, windowStart(now), BURST_LIMIT))) {
    return errorResponse(429, "rate_limited", "Limit is 60 requests per minute per organization.", {
      "Retry-After": String(retryAfterSeconds(now)),
      ...quotaHeaders(outcome.auth.org.requestLimit, 0),
    });
  }
  return { auth: outcome.auth, now };
}

/** Counts a metered request. Only successful resource lookups are charged. */
async function charge(gate: Gate, c: Context<AppEnv>): Promise<number | Response> {
  const { auth, now } = gate;
  const remaining = await consumeQuota(
    c.env.DB,
    auth.org.id,
    billingPeriodStart(now),
    auth.org.requestLimit,
    now.toISOString(),
  );
  if (remaining === null) {
    return errorResponse(429,
      "quota_exhausted",
      `Monthly allowance of ${auth.org.requestLimit} requests is used up. It resets on the 1st.`,
      quotaHeaders(auth.org.requestLimit, 0),
    );
  }
  return remaining;
}

async function respond(
  c: Context<AppEnv>,
  payload: unknown,
  gate: Gate,
  remaining: number,
  extra: Record<string, string> = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
  const headers = {
    ...BASE_HEADERS,
    ...quotaHeaders(gate.auth.org.requestLimit, remaining),
    ETag: etag,
    ...extra,
  };
  if (c.req.header("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function dto(record: ApiArticleRecord, siteUrl: string): ApiV1Article {
  return buildApiArticle({
    article: {
      id: record.id,
      slug: record.slug,
      url: absoluteUrl(siteUrl, `/articles/${record.slug}`),
      sourcePublishedAt: record.sourcePublishedAt,
      sourceName: record.sourceName,
      sourceUrl: record.sourceUrl,
      topicLabel: record.topicLabel,
    },
    revision: record.revision,
    explanation: record.explanation,
  });
}

function pageLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function renderApiV1Articles(c: Context<AppEnv>): Promise<Response> {
  const gate = await guard(c);
  if (gate instanceof Response) return gate;

  const topic = c.req.query("topic")?.trim() || null;
  if (topic !== null && topic.length > 64) {
    return errorResponse(400, "invalid_topic", "topic must be 64 characters or fewer.");
  }
  const rawCursor = c.req.query("cursor");
  const cursor = decodeApiCursor(rawCursor, topic);
  if (rawCursor && !cursor) {
    return errorResponse(400, "invalid_cursor", "cursor is invalid or belongs to another filter.");
  }

  const limit = pageLimit(c.req.query("limit"), 20, 50);
  const page = await listApiArticles(c.env.DB, { topic, cursor, limit });
  const remaining = await charge(gate, c);
  if (remaining instanceof Response) return remaining;

  const last = page.items[page.items.length - 1];
  return respond(
    c,
    {
      data: page.items.map((item) => dto(item, c.env.SITE_URL)),
      has_more: page.hasMore,
      next_cursor:
        page.hasMore && last
          ? encodeApiCursor({ publishedAt: last.sourcePublishedAt, id: last.id, topic: topic ?? "" })
          : null,
    },
    gate,
    remaining,
  );
}

export async function renderApiV1Article(c: Context<AppEnv>): Promise<Response> {
  const gate = await guard(c);
  if (gate instanceof Response) return gate;

  const record = await getApiArticle(c.env.DB, { id: c.req.param("id") });
  if (!record) return errorResponse(404, "not_found", "No published article matches that id.");
  const remaining = await charge(gate, c);
  if (remaining instanceof Response) return remaining;

  return respond(c, { data: dto(record, c.env.SITE_URL) }, gate, remaining);
}

export async function renderApiV1Revision(c: Context<AppEnv>): Promise<Response> {
  const gate = await guard(c);
  if (gate instanceof Response) return gate;

  const record = await getApiRevision(
    c.env.DB,
    c.req.param("id") ?? "",
    c.req.param("revisionId") ?? "",
  );
  if (!record) return errorResponse(404, "not_found", "No published revision matches that id.");
  const remaining = await charge(gate, c);
  if (remaining instanceof Response) return remaining;

  return respond(c, { data: dto(record, c.env.SITE_URL) }, gate, remaining);
}

export async function renderApiV1Changes(c: Context<AppEnv>): Promise<Response> {
  const gate = await guard(c);
  if (gate instanceof Response) return gate;

  const afterRaw = c.req.query("after") ?? "0";
  const after = Number.parseInt(afterRaw, 10);
  if (!Number.isFinite(after) || after < 0) {
    return errorResponse(400, "invalid_cursor", "after must be a non-negative change sequence.");
  }
  const limit = pageLimit(c.req.query("limit"), 100, 200);
  const changes = await listApiChanges(c.env.DB, { after, limit });
  const remaining = await charge(gate, c);
  if (remaining instanceof Response) return remaining;

  const last = changes[changes.length - 1];
  return respond(
    c,
    {
      data: changes.map((change) => ({
        sequence: change.sequence,
        article_id: change.articleId,
        revision_id: change.revisionId,
        type: change.type,
        occurred_at: change.occurredAt,
      })),
      next_after: last ? last.sequence : after,
    },
    gate,
    remaining,
  );
}

export async function renderApiV1Usage(c: Context<AppEnv>): Promise<Response> {
  const gate = await guard(c);
  if (gate instanceof Response) return gate;

  const periodStart = billingPeriodStart(gate.now);
  const usage = await readUsage(c.env.DB, gate.auth.org.id, periodStart);
  const limit = gate.auth.org.requestLimit;
  const used = usage?.used ?? 0;
  return respond(
    c,
    {
      data: {
        organization: gate.auth.org.name,
        status: gate.auth.org.status,
        period_start: periodStart,
        limit,
        used,
        remaining: Math.max(0, limit - used),
      },
    },
    gate,
    Math.max(0, limit - used),
  );
}
