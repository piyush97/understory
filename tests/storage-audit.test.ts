import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getSnapshotStorageReport } from "../src/infrastructure/db";
import {
  formatStorageAudit,
  parseStorageAuditArgs,
  type StorageAuditArgs,
} from "../scripts/storage-audit";
import { formatRetention, getRetentionReport, parseRetentionArgs } from "../scripts/retention";
import { sqliteDb } from "./helpers/sqlite";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const DAY_MS = 86_400_000;
const cutoff = new Date(NOW.getTime() - 30 * DAY_MS).toISOString();

const databases: ReturnType<typeof sqliteDb>[] = [];
function setup() {
  const db = sqliteDb();
  databases.push(db);
  db.sqlite.prepare(
    "INSERT INTO sources (id, name, site_url, host) VALUES ('source', 'Source', 'https://example.com', 'example.com')",
  ).run();
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
});

function insertArticle(db: ReturnType<typeof sqliteDb>, id: string, status = "published") {
  db.sqlite.prepare(
    `INSERT INTO articles
      (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status)
     VALUES (?, 'source', ?, ?, ?, ?, ?, ?)`,
  ).run(id, `https://example.com/${id}`, `Article ${id}`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", id, status);
}

function insertSnapshot(
  db: ReturnType<typeof sqliteDb>,
  input: { id: string; articleId: string; fetchedAt: string | null; blocksJson?: string },
) {
  db.sqlite.prepare(
    `INSERT INTO article_snapshots
      (id, article_id, source_hash, blocks_json, word_count, extractor_version, fetched_at)
     VALUES (?, ?, ?, ?, 1, 'test', ?)`,
  ).run(input.id, input.articleId, `hash_${input.id}`, input.blocksJson ?? "[]", input.fetchedAt);
}

function insertRevision(
  db: ReturnType<typeof sqliteDb>,
  input: { id: string; articleId: string; snapshotId: string; status: string; createdAt?: string },
) {
  db.sqlite.prepare(
    `INSERT INTO explanation_revisions
      (id, article_id, snapshot_id, status, content_json, provenance_json, model_id, prompt_version, schema_version, created_at)
     VALUES (?, ?, ?, ?, '{}', '{}', 'model', 'prompt', 'schema', ?)`,
  ).run(input.id, input.articleId, input.snapshotId, input.status, input.createdAt ?? daysAgo(1));
}

function insertJob(
  db: ReturnType<typeof sqliteDb>,
  input: { id: string; articleId: string; state: string; updatedAt?: string },
) {
  db.sqlite.prepare(
    `INSERT INTO jobs (id, kind, article_id, state, idempotency_key, next_run_at, updated_at)
     VALUES (?, 'extract', ?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
  ).run(input.id, input.articleId, input.state, input.id, input.updatedAt ?? daysAgo(1));
}

function daysAgo(days: number, extraMs = 0) {
  return new Date(NOW.getTime() - days * DAY_MS + extraMs).toISOString();
}

async function report(db: ReturnType<typeof sqliteDb>, limit = 20, days = 30) {
  return getSnapshotStorageReport(db.db, { days, limit, now: NOW });
}

describe("storage audit arguments", () => {
  it("parses explicit targets and optional values", () => {
    expect(parseStorageAuditArgs(["--local"])).toEqual<StorageAuditArgs>({
      mode: "local", json: false, days: 30, limit: 20,
    });
    expect(parseStorageAuditArgs(["--remote", "--json", "--days", "7", "--limit", "200"])).toEqual<StorageAuditArgs>({
      mode: "remote", json: true, days: 7, limit: 200,
    });
  });

  it.each([
    { argv: [] as string[], message: /exactly one of --local or --remote/ },
    { argv: ["--local", "--remote"], message: /only one of --local or --remote/ },
    { argv: ["--remote", "--requests"], message: /Unknown argument/ },
    { argv: ["--local", "--days"], message: /--days needs a positive integer/ },
    { argv: ["--local", "--days", "0"], message: /--days needs a positive integer/ },
    { argv: ["--local", "--days", "-1"], message: /--days needs a positive integer/ },
    { argv: ["--local", "--days", "1.5"], message: /--days needs a positive integer/ },
    { argv: ["--local", "--days", "soon"], message: /--days needs a positive integer/ },
    { argv: ["--local", "--days", "3651"], message: /--days must be at most 3650/ },
    { argv: ["--local", "--limit"], message: /--limit needs a positive integer/ },
    { argv: ["--local", "--limit", "0"], message: /--limit needs a positive integer/ },
    { argv: ["--local", "--limit", "201"], message: /--limit must be at most 200/ },
    { argv: ["--local", "--limit", "2.5"], message: /--limit needs a positive integer/ },
    { argv: ["--local", "--apply"], message: /read-only/ },
    { argv: ["--remote", "--write"], message: /read-only/ },
    { argv: ["--remote", "--delete"], message: /read-only/ },
  ])("rejects $argv before any query", ({ argv, message }) => {
    expect(() => parseStorageAuditArgs(argv)).toThrow(message);
  });
});

describe("snapshot storage report", () => {
  it("returns honest zero counts and an empty sample", async () => {
    const db = setup();
    const result = await report(db);
    expect(result).toMatchObject({
      generatedAt: NOW.toISOString(),
      cutoff,
      days: 30,
      limit: 20,
      snapshots: { total: 0, referenced: 0, unreferenced: 0, candidates: 0 },
      payloadBytes: { total: 0, referenced: 0, unreferenced: 0, candidates: 0 },
      sample: [],
    });
    expect(result.note).toMatch(/not total D1 database size/i);
  });

  it.each(["draft", "approved", "published", "rejected"])(
    "protects snapshots referenced by a %s revision",
    async (status) => {
      const db = setup();
      insertArticle(db, "article");
      insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(40) });
      insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1) });
      insertRevision(db, { id: "revision", articleId: "article", snapshotId: "old", status });

      const result = await report(db);
      expect(result.snapshots).toMatchObject({ total: 2, referenced: 1, unreferenced: 1, candidates: 0 });
      expect(result.payloadBytes).toMatchObject({ total: 4, referenced: 2, unreferenced: 2, candidates: 0 });
      expect(result.sample).toEqual([]);
    },
  );

  it("never treats the article's newest snapshot as a candidate", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "oldest", articleId: "article", fetchedAt: daysAgo(50) });
    insertSnapshot(db, { id: "older", articleId: "article", fetchedAt: daysAgo(40) });
    insertSnapshot(db, { id: "newest", articleId: "article", fetchedAt: daysAgo(35) });

    const result = await report(db);
    expect(result.sample.map((row) => row.snapshotId)).toEqual(["oldest", "older"]);
  });

  it("breaks newest-snapshot timestamp ties by descending id", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "tie-a", articleId: "article", fetchedAt: daysAgo(40) });
    insertSnapshot(db, { id: "tie-z", articleId: "article", fetchedAt: daysAgo(40) });

    const result = await report(db);
    expect(result.sample.map((row) => row.snapshotId)).toEqual(["tie-a"]);
  });

  it("uses a strict UTC cutoff", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "at-cutoff", articleId: "article", fetchedAt: cutoff });
    insertSnapshot(db, { id: "before-cutoff", articleId: "article", fetchedAt: new Date(Date.parse(cutoff) - 1).toISOString() });
    insertSnapshot(db, { id: "newest", articleId: "article", fetchedAt: daysAgo(1) });

    const result = await report(db);
    expect(result.sample.map((row) => row.snapshotId)).toEqual(["before-cutoff"]);
  });

  it.each(["pending", "running", "deferred"])("protects articles with a %s job", async (state) => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(40) });
    insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1) });
    insertJob(db, { id: "job", articleId: "article", state });

    expect((await report(db)).snapshots.candidates).toBe(0);
  });

  it.each(["done", "failed"])("does not protect articles with a %s job", async (state) => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(40) });
    insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1) });
    insertJob(db, { id: "job", articleId: "article", state });

    expect((await report(db)).sample.map((row) => row.snapshotId)).toEqual(["old"]);
  });

  it("treats missing or malformed snapshot timestamps conservatively", async () => {
    const db = setup();
    insertArticle(db, "malformed");
    insertSnapshot(db, { id: "unknown", articleId: "malformed", fetchedAt: "not-a-timestamp" });
    insertSnapshot(db, { id: "valid-old", articleId: "malformed", fetchedAt: daysAgo(50) });
    insertSnapshot(db, { id: "newest", articleId: "malformed", fetchedAt: daysAgo(1) });

    insertArticle(db, "empty");
    insertSnapshot(db, { id: "empty-time", articleId: "empty", fetchedAt: "" });
    insertSnapshot(db, { id: "empty-newest", articleId: "empty", fetchedAt: daysAgo(1) });

    const result = await report(db);
    expect(result.snapshots.total).toBe(5);
    expect(result.snapshots.candidates).toBe(0);
    expect(result.sample).toEqual([]);
  });

  it("estimates UTF-8 payload bytes, not character counts", async () => {
    const db = setup();
    insertArticle(db, "article");
    const text = `["café ☕ — 日本語"]`;
    insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(40), blocksJson: text });
    insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1), blocksJson: "[]" });

    const result = await report(db);
    const expected = Buffer.byteLength(text, "utf8");
    expect(result.sample[0]?.payloadBytes).toBe(expected);
    expect(result.payloadBytes.total).toBe(expected + 2);
    expect(result.payloadBytes.candidates).toBe(expected);
    expect(result.payloadBytes.candidates).not.toBe(text.length);
  });

  it("computes aggregates independently of the bounded sample", async () => {
    const db = setup();
    for (let index = 0; index < 5; index++) {
      const id = `article-${index}`;
      insertArticle(db, id);
      insertSnapshot(db, { id: `old-${index}`, articleId: id, fetchedAt: daysAgo(40 + index) });
      insertSnapshot(db, { id: `new-${index}`, articleId: id, fetchedAt: daysAgo(1) });
    }

    const result = await report(db, 2);
    expect(result.snapshots.candidates).toBe(5);
    expect(result.sample).toHaveLength(2);
    expect(result.payloadBytes.candidates).toBe(10);
    expect(result.sample.map((row) => row.snapshotId)).toEqual(["old-4", "old-3"]);
  });

  it("returns a deterministic oldest-first sample of identifiers and never source text", async () => {
    const db = setup();
    const secret = "SOURCE_TEXT_SHOULD_NOT_APPEAR";
    insertArticle(db, "article-a");
    insertSnapshot(db, { id: "b", articleId: "article-a", fetchedAt: daysAgo(45), blocksJson: JSON.stringify([secret]) });
    insertSnapshot(db, { id: "a", articleId: "article-a", fetchedAt: daysAgo(45), blocksJson: JSON.stringify([secret]) });
    insertSnapshot(db, { id: "new-a", articleId: "article-a", fetchedAt: daysAgo(1) });
    insertArticle(db, "article-b");
    insertSnapshot(db, { id: "c", articleId: "article-b", fetchedAt: daysAgo(50), blocksJson: JSON.stringify([secret]) });
    insertSnapshot(db, { id: "new-b", articleId: "article-b", fetchedAt: daysAgo(1) });

    const result = await report(db);
    expect(result.sample.map((row) => row.snapshotId)).toEqual(["c", "a", "b"]);
    expect(result.sample[0]).toMatchObject({
      articleId: "article-b",
      articleSlug: "article-b",
      fetchedAt: daysAgo(50),
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(Object.keys(result.sample[0]!)).toEqual([
      "snapshotId", "articleId", "articleSlug", "fetchedAt", "payloadBytes",
    ]);
  });

  it("does not write to the database", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(40), blocksJson: "[]" });
    insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1), blocksJson: "[]" });
    insertRevision(db, { id: "revision", articleId: "article", snapshotId: "old", status: "draft" });
    const before = {
      articles: db.sqlite.prepare("SELECT * FROM articles ORDER BY id").all(),
      snapshots: db.sqlite.prepare("SELECT * FROM article_snapshots ORDER BY id").all(),
      revisions: db.sqlite.prepare("SELECT * FROM explanation_revisions ORDER BY id").all(),
      jobs: db.sqlite.prepare("SELECT * FROM jobs ORDER BY id").all(),
    };
    const prepare = db.db.prepare.bind(db.db);
    db.db.prepare = ((sql: string) => {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH|PRAGMA)\b/i.test(sql)) {
        throw new Error("storage audit attempted a write");
      }
      return prepare(sql);
    }) as typeof db.db.prepare;

    await report(db);

    expect({
      articles: db.sqlite.prepare("SELECT * FROM articles ORDER BY id").all(),
      snapshots: db.sqlite.prepare("SELECT * FROM article_snapshots ORDER BY id").all(),
      revisions: db.sqlite.prepare("SELECT * FROM explanation_revisions ORDER BY id").all(),
      jobs: db.sqlite.prepare("SELECT * FROM jobs ORDER BY id").all(),
    }).toEqual(before);
  });
});

describe("storage audit output", () => {
  it("renders JSON and human output from the same controlled report", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(40), blocksJson: "[\"source\"]" });
    insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1), blocksJson: "[]" });
    const result = await report(db);

    const json = formatStorageAudit(result, "remote", true);
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      target: "remote",
      readOnly: true,
      cutoff,
      snapshots: { total: 2, candidates: 1 },
    });
    expect(parsed.sample[0]).toMatchObject({ snapshotId: "old", payloadBytes: 10 });

    const human = formatStorageAudit(result, "remote", false);
    expect(human).toContain("Target: remote (read-only)");
    expect(human).toContain(`Cutoff: ${cutoff}`);
    expect(human).toContain("Snapshots: 2 total");
    expect(human).toContain("old");
    expect(human).toMatch(/not total D1 database size/i);
  });
});

async function retention(db: ReturnType<typeof sqliteDb>, limit = 20, days = 30) {
  return getRetentionReport(db.db, { days, limit, now: NOW });
}

describe("retention arguments", () => {
  it("defaults to 90 days and reuses the audit target contract", () => {
    expect(parseRetentionArgs(["--remote", "--json", "--limit", "5"])).toEqual<StorageAuditArgs>({
      mode: "remote", json: true, days: 90, limit: 5,
    });
    expect(() => parseRetentionArgs([])).toThrow(/exactly one of --local or --remote/);
  });

  it.each(["--delete", "--apply", "--force", "--write", "--purge", "--prune"])(
    "refuses destructive %s before any query",
    (flag) => {
      expect(() => parseRetentionArgs(["--local", flag])).toThrow(/read-only/);
    },
  );
});

describe("retention candidates", () => {
  it("selects only old superseded revisions of published articles", async () => {
    const db = setup();
    insertArticle(db, "article");
    for (const id of ["s-old", "s-new", "s-current", "s-reviewed"]) {
      insertSnapshot(db, { id, articleId: "article", fetchedAt: daysAgo(1) });
    }
    insertRevision(db, { id: "old", articleId: "article", snapshotId: "s-old", status: "draft", createdAt: daysAgo(50) });
    insertRevision(db, { id: "new", articleId: "article", snapshotId: "s-new", status: "draft", createdAt: daysAgo(2) });
    insertRevision(db, { id: "current", articleId: "article", snapshotId: "s-current", status: "published", createdAt: daysAgo(50) });
    insertRevision(db, { id: "reviewed", articleId: "article", snapshotId: "s-reviewed", status: "approved", createdAt: daysAgo(50) });
    db.sqlite.prepare("UPDATE articles SET published_revision_id = 'current' WHERE id = 'article'").run();
    db.sqlite.prepare(
      "INSERT INTO reviews (id, revision_id, decision, reviewer) VALUES ('review', 'reviewed', 'approved', 'owner')",
    ).run();
    insertArticle(db, "draft-article", "review");
    insertRevision(db, { id: "unpublished", articleId: "draft-article", snapshotId: "s-old", status: "draft", createdAt: daysAgo(50) });

    const result = await retention(db);
    const revisions = result.categories.find((item) => item.category === "explanation_revisions")!;
    expect(revisions).toMatchObject({ candidates: 1, skipped: 0 });
    expect(result.sample.filter((row) => row.category === "explanation_revisions").map((row) => row.id)).toEqual(["old"]);
    expect(JSON.stringify(result)).not.toContain("content_json");
  });

  it("keeps snapshots referenced by a revision and snapshots newer than the cutoff", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(50) });
    insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1) });
    insertRevision(db, { id: "revision", articleId: "article", snapshotId: "old", status: "draft", createdAt: daysAgo(50) });
    db.sqlite.prepare("UPDATE articles SET published_revision_id = 'revision' WHERE id = 'article'").run();

    const result = await retention(db);
    expect(result.categories[0]).toMatchObject({ category: "article_snapshots", candidates: 0, skipped: 0 });
    expect(result.sample.some((row) => row.category === "article_snapshots")).toBe(false);
  });

  it("selects only done or failed jobs older than the cutoff", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertJob(db, { id: "done-old", articleId: "article", state: "done", updatedAt: daysAgo(50) });
    insertJob(db, { id: "failed-old", articleId: "article", state: "failed", updatedAt: daysAgo(40) });
    insertJob(db, { id: "done-new", articleId: "article", state: "done", updatedAt: daysAgo(2) });
    insertJob(db, { id: "pending-old", articleId: "article", state: "pending", updatedAt: daysAgo(50) });
    insertJob(db, { id: "running-old", articleId: "article", state: "running", updatedAt: daysAgo(50) });

    const result = await retention(db);
    const jobs = result.categories.find((item) => item.category === "jobs")!;
    expect(jobs).toMatchObject({ candidates: 2, skipped: 0 });
    expect(result.sample.map((row) => row.id)).toEqual(["done-old", "failed-old"]);
  });

  it("buckets missing or malformed timestamps as skipped, never candidates", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "malformed-snapshot", articleId: "article", fetchedAt: "not-a-timestamp" });
    insertSnapshot(db, { id: "newest-snapshot", articleId: "article", fetchedAt: daysAgo(1) });
    insertRevision(db, { id: "malformed-revision", articleId: "article", snapshotId: "newest-snapshot", status: "draft", createdAt: "not-a-timestamp" });
    insertJob(db, { id: "malformed-job", articleId: "article", state: "done", updatedAt: "" });

    const result = await retention(db);
    expect(result.categories).toEqual([
      { category: "article_snapshots", candidates: 0, payloadBytes: 0, skipped: 1 },
      { category: "explanation_revisions", candidates: 0, payloadBytes: 0, skipped: 1 },
      { category: "jobs", candidates: 0, payloadBytes: 0, skipped: 1 },
    ]);
    expect(result.totals.skipped).toBe(3);
    expect(result.sample).toEqual([]);
  });

  it("is deterministic, oldest-first, and bounded by --limit", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "snapshot", articleId: "article", fetchedAt: daysAgo(50) });
    insertSnapshot(db, { id: "newest", articleId: "article", fetchedAt: daysAgo(1) });
    insertRevision(db, { id: "revision", articleId: "article", snapshotId: "newest", status: "draft", createdAt: daysAgo(55) });
    insertJob(db, { id: "job", articleId: "article", state: "done", updatedAt: daysAgo(60) });

    const first = await retention(db, 2);
    const second = await retention(db, 2);
    expect(first).toEqual(second);
    expect(first.sample.map((row) => row.id)).toEqual(["job", "revision"]);
    expect(first.totals).toMatchObject({ candidates: 3, skipped: 0 });
    expect(first.sample.map((row) => row.timestamp)).toEqual([daysAgo(60), daysAgo(55)]);
  });

  it("does not write to the database", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(50) });
    insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1) });
    insertJob(db, { id: "job", articleId: "article", state: "done", updatedAt: daysAgo(50) });
    const before = db.sqlite.prepare("SELECT * FROM jobs ORDER BY id").all();
    const prepare = db.db.prepare.bind(db.db);
    db.db.prepare = ((sql: string) => {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH|PRAGMA)\b/i.test(sql)) {
        throw new Error("retention attempted a write");
      }
      return prepare(sql);
    }) as typeof db.db.prepare;

    await retention(db);
    expect(db.sqlite.prepare("SELECT * FROM jobs ORDER BY id").all()).toEqual(before);
    const source = readFileSync(new URL("../scripts/retention.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(DELETE|UPDATE|DROP|INSERT|REPLACE|ALTER)\b/i);
  });
});

describe("retention output", () => {
  it("renders read-only JSON and human output with per-category bytes", async () => {
    const db = setup();
    insertArticle(db, "article");
    insertSnapshot(db, { id: "old", articleId: "article", fetchedAt: daysAgo(50), blocksJson: "[\"source\"]" });
    insertSnapshot(db, { id: "new", articleId: "article", fetchedAt: daysAgo(1) });
    const result = await retention(db);

    const parsed = JSON.parse(formatRetention(result, "remote", true));
    expect(parsed).toMatchObject({
      target: "remote",
      readOnly: true,
      cutoff,
      totals: { candidates: 1, payloadBytes: 10, skipped: 0 },
    });
    expect(parsed.categories).toHaveLength(3);

    const human = formatRetention(result, "remote", false);
    expect(human).toContain("Target: remote (read-only)");
    expect(human).toContain(`Cutoff: ${cutoff}`);
    expect(human).toContain("article_snapshots: 1 candidates, 10 bytes");
    expect(human).toMatch(/no rows were deleted/i);
    expect(human).toContain("oldest first");
  });
});
