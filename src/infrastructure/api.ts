import { validateExplanation, type Explanation } from "../domain/explanation";
import type { ApiCursor } from "../domain/api-v1";

export type ApiOrg = {
  id: string;
  name: string;
  status: "trial" | "active" | "past_due" | "canceled";
  requestLimit: number;
  trialEndsAt: string | null;
  paidThrough: string | null;
  graceEndsAt: string | null;
};

export type ApiKeyAuth = { keyId: string; org: ApiOrg };

type ApiKeyRow = {
  key_id: string;
  org_id: string;
  name: string;
  status: ApiOrg["status"];
  request_limit: number;
  trial_ends_at: string | null;
  paid_through: string | null;
  grace_ends_at: string | null;
};

export async function findApiKey(db: D1Database, keyHash: string): Promise<ApiKeyAuth | null> {
  const row = await db
    .prepare(
      `SELECT k.id AS key_id, o.id AS org_id, o.name, o.status, o.request_limit,
              o.trial_ends_at, o.paid_through, o.grace_ends_at
         FROM api_keys k
         JOIN api_orgs o ON o.id = k.org_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    )
    .bind(keyHash)
    .first<ApiKeyRow>();
  if (!row) return null;
  return {
    keyId: row.key_id,
    org: {
      id: row.org_id,
      name: row.name,
      status: row.status,
      requestLimit: row.request_limit,
      trialEndsAt: row.trial_ends_at,
      paidThrough: row.paid_through,
      graceEndsAt: row.grace_ends_at,
    },
  };
}

/**
 * Counts one request against the fixed-window burst limit. Exceeding the limit
 * does not advance the counter, so a throttled client recovers at the next
 * window instead of extending its own lockout.
 */
export async function allowBurst(
  db: D1Database,
  orgId: string,
  windowStart: string,
  limit: number,
): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO api_burst (org_id, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(org_id, window_start) DO UPDATE SET count = count + 1
       WHERE count < ?
       RETURNING count`,
    )
    .bind(orgId, windowStart, limit)
    .first<{ count: number }>();
  return inserted !== null;
}

/**
 * Metered allowance. Returns the remaining count, or null when the allowance is
 * exhausted. The conditional update makes concurrent requests race safely.
 */
export async function consumeQuota(
  db: D1Database,
  orgId: string,
  periodStart: string,
  limit: number,
  now: string,
): Promise<number | null> {
  await db
    .prepare(
      `INSERT INTO api_usage (org_id, period_start, used, limit_count, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(org_id, period_start) DO UPDATE SET limit_count = excluded.limit_count`,
    )
    .bind(orgId, periodStart, limit, now)
    .run();
  const updated = await db
    .prepare(
      `UPDATE api_usage SET used = used + 1, updated_at = ?
        WHERE org_id = ? AND period_start = ? AND used < limit_count
        RETURNING used, limit_count`,
    )
    .bind(now, orgId, periodStart)
    .first<{ used: number; limit_count: number }>();
  if (!updated) return null;
  return Math.max(0, updated.limit_count - updated.used);
}

export type ApiUsageRow = { used: number; limitCount: number; periodStart: string };

export async function readUsage(
  db: D1Database,
  orgId: string,
  periodStart: string,
): Promise<ApiUsageRow | null> {
  const row = await db
    .prepare(`SELECT used, limit_count, period_start FROM api_usage WHERE org_id = ? AND period_start = ?`)
    .bind(orgId, periodStart)
    .first<{ used: number; limit_count: number; period_start: string }>();
  if (!row) return null;
  return { used: row.used, limitCount: row.limit_count, periodStart: row.period_start };
}

export type ApiArticleRecord = {
  id: string;
  slug: string;
  canonicalUrl: string;
  sourcePublishedAt: string;
  sourceName: string;
  sourceUrl: string;
  topicLabel: string | null;
  revision: {
    id: string;
    createdAt: string;
    reviewedAt: string | null;
    reviewedBy: string | null;
    modelId: string | null;
    promptVersion: string | null;
    schemaVersion: string | null;
  };
  explanation: Explanation;
};

type ApiArticleRow = {
  id: string;
  slug: string;
  canonical_url: string;
  source_published_at: string | null;
  source_name: string;
  source_url: string;
  topic_label: string | null;
  revision_id: string;
  revision_created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  model_id: string | null;
  prompt_version: string | null;
  schema_version: string | null;
  content_json: string;
};

const API_ARTICLE_COLUMNS = `a.id, a.slug, a.canonical_url, a.published_at AS source_published_at,
         s.name AS source_name, s.site_url AS source_url, t.label AS topic_label,
         r.id AS revision_id, r.created_at AS revision_created_at,
         r.reviewed_at, r.reviewed_by, r.model_id, r.prompt_version, r.schema_version,
         r.content_json`;

