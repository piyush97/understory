import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";
import { mapSubscription } from "../src/web/routes/billing";
import { seed, seedPublished, sqliteDb } from "./helpers/sqlite";

const SITE = "https://understory.test";
const SECRET = "whsec_test";
const databases: ReturnType<typeof sqliteDb>[] = [];
let db: ReturnType<typeof sqliteDb>;
let env: Bindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`${SITE}${path}`, init), env, ctx);
}

function post(path: string, fields: Record<string, string>, origin = SITE) {
  return call(path, { method: "POST", headers: { Origin: origin }, body: new URLSearchParams(fields) });
}

function siteverify(result: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(result));
}

const passing = { success: true, action: "trial", hostname: "understory.test" };
const trialFields = { email: "Dev@Example.com", name: "Example Co", "cf-turnstile-response": "token" };

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subscriptionEvent(attrs: Record<string, unknown>, orgId?: string) {
  return JSON.stringify({
    meta: { event_name: "subscription_updated", custom_data: orgId ? { org_id: orgId } : null },
    data: {
      type: "subscriptions",
      id: "sub_1",
      attributes: {
        store_id: 7,
        variant_id: 11,
        customer_id: 99,
        test_mode: true,
        status: "active",
        renews_at: "2099-02-01T00:00:00.000000Z",
        ends_at: null,
        updated_at: "2026-11-06T10:00:00.000000Z",
        ...attrs,
      },
    },
  });
}

async function webhook(body: string, signature?: string) {
  return call("/api/billing/lemonsqueezy", {
    method: "POST",
    headers: { "X-Signature": signature ?? (await sign(body)), "Content-Type": "application/json" },
    body,
  });
}

function org(id = "org_paid") {
  return db.sqlite
    .prepare("SELECT status, request_limit, paid_through, grace_ends_at, ls_subscription_id FROM api_orgs WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

async function startTrial(): Promise<string> {
  siteverify(passing);
  const res = await post("/developers/trial", trialFields);
  expect(res.status).toBe(200);
  const key = /us_test_[0-9a-f]{48}/.exec(await res.text())?.[0];
  expect(key).toBeDefined();
  return key!;
}

beforeEach(() => {
  db = sqliteDb();
  databases.push(db);
  seed(db);
  seedPublished(db, { id: "a1", publishedAt: "2026-01-02T00:00:00.000Z", slug: "first" });
  env = {
    ENVIRONMENT: "test",
    SITE_NAME: "Understory",
    SITE_URL: SITE,
    DB: db.db,
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET: "turnstile-secret",
    LEMONSQUEEZY_CHECKOUT_URL: "https://understory.lemonsqueezy.com/buy/abc",
    LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
    LEMONSQUEEZY_STORE_ID: "7",
    LEMONSQUEEZY_VARIANT_ID: "11",
    LEMONSQUEEZY_TEST_MODE: "true",
  } as unknown as Bindings;
  db.sqlite
    .prepare(
      `INSERT INTO api_orgs (id, name, status, request_limit, trial_ends_at)
       VALUES ('org_paid', 'Paid Co', 'trial', 1000, '2099-01-01T00:00:00.000Z')`,
    )
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const item of databases.splice(0)) item.sqlite.close();
});

describe("developers page", () => {
  it("renders the trial form with a Turnstile-aware CSP", async () => {
    const res = await call("/developers");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("form-action 'self' https://*.lemonsqueezy.com");
    const html = await res.text();
    expect(html).toContain('data-sitekey="site-key"');
    expect(html).toContain('action="/developers/trial"');
  });

  it("shows closed states when Turnstile and billing are not configured", async () => {
    env = { ...env, TURNSTILE_SITE_KEY: undefined, LEMONSQUEEZY_CHECKOUT_URL: undefined };
    const html = await (await call("/developers")).text();
    expect(html).toContain("Trial signup is not open yet.");
    expect(html).toContain("Paid plans are not open yet.");
    expect((await post("/developers/trial", trialFields)).status).toBe(503);
  });
});

describe("trial signup", () => {
  it("issues a working trial key once per email", async () => {
    const key = await startTrial();
    const usage = await call("/api/v1/usage", { headers: { Authorization: `Bearer ${key}` } });
    expect(usage.status).toBe(200);
    await expect(usage.json()).resolves.toMatchObject({ data: { limit: 1000 } });

    const row = db.sqlite.prepare("SELECT email, status FROM api_orgs WHERE email = 'dev@example.com'").get();
    expect(row).toMatchObject({ status: "trial" });

    const again = await post("/developers/trial", trialFields);
    expect(again.status).toBe(409);
  });

  it("rejects cross-origin posts, failed checks, and bad input", async () => {
    expect((await post("/developers/trial", trialFields, "https://evil.test")).status).toBe(403);
    expect((await post("/developers/trial", { ...trialFields, email: "nope" })).status).toBe(400);

    siteverify({ ...passing, hostname: "evil.test" });
    expect((await post("/developers/trial", trialFields)).status).toBe(403);
    siteverify({ ...passing, action: "other" });
    expect((await post("/developers/trial", trialFields)).status).toBe(403);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect((await post("/developers/trial", trialFields)).status).toBe(403);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM api_orgs").get()).toMatchObject({ n: 1 });
  });

  it("caps trials per network per day", async () => {
    siteverify(passing);
    for (let i = 0; i < 3; i++) {
      const res = await post("/developers/trial", { ...trialFields, email: `dev${i}@example.com` });
      expect(res.status).toBe(200);
    }
    expect((await post("/developers/trial", { ...trialFields, email: "dev9@example.com" })).status).toBe(429);
  });
});

describe("checkout", () => {
  it("redirects a known key to Lemon Squeezy with the org id", async () => {
    const key = await startTrial();
    const res = await post("/developers/checkout", { key });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.hostname).toBe("understory.lemonsqueezy.com");
    expect(location.searchParams.get("checkout[custom][org_id]")).toMatch(/^org_[0-9a-f]{16}$/);
    expect(location.searchParams.get("checkout[email]")).toBe("dev@example.com");
  });

  it("rejects unknown keys", async () => {
    expect((await post("/developers/checkout", { key: "us_test_unknownunknownunknown" })).status).toBe(400);
  });
});

