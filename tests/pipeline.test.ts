import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SourceBlock } from "../src/domain/source";
import { createJob } from "../src/infrastructure/db";
import { processJob, runDiscovery, runScheduled } from "../src/pipeline/run";
import { PROMPT_VERSION, SCHEMA_VERSION } from "../src/pipeline/prompt";
import type { Bindings } from "../src/shared/env";
import { explanation, seed, seedRevision, sqliteDb } from "./helpers/sqlite";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), fetchPage: vi.fn(), extract: vi.fn(), snapshot: vi.fn(), discovery: vi.fn() }));
vi.mock("../src/pipeline/generate", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/pipeline/generate")>()), attemptGeneration: mocks.generate }));
vi.mock("../src/pipeline/extract", () => ({ fetchArticlePage: mocks.fetchPage, extractArticle: mocks.extract, toSnapshot: mocks.snapshot }));
vi.mock("../src/pipeline/discovery", () => ({ parseDiscoveryHtml: mocks.discovery }));

let store: ReturnType<typeof sqliteDb>;
let env: Bindings;
beforeEach(() => {
  vi.resetAllMocks();
  store = sqliteDb(); seed(store);
  env = { DB: store.db, AI: {} as Ai, PIPELINE_QUEUE: { send: vi.fn() } as unknown as Queue, SITE_URL: "https://understory.test", AI_MODEL: "model" } as Bindings;
  mocks.generate.mockResolvedValue({ ok: true, explanation, issues: [], rawText: "{}", usage: null });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); store.sqlite.close(); });

async function generateJob() {
  await createJob(store.db, { id: "job", kind: "generate", articleId: "article", payload: { snapshotId: "snapshot" }, idempotencyKey: "generate:snapshot" });
}
function snapshotFor(blocks: Array<{ kind: SourceBlock["kind"]; text: string }>, wordCount: number, url: string) {
  return {
    articleId: "article",
    title: "Test article",
    url,
    fetchedAt: "2026-10-29T00:00:00.000Z",
    extractorVersion: "test",
    wordCount,
    blocks: blocks.map((block, index) => ({
      id: `b${index + 1}`,
      kind: block.kind,
      text: block.text,
      sourceUrl: url,
      headingPath: [],
    })),
  };
}
async function extractJob(title: string, url: string, wordCount: number, blocks: Array<{ kind: SourceBlock["kind"]; text: string }>) {
  store.sqlite.prepare("UPDATE articles SET status = 'discovered', original_title = ?, canonical_url = ? WHERE id = 'article'").run(title, url);
  await createJob(store.db, { id: "job", kind: "extract", articleId: "article", idempotencyKey: "extract:article" });
  mocks.fetchPage.mockResolvedValue({ html: "source", finalUrl: url, status: 200 });
  mocks.extract.mockResolvedValue({ title, author: null, summary: null, canonicalUrl: null, blocks: [], wordCount, links: [] });
  mocks.snapshot.mockReturnValue(snapshotFor(blocks, wordCount, url));
}
function textWords(count: number): string {
  return Array.from({ length: count }, () => "word").join(" ");
}
function skippedDuplicate(id = "dup") {
  store.sqlite.prepare(`INSERT INTO articles
    (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status, duplicate_of, selection_score, selection_reason, last_error)
    VALUES (?, 'source', ?, 'Widget now available', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', ?, 'skipped', 'article', 33, 'duplicate of test', 'old error')`)
    .run(id, `https://example.com/${id}`, id);
  store.sqlite.prepare(`INSERT INTO jobs (id, kind, article_id, payload_json, state, attempts, idempotency_key, next_run_at, last_error)
    VALUES (?, 'extract', ?, '{}', 'done', 1, ?, '2026-10-28T00:00:00.000Z', 'old error')`)
    .run(`job_extract_${id}`, id, `extract:${id}`);
}
function expectDuplicateRequeued(id = "dup") {
  expect(store.sqlite.prepare("SELECT status, duplicate_of, selection_score, selection_reason, last_error FROM articles WHERE id = ?").get(id))
    .toEqual({ status: "discovered", duplicate_of: null, selection_score: 33, selection_reason: null, last_error: null });
  expect(store.sqlite.prepare("SELECT state, attempts, lease_token, lease_expires_at, last_error FROM jobs WHERE id = ?").get(`job_extract_${id}`))
    .toEqual({ state: "pending", attempts: 0, lease_token: null, lease_expires_at: null, last_error: null });
}
function expectDuplicateRetained() {
  expect(store.sqlite.prepare("SELECT status, duplicate_of, selection_reason, last_error FROM articles WHERE id = 'dup'").get())
    .toEqual({ status: "skipped", duplicate_of: "article", selection_reason: "duplicate of test", last_error: "old error" });
  expect(store.sqlite.prepare("SELECT state, attempts, last_error FROM jobs WHERE id = 'job_extract_dup'").get())
    .toEqual({ state: "done", attempts: 1, last_error: "old error" });
}
function stealLease(status: "skipped" | "failed" = "failed") {
  store.sqlite.exec("UPDATE jobs SET lease_token = 'new-owner' WHERE id = 'job'");
  store.sqlite.prepare("UPDATE articles SET status = ?, selection_score = 88, selection_reason = 'new owner decision', last_error = 'new owner error' WHERE id = 'article'").run(status);
}
function expectNewOwnerRetained(status: "skipped" | "failed" = "failed") {
  expect(store.sqlite.prepare("SELECT status, selection_score, selection_reason, last_error FROM articles WHERE id = 'article'").get())
    .toEqual({ status, selection_score: 88, selection_reason: "new owner decision", last_error: "new owner error" });
  expect(store.sqlite.prepare("SELECT state, lease_token FROM jobs WHERE id = 'job'").get())
    .toEqual({ state: "running", lease_token: "new-owner" });
  expectDuplicateRetained();
}
function beforeStatement(match: string, effect: () => void) {
  const prepare = store.db.prepare.bind(store.db);
  const spy = vi.spyOn(store.db, "prepare").mockImplementation((sql: string) => {
    if (sql.includes(match)) {
      spy.mockRestore();
      effect();
    }
    return prepare(sql);
  });
}
function duplicateSurvivor() {
  store.sqlite.exec(`INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status)
    VALUES ('survivor', 'source', 'https://example.com/old', 'Introducing Widget Search Index', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'old-widget', 'published')`);
}
function existingRevision(status: string) {
  seedRevision(store, status);
  store.sqlite.prepare("UPDATE explanation_revisions SET prompt_version = ?, schema_version = ?").run(PROMPT_VERSION, SCHEMA_VERSION);
}

