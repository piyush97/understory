import type {
  Article,
  ArticleWithSource,
  Job,
  JobKind,
  PublishedArticle,
  RevisionRow,
  SourceRow,
  Topic,
} from "../domain/article";
import type { FeedCursor } from "../domain/pagination";
import { validateExplanation } from "../domain/explanation";
import { estimateReadingMinutes } from "../domain/source";

type ArticleRow = {
  id: string;
  source_id: string;
  canonical_url: string;
  original_title: string;
  published_at: string;
  discovered_at: string;
  author: string | null;
  summary: string | null;
  slug: string;
  status: string;
  context_headline: string | null;
  dek: string | null;
  topic_id: string | null;
  reading_minutes: number | null;
  published_revision_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ArticleSourceRow = ArticleRow & {
  source_name: string;
  source_site_url: string;
  source_host: string;
  topic_label: string | null;
};

type RevisionDbRow = {
  id: string;
  article_id: string;
  snapshot_id: string;
  status: string;
  content_json: string;
  provenance_json: string;
  model_id: string;
  prompt_version: string;
  schema_version: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
};

function mapRevision(row: RevisionDbRow): RevisionRow {
  return {
    id: row.id,
    articleId: row.article_id,
    snapshotId: row.snapshot_id,
    status: row.status as RevisionRow["status"],
    contentJson: row.content_json,
    provenanceJson: row.provenance_json,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
  };
}

function mapArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    sourceId: row.source_id,
    canonicalUrl: row.canonical_url,
    originalTitle: row.original_title,
    publishedAt: row.published_at,
    discoveredAt: row.discovered_at,
    author: row.author,
    summary: row.summary,
    slug: row.slug,
    status: row.status as Article["status"],
    contextHeadline: row.context_headline,
    dek: row.dek,
    topicId: row.topic_id,
    readingMinutes: row.reading_minutes,
    publishedRevisionId: row.published_revision_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArticleWithSource(row: ArticleSourceRow): ArticleWithSource {
  return {
    ...mapArticle(row),
    sourceName: row.source_name,
    sourceSiteUrl: row.source_site_url,
    sourceHost: row.source_host,
    topicLabel: row.topic_label,
  };
}

const ARTICLE_SELECT = `
  SELECT a.*, s.name AS source_name, s.site_url AS source_site_url, s.host AS source_host,
         t.label AS topic_label
  FROM articles a
  JOIN sources s ON s.id = a.source_id
  LEFT JOIN topics t ON t.id = a.topic_id
`;

export async function listFeedArticles(
  db: D1Database,
  options: { cursor?: FeedCursor | null; topic?: string | null; limit?: number },
): Promise<ArticleWithSource[]> {
  const page = await listFeedPage(db, options);
  return page.items;
}

export async function listFeedPage(
  db: D1Database,
  options: { cursor?: FeedCursor | null; topic?: string | null; limit?: number },
): Promise<{ items: ArticleWithSource[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const bindings: unknown[] = [];
  const where: string[] = ["a.status = 'published'"];

  if (options.topic) {
    where.push(`EXISTS (
      SELECT 1 FROM article_topics at WHERE at.article_id = a.id AND at.topic_id = ?
    )`);
    bindings.push(options.topic);
  }

  if (options.cursor) {
    where.push("(a.published_at < ? OR (a.published_at = ? AND a.id < ?))");
    bindings.push(options.cursor.publishedAt, options.cursor.publishedAt, options.cursor.id);
  }

  bindings.push(limit + 1);
  const result = await db
    .prepare(
      `${ARTICLE_SELECT}
       WHERE ${where.join(" AND ")}
       ORDER BY a.published_at DESC, a.id DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<ArticleSourceRow>();

  const rows = (result.results ?? []).map(mapArticleWithSource);
  return {
    items: rows.slice(0, limit),
    hasMore: rows.length > limit,
  };
}

export async function listPendingArticles(
  db: D1Database,
  limit = 4,
): Promise<ArticleWithSource[]> {
  const result = await db
    .prepare(
      `${ARTICLE_SELECT}
       WHERE a.status IN ('discovered', 'extracting', 'generating', 'review')
       ORDER BY a.published_at DESC, a.id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<ArticleSourceRow>();
  return (result.results ?? []).map(mapArticleWithSource);
}

export async function getFeedLead(db: D1Database): Promise<PublishedArticle | null> {
  const result = await db
    .prepare(
      `SELECT a.*, s.name AS source_name, s.site_url AS source_site_url, s.host AS source_host,
              t.label AS topic_label,
              r.content_json AS revision_content, r.provenance_json AS revision_provenance
       FROM articles a
       JOIN sources s ON s.id = a.source_id
       LEFT JOIN topics t ON t.id = a.topic_id
       JOIN explanation_revisions r ON r.id = a.published_revision_id
       WHERE a.status = 'published'
       ORDER BY a.published_at DESC, a.id DESC
       LIMIT 1`,
    )
    .first<ArticleSourceRow & { revision_content: string; revision_provenance: string }>();

  if (!result) return null;
  return {
    ...mapArticleWithSource(result),
    revisionId: result.published_revision_id ?? "",
    revisionContent: result.revision_content,
    revisionProvenance: result.revision_provenance,
  };
}

export async function getPublishedArticleBySlug(
  db: D1Database,
  slug: string,
): Promise<PublishedArticle | null> {
  const result = await db
    .prepare(
      `SELECT a.*, s.name AS source_name, s.site_url AS source_site_url, s.host AS source_host,
              t.label AS topic_label,
              r.content_json AS revision_content, r.provenance_json AS revision_provenance
       FROM articles a
       JOIN sources s ON s.id = a.source_id
       LEFT JOIN topics t ON t.id = a.topic_id
       JOIN explanation_revisions r ON r.id = a.published_revision_id
       WHERE a.slug = ? AND a.status = 'published'
       LIMIT 1`,
    )
    .bind(slug)
    .first<ArticleSourceRow & { revision_content: string; revision_provenance: string }>();

  if (!result) return null;
  return {
    ...mapArticleWithSource(result),
    revisionId: result.published_revision_id ?? "",
    revisionContent: result.revision_content,
    revisionProvenance: result.revision_provenance,
  };
}

export async function listRelatedArticles(
  db: D1Database,
  articleId: string,
  topicId: string | null,
  limit = 3,
): Promise<ArticleWithSource[]> {
  const result = topicId
    ? await db
        .prepare(
          `${ARTICLE_SELECT}
           JOIN article_topics at ON at.article_id = a.id
           WHERE a.status = 'published' AND a.id != ? AND at.topic_id = ?
           ORDER BY a.published_at DESC
           LIMIT ?`,
        )
        .bind(articleId, topicId, limit)
        .all<ArticleSourceRow>()
    : await db
        .prepare(
          `${ARTICLE_SELECT}
           WHERE a.status = 'published' AND a.id != ?
           ORDER BY a.published_at DESC
           LIMIT ?`,
        )
        .bind(articleId, limit)
        .all<ArticleSourceRow>();

  const related = (result.results ?? []).map(mapArticleWithSource);
  if (related.length >= limit) return related.slice(0, limit);

  const seen = new Set(related.map((article) => article.id));
  seen.add(articleId);
  const fallback = await db
    .prepare(
      `${ARTICLE_SELECT}
       WHERE a.status = 'published' AND a.id != ?
       ORDER BY a.published_at DESC
       LIMIT ?`,
    )
    .bind(articleId, limit + seen.size + 1)
    .all<ArticleSourceRow>();

  for (const row of fallback.results ?? []) {
    if (related.length >= limit) break;
    const article = mapArticleWithSource(row);
    if (seen.has(article.id)) continue;
    seen.add(article.id);
    related.push(article);
  }
  return related.slice(0, limit);
}

export async function getAdjacentArticles(
  db: D1Database,
  publishedAt: string,
  articleId: string,
): Promise<{ newer: ArticleWithSource | null; older: ArticleWithSource | null }> {
  const [newer, older] = await Promise.all([
    db
      .prepare(
        `${ARTICLE_SELECT}
         WHERE a.status = 'published'
           AND (a.published_at > ? OR (a.published_at = ? AND a.id > ?))
         ORDER BY a.published_at ASC, a.id ASC
         LIMIT 1`,
      )
      .bind(publishedAt, publishedAt, articleId)
      .first<ArticleSourceRow>(),
    db
      .prepare(
        `${ARTICLE_SELECT}
         WHERE a.status = 'published'
           AND (a.published_at < ? OR (a.published_at = ? AND a.id < ?))
         ORDER BY a.published_at DESC, a.id DESC
         LIMIT 1`,
      )
      .bind(publishedAt, publishedAt, articleId)
      .first<ArticleSourceRow>(),
  ]);

  return {
    newer: newer ? mapArticleWithSource(newer) : null,
    older: older ? mapArticleWithSource(older) : null,
  };
}

export async function listTopics(db: D1Database): Promise<Array<Topic & { count: number }>> {
  const result = await db
    .prepare(
      `SELECT t.id, t.label, t.description, t.sort_order,
              COUNT(a.id) AS count
       FROM topics t
       LEFT JOIN article_topics at ON at.topic_id = t.id
       LEFT JOIN articles a ON a.id = at.article_id AND a.status = 'published'
       GROUP BY t.id
       ORDER BY t.sort_order ASC, t.label ASC`,
    )
    .all<{
      id: string;
      label: string;
      description: string | null;
      sort_order: number;
      count: number;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    sortOrder: row.sort_order,
    count: row.count,
  }));
}

export async function getTopic(db: D1Database, id: string): Promise<Topic | null> {
  const row = await db
    .prepare("SELECT id, label, description, sort_order FROM topics WHERE id = ?")
    .bind(id)
    .first<{ id: string; label: string; description: string | null; sort_order: number }>();
  return row
    ? { id: row.id, label: row.label, description: row.description, sortOrder: row.sort_order }
    : null;
}

export async function listSources(
  db: D1Database,
): Promise<Array<SourceRow & { articleCount: number; explainedCount: number }>> {
  const result = await db
    .prepare(
      `SELECT s.id, s.name, s.site_url, s.feed_url, s.host, s.status,
              COUNT(a.id) AS article_count,
              SUM(CASE WHEN a.status = 'published' THEN 1 ELSE 0 END) AS explained_count
       FROM sources s
       LEFT JOIN articles a ON a.source_id = s.id
       GROUP BY s.id
       HAVING COUNT(a.id) > 0
       ORDER BY explained_count DESC, s.name ASC`,
    )
    .all<{
      id: string;
      name: string;
      site_url: string;
      feed_url: string | null;
      host: string;
      status: "active" | "paused";
      article_count: number;
      explained_count: number;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    siteUrl: row.site_url,
    feedUrl: row.feed_url,
    host: row.host,
    status: row.status,
    articleCount: row.article_count,
    explainedCount: row.explained_count,
  }));
}