describe("lemon squeezy webhook", () => {
  it("rejects a bad signature", async () => {
    const body = subscriptionEvent({}, "org_paid");
    expect((await webhook(body, "00".repeat(32))).status).toBe(401);
    expect((await webhook(body, "not-hex")).status).toBe(401);
    expect(org()).toMatchObject({ status: "trial" });
  });

  it("activates the org from checkout custom data, then matches by subscription id", async () => {
    const res = await webhook(subscriptionEvent({}, "org_paid"));
    await expect(res.json()).resolves.toMatchObject({ applied: true });
    expect(org()).toMatchObject({
      status: "active",
      request_limit: 25000,
      paid_through: "2099-02-01T00:00:00.000000Z",
      ls_subscription_id: "sub_1",
    });

    await webhook(subscriptionEvent({ status: "past_due", updated_at: "2026-11-07T10:00:00.000000Z" }));
    expect(org()).toMatchObject({ status: "past_due", grace_ends_at: "2026-11-21T10:00:00.000Z" });
  });

  it("ignores stale deliveries and other products", async () => {
    await webhook(subscriptionEvent({ updated_at: "2026-11-08T00:00:00.000000Z" }, "org_paid"));
    const stale = await webhook(subscriptionEvent({ status: "expired" }, "org_paid"));
    await expect(stale.json()).resolves.toMatchObject({ applied: false });
    expect(org()).toMatchObject({ status: "active" });

    const other = await webhook(subscriptionEvent({ variant_id: 12, status: "expired" }, "org_paid"));
    await expect(other.json()).resolves.toMatchObject({ reason: "other_product" });
    expect(org()).toMatchObject({ status: "active" });
  });

  it("maps every provider status", () => {
    expect(mapSubscription({ status: "cancelled", ends_at: "2099-01-01" })).toMatchObject({
      status: "active",
      paidThrough: "2099-01-01",
    });
    for (const status of ["paused", "unpaid", "expired"]) {
      expect(mapSubscription({ status })).toMatchObject({ status: "canceled", paidThrough: null });
    }
    expect(mapSubscription({ status: "mystery" })).toBeNull();
  });
});

describe("free API", () => {
  it("returns a summary without the full explainer", async () => {
    const res = await call("/api/articles/first");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("explanation");
    expect(body).toMatchObject({ fullExplainer: { docs: `${SITE}/developers` } });
  });
});
