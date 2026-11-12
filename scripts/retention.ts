import { pathToFileURL } from "node:url";
import { getSnapshotStorageReport } from "../src/infrastructure/db";
import { createWranglerDb, parseStorageAuditArgs, type StorageAuditArgs } from "./storage-audit";

const DEFAULT_DAYS = 90;

export type RetentionCategoryName = "article_snapshots" | "explanation_revisions" | "jobs";

export type RetentionCandidate = {
  category: RetentionCategoryName;
  id: string;
  articleId: string | null;
  articleSlug: string | null;
  timestamp: string;
  payloadBytes: number;
};

export type RetentionCategory = {
  category: RetentionCategoryName;
  candidates: number;
  payloadBytes: number;
  skipped: number;
};

export type RetentionReport = {
  generatedAt: string;
  cutoff: string;
  days: number;
  limit: number;
  categories: RetentionCategory[];
  totals: { candidates: number; payloadBytes: number; skipped: number };
  sample: RetentionCandidate[];
  note: string;
};

const READ_ONLY_NOTE =
  "Read-only: no rows were deleted or modified. Bytes are UTF-8 estimates for candidate JSON payloads only, not total D1 database size. Owner approval and a D1 backup are required before any deletion.";

const CATEGORY_ORDER: RetentionCategoryName[] = [
  "article_snapshots",
  "explanation_revisions",
  "jobs",
];

type RetentionRow = Omit<RetentionCandidate, "category">;

export function parseRetentionArgs(argv: string[]): StorageAuditArgs {
  return parseStorageAuditArgs(argv, DEFAULT_DAYS);
}

