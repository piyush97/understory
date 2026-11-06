import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";
import { approveRevision } from "../src/infrastructure/db";
import { sha256Hex } from "../src/web/lib/api-auth";
import { explanation, seed, seedPublished, sqliteDb } from "./helpers/sqlite";

const KEY = "us_live_test_key_000000000000";
const databases: ReturnType<typeof sqliteDb>[] = [];
let db: ReturnType<typeof sqliteDb>;
let env: Bindings;

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function call(path: string, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`https://understory.test${path}`, { headers }), env, ctx);
}

function authorized(path: string, extra: Record<string, string> = {}) {
  return call(path, { Authorization: `Bearer ${KEY}`, ...extra });
}

type OrgOverrides = {
  status?: string;
  limit?: number;
  trialEndsAt?: string | null;
  paidThrough?: string | null;
  graceEndsAt?: string | null;
};

function addOrg(overrides: OrgOverrides = {}) {
  db.sqlite
    .prepare(
      `INSERT INTO api_orgs (id, name, status, request_limit, trial_ends_at, paid_through, grace_ends_at)
       VALUES ('org', 'Test Org', ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.status ?? "active",
      overrides.limit ?? 1000,
      overrides.trialEndsAt ?? null,
      overrides.paidThrough ?? "2099-01-01T00:00:00.000Z",
      overrides.graceEndsAt ?? null,
    );
}

async function addKey(plain: string = KEY) {
  db.sqlite
    .prepare("INSERT INTO api_keys (id, org_id, name, prefix, key_hash) VALUES ('key', 'org', 'test', ?, ?)")
    .run(plain.slice(0, 8), await sha256Hex(plain));
}

beforeEach(async () => {
  db = sqliteDb();
  databases.push(db);
  seed(db);
  seedPublished(db, { id: "a1", publishedAt: "2026-01-02T00:00:00.000Z", slug: "first" });
  seedPublished(db, { id: "a2", publishedAt: "2026-01-03T00:00:00.000Z", slug: "second" });
  env = {
    ENVIRONMENT: "test",
    SITE_NAME: "Understory",
    SITE_URL: "https://understory.test",
    DB: db.db,
  } as unknown as Bindings;
  addOrg();
  await addKey();
});

afterEach(() => {
  for (const item of databases.splice(0)) item.sqlite.close();
});

describe("api v1 auth", () => {
  it("rejects a missing or unknown key", async () => {
    const missing = await call("/api/v1/articles");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: "invalid_api_key" } });

    const unknown = await call("/api/v1/articles", { Authorization: "Bearer nope" });
    expect(unknown.status).toBe(401);
  });

  it("returns 402 once the subscription lapses", async () => {
    db.sqlite.prepare("UPDATE api_orgs SET trial_ends_at = '2020-01-01T00:00:00.000Z', status = 'trial'").run();
    const response = await authorized("/api/v1/articles");
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code: "payment_required" } });
  });
});

describe("api v1 article payload", () => {
  it("serves newest first without publisher quotations or evidence ids", async () => {
    const quoted = {
      ...explanation,
      sections: [
        {
          ...explanation.sections[0]!,
          blocks: [
            ...explanation.sections[0]!.blocks,
            { type: "quote", runs: [{ text: "PUBLISHER_PROSE_MUST_NOT_SHIP" }], attribution: "Publisher" },
          ],
        },
        ...explanation.sections.slice(1),
      ],
    };
    db.sqlite
      .prepare("UPDATE explanation_revisions SET content_json = ? WHERE id = 'revision_a1'")
      .run(JSON.stringify(quoted));

    const response = await authorized("/api/v1/articles");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("PUBLISHER_PROSE_MUST_NOT_SHIP");
    expect(body).not.toContain("evidenceIds");

    const payload = JSON.parse(body) as {
      data: Array<{ id: string; review: { mode: string }; license: { name: string }; sources: unknown[] }>;
      has_more: boolean;
    };
    expect(payload.data.map((item) => item.id)).toEqual(["a2", "a1"]);
    expect(payload.data[0]!.review.mode).toBe("automated");
    expect(payload.data[0]!.license.name).toBe("CC BY 4.0");
    expect(payload.has_more).toBe(false);
  });

  it("revalidates with an ETag and bills both requests", async () => {
    const first = await authorized("/api/v1/articles/a1");
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await authorized("/api/v1/articles/a1", { "If-None-Match": etag! });
    expect(second.status).toBe(304);

    const usage = await authorized("/api/v1/usage");
    await expect(usage.json()).resolves.toMatchObject({ data: { used: 2, remaining: 998 } });
  });

  it("returns 404 for unknown or unpublished ids", async () => {
    expect((await authorized("/api/v1/articles/missing")).status).toBe(404);
  });
});

describe("api v1 metering", () => {
  it("refuses requests past the monthly allowance", async () => {
    db.sqlite.prepare("UPDATE api_orgs SET request_limit = 1").run();
    expect((await authorized("/api/v1/articles")).status).toBe(200);

    const blocked = await authorized("/api/v1/articles");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-Quota-Remaining")).toBe("0");
    expect(await blocked.json()).toMatchObject({ error: { code: "quota_exhausted" } });
  });

  it("does not charge a request that found nothing", async () => {
    await authorized("/api/v1/articles/missing");
    const usage = await authorized("/api/v1/usage");
    await expect(usage.json()).resolves.toMatchObject({ data: { used: 0 } });
  });

  it("throttles bursts above 60 requests per minute", async () => {
    for (let index = 0; index < 60; index += 1) {
      expect((await authorized("/api/v1/usage")).status).toBe(200);
    }
    const blocked = await authorized("/api/v1/usage");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(await blocked.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("api v1 paging", () => {
  it("binds cursors to the topic filter", async () => {
    db.sqlite
      .prepare("INSERT INTO topics (id, label, description, sort_order) VALUES ('infra', 'Infrastructure', '', 1)")
      .run();
    db.sqlite.prepare("UPDATE articles SET topic_id = 'infra'").run();

    const page = await authorized("/api/v1/articles?topic=infra&limit=1");
    const payload = (await page.json()) as { next_cursor: string | null };
    expect(payload.next_cursor).toBeTruthy();

    const reused = await authorized(`/api/v1/articles?topic=other&cursor=${payload.next_cursor}`);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: { code: "invalid_cursor" } });
  });
});

describe("api v1 change feed", () => {
  it("records publications and exposes only recorded revisions", async () => {
    db.sqlite
      .prepare(
        `INSERT INTO explanation_revisions
           (id, article_id, snapshot_id, status, content_json, provenance_json, model_id, prompt_version, schema_version)
         VALUES ('rev2', 'a1', 'snapshot_a1', 'draft', ?, '{}', 'model', 'prompt2', 'schema')`,
      )
      .run(JSON.stringify(explanation));
    expect(await approveRevision(db.db, "rev2", "editorial", null)).not.toBeNull();

    const feed = await authorized("/api/v1/changes?after=0");
    const payload = (await feed.json()) as {
      data: Array<{ sequence: number; article_id: string; revision_id: string; type: string }>;
      next_after: number;
    };
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({ article_id: "a1", revision_id: "rev2", type: "published" });
    expect(payload.next_after).toBe(payload.data[0]!.sequence);

    expect((await authorized("/api/v1/articles/a1/revisions/rev2")).status).toBe(200);
    // Seeded revisions were published before the feed existed, so they stay
    // unreachable until a publication event records them.
    expect((await authorized("/api/v1/articles/a1/revisions/revision_a1")).status).toBe(404);
  });
});