export async function getCounts(
  db: D1Database,
): Promise<{ published: number; sources: number; topics: number; inReview: number }> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM articles WHERE status = 'published') AS published,
        (SELECT COUNT(*) FROM sources WHERE status = 'active') AS sources,
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM explanation_revisions WHERE status = 'draft') AS in_review`,
    )
    .first<{ published: number; sources: number; topics: number; in_review: number }>();

  return {
    published: row?.published ?? 0,
    sources: row?.sources ?? 0,
    topics: row?.topics ?? 0,
    inReview: row?.in_review ?? 0,
  };
}

export async function listReviewQueue(
  db: D1Database,
  limit = 40,
): Promise<Array<RevisionRow & { originalTitle: string; sourceName: string; slug: string }>> {
  const result = await db
    .prepare(
      `SELECT r.*, a.original_title, a.slug, s.name AS source_name
       FROM explanation_revisions r
       JOIN articles a ON a.id = r.article_id
       JOIN sources s ON s.id = a.source_id
       WHERE r.status IN ('draft', 'rejected')
       ORDER BY r.created_at ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<
      RevisionDbRow & { original_title: string; source_name: string; slug: string }
    >();

  return (result.results ?? []).map((row) => ({
    ...mapRevision(row),
    originalTitle: row.original_title,
    sourceName: row.source_name,
    slug: row.slug,
  }));
}