function isoUtc(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function toCandidate(
  category: RetentionCategoryName,
  row: RetentionRow,
): RetentionCandidate | null {
  const timestamp = isoUtc(row.timestamp);
  if (timestamp === null) return null;
  return {
    category,
    id: row.id,
    articleId: row.articleId,
    articleSlug: row.articleSlug,
    timestamp,
    payloadBytes: Number(row.payloadBytes),
  };
}

export async function getRetentionReport(
  db: D1Database,
  options: { days?: number; limit?: number; now?: Date } = {},
): Promise<RetentionReport> {
  const days = Number.isFinite(options.days) ? Math.max(1, Math.trunc(options.days!)) : DEFAULT_DAYS;
  const limit = Number.isFinite(options.limit) ? Math.min(200, Math.max(1, Math.trunc(options.limit!))) : 20;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();

  const revisionScope = `
    a.status = 'published'
    AND (a.published_revision_id IS NULL OR r.id <> a.published_revision_id)
  `;
  const revisionCandidate = `
    ${revisionScope}
    AND julianday(r.created_at) IS NOT NULL
    AND julianday(r.created_at) < julianday(?)
    AND NOT EXISTS (SELECT 1 FROM reviews v WHERE v.revision_id = r.id)
  `;
  const jobCandidate = `
    j.state IN ('done', 'failed')
    AND julianday(j.updated_at) IS NOT NULL
    AND julianday(j.updated_at) < julianday(?)
  `;

  const [snapshots, revisionTotals, revisionSample, revisionSkipped, jobTotals, jobSample, jobSkipped, snapshotSkipped] =
    await Promise.all([
      getSnapshotStorageReport(db, { days, limit, now }),
      db.prepare(
        `SELECT COUNT(*) AS candidates,
                COALESCE(SUM(LENGTH(CAST(r.content_json AS BLOB))), 0) AS payloadBytes
         FROM explanation_revisions r
         JOIN articles a ON a.id = r.article_id
         WHERE ${revisionCandidate}`,
      ).bind(cutoff).first<{ candidates: number; payloadBytes: number }>(),
      db.prepare(
        `SELECT r.id AS id, r.article_id AS articleId, a.slug AS articleSlug,
                r.created_at AS timestamp, LENGTH(CAST(r.content_json AS BLOB)) AS payloadBytes
         FROM explanation_revisions r
         JOIN articles a ON a.id = r.article_id
         WHERE ${revisionCandidate}
         ORDER BY julianday(r.created_at) ASC, r.id ASC
         LIMIT ?`,
      ).bind(cutoff, limit).all<RetentionRow>(),
      db.prepare(
        `SELECT COUNT(*) AS skipped
         FROM explanation_revisions r
         JOIN articles a ON a.id = r.article_id
         WHERE ${revisionScope} AND julianday(r.created_at) IS NULL`,
      ).first<{ skipped: number }>(),
      db.prepare(
        `SELECT COUNT(*) AS candidates,
                COALESCE(SUM(LENGTH(CAST(j.payload_json AS BLOB))), 0) AS payloadBytes
         FROM jobs j
         WHERE ${jobCandidate}`,
      ).bind(cutoff).first<{ candidates: number; payloadBytes: number }>(),
      db.prepare(
        `SELECT j.id AS id, j.article_id AS articleId, a.slug AS articleSlug,
                j.updated_at AS timestamp, LENGTH(CAST(j.payload_json AS BLOB)) AS payloadBytes
         FROM jobs j
         LEFT JOIN articles a ON a.id = j.article_id
         WHERE ${jobCandidate}
         ORDER BY julianday(j.updated_at) ASC, j.id ASC
         LIMIT ?`,
      ).bind(cutoff, limit).all<RetentionRow>(),
      db.prepare(
        `SELECT COUNT(*) AS skipped FROM jobs j
         WHERE j.state IN ('done', 'failed') AND julianday(j.updated_at) IS NULL`,
      ).first<{ skipped: number }>(),
      db.prepare(
        "SELECT COUNT(*) AS skipped FROM article_snapshots s WHERE julianday(s.fetched_at) IS NULL",
      ).first<{ skipped: number }>(),
    ]);

  const categories: RetentionCategory[] = [
    {
      category: "article_snapshots",
      candidates: snapshots.snapshots.candidates,
      payloadBytes: snapshots.payloadBytes.candidates,
      skipped: Number(snapshotSkipped?.skipped ?? 0),
    },
    {
      category: "explanation_revisions",
      candidates: Number(revisionTotals?.candidates ?? 0),
      payloadBytes: Number(revisionTotals?.payloadBytes ?? 0),
      skipped: Number(revisionSkipped?.skipped ?? 0),
    },
    {
      category: "jobs",
      candidates: Number(jobTotals?.candidates ?? 0),
      payloadBytes: Number(jobTotals?.payloadBytes ?? 0),
      skipped: Number(jobSkipped?.skipped ?? 0),
    },
  ];

  const rank = (category: RetentionCategoryName) => CATEGORY_ORDER.indexOf(category);
  const sample = [
    ...snapshots.sample
      .map((row) =>
        toCandidate("article_snapshots", {
          id: row.snapshotId,
          articleId: row.articleId,
          articleSlug: row.articleSlug,
          timestamp: row.fetchedAt,
          payloadBytes: row.payloadBytes,
        }),
      )
      .filter((row): row is RetentionCandidate => row !== null),
    ...(revisionSample.results ?? [])
      .map((row) => toCandidate("explanation_revisions", row))
      .filter((row): row is RetentionCandidate => row !== null),
    ...(jobSample.results ?? [])
      .map((row) => toCandidate("jobs", row))
      .filter((row): row is RetentionCandidate => row !== null),
  ]
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        rank(left.category) - rank(right.category) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);

  return {
    generatedAt: now.toISOString(),
    cutoff,
    days,
    limit,
    categories,
    totals: {
      candidates: categories.reduce((sum, item) => sum + item.candidates, 0),
      payloadBytes: categories.reduce((sum, item) => sum + item.payloadBytes, 0),
      skipped: categories.reduce((sum, item) => sum + item.skipped, 0),
    },
    sample,
    note: READ_ONLY_NOTE,
  };
}

function bytes(value: number): string {
  return `${value.toLocaleString("en-US")} bytes`;
}

export function formatRetention(report: RetentionReport, target: StorageAuditArgs["mode"], json: boolean): string {
  if (json) return JSON.stringify({ target, readOnly: true, ...report }, null, 2);

  const lines = [
    `Target: ${target} (read-only)`,
    `Generated: ${report.generatedAt}`,
    `Cutoff: ${report.cutoff} (strictly ${report.days} UTC days)`,
    `Reclaimable: ${report.totals.candidates.toLocaleString("en-US")} candidates, ${bytes(report.totals.payloadBytes)} estimated payload`,
    ...report.categories.map(
      (item) =>
        `  ${item.category}: ${item.candidates.toLocaleString("en-US")} candidates, ${bytes(item.payloadBytes)}, ${item.skipped.toLocaleString("en-US")} skipped (missing or malformed timestamps)`,
    ),
    report.note,
    `Candidates, oldest first (${report.limit} max):`,
  ];
  if (report.sample.length === 0) {
    lines.push("  none");
  } else {
    for (const row of report.sample) {
      const article = row.articleId === null ? "no article" : `${row.articleId} (${row.articleSlug})`;
      lines.push(`  ${row.timestamp} ${row.category} ${row.id} ${article} ${bytes(row.payloadBytes)}`);
    }
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const args = parseRetentionArgs(argv);
    const db = createWranglerDb(args.mode);
    const report = await getRetentionReport(db, { days: args.days, limit: args.limit });
    console.log(formatRetention(report, args.mode, args.json));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
