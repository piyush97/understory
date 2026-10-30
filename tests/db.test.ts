import { afterEach, describe, expect, it, vi } from "vitest";
import { approveRevision, claimJob, completeJob, createJob, deferJob, failJob, insertArticle, insertRevision, listRecentSourceArticles, rejectRevision, renewJobLease, saveSnapshot, setArticleStatus } from "../src/infrastructure/db";
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