export async function getRevisionDetail(
  db: D1Database,
  revisionId: string,
): Promise<
  | (RevisionRow & {
      originalTitle: string;
      canonicalUrl: string;
      sourceName: string;
      articleStatus: string;
    })
  | null
> {
  const row = await db
    .prepare(
      `SELECT r.*, a.original_title, a.canonical_url, a.status AS article_status, s.name AS source_name
       FROM explanation_revisions r
       JOIN articles a ON a.id = r.article_id
       JOIN sources s ON s.id = a.source_id
       WHERE r.id = ?`,
    )
    .bind(revisionId)
    .first<
      RevisionDbRow & {
        original_title: string;
        canonical_url: string;
        article_status: string;
        source_name: string;
      }
    >();

  if (!row) return null;
  return {
    ...mapRevision(row),
    originalTitle: row.original_title,
    canonicalUrl: row.canonical_url,
    sourceName: row.source_name,
    articleStatus: row.article_status,
  };
}

export async function getArticleRow(db: D1Database, id: string): Promise<Article | null> {
  const row = await db.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first<ArticleRow>();
  return row ? mapArticle(row) : null;
}

export async function approveRevision(
  db: D1Database,
  revisionId: string,
  reviewer: string,
  note: string | null,
): Promise<{ articleId: string; slug: string } | null> {
  const revision = await db
    .prepare(
      `SELECT r.id, r.article_id, r.content_json, a.slug
       FROM explanation_revisions r
       JOIN articles a ON a.id = r.article_id
       WHERE r.id = ? AND r.status = 'draft'`,
    )
    .bind(revisionId)
    .first<{ id: string; article_id: string; content_json: string; slug: string }>();

  if (!revision) return null;

  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(revision.content_json);
  } catch {
    return null;
  }
  const validated = validateExplanation(parsedContent);
  if (!validated.ok) return null;

  const readingMinutes = validated.value.readingMinutes;
  const contextHeadline = validated.value.contextHeadline;
  const dek = validated.value.dek;
  const topicId = validated.value.topic;

  const now = new Date().toISOString();
  const reviewId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`INSERT INTO reviews (id, revision_id, decision, note, reviewer, created_at)
      SELECT ?, id, 'approved', ?, ?, ? FROM explanation_revisions WHERE id = ? AND status = 'draft'`)
      .bind(reviewId, note, reviewer, now, revisionId),
    db
      .prepare(
        `UPDATE explanation_revisions
         SET status = 'published', reviewed_at = ?, reviewed_by = ?, review_note = ?
          WHERE id = ? AND status = 'draft' AND EXISTS (SELECT 1 FROM reviews WHERE id = ?)`,
      )
      .bind(now, reviewer, note, revisionId, reviewId),
    db.prepare(`UPDATE explanation_revisions SET status = 'approved'
      WHERE article_id = ? AND status = 'published' AND id != ?
      AND EXISTS (SELECT 1 FROM reviews WHERE id = ?)`)
      .bind(revision.article_id, revisionId, reviewId),
    db
      .prepare(
        `UPDATE articles
         SET status = 'published', published_revision_id = ?, reading_minutes = ?,
             context_headline = ?, dek = ?, topic_id = ?, updated_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM reviews WHERE id = ?)`,
      )
      .bind(revisionId, readingMinutes, contextHeadline, dek, topicId, now, revision.article_id, reviewId),
    db
      .prepare(
        `INSERT INTO article_topics (article_id, topic_id)
          SELECT ?, ? WHERE EXISTS (SELECT 1 FROM topics WHERE id = ?)
          AND EXISTS (SELECT 1 FROM reviews WHERE id = ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(revision.article_id, topicId, topicId, reviewId),
    db
      .prepare(
        `UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
          WHERE key = 'publication_version' AND EXISTS (SELECT 1 FROM reviews WHERE id = ?)`,
      ).bind(reviewId),
  ]);

  return (results[0]?.meta.changes ?? 0) > 0 ? { articleId: revision.article_id, slug: revision.slug } : null;
}

export async function rejectRevision(
  db: D1Database,
  revisionId: string,
  reviewer: string,
  note: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const reviewId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`INSERT INTO reviews (id, revision_id, decision, note, reviewer, created_at)
      SELECT ?, id, 'rejected', ?, ?, ? FROM explanation_revisions WHERE id = ? AND status = 'draft'`)
      .bind(reviewId, note, reviewer, now, revisionId),
    db.prepare(
       `UPDATE explanation_revisions
       SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, review_note = ?
        WHERE id = ? AND status = 'draft' AND EXISTS (SELECT 1 FROM reviews WHERE id = ?)`,
    )
    .bind(now, reviewer, note, revisionId, reviewId),
    db.prepare(`UPDATE articles SET status = 'failed', updated_at = ?
      WHERE status = 'review' AND published_revision_id IS NULL
      AND id = (SELECT article_id FROM explanation_revisions WHERE id = ?)
      AND EXISTS (SELECT 1 FROM reviews WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM explanation_revisions WHERE article_id = articles.id AND status = 'draft')`)
      .bind(now, revisionId, reviewId),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

export async function getPublicationVersion(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'publication_version'").first<{ value: string }>();
  return row?.value ?? "0";
}

export type SiteState = {
  published: number;
  sources: number;
  topics: number;
  inReview: number;
  publicationVersion: string;
};

export async function getSiteState(db: D1Database): Promise<SiteState> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM articles WHERE status = 'published') AS published,
        (SELECT COUNT(*) FROM sources WHERE status = 'active') AS sources,
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM explanation_revisions WHERE status = 'draft') AS in_review,
        (SELECT value FROM meta WHERE key = 'publication_version') AS publication_version`,
    )
    .first<{
      published: number;
      sources: number;
      topics: number;
      in_review: number;
      publication_version: string | null;
    }>();

  return {
    published: row?.published ?? 0,
    sources: row?.sources ?? 0,
    topics: row?.topics ?? 0,
    inReview: row?.in_review ?? 0,
    publicationVersion: row?.publication_version ?? "0",
  };
}