const API_ARTICLE_JOINS = `FROM articles a
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN topics t ON t.id = a.topic_id`;

const API_ARTICLE_SELECT = `SELECT ${API_ARTICLE_COLUMNS} ${API_ARTICLE_JOINS}
    JOIN explanation_revisions r ON r.id = a.published_revision_id`;

function parseContent(value: string): Explanation | null {
  try {
    const result = validateExplanation(JSON.parse(value) as unknown);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

function toRecord(row: ApiArticleRow): ApiArticleRecord | null {
  const explanation = parseContent(row.content_json);
  if (!explanation) return null;
  return {
    id: row.id,
    slug: row.slug,
    canonicalUrl: row.canonical_url,
    sourcePublishedAt: row.source_published_at ?? row.revision_created_at,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    topicLabel: row.topic_label,
    revision: {
      id: row.revision_id,
      createdAt: row.revision_created_at,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
      modelId: row.model_id,
      promptVersion: row.prompt_version,
      schemaVersion: row.schema_version,
    },
    explanation,
  };
}

export async function listApiArticles(
  db: D1Database,
  options: { topic: string | null; cursor: ApiCursor | null; limit: number },
): Promise<{ items: ApiArticleRecord[]; hasMore: boolean }> {
  const conditions = ["a.status = 'published'", "a.published_revision_id IS NOT NULL"];
  const bindings: unknown[] = [];
  if (options.topic) {
    conditions.push(
      "(a.topic_id = ? OR EXISTS (SELECT 1 FROM article_topics at WHERE at.article_id = a.id AND at.topic_id = ?))",
    );
    bindings.push(options.topic, options.topic);
  }
  if (options.cursor) {
    conditions.push("(a.published_at < ? OR (a.published_at = ? AND a.id < ?))");
    bindings.push(options.cursor.publishedAt, options.cursor.publishedAt, options.cursor.id);
  }
  bindings.push(options.limit + 1);

  const rows = await db
    .prepare(
      `${API_ARTICLE_SELECT}
        WHERE ${conditions.join(" AND ")}
        ORDER BY a.published_at DESC, a.id DESC
        LIMIT ?`,
    )
    .bind(...bindings)
    .all<ApiArticleRow>();

  const records: ApiArticleRecord[] = [];
  for (const row of rows.results ?? []) {
    const record = toRecord(row);
    if (record) records.push(record);
  }
  const hasMore = records.length > options.limit;
  return { items: hasMore ? records.slice(0, options.limit) : records, hasMore };
}

export async function getApiArticle(
  db: D1Database,
  options: { id?: string; slug?: string },
): Promise<ApiArticleRecord | null> {
  const column = options.id !== undefined ? "a.id" : "a.slug";
  const value = options.id ?? options.slug ?? "";
  const row = await db
    .prepare(`${API_ARTICLE_SELECT} WHERE ${column} = ? AND a.status = 'published'`)
    .bind(value)
    .first<ApiArticleRow>();
  return row ? toRecord(row) : null;
}

/**
 * Historical revisions are served only when the change feed recorded a
 * publication event for them, so drafts and rejected edits stay private.
 */
export async function getApiRevision(
  db: D1Database,
  articleId: string,
  revisionId: string,
): Promise<ApiArticleRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${API_ARTICLE_COLUMNS} ${API_ARTICLE_JOINS}
         JOIN explanation_revisions r ON r.id = ? AND r.article_id = a.id
         JOIN api_changes c ON c.revision_id = r.id AND c.article_id = a.id
        WHERE a.id = ?`,
    )
    .bind(revisionId, articleId)
    .first<ApiArticleRow>();
  return row ? toRecord(row) : null;
}

export type ApiChangeRecord = {
  sequence: number;
  articleId: string;
  revisionId: string | null;
  type: "published" | "corrected" | "withdrawn";
  occurredAt: string;
};

export async function listApiChanges(
  db: D1Database,
  options: { after: number; limit: number },
): Promise<ApiChangeRecord[]> {
  const rows = await db
    .prepare(
      `SELECT sequence, article_id, revision_id, type, occurred_at
         FROM api_changes
        WHERE sequence > ?
        ORDER BY sequence ASC
        LIMIT ?`,
    )
    .bind(options.after, options.limit)
    .all<{
      sequence: number;
      article_id: string;
      revision_id: string | null;
      type: ApiChangeRecord["type"];
      occurred_at: string;
    }>();
  return (rows.results ?? []).map((row) => ({
    sequence: row.sequence,
    articleId: row.article_id,
    revisionId: row.revision_id,
    type: row.type,
    occurredAt: row.occurred_at,
  }));
}