describe("selection gate", () => {
  it("defaults the pipeline config to shadow mode", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.pipeline.jsonc", import.meta.url), "utf8"));
    expect(config.vars.SELECTION_ENFORCE).toBe("false");
  });

  it.each(["true", "1"])("skips a release note without a generate job when enforcement is %s", async (enforce) => {
    env.SELECTION_ENFORCE = enforce;
    await extractJob("Widget v2 is now available", "https://example.com/releases/widget-v2", 350, [
      { kind: "paragraph", text: `We are excited. Seamless integration. ${textWords(350)}` },
    ]);

    const result = await processJob(env, "job");

    expect(result.ok).toBe(true);
    const row = store.sqlite.prepare("SELECT status, selection_score, selection_reason, duplicate_of, last_error FROM articles WHERE id = 'article'").get();
    expect(row).toMatchObject({ status: "skipped", selection_score: 0, duplicate_of: null });
    expect(String(row?.selection_reason)).toContain("release/announcement title");
    expect(row?.last_error).toBe(row?.selection_reason);
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM article_snapshots WHERE id != 'snapshot'").get()?.n).toBe(1);
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("allows a deep mechanism post to generate when enforcement is on", async () => {
    env.SELECTION_ENFORCE = "true";
    await extractJob("How we redesigned storage", "https://example.com/blog/storage-design", 1500, [
      { kind: "heading", text: "Architecture and query planner" },
      { kind: "paragraph", text: textWords(1500) },
      { kind: "code", text: "SELECT * FROM items;" },
      { kind: "paragraph", text: "Latency fell from 80ms to 12ms at 1000qps." },
    ]);

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status, selection_score, selection_reason, duplicate_of FROM articles WHERE id = 'article'").get())
      .toEqual({ status: "generating", selection_score: 95, selection_reason: "1500 words (+15); 1 code block(s) (+10); 3 metrics (+10)", duplicate_of: null });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(1);
    expect(env.PIPELINE_QUEUE.send).toHaveBeenCalledOnce();
  });

  it("scores the discovered title and canonical URL, not redirected page metadata", async () => {
    env.SELECTION_ENFORCE = "true";
    await extractJob("How cache architecture works", "https://example.com/blog/cache", 900, [{ kind: "paragraph", text: textWords(900) }]);
    mocks.fetchPage.mockResolvedValue({ html: "source", finalUrl: "https://example.com/releases/widget", status: 200 });
    mocks.extract.mockResolvedValue({ title: "Introducing Widget", wordCount: 900, links: [] });

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status, selection_score, selection_reason FROM articles WHERE id = 'article'").get())
      .toEqual({ status: "generating", selection_score: 70, selection_reason: "900 words (+10); 2 mechanism terms (+10)" });
    expect(env.PIPELINE_QUEUE.send).toHaveBeenCalledOnce();
  });

  it("stores a null reason when a generated source has no scoring adjustments", async () => {
    env.SELECTION_ENFORCE = "true";
    await extractJob("Cache", "https://example.com/blog/cache", 600, [{ kind: "paragraph", text: textWords(600) }]);

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status, selection_score, selection_reason FROM articles WHERE id = 'article'").get())
      .toEqual({ status: "generating", selection_score: 50, selection_reason: null });
    expect(env.PIPELINE_QUEUE.send).toHaveBeenCalledOnce();
  });

  it("anchors duplicate candidates to the article publication date, not processing time", async () => {
    env.SELECTION_ENFORCE = "true";
    duplicateSurvivor();
    store.sqlite.exec("UPDATE articles SET published_at = '2020-01-01T00:00:00.000Z' WHERE id = 'survivor'");
    await extractJob("Widget Search Index now available", "https://example.com/new", 900, [{ kind: "paragraph", text: textWords(900) }]);
    store.sqlite.exec("UPDATE articles SET published_at = '2020-01-02T00:00:00.000Z' WHERE id = 'article'");

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status, selection_reason, duplicate_of FROM articles WHERE id = 'article'").get())
      .toEqual({ status: "skipped", selection_reason: "duplicate of old-widget", duplicate_of: "survivor" });
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("does not score or enqueue when snapshot persistence fails", async () => {
    env.SELECTION_ENFORCE = "true";
    await extractJob("How cache architecture works", "https://example.com/new", 900, [{ kind: "paragraph", text: textWords(900) }]);
    store.sqlite.exec("UPDATE articles SET selection_score = 76, selection_reason = 'previous score' WHERE id = 'article'");
    beforeStatement("INSERT INTO article_snapshots", () => { throw new Error("snapshot persistence failed"); });

    expect((await processJob(env, "job")).ok).toBe(false);

    expect(store.sqlite.prepare("SELECT selection_score, selection_reason FROM articles WHERE id = 'article'").get())
      .toEqual({ selection_score: 76, selection_reason: "previous score" });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it.each(["false", undefined])("records a low score but generates in shadow mode (%s)", async (enforce) => {
    env.SELECTION_ENFORCE = enforce;
    await extractJob("Widget v2 is now available", "https://example.com/releases/widget-v2", 350, [
      { kind: "paragraph", text: `Useful product details. ${textWords(350)}` },
    ]);

    await processJob(env, "job");

    const row = store.sqlite.prepare("SELECT status, selection_score, selection_reason FROM articles WHERE id = 'article'").get();
    expect(row?.status).toBe("generating");
    expect(row?.selection_score).toBe(0);
    expect(String(row?.selection_reason)).toContain("release/announcement title");
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(1);
    expect(env.PIPELINE_QUEUE.send).toHaveBeenCalledOnce();
  });

  it.each(["true", "false", undefined])("records a same-source duplicate and enforces only when enabled (%s)", async (enforce) => {
    env.SELECTION_ENFORCE = enforce;
    duplicateSurvivor();
    await extractJob("Widget Search Index now available", "https://example.com/new", 900, [
      { kind: "paragraph", text: textWords(900) },
    ]);

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status, selection_score, selection_reason, duplicate_of FROM articles WHERE id = 'article'").get())
      .toEqual({ status: enforce === "true" ? "skipped" : "generating", selection_score: 45, selection_reason: "duplicate of old-widget", duplicate_of: "survivor" });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(enforce === "true" ? 0 : 1);
    expect(env.PIPELINE_QUEUE.send).toHaveBeenCalledTimes(enforce === "true" ? 0 : 1);
  });

  it("keeps the thin floor in shadow mode, resets a prior score, and recovers duplicates", async () => {
    env.SELECTION_ENFORCE = "false";
    await extractJob("How cache architecture works", "https://example.com/thin", 219, [{ kind: "paragraph", text: textWords(219) }]);
    store.sqlite.exec("UPDATE articles SET selection_score = 95, selection_reason = 'previous score' WHERE id = 'article'");
    skippedDuplicate();

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status, selection_score, selection_reason, last_error, duplicate_of FROM articles WHERE id = 'article'").get())
      .toEqual({ status: "skipped", selection_score: 0, selection_reason: "Source page yielded 219 words, below the 220-word floor.", last_error: "Source page yielded 219 words, below the 220-word floor.", duplicate_of: null });
    expectDuplicateRequeued();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("scores a source at the 220-word floor instead of treating it as thin", async () => {
    env.SELECTION_ENFORCE = "false";
    await extractJob("Plain article", "https://example.com/floor", 220, [{ kind: "paragraph", text: textWords(220) }]);

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status, selection_score, selection_reason FROM articles WHERE id = 'article'").get())
      .toEqual({ status: "generating", selection_score: 20, selection_reason: "220 words (-15); no code, metrics, or mechanism terms (-15)" });
    expect(env.PIPELINE_QUEUE.send).toHaveBeenCalledOnce();
  });

  it.each([false, true])("requeues every skipped duplicate after a selection skip (duplicate survivor: %s)", async (duplicate) => {
    env.SELECTION_ENFORCE = "true";
    if (duplicate) duplicateSurvivor();
    await extractJob(duplicate ? "Widget Search Index now available" : "Widget v2 is now available", "https://example.com/new", 900, [
      { kind: "paragraph", text: textWords(900) },
    ]);
    skippedDuplicate();
    skippedDuplicate("dup2");

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("skipped");
    expectDuplicateRequeued();
    expectDuplicateRequeued("dup2");
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("does not recover duplicates while the survivor is still generating in shadow mode", async () => {
    env.SELECTION_ENFORCE = "false";
    await extractJob("Widget v2 is now available", "https://example.com/releases/widget-v2", 350, [{ kind: "paragraph", text: textWords(350) }]);
    skippedDuplicate();

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("generating");
    expectDuplicateRetained();
  });

  it("does not score or enqueue an invalid snapshot", async () => {
    await extractJob("How cache architecture works", "https://example.com/invalid", 900, []);
    store.sqlite.exec("UPDATE articles SET selection_score = 76, selection_reason = 'previous score' WHERE id = 'article'");

    expect((await processJob(env, "job")).ok).toBe(false);

    expect(store.sqlite.prepare("SELECT selection_score, selection_reason FROM articles WHERE id = 'article'").get())
      .toEqual({ selection_score: 76, selection_reason: "previous score" });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM article_snapshots WHERE id != 'snapshot'").get()?.n).toBe(0);
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("requeues a skipped duplicate after deterministic invalid generation", async () => {
    skippedDuplicate();
    await generateJob();
    mocks.generate.mockResolvedValue({ ok: false, explanation: null, issues: [{ path: "headline", message: "too long" }], rawText: "{}", usage: null });

    expect((await processJob(env, "job")).ok).toBe(false);

    expect(store.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("failed");
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM explanation_revisions").get()?.n).toBe(0);
    expectDuplicateRequeued();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("requeues a skipped duplicate when extraction fails on the third attempt", async () => {
    skippedDuplicate();
    await createJob(store.db, { id: "job", kind: "extract", articleId: "article", idempotencyKey: "extract:article" });
    store.sqlite.exec("UPDATE jobs SET attempts = 2 WHERE id = 'job'");
    mocks.fetchPage.mockRejectedValue(new Error("blocked"));

    expect((await processJob(env, "job")).ok).toBe(false);

    expect(store.sqlite.prepare("SELECT status, last_error FROM articles WHERE id = 'article'").get()).toEqual({ status: "failed", last_error: "blocked" });
    expect(store.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job'").get()).toEqual({ state: "failed", attempts: 3 });
    expectDuplicateRequeued();
  });

  it.each([0, 1])("does not recover duplicates after transient extraction failure (prior attempts: %s)", async (attempts) => {
    skippedDuplicate();
    await createJob(store.db, { id: "job", kind: "extract", articleId: "article", idempotencyKey: "extract:article" });
    store.sqlite.prepare("UPDATE jobs SET attempts = ? WHERE id = 'job'").run(attempts);
    mocks.fetchPage.mockRejectedValue(new Error("blocked"));

    expect((await processJob(env, "job")).ok).toBe(false);

    expect(store.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("failed");
    expect(store.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job'").get()).toEqual({ state: "pending", attempts: attempts + 1 });
    expectDuplicateRetained();
  });

  it("requeues duplicates when a thrown model error exhausts the third job attempt", async () => {
    skippedDuplicate();
    await generateJob();
    store.sqlite.exec("UPDATE jobs SET attempts = 2 WHERE id = 'job'");
    mocks.generate.mockRejectedValue(new Error("model unavailable"));

    expect(await processJob(env, "job")).toEqual({ ok: false, detail: "model unavailable" });

    expect(store.sqlite.prepare("SELECT status, last_error FROM articles WHERE id = 'article'").get()).toEqual({ status: "failed", last_error: "model unavailable" });
    expect(store.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job'").get()).toEqual({ state: "failed", attempts: 3 });
    expect(store.sqlite.prepare("SELECT reserved_neurons FROM ai_budget").get()?.reserved_neurons).toBe(0);
    expectDuplicateRequeued();
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it.each([0, 1])("does not recover duplicates after transient model failure (prior attempts: %s)", async (attempts) => {
    skippedDuplicate();
    await generateJob();
    store.sqlite.prepare("UPDATE jobs SET attempts = ? WHERE id = 'job'").run(attempts);
    mocks.generate.mockRejectedValue(new Error("model unavailable"));

    expect((await processJob(env, "job")).ok).toBe(false);

    expect(store.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("generating");
    expect(store.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job'").get()).toEqual({ state: "pending", attempts: attempts + 1 });
    expectDuplicateRetained();
  });

  it("does not retire a survivor or recover duplicates on a third-attempt budget defer", async () => {
    skippedDuplicate();
    await generateJob();
    store.sqlite.exec("UPDATE jobs SET attempts = 2 WHERE id = 'job'");
    env.DAILY_NEURON_BUDGET = "0";

    expect((await processJob(env, "job")).deferred).toBe(true);

    expect(store.sqlite.prepare("SELECT status FROM articles WHERE id = 'article'").get()?.status).toBe("generating");
    expect(store.sqlite.prepare("SELECT state, attempts FROM jobs WHERE id = 'job'").get()).toEqual({ state: "pending", attempts: 2 });
    expectDuplicateRetained();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it.each([
    ["true", "Widget v2 is now available"],
    ["false", "Widget v2 is now available"],
    ["true", "How cache architecture works"],
  ])("does not overwrite or enqueue after losing the lease before gate writes (%s, %s)", async (enforce, title) => {
    env.SELECTION_ENFORCE = enforce;
    await extractJob(title, "https://example.com/new", 900, [{ kind: "paragraph", text: textWords(900) }]);
    skippedDuplicate();
    beforeStatement("INSERT INTO article_snapshots", () => stealLease("skipped"));

    await processJob(env, "job");

    expectNewOwnerRetained("skipped");
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("does not send persisted work after losing the lease just before generate job creation", async () => {
    await extractJob("How cache architecture works", "https://example.com/new", 900, [{ kind: "paragraph", text: textWords(900) }]);
    skippedDuplicate();
    beforeStatement("INSERT INTO jobs (id, kind, article_id, payload_json, idempotency_key, next_run_at)", () => stealLease());

    await processJob(env, "job");

    expectNewOwnerRetained();
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("does not send persisted work after the extraction lease expires", async () => {
    await extractJob("How cache architecture works", "https://example.com/new", 900, [{ kind: "paragraph", text: textWords(900) }]);
    beforeStatement("INSERT INTO article_snapshots", () => {
      store.sqlite.exec("UPDATE jobs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'job'");
      store.sqlite.exec("UPDATE articles SET selection_score = 88, selection_reason = 'prior decision' WHERE id = 'article'");
    });

    await processJob(env, "job");

    expect(store.sqlite.prepare("SELECT status, selection_score, selection_reason FROM articles WHERE id = 'article'").get())
      .toEqual({ status: "extracting", selection_score: 88, selection_reason: "prior decision" });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(0);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("does not send a persisted generate job after the extraction lease is replaced", async () => {
    await extractJob("How cache architecture works", "https://example.com/new", 900, [{ kind: "paragraph", text: textWords(900) }]);
    skippedDuplicate();
    beforeStatement("SELECT id FROM jobs WHERE id = ? AND state = 'pending'", () => stealLease());

    await processJob(env, "job");

    expectNewOwnerRetained();
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'generate'").get()?.n).toBe(1);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("does not overwrite or recover duplicates after losing the lease before a thin skip", async () => {
    await extractJob("Thin source", "https://example.com/thin", 219, [{ kind: "paragraph", text: textWords(219) }]);
    skippedDuplicate();
    mocks.fetchPage.mockImplementation(async () => {
      stealLease("skipped");
      return { html: "source", finalUrl: "https://example.com/thin", status: 200 };
    });

    await processJob(env, "job");

    expectNewOwnerRetained("skipped");
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });

  it("does not recover duplicates after stale terminal extraction failure", async () => {
    skippedDuplicate();
    await createJob(store.db, { id: "job", kind: "extract", articleId: "article", idempotencyKey: "extract:article" });
    store.sqlite.exec("UPDATE jobs SET attempts = 2 WHERE id = 'job'");
    mocks.fetchPage.mockImplementation(async () => { stealLease(); throw new Error("blocked"); });

    expect((await processJob(env, "job")).ok).toBe(false);

    expectNewOwnerRetained();
  });

  it("does not write a revision or recover duplicates after stale invalid generation", async () => {
    skippedDuplicate();
    await generateJob();
    mocks.generate.mockImplementation(async () => {
      stealLease();
      return { ok: false, explanation: null, issues: [{ path: "headline", message: "too long" }], rawText: "{}", usage: null };
    });

    expect((await processJob(env, "job")).ok).toBe(false);

    expectNewOwnerRetained();
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM explanation_revisions").get()?.n).toBe(0);
  });

  it("does not recover duplicates after a stale third-attempt thrown generation error", async () => {
    skippedDuplicate();
    await generateJob();
    store.sqlite.exec("UPDATE jobs SET attempts = 2 WHERE id = 'job'");
    mocks.generate.mockImplementation(async () => { stealLease(); throw new Error("model unavailable"); });

    expect((await processJob(env, "job")).ok).toBe(false);

    expectNewOwnerRetained();
  });
});

describe("pipeline consistency", () => {
  it("auto-publishes a newly validated generation once, without extra model calls", async () => {
    env.AUTO_PUBLISH = "true";
    await generateJob();
    expect((await processJob(env, "job")).ok).toBe(true);
    const revision = store.sqlite.prepare("SELECT id, status, provenance_json FROM explanation_revisions").get()!;
    expect(revision.status).toBe("published");
    expect(store.sqlite.prepare("SELECT status, published_revision_id FROM articles").get()).toMatchObject({ status: "published", published_revision_id: revision.id });
    expect(JSON.parse(revision.provenance_json as string).reviewedBy).toBe("Understory automated validation");
    expect(store.sqlite.prepare("SELECT reviewer, decision FROM reviews").get()).toMatchObject({ reviewer: "Understory automated validation", decision: "approved" });
    const version = store.sqlite.prepare("SELECT value FROM meta WHERE key = 'publication_version'").get()?.value;
    expect(version).toBe("1");
    await processJob(env, "job");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(1);
    expect(store.sqlite.prepare("SELECT value FROM meta WHERE key = 'publication_version'").get()?.value).toBe(version);
  });
  it("leaves existing drafts unpublished when automatic publication is enabled", async () => {
    env.AUTO_PUBLISH = "true";
    existingRevision("draft");
    await generateJob();
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("review");
    expect(store.sqlite.prepare("SELECT status FROM explanation_revisions").get()?.status).toBe("draft");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("never publishes a generation rejected by validation", async () => {
    env.AUTO_PUBLISH = "true";
    await generateJob();
    mocks.generate.mockResolvedValue({ ok: false, explanation: null, issues: [{ path: "sources", message: "invalid source" }], rawText: "{}", usage: null });
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status, published_revision_id FROM articles").get()).toMatchObject({ status: "failed", published_revision_id: null });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions").get()?.n).toBe(0);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
  });
  it("cannot auto-publish after losing its lease during the publication transaction", async () => {
    env.AUTO_PUBLISH = "true";
    await generateJob();
    mocks.generate.mockImplementationOnce(async () => {
      store.beforeBatch(() => { store.sqlite.exec("UPDATE jobs SET lease_token = 'replacement'"); });
      return { ok: true, explanation, issues: [], rawText: "{}", usage: null };
    });
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT published_revision_id FROM articles").get()?.published_revision_id).toBeNull();
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions").get()?.n).toBe(0);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
  });
  it("rolls back the generated revision when automatic publication fails", async () => {
    env.AUTO_PUBLISH = "true";
    await generateJob();
    store.failOn("INSERT INTO reviews");
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions").get()?.n).toBe(0);
    expect(store.sqlite.prepare("SELECT published_revision_id FROM articles").get()?.published_revision_id).toBeNull();
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
  });
  it("does not overwrite an article published by an editor while generation was running", async () => {
    env.AUTO_PUBLISH = "true";
    await generateJob();
    mocks.generate.mockImplementationOnce(async () => {
      store.beforeBatch(() => {
        existingRevision("published");
        store.sqlite.exec("UPDATE articles SET status = 'published', published_revision_id = 'revision'");
      });
      return { ok: true, explanation, issues: [], rawText: "{}", usage: null };
    });
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT published_revision_id FROM articles").get()?.published_revision_id).toBe("revision");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions").get()?.n).toBe(1);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
  });
  it("keeps new valid generations in review when automatic publication is disabled", async () => {
    env.AUTO_PUBLISH = "false";
    await generateJob();
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("review");
    expect(store.sqlite.prepare("SELECT status FROM explanation_revisions").get()?.status).toBe("draft");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM reviews").get()?.n).toBe(0);
  });
  it("does not turn a rejected revision into a phantom review on retry", async () => {
    existingRevision("rejected"); await generateJob();
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("failed");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("does not demote a published article when its generation job is retried", async () => {
    existingRevision("published"); await generateJob();
    store.sqlite.exec("UPDATE articles SET status = 'published', published_revision_id = 'revision'");
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("published");
  });
  it("restores review only for an existing draft without spending model budget", async () => {
    existingRevision("draft"); await generateJob();
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("review");
    expect(store.sqlite.prepare("SELECT state FROM jobs").get()?.state).toBe("done");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("discards model output after the lease is replaced and another worker publishes", async () => {
    await generateJob();
    mocks.generate.mockImplementationOnce(async () => {
      store.sqlite.exec("UPDATE jobs SET lease_token = 'replacement'; UPDATE articles SET status = 'published', published_revision_id = 'other'");
      return { ok: true, explanation, issues: [], rawText: "{}", usage: null };
    });
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("published");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions").get()?.n).toBe(0);
    expect(store.sqlite.prepare("SELECT state FROM jobs").get()?.state).toBe("running");
  });
  it("renews the lease while a model call exceeds the original 120 seconds", async () => {
    vi.useFakeTimers(); await generateJob();
    mocks.generate.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, explanation, issues: [], rawText: "{}", usage: null }), 180_000)));
    const running = processJob(env, "job", 120);
    await vi.advanceTimersByTimeAsync(121_000);
    const expiry = String(store.sqlite.prepare("SELECT lease_expires_at FROM jobs").get()?.lease_expires_at);
    expect(Date.parse(expiry)).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(60_000); await running;
    expect(store.sqlite.prepare("SELECT state FROM jobs").get()?.state).toBe("done");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("review");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards output after lease expiry without replacement", async () => {
    await generateJob();
    mocks.generate.mockImplementationOnce(async () => {
      store.sqlite.exec("UPDATE jobs SET lease_expires_at = '2000-01-01'");
      return { ok: true, explanation, issues: [], rawText: "{}", usage: null };
    });
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM explanation_revisions").get()?.n).toBe(0);
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).not.toBe("review");
    expect(store.sqlite.prepare("SELECT state FROM jobs").get()?.state).toBe("running");
  });
  it("defers exhausted-budget jobs without allowing duplicate queue delivery to bypass the delay", async () => {
    env.DAILY_NEURON_BUDGET = "0"; await generateJob();
    expect((await processJob(env, "job")).deferred).toBe(true);
    expect((await processJob(env, "job")).detail).toContain("not claimable");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(store.sqlite.prepare("SELECT attempts FROM jobs").get()?.attempts).toBe(0);
  });
  it("fences extraction failures after a replacement worker publishes", async () => {
    await createJob(store.db, { id: "job", kind: "extract", articleId: "article", idempotencyKey: "extract:article" });
    mocks.fetchPage.mockImplementationOnce(async () => {
      store.sqlite.exec("UPDATE jobs SET lease_token = 'replacement'; UPDATE articles SET status = 'published', published_revision_id = 'other'");
      throw new Error("late fetch failure");
    });
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("published");
  });
  it("fences extraction snapshots and downstream jobs after lease replacement", async () => {
    await createJob(store.db, { id: "job", kind: "extract", articleId: "article", idempotencyKey: "extract:article" });
    mocks.fetchPage.mockImplementationOnce(async () => {
      store.sqlite.exec("UPDATE jobs SET lease_token = 'replacement'; UPDATE articles SET status = 'published', published_revision_id = 'other'");
      return { html: "source", finalUrl: "https://example.com/post", status: 200 };
    });
    mocks.extract.mockResolvedValue({ wordCount: 300, links: [] });
    mocks.snapshot.mockReturnValue({ articleId: "article", title: "Test article", url: "https://example.com/post", fetchedAt: new Date().toISOString(), extractorVersion: "test", wordCount: 300, blocks: [{ id: "b1", kind: "paragraph", text: "Source content", sourceUrl: "https://example.com/post", headingPath: [] }] });
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT status FROM articles").get()?.status).toBe("published");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM article_snapshots").get()?.n).toBe(1);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(1);
  });
  it("stops retries after ownership is lost, retaining already spent model budget", async () => {
    await generateJob();
    mocks.generate.mockImplementationOnce(async () => {
      store.sqlite.exec("UPDATE jobs SET lease_token = 'replacement'");
      return { ok: false, explanation: null, issues: [], rawText: "invalid", usage: null };
    });
    await processJob(env, "job");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(store.sqlite.prepare("SELECT used_neurons, reserved_neurons FROM ai_budget").get()).toMatchObject({ used_neurons: 500, reserved_neurons: 0 });
  });
  it("spaces discovery across cron runs", async () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    store.sqlite.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_discovery_enqueued_at', ?)").run(new Date(now.getTime() - 11 * 60_000).toISOString());
    await runScheduled(env, now);
    expect((env.PIPELINE_QUEUE.send as ReturnType<typeof vi.fn>).mock.calls).not.toContainEqual([{ kind: "discover", reason: "cron" }]);
  });
  it("retires a rejected generation instead of retrying the whole job", async () => {
    await generateJob();
    mocks.generate.mockResolvedValue({ ok: false, explanation: null, issues: [{ path: "headline", message: "too long" }], rawText: "{}", usage: { inputTokens: 9000, outputTokens: 4000 } });
    await processJob(env, "job");
    expect(store.sqlite.prepare("SELECT state FROM jobs").get()?.state).toBe("failed");
  });
  it("looks up known discovery posts in one query", async () => {
    const post = { url: "https://example.com/post", publishedAt: new Date().toISOString(), sourceSiteUrl: "https://example.com", title: "Test article", sourceName: "Source" };
    mocks.discovery.mockReturnValue(Array.from({ length: 30 }, () => post));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html></html>")));
    const counted: string[] = [];
    const countedDb = new Proxy(store.db, {
      get(target, prop, receiver) {
        if (prop === "prepare") return (sql: string) => { counted.push(sql); return (target as unknown as D1Database).prepare(sql); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runDiscovery({ ...env, DB: countedDb }, "test");
    expect(counted.filter((sql) => /canonical_url\s*=\s*\?/.test(sql))).toHaveLength(0);
    expect(counted.filter((sql) => /canonical_url\s+IN\s*\(/.test(sql))).toHaveLength(1);
  });
  it("reconciles previously discovered articles without an extraction job", async () => {
    store.sqlite.exec("UPDATE articles SET status = 'discovered'");
    mocks.discovery.mockReturnValue([{ url: "https://example.com/post", publishedAt: new Date().toISOString(), sourceSiteUrl: "https://example.com", title: "Test article", sourceName: "Source" }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html></html>")));
    await runDiscovery(env, "retry");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'extract'").get()?.n).toBe(1);
  });
});