export async function listAllPublished(
  db: D1Database,
): Promise<Array<{ slug: string; publishedAt: string; updatedAt: string }>> {
  const result = await db
    .prepare(
      `SELECT slug, published_at, updated_at
       FROM articles
       WHERE status = 'published'
       ORDER BY published_at DESC, id DESC`,
    )
    .all<{ slug: string; published_at: string; updated_at: string }>();
  return (result.results ?? []).map((row) => ({
    slug: row.slug,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  }));
}

/* ------------------------------------------------------------------ */
/* Pipeline writes                                                     */
/* ------------------------------------------------------------------ */

export async function findArticleByUrl(db: D1Database, canonicalUrl: string): Promise<Article | null> {
  const row = await db
    .prepare("SELECT * FROM articles WHERE canonical_url = ?")
    .bind(canonicalUrl)
    .first<ArticleRow>();
  return row ? mapArticle(row) : null;
}

export async function findArticleBySlug(db: D1Database, slug: string): Promise<Article | null> {
  const row = await db.prepare("SELECT * FROM articles WHERE slug = ?").bind(slug).first<ArticleRow>();
  return row ? mapArticle(row) : null;
}

export async function findSourceByHost(db: D1Database, host: string): Promise<SourceRow | null> {
  const row = await db
    .prepare("SELECT id, name, site_url, feed_url, host, status FROM sources WHERE host = ? LIMIT 1")
    .bind(host)
    .first<{
      id: string;
      name: string;
      site_url: string;
      feed_url: string | null;
      host: string;
      status: "active" | "paused";
    }>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    siteUrl: row.site_url,
    feedUrl: row.feed_url,
    host: row.host,
    status: row.status,
  };
}

