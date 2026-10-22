import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); store.sqlite.close(); });

async function generateJob() {
  await createJob(store.db, { id: "job", kind: "generate", articleId: "article", payload: { snapshotId: "snapshot" }, idempotencyKey: "generate:snapshot" });
}
function existingRevision(status: string) {
  seedRevision(store, status);
  store.sqlite.prepare("UPDATE explanation_revisions SET prompt_version = ?, schema_version = ?").run(PROMPT_VERSION, SCHEMA_VERSION);
}

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
