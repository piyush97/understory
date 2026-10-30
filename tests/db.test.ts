import { afterEach, describe, expect, it, vi } from "vitest";
import { approveRevision, claimJob, completeJob, createJob, deferJob, failJob, insertArticle, insertRevision, listRecentSourceArticles, rejectRevision, renewJobLease, requeueDuplicates, saveSnapshot, setArticleStatus } from "../src/infrastructure/db";
import { articleInput, seed, seedPublished, seedRevision, sqliteDb } from "./helpers/sqlite";

const databases: ReturnType<typeof sqliteDb>[] = [];
function setup() { const db = sqliteDb(); databases.push(db); seed(db); return db; }
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.sqlite.close(); });
async function lease(db: ReturnType<typeof sqliteDb>) {
  await createJob(db.db, { id: "job", kind: "generate", articleId: "article", idempotencyKey: "generate:snapshot" });
  return (await claimJob(db.db, "job", "worker"))!;
}

describe("job leases", () => {
  it("does not claim pending jobs before next_run_at, including deferred retries", async () => {
    const db = setup(); const job = await lease(db);
    await deferJob(db.db, job, new Date(Date.now() + 86_400_000).toISOString(), "budget");
    expect(await claimJob(db.db, "job", "duplicate")).toBeNull();
    expect(db.sqlite.prepare("SELECT attempts FROM jobs").get()?.attempts).toBe(0);
  });
  it("recovers expired running jobs even when next_run_at is in the future", async () => {
    const db = setup(); await lease(db);
    db.sqlite.exec("UPDATE jobs SET lease_expires_at = '2000-01-01', next_run_at = '2099-01-01'");
    expect((await claimJob(db.db, "job", "replacement"))?.leaseToken).toBe("replacement");
  });
  it.each(["expired", "replaced"])("fences revision, snapshot and article writes from %s workers", async (mode) => {
    const db = setup(); const job = await lease(db);
    db.sqlite.exec("UPDATE jobs SET lease_expires_at = '2000-01-01'");
    if (mode === "replaced") await claimJob(db.db, "job", "replacement");
    await setArticleStatus(db.db, "article", "failed", "stale worker", job);
    expect(await insertRevision(db.db, { id: "stale", articleId: "article", snapshotId: "snapshot", contentJson: "{}", provenanceJson: "{}", modelId: "model", promptVersion: "prompt", schemaVersion: "schema" }, job)).toBe(false);
    await saveSnapshot(db.db, { id: "stale-snapshot", articleId: "article", sourceHash: "new", blocksJson: "[]", wordCount: 300, extractorVersion: "test", fetchedAt: new Date().toISOString(), finalUrl: "https://example.com/post", httpStatus: 200 }, job);
    expect(db.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("generating");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM article_snapshots").get()?.n).toBe(1);
  });
  it("never demotes a published article, even with a current lease", async () => {
    const db = setup(); const job = await lease(db);
    db.sqlite.exec("UPDATE articles SET status = 'published', published_revision_id = 'published'");
    await setArticleStatus(db.db, "article", "failed", "stale failure", job);
    expect(db.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("published");
  });
  it("does not enqueue downstream work or renew an expired lease", async () => {
    const db = setup(); const job = await lease(db);
    db.sqlite.exec("UPDATE jobs SET lease_expires_at = '2000-01-01'");
    expect(await renewJobLease(db.db, job)).toBe(false);
    await createJob(db.db, { id: "downstream", kind: "generate", articleId: "article", idempotencyKey: "downstream" }, job);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(1);
  });
  it("checks lease expiry using database time, not a stale worker clock", async () => {
    const db = setup(); const job = await lease(db);
    db.sqlite.exec("UPDATE jobs SET lease_expires_at = '2000-01-01'");
    vi.useFakeTimers(); vi.setSystemTime(new Date("1999-01-01"));
    expect(await renewJobLease(db.db, job)).toBe(false);
    await setArticleStatus(db.db, "article", "failed", "late", job);
    await completeJob(db.db, job.id, job.leaseToken!);
    expect(db.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("generating");
    expect(db.sqlite.prepare("SELECT state FROM jobs").get()?.state).toBe("running");
  });
  it("cannot mark an article for review after its draft was rejected", async () => {
    const db = setup(); const job = await lease(db); seedRevision(db);
    await rejectRevision(db.db, "revision", "reviewer", "No");
    await setArticleStatus(db.db, "article", "review", null, job);
    expect(db.sqlite.prepare("SELECT status FROM articles").get()?.status).not.toBe("review");
  });
  it.each(["complete", "fail", "defer"])("does not %s a job after lease expiry", async (action) => {
    const db = setup(); const job = await lease(db);
    db.sqlite.exec("UPDATE jobs SET lease_expires_at = '2000-01-01'");
    if (action === "complete") await completeJob(db.db, job.id, job.leaseToken!);
    if (action === "fail") await failJob(db.db, job, "error");
    if (action === "defer") await deferJob(db.db, job, "2099-01-01", "budget");
    expect(db.sqlite.prepare("SELECT state FROM jobs").get()?.state).toBe("running");
  });
});

describe("selection persistence", () => {
  it("writes selection fields only through a live lease", async () => {
    const db = setup();
    const job = await lease(db);

    expect(await setArticleStatus(db.db, "article", "generating", null, job, {
      score: 62,
      reason: "1200 words (+10)",
      duplicateOf: null,
    })).toBe(true);
    expect(db.sqlite.prepare(
      "SELECT status, selection_score, selection_reason, duplicate_of FROM articles",
    ).get()).toMatchObject({
      status: "generating",
      selection_score: 62,
      selection_reason: "1200 words (+10)",
      duplicate_of: null,
    });

    db.sqlite.exec("UPDATE jobs SET lease_expires_at = '2000-01-01'");
    expect(await setArticleStatus(db.db, "article", "skipped", "stale", job, {
      score: 99,
      reason: "stale",
      duplicateOf: "other",
    })).toBe(false);
    expect(db.sqlite.prepare("SELECT status, selection_score FROM articles").get()).toMatchObject({
      status: "generating",
      selection_score: 62,
    });
  });

  it("returns viable same-source articles inside the duplicate window, excluding the current article", async () => {
    const db = setup();
    db.sqlite.prepare(
      "INSERT INTO sources (id, name, site_url, host) VALUES ('other-source', 'Other', 'https://other.example', 'other.example')",
    ).run();
    seedPublished(db, { id: "recent", originalTitle: "Vercel AI SDK 5", publishedAt: "2026-10-28T00:00:00.000Z" });
    seedPublished(db, { id: "old", originalTitle: "Old post", publishedAt: "2026-09-01T00:00:00.000Z" });
    seedPublished(db, { id: "other", originalTitle: "Other source", publishedAt: "2026-10-28T00:00:00.000Z", sourceId: "other-source" });

    const rows = await listRecentSourceArticles(
      db.db,
      "source",
      "article",
      "2026-10-15T00:00:00.000Z",
    );
    expect(rows.map((row) => row.id)).toEqual(["recent"]);
  });
});

describe("discovery persistence", () => {
  it("rolls back article insertion when the initial job cannot be written", async () => {
    const db = setup(); db.sqlite.exec("DELETE FROM article_snapshots; DELETE FROM articles");
    db.failOn("INSERT INTO jobs");
    await expect(insertArticle(db.db, articleInput)).rejects.toThrow("injected write failure");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM articles").get()?.n).toBe(0);
  });
  it("retries article creation idempotently with exactly one initial job", async () => {
    const db = setup(); db.sqlite.exec("DELETE FROM article_snapshots; DELETE FROM articles");
    await Promise.all([insertArticle(db.db, articleInput), insertArticle(db.db, articleInput)]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM articles").get()?.n).toBe(1);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(1);
  });
});

describe("duplicate requeue", () => {
  it.each(["failed", "skipped"])("requeues skipped duplicates exactly once when their survivor is retired as %s", async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
    const db = setup();
    db.sqlite.prepare("UPDATE articles SET status = ? WHERE id = 'article'").run(status);
    db.sqlite.exec(`
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, selection_score, selection_reason, duplicate_of, last_error)
      VALUES ('dup', 'source', 'https://example.com/dup', 'Widget now available', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'dup', 'skipped', 20, 'duplicate of article', 'article', 'duplicate');
      INSERT INTO jobs (id, kind, article_id, payload_json, state, attempts, idempotency_key, next_run_at, lease_token, lease_expires_at, last_error)
      VALUES ('job_extract_dup', 'extract', 'dup', '{}', 'done', 1, 'extract:dup', '2099-01-01', 'old-worker', '2099-01-01', 'old error');
    `);

    expect(await requeueDuplicates(db.db, "article")).toBe(1);
    expect(db.sqlite.prepare(
      "SELECT status, selection_score, selection_reason, duplicate_of, last_error, updated_at FROM articles WHERE id = 'dup'",
    ).get()).toMatchObject({
      status: "discovered", selection_score: 20, selection_reason: null, duplicate_of: null,
      last_error: null, updated_at: "2026-10-29T12:00:00.000Z",
    });
    expect(db.sqlite.prepare(
      "SELECT state, attempts, lease_token, lease_expires_at, next_run_at, last_error, updated_at FROM jobs WHERE id = 'job_extract_dup'",
    ).get()).toMatchObject({
      state: "pending", attempts: 0, lease_token: null, lease_expires_at: null, last_error: null,
      next_run_at: "2026-10-29T12:00:00.000Z", updated_at: "2026-10-29T12:00:00.000Z",
    });

    expect(await requeueDuplicates(db.db, "article")).toBe(0);
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'extract' AND article_id = 'dup'",
    ).get()?.n).toBe(1);
  });

  it("creates missing extract jobs and counts every successful transition", async () => {
    const db = setup();
    db.sqlite.exec(`
      UPDATE articles SET status = 'failed' WHERE id = 'article';
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
      VALUES ('dup', 'source', 'https://example.com/dup', 'Duplicate', '2026-10-28', '2026-10-28', 'dup', 'skipped', 'article'),
             ('dup2', 'source', 'https://example.com/dup2', 'Duplicate 2', '2026-10-28', '2026-10-28', 'dup2', 'skipped', 'article');
    `);
    expect(await requeueDuplicates(db.db, "article")).toBe(2);
    expect(db.sqlite.prepare(
      "SELECT id, kind, article_id, payload_json, idempotency_key, state, attempts FROM jobs ORDER BY id",
    ).all()).toEqual([
      { id: "job_extract_dup", kind: "extract", article_id: "dup", payload_json: "{}", idempotency_key: "extract:dup", state: "pending", attempts: 0 },
      { id: "job_extract_dup2", kind: "extract", article_id: "dup2", payload_json: "{}", idempotency_key: "extract:dup2", state: "pending", attempts: 0 },
    ]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM articles WHERE status = 'discovered' AND duplicate_of IS NULL").get()?.n).toBe(2);
  });

  it("leaves unrelated skipped articles and non-skipped duplicates alone", async () => {
    const db = setup();
    db.sqlite.exec(`
      UPDATE articles SET status = 'failed' WHERE id = 'article';
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
      VALUES ('unrelated', 'source', 'https://example.com/unrelated', 'Unrelated', '2026-10-28', '2026-10-28', 'unrelated', 'skipped', NULL),
             ('other', 'source', 'https://example.com/other', 'Other survivor', '2026-10-28', '2026-10-28', 'other', 'skipped', 'another-survivor'),
             ('failed', 'source', 'https://example.com/failed', 'Failed', '2026-10-28', '2026-10-28', 'failed', 'failed', 'article'),
             ('published', 'source', 'https://example.com/published', 'Published', '2026-10-28', '2026-10-28', 'published', 'published', 'article');
    `);
    const before = db.sqlite.prepare("SELECT * FROM articles ORDER BY id").all();
    expect(await requeueDuplicates(db.db, "article")).toBe(0);
    expect(db.sqlite.prepare("SELECT * FROM articles ORDER BY id").all()).toEqual(before);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  });

  it("does not reset a job reclaimed after an overlapping requeue wins", async () => {
    const db = setup();
    await insertArticle(db.db, { ...articleInput, id: "dup", canonicalUrl: "https://example.com/dup", slug: "dup" });
    db.sqlite.exec("UPDATE articles SET status = 'failed' WHERE id = 'article'; UPDATE articles SET status = 'skipped', duplicate_of = 'article' WHERE id = 'dup'; UPDATE jobs SET state = 'done'");
    db.beforeBatch(async () => {
      expect(await requeueDuplicates(db.db, "article")).toBe(1);
      expect((await claimJob(db.db, "job_extract_dup", "winner"))?.leaseToken).toBe("winner");
    });
    expect(await requeueDuplicates(db.db, "article")).toBe(0);
    expect(db.sqlite.prepare("SELECT state, attempts, lease_token FROM jobs WHERE id = 'job_extract_dup'").get()).toMatchObject({
      state: "running", attempts: 1, lease_token: "winner",
    });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = 'extract:dup'").get()?.n).toBe(1);
  });

  it("does not reset a reclaimed job when an overlapping rejection wins", async () => {
    const db = setup();
    seedRevision(db);
    await insertArticle(db.db, { ...articleInput, id: "dup", canonicalUrl: "https://example.com/dup", slug: "dup" });
    db.sqlite.exec("UPDATE articles SET status = 'review' WHERE id = 'article'; UPDATE articles SET status = 'skipped', duplicate_of = 'article' WHERE id = 'dup'; UPDATE jobs SET state = 'done'");
    db.beforeBatch(async () => {
      expect(await rejectRevision(db.db, "revision", "winner", "No")).toBe(true);
      expect((await claimJob(db.db, "job_extract_dup", "winner"))?.leaseToken).toBe("winner");
    });
    expect(await rejectRevision(db.db, "revision", "loser", "No")).toBe(false);
    expect(db.sqlite.prepare("SELECT state, attempts, lease_token FROM jobs WHERE id = 'job_extract_dup'").get()).toMatchObject({ state: "running", attempts: 1, lease_token: "winner" });
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "discovered", duplicate_of: null });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(1);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = 'extract:dup'").get()?.n).toBe(1);
  });

  it.each(["advanced", "relinked"])("does not create a job for a candidate %s before the batch", async (mode) => {
    const db = setup();
    db.sqlite.exec(`
      UPDATE articles SET status = 'failed' WHERE id = 'article';
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
      VALUES ('dup', 'source', 'https://example.com/dup', 'Duplicate', '2026-10-28', '2026-10-28', 'dup', 'skipped', 'article');
    `);
    db.beforeBatch(() => {
      db.sqlite.exec(mode === "advanced"
        ? "UPDATE articles SET status = 'generating' WHERE id = 'dup'"
        : "UPDATE articles SET duplicate_of = 'another-survivor' WHERE id = 'dup'");
    });
    expect(await requeueDuplicates(db.db, "article")).toBe(0);
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({
      status: mode === "advanced" ? "generating" : "skipped",
      duplicate_of: mode === "advanced" ? "article" : "another-survivor",
    });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  });

  it("rolls back the article transition if the extract job upsert fails", async () => {
    const db = setup();
    await insertArticle(db.db, { ...articleInput, id: "dup", canonicalUrl: "https://example.com/dup", slug: "dup" });
    db.sqlite.exec("UPDATE articles SET status = 'failed' WHERE id = 'article'; UPDATE articles SET status = 'skipped', duplicate_of = 'article', selection_score = 20, selection_reason = 'duplicate', last_error = 'old error' WHERE id = 'dup'; UPDATE jobs SET state = 'done'");
    db.failOn("INSERT INTO jobs");
    await expect(requeueDuplicates(db.db, "article")).rejects.toThrow("injected write failure");
    expect(db.sqlite.prepare("SELECT status, duplicate_of, selection_score, selection_reason, last_error FROM articles WHERE id = 'dup'").get()).toMatchObject({
      status: "skipped", duplicate_of: "article", selection_score: 20, selection_reason: "duplicate", last_error: "old error",
    });
    expect(db.sqlite.prepare("SELECT state FROM jobs WHERE id = 'job_extract_dup'").get()?.state).toBe("done");
  });

  it("requeues skipped duplicates when a draft is rejected", async () => {
    const db = setup();
    seedRevision(db);
    await insertArticle(db.db, { ...articleInput, id: "dup", canonicalUrl: "https://example.com/dup", slug: "dup" });
    db.sqlite.exec("UPDATE articles SET status = 'review' WHERE id = 'article'; UPDATE articles SET status = 'skipped', duplicate_of = 'article' WHERE id = 'dup'; UPDATE jobs SET state = 'done', attempts = 1");

    expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(true);
    expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("failed");
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "discovered", duplicate_of: null });
    expect(db.sqlite.prepare("SELECT state FROM jobs WHERE id = 'job_extract_dup'").get()?.state).toBe("pending");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = 'extract:dup'").get()?.n).toBe(1);
  });

  it.each(["missing", "rejected", "published"])("does not requeue after rejecting a %s revision is a no-op", async (status) => {
    const db = setup();
    if (status !== "missing") seedRevision(db, status);
    await insertArticle(db.db, { ...articleInput, id: "dup", canonicalUrl: "https://example.com/dup", slug: "dup" });
    db.sqlite.exec("UPDATE articles SET status = 'failed' WHERE id = 'article'; UPDATE articles SET status = 'skipped', duplicate_of = 'article' WHERE id = 'dup'; UPDATE jobs SET state = 'done', attempts = 1");
    expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(false);
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "article" });
    expect(db.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job_extract_dup'").get()).toMatchObject({ state: "done", attempts: 1 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
  });

  it("does not requeue when approval wins the race against rejection", async () => {
    const db = setup();
    seedRevision(db);
    db.sqlite.exec(`
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
      VALUES ('dup', 'source', 'https://example.com/dup', 'Duplicate', '2026-10-28', '2026-10-28', 'dup', 'skipped', 'article');
    `);
    db.beforeBatch(async () => { expect(await approveRevision(db.db, "revision", "winner", null)).not.toBeNull(); });
    expect(await rejectRevision(db.db, "revision", "loser", "No")).toBe(false);
    expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("published");
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "article" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  });

  it("does not requeue after rejecting a new draft of a still-published article", async () => {
    const db = setup();
    seedPublished(db, { id: "live", publishedAt: "2026-10-28T00:00:00.000Z" });
    db.sqlite.exec(`
      INSERT INTO explanation_revisions (id, article_id, snapshot_id, status, content_json, provenance_json, model_id, prompt_version, schema_version)
      SELECT 'new-draft', article_id, snapshot_id, 'draft', content_json, provenance_json, model_id, 'new-prompt', schema_version
      FROM explanation_revisions WHERE id = 'revision_live';
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
      VALUES ('dup', 'source', 'https://example.com/dup', 'Duplicate', '2026-10-28', '2026-10-28', 'dup', 'skipped', 'live');
    `);
    expect(await rejectRevision(db.db, "new-draft", "reviewer", "No")).toBe(true);
    expect(db.sqlite.prepare("SELECT status, published_revision_id FROM articles WHERE id = 'live'").get()).toMatchObject({ status: "published", published_revision_id: "revision_live" });
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "live" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  });

  it.each(["helper", "rejection"])("recovers every one of 51 skipped duplicates through %s", async (path) => {
    const db = setup();
    seedRevision(db);
    db.sqlite.prepare("UPDATE articles SET status = ? WHERE id = 'article'").run(path === "helper" ? "failed" : "review");
    db.sqlite.exec(`
      WITH RECURSIVE duplicates(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM duplicates WHERE n < 51)
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, selection_score, duplicate_of)
      SELECT 'dup_' || n, 'source', 'https://example.com/dup_' || n, 'Duplicate', '2026-10-28', '2026-10-28', 'dup_' || n, 'skipped', 20, 'article'
      FROM duplicates;
    `);
    if (path === "helper") {
      db.sqlite.exec("UPDATE explanation_revisions SET status = 'rejected'");
      expect(await requeueDuplicates(db.db, "article")).toBe(51);
    } else {
      expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(true);
      expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(false);
      expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("failed");
    }
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM articles WHERE status = 'skipped' AND duplicate_of = 'article'").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM articles WHERE status = 'discovered' AND duplicate_of IS NULL AND selection_score = 20").get()?.n).toBe(51);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'extract' AND state = 'pending' AND attempts = 0").get()?.n).toBe(51);
    expect(await requeueDuplicates(db.db, "article")).toBe(0);
  });

  it("rolls rejection back on requeue failure so a retry recovers its duplicates", async () => {
    const db = setup();
    seedRevision(db);
    await insertArticle(db.db, { ...articleInput, id: "dup", canonicalUrl: "https://example.com/dup", slug: "dup" });
    db.sqlite.exec("UPDATE articles SET status = 'review' WHERE id = 'article'; UPDATE articles SET status = 'skipped', duplicate_of = 'article' WHERE id = 'dup'; UPDATE jobs SET state = 'done', attempts = 1");
    db.failOn("INSERT INTO jobs");
    await expect(rejectRevision(db.db, "revision", "reviewer", "No")).rejects.toThrow("injected write failure");
    expect(db.sqlite.prepare("SELECT status FROM explanation_revisions WHERE id = 'revision'").get()?.status).toBe("draft");
    expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("review");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "article" });
    expect(db.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job_extract_dup'").get()).toMatchObject({ state: "done", attempts: 1 });
    db.failOn();
    expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(true);
    expect(db.sqlite.prepare("SELECT status FROM explanation_revisions WHERE id = 'revision'").get()?.status).toBe("rejected");
    expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("failed");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(1);
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "discovered", duplicate_of: null });
    expect(db.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job_extract_dup'").get()).toMatchObject({ state: "pending", attempts: 0 });
    expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(false);
  });

  it.each(["helper", "rejection"])("rolls job resets back if the article reset fails through %s", async (path) => {
    const db = setup();
    if (path === "rejection") seedRevision(db);
    await insertArticle(db.db, { ...articleInput, id: "dup", canonicalUrl: "https://example.com/dup", slug: "dup" });
    db.sqlite.prepare("UPDATE articles SET status = ? WHERE id = 'article'").run(path === "helper" ? "failed" : "review");
    db.sqlite.exec("UPDATE articles SET status = 'skipped', duplicate_of = 'article', selection_reason = 'duplicate' WHERE id = 'dup'; UPDATE jobs SET state = 'done', attempts = 1");
    db.failOn("selection_reason = NULL");
    await expect(path === "helper"
      ? requeueDuplicates(db.db, "article")
      : rejectRevision(db.db, "revision", "reviewer", "No")).rejects.toThrow("injected write failure");
    expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe(path === "helper" ? "failed" : "review");
    expect(db.sqlite.prepare("SELECT status, duplicate_of, selection_reason FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "article", selection_reason: "duplicate" });
    expect(db.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job_extract_dup'").get()).toMatchObject({ state: "done", attempts: 1 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
    if (path === "rejection") expect(db.sqlite.prepare("SELECT status FROM explanation_revisions WHERE id = 'revision'").get()?.status).toBe("draft");
  });

  it("keeps duplicates skipped until the final viable draft is rejected", async () => {
    const db = setup();
    seedRevision(db);
    await insertArticle(db.db, { ...articleInput, id: "dup", canonicalUrl: "https://example.com/dup", slug: "dup" });
    db.sqlite.exec(`
      UPDATE articles SET status = 'review' WHERE id = 'article';
      UPDATE articles SET status = 'skipped', duplicate_of = 'article' WHERE id = 'dup';
      UPDATE jobs SET state = 'done', attempts = 1;
      INSERT INTO explanation_revisions (id, article_id, snapshot_id, status, content_json, provenance_json, model_id, prompt_version, schema_version)
      SELECT 'second-draft', article_id, snapshot_id, 'draft', content_json, provenance_json, model_id, 'second-prompt', schema_version
      FROM explanation_revisions WHERE id = 'revision';
    `);
    expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(true);
    expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("review");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions WHERE status = 'draft'").get()?.n).toBe(1);
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "article" });
    expect(db.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job_extract_dup'").get()).toMatchObject({ state: "done", attempts: 1 });
    expect(await rejectRevision(db.db, "second-draft", "reviewer", "No")).toBe(true);
    expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("failed");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions WHERE status = 'draft'").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "discovered", duplicate_of: null });
    expect(db.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job_extract_dup'").get()).toMatchObject({ state: "pending", attempts: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = 'extract:dup'").get()?.n).toBe(1);
  });

  it.each(["discovered", "extracting", "generating", "review", "published"])("does not requeue while the survivor is %s", async (status) => {
    const db = setup();
    db.sqlite.prepare("UPDATE articles SET status = ? WHERE id = 'article'").run(status);
    db.sqlite.exec(`
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
      VALUES ('dup', 'source', 'https://example.com/dup', 'Duplicate', '2026-10-28', '2026-10-28', 'dup', 'skipped', 'article');
    `);
    expect(await requeueDuplicates(db.db, "article")).toBe(0);
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "article" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  });

  it.each(["publication pointer", "draft", "published revision"])("does not requeue a terminal survivor with a %s", async (viable) => {
    const db = setup();
    if (viable === "publication pointer") db.sqlite.exec("UPDATE articles SET published_revision_id = 'live' WHERE id = 'article'");
    else seedRevision(db, viable === "draft" ? "draft" : "published");
    db.sqlite.exec(`
      UPDATE articles SET status = 'failed' WHERE id = 'article';
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
      VALUES ('dup', 'source', 'https://example.com/dup', 'Duplicate', '2026-10-28', '2026-10-28', 'dup', 'skipped', 'article');
    `);
    expect(await requeueDuplicates(db.db, "article")).toBe(0);
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "article" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  });

  it("does not requeue if the rejection transaction fails", async () => {
    const db = setup();
    seedRevision(db);
    db.sqlite.exec(`
      UPDATE articles SET status = 'review' WHERE id = 'article';
      INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of)
      VALUES ('dup', 'source', 'https://example.com/dup', 'Duplicate', '2026-10-28', '2026-10-28', 'dup', 'skipped', 'article');
    `);
    db.failOn("UPDATE explanation_revisions");
    await expect(rejectRevision(db.db, "revision", "reviewer", "No")).rejects.toThrow("injected write failure");
    expect(db.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("review");
    expect(db.sqlite.prepare("SELECT status FROM explanation_revisions WHERE id = 'revision'").get()?.status).toBe("draft");
    expect(db.sqlite.prepare("SELECT status, duplicate_of FROM articles WHERE id = 'dup'").get()).toMatchObject({ status: "skipped", duplicate_of: "article" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  });
});

describe("editorial transitions", () => {
  it("does not auto-publish an existing draft when a generation insert conflicts", async () => {
    const db = setup(); seedRevision(db); const job = await lease(db);
    const draft = db.sqlite.prepare("SELECT * FROM explanation_revisions WHERE id = 'revision'").get()!;
    const inserted = await insertRevision(db.db, {
      id: "revision", articleId: "article", snapshotId: "snapshot",
      contentJson: draft.content_json as string, provenanceJson: "{}",
      modelId: draft.model_id as string, promptVersion: draft.prompt_version as string,
      schemaVersion: draft.schema_version as string,
    }, job, { reviewer: "Understory automated validation" });
    expect(inserted).toBe(false);
    expect(db.sqlite.prepare("SELECT status FROM explanation_revisions").get()?.status).toBe("draft");
    expect(db.sqlite.prepare("SELECT published_revision_id FROM articles").get()?.published_revision_id).toBeNull();
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'publication_version'").get()?.value).toBe("0");
  });
  it("rolls back automatic publication if updating the article fails", async () => {
    const db = setup(); seedRevision(db); const job = await lease(db);
    const draft = db.sqlite.prepare("SELECT * FROM explanation_revisions WHERE id = 'revision'").get()!;
    db.sqlite.exec("DELETE FROM explanation_revisions");
    db.failOn("UPDATE articles");
    await expect(insertRevision(db.db, {
      id: "new-revision", articleId: "article", snapshotId: "snapshot",
      contentJson: draft.content_json as string, provenanceJson: "{}",
      modelId: "test", promptVersion: "1", schemaVersion: "1",
    }, job, { reviewer: "Understory automated validation" })).rejects.toThrow("injected write failure");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'publication_version'").get()?.value).toBe("0");
  });
  it("cannot publish a revision rejected after the initial draft read", async () => {
    const db = setup(); seedRevision(db);
    db.beforeBatch(async () => { expect(await rejectRevision(db.db, "revision", "rejector", "No")).toBe(true); });
    expect(await approveRevision(db.db, "revision", "approver", null)).toBeNull();
    expect(db.sqlite.prepare("SELECT status FROM explanation_revisions").get()?.status).toBe("rejected");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(1);
    expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'publication_version'").get()?.value).toBe("0");
    expect(db.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("generating");
  });
  it("concurrent approvals produce one audit and one version increment", async () => {
    const db = setup(); seedRevision(db);
    db.beforeBatch(async () => { expect(await approveRevision(db.db, "revision", "first", null)).not.toBeNull(); });
    expect(await approveRevision(db.db, "revision", "second", null)).toBeNull();
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(1);
    expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'publication_version'").get()?.value).toBe("1");
  });
  it("rolls rejection back if its audit insert fails", async () => {
    const db = setup(); seedRevision(db); db.failOn("INSERT INTO reviews");
    await expect(rejectRevision(db.db, "revision", "reviewer", "No")).rejects.toThrow();
    expect(db.sqlite.prepare("SELECT status FROM explanation_revisions").get()?.status).toBe("draft");
  });
  it("rolls publication and the previous published revision back on audit failure", async () => {
    const db = setup(); seedRevision(db);
    db.sqlite.exec("UPDATE articles SET status = 'published', published_revision_id = 'old'");
    db.failOn("INSERT INTO reviews");
    await expect(approveRevision(db.db, "revision", "reviewer", null)).rejects.toThrow();
    expect(db.sqlite.prepare("SELECT status FROM explanation_revisions").get()?.status).toBe("draft");
    expect(db.sqlite.prepare("SELECT published_revision_id FROM articles").get()?.published_revision_id).toBe("old");
    expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'publication_version'").get()?.value).toBe("0");
  });
  it("cannot reject a revision after a concurrent approval", async () => {
    const db = setup(); seedRevision(db);
    db.beforeBatch(async () => { await approveRevision(db.db, "revision", "approver", null); });
    expect(await rejectRevision(db.db, "revision", "rejector", "No")).toBe(false);
    expect(db.sqlite.prepare("SELECT status FROM explanation_revisions").get()?.status).toBe("published");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(1);
  });
  it.each([false, true])("rejection clears phantom review without demoting published articles (published=%s)", async (published) => {
    const db = setup(); seedRevision(db);
    db.sqlite.prepare("UPDATE articles SET status = ?, published_revision_id = ?").run(published ? "published" : "review", published ? "old" : null);
    expect(await rejectRevision(db.db, "revision", "reviewer", "No")).toBe(true);
    expect(db.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe(published ? "published" : "failed");
  });
});

describe("schema", () => {
  it("loads every migration and adds selection columns", () => {
    const db = setup();
    const columns = db.sqlite.prepare("PRAGMA table_info(articles)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["selection_score", "selection_reason", "duplicate_of"]),
    );
  });
});