export async function insertArticle(
  db: D1Database,
  input: {
    id: string;
    sourceId: string;
    canonicalUrl: string;
    originalTitle: string;
    publishedAt: string;
    author?: string | null;
    summary?: string | null;
    slug: string;
    discoveredAt: string;
  },
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(
      `INSERT INTO articles
        (id, source_id, canonical_url, original_title, published_at, discovered_at, author, summary, slug, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')
       ON CONFLICT (canonical_url) DO NOTHING`,
    )
    .bind(
      input.id,
      input.sourceId,
      input.canonicalUrl,
      input.originalTitle,
      input.publishedAt,
      input.discoveredAt,
      input.author ?? null,
      input.summary ?? null,
      input.slug,
    ),
    db.prepare(`INSERT INTO jobs (id, kind, article_id, payload_json, idempotency_key, next_run_at)
      SELECT 'job_extract_' || id, 'extract', id, '{}', 'extract:' || id, ? FROM articles
      WHERE canonical_url = ? AND status = 'discovered'
      ON CONFLICT (idempotency_key) DO NOTHING`)
      .bind(new Date().toISOString(), input.canonicalUrl),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

export async function upsertSource(
  db: D1Database,
  input: { id: string; name: string; siteUrl: string; host: string; feedUrl?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sources (id, name, site_url, host, feed_url)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         site_url = excluded.site_url,
         host = excluded.host,
         feed_url = COALESCE(excluded.feed_url, sources.feed_url)`,
    )
    .bind(input.id, input.name, input.siteUrl, input.host, input.feedUrl ?? null)
    .run();
}

export async function setArticleStatus(
  db: D1Database,
  articleId: string,
  status: Article["status"],
  error: string | null,
  lease: Job,
): Promise<void> {
  await db
    .prepare(`UPDATE articles SET status = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND id = ? AND status != 'published' AND published_revision_id IS NULL AND ${CURRENT_LEASE_SQL}
      ${status === "review" ? "AND EXISTS (SELECT 1 FROM explanation_revisions WHERE article_id = articles.id AND status = 'draft')" : ""}
      ${status === "failed" ? "AND NOT EXISTS (SELECT 1 FROM explanation_revisions WHERE article_id = articles.id AND status = 'draft')" : ""}`)
    .bind(status, error, new Date().toISOString(), articleId, lease.articleId, ...leaseValues(lease))
    .run();
}

export async function saveSnapshot(
  db: D1Database,
  input: {
    id: string;
    articleId: string;
    sourceHash: string;
    blocksJson: string;
    wordCount: number;
    extractorVersion: string;
    fetchedAt: string;
    finalUrl: string;
    httpStatus: number;
  },
  lease: Job,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO article_snapshots
        (id, article_id, source_hash, blocks_json, word_count, extractor_version, fetched_at, final_url, http_status)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? = ? AND ${CURRENT_LEASE_SQL}
       ON CONFLICT (article_id, source_hash) DO NOTHING`,
    )
    .bind(
      input.id,
      input.articleId,
      input.sourceHash,
      input.blocksJson,
      input.wordCount,
      input.extractorVersion,
      input.fetchedAt,
      input.finalUrl,
      input.httpStatus,
      input.articleId, lease.articleId, ...leaseValues(lease),
    )
    .run();
}

export async function findSnapshotByHash(
  db: D1Database,
  articleId: string,
  sourceHash: string,
): Promise<{ id: string; blocks_json: string } | null> {
  return db
    .prepare("SELECT id, blocks_json FROM article_snapshots WHERE article_id = ? AND source_hash = ?")
    .bind(articleId, sourceHash)
    .first<{ id: string; blocks_json: string }>();
}

export async function getSnapshotById(
  db: D1Database,
  snapshotId: string,
): Promise<{
  id: string;
  articleId: string;
  blocksJson: string;
  wordCount: number;
  finalUrl: string | null;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, article_id, blocks_json, word_count, final_url
       FROM article_snapshots WHERE id = ?`,
    )
    .bind(snapshotId)
    .first<{
      id: string;
      article_id: string;
      blocks_json: string;
      word_count: number;
      final_url: string | null;
    }>();
  return row
    ? {
        id: row.id,
        articleId: row.article_id,
        blocksJson: row.blocks_json,
        wordCount: row.word_count,
        finalUrl: row.final_url,
      }
    : null;
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}

export async function insertRevision(
  db: D1Database,
  input: {
    id: string;
    articleId: string;
    snapshotId: string;
    contentJson: string;
    provenanceJson: string;
    modelId: string;
    promptVersion: string;
    schemaVersion: string;
  },
  lease: Job,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO explanation_revisions
        (id, article_id, snapshot_id, status, content_json, provenance_json, model_id, prompt_version, schema_version)
       SELECT ?, ?, ?, 'draft', ?, ?, ?, ?, ? WHERE ? = ? AND ${CURRENT_LEASE_SQL}
       ON CONFLICT (article_id, snapshot_id, model_id, prompt_version, schema_version) DO NOTHING`,
    )
    .bind(
      input.id,
      input.articleId,
      input.snapshotId,
      input.contentJson,
      input.provenanceJson,
      input.modelId,
      input.promptVersion,
      input.schemaVersion,
      input.articleId, lease.articleId, ...leaseValues(lease),
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function findRevisionKey(
  db: D1Database,
  input: {
    articleId: string;
    snapshotId: string;
    modelId: string;
    promptVersion: string;
    schemaVersion: string;
  },
): Promise<{ id: string; status: string } | null> {
  return db
    .prepare(
      `SELECT id, status FROM explanation_revisions
       WHERE article_id = ? AND snapshot_id = ? AND model_id = ? AND prompt_version = ? AND schema_version = ?
       LIMIT 1`,
    )
    .bind(
      input.articleId,
      input.snapshotId,
      input.modelId,
      input.promptVersion,
      input.schemaVersion,
    )
    .first<{ id: string; status: string }>();
}

export async function createJob(
  db: D1Database,
  input: {
    id: string;
    kind: JobKind;
    articleId: string | null;
    payload?: Record<string, unknown>;
    idempotencyKey: string;
    nextRunAt?: string;
  },
  lease?: Job,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobs (id, kind, article_id, payload_json, idempotency_key, next_run_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${lease ? `? = ? AND ${CURRENT_LEASE_SQL}` : "1"}
       ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(
      input.id,
      input.kind,
      input.articleId,
      JSON.stringify(input.payload ?? {}),
      input.idempotencyKey,
      input.nextRunAt ?? new Date().toISOString(),
      ...(lease ? [input.articleId, lease.articleId, ...leaseValues(lease)] : []),
    )
    .run();
}

export async function listReadyJobs(db: D1Database, limit = 10): Promise<Job[]> {
  const result = await db
    .prepare(
      `SELECT * FROM jobs
       WHERE (state = 'pending' AND next_run_at <= ?)
           OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
       ORDER BY next_run_at ASC
       LIMIT ?`,
    )
    .bind(new Date().toISOString(), new Date().toISOString(), limit)
    .all<{
      id: string;
      kind: JobKind;
      article_id: string | null;
      payload_json: string;
      state: Job["state"];
      attempts: number;
      idempotency_key: string;
      lease_token: string | null;
      lease_expires_at: string | null;
      next_run_at: string;
      last_error: string | null;
    }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    articleId: row.article_id,
    payloadJson: row.payload_json,
    state: row.state,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
  }));
}

export async function claimJob(
  db: D1Database,
  jobId: string,
  leaseToken: string,
  leaseSeconds = 120,
): Promise<Job | null> {
  const now = new Date();
  const expires = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const result = await db
    .prepare(
      `UPDATE jobs
       SET state = 'running', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND ((state = 'pending' AND next_run_at <= ?) OR (state = 'running' AND lease_expires_at <= ?))
       RETURNING *`,
    )
    .bind(leaseToken, expires, now.toISOString(), jobId, now.toISOString(), now.toISOString())
    .first<{
      id: string;
      kind: JobKind;
      article_id: string | null;
      payload_json: string;
      state: Job["state"];
      attempts: number;
      idempotency_key: string;
      lease_token: string | null;
      lease_expires_at: string | null;
      next_run_at: string;
      last_error: string | null;
    }>();

  if (!result) return null;
  return {
    id: result.id,
    kind: result.kind,
    articleId: result.article_id,
    payloadJson: result.payload_json,
    state: result.state,
    attempts: result.attempts,
    idempotencyKey: result.idempotency_key,
    leaseToken: result.lease_token,
    leaseExpiresAt: result.lease_expires_at,
    nextRunAt: result.next_run_at,
    lastError: result.last_error,
  };
}

export async function completeJob(
  db: D1Database,
  jobId: string,
  leaseToken: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs
       SET state = 'done', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND lease_token = ? AND state = 'running'
          AND lease_expires_at > MAX(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(new Date().toISOString(), jobId, leaseToken, new Date().toISOString())
    .run();
}

export async function failJob(
  db: D1Database,
  job: { id: string; attempts: number; leaseToken: string | null },
  error: string,
  options: { terminal?: boolean; retryAfterSeconds?: number } = {},
): Promise<void> {
  const now = new Date();
  const terminal = options.terminal === true || job.attempts >= 5;
  const delay = options.retryAfterSeconds ?? Math.min(3600, 30 * 2 ** Math.max(0, job.attempts - 1));
  const nextRun = new Date(now.getTime() + delay * 1000).toISOString();

  await db
    .prepare(
      `UPDATE jobs
       SET state = ?, last_error = ?, lease_token = NULL, lease_expires_at = NULL,
           next_run_at = ?, updated_at = ?
        WHERE id = ? AND lease_token = ? AND state = 'running'
          AND lease_expires_at > MAX(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(terminal ? "failed" : "pending", error.slice(0, 800), nextRun, now.toISOString(), job.id, job.leaseToken, now.toISOString())
    .run();
}

/**
 * Push a job back without burning an attempt. Used when the reason is outside
 * the job's control, such as the daily model budget being spent.
 */
export async function deferJob(
  db: D1Database,
  job: { id: string; leaseToken: string | null },
  nextRunAt: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs
       SET state = 'pending', attempts = MAX(0, attempts - 1), last_error = ?,
           lease_token = NULL, lease_expires_at = NULL, next_run_at = ?, updated_at = ?
        WHERE id = ? AND lease_token = ? AND state = 'running'
          AND lease_expires_at > MAX(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(reason.slice(0, 800), nextRunAt, new Date().toISOString(), job.id, job.leaseToken, new Date().toISOString())
    .run();
}

// Check ownership and expiry in each mutation, not a preceding read.
const CURRENT_LEASE_SQL = `EXISTS (SELECT 1 FROM jobs WHERE id = ? AND lease_token = ?
  AND article_id = ? AND state = 'running'
  AND lease_expires_at > MAX(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`;

function leaseValues(job: Job): Array<string | null> {
  return [job.id, job.leaseToken, job.articleId, new Date().toISOString()];
}

export async function renewJobLease(db: D1Database, job: Job, leaseSeconds = 240): Promise<boolean> {
  const now = new Date().toISOString();
  // Extend from the later of now and the current expiry so a renewal never
  // shortens a lease that was claimed with a longer window.
  const current = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : 0;
  const base = Number.isFinite(current) && current > Date.now() ? current : Date.now();
  const result = await db.prepare(`UPDATE jobs SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND state = 'running'
      AND lease_expires_at > MAX(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    .bind(new Date(base + leaseSeconds * 1000).toISOString(), now, job.id, job.leaseToken, now).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function reserveBudget(
  db: D1Database,
  day: string,
  estimatedNeurons: number,
  dailyBudget: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO ai_budget (day, reserved_neurons, used_neurons, generations, updated_at)
       SELECT ?, ?, 0, 1, ? WHERE ? <= ?
       ON CONFLICT (day) DO UPDATE SET
         reserved_neurons = reserved_neurons + excluded.reserved_neurons,
         generations = generations + 1,
         updated_at = excluded.updated_at
       WHERE ai_budget.reserved_neurons + ai_budget.used_neurons + excluded.reserved_neurons <= ?`,
    )
    .bind(day, estimatedNeurons, new Date().toISOString(), estimatedNeurons, dailyBudget, dailyBudget)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function recordBudgetUsage(
  db: D1Database,
  day: string,
  estimatedNeurons: number,
  actualNeurons: number | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_budget
       SET used_neurons = used_neurons + ?, reserved_neurons = MAX(0, reserved_neurons - ?), updated_at = ?
       WHERE day = ?`,
    )
    .bind(actualNeurons ?? estimatedNeurons, estimatedNeurons, new Date().toISOString(), day)
    .run();
}

export async function releaseBudgetReservation(
  db: D1Database,
  day: string,
  estimatedNeurons: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_budget
       SET reserved_neurons = MAX(0, reserved_neurons - ?), updated_at = ?
       WHERE day = ?`,
    )
    .bind(estimatedNeurons, new Date().toISOString(), day)
    .run();
}
