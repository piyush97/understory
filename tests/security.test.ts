import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";
import * as dbModule from "../src/infrastructure/db";

const db = vi.hoisted(() => ({ approveRevision: vi.fn(), listReviewQueue: vi.fn() }));
vi.mock("../src/infrastructure/db", () => ({
  ...db,
  getSiteState: vi.fn(async () => ({ publicationVersion: "1" })),
  getPublicationVersion: vi.fn(async () => "1"),
  getRevisionDetail: vi.fn(), rejectRevision: vi.fn(),
}));

let pair: CryptoKeyPair;
let jwk: JsonWebKey;
const issuer = "https://understory-test.cloudflareaccess.com";
const env = {
  ADMIN_TOKEN: "test-editor-token", REQUIRE_ACCESS_JWT: "true",
  ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: "editor-audience",
  ENVIRONMENT: "production", SITE_NAME: "Test", SITE_URL: "https://example.com",
  PIPELINE_QUEUE: { send: vi.fn() },
} as unknown as Bindings;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function jwt(claims: Record<string, unknown> = {}, header = { alg: "RS256", kid: "key-1" }, key?: CryptoKey) {
  const input = `${encode(header)}.${encode({ iss: issuer, aud: ["editor-audience"], exp: Date.now() / 1000 + 300, email: "verified@example.com", sub: "user-1", ...claims })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key ?? pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}
function request(path: string, headers: Record<string, string> = {}, bindings = env, body?: string) {
  return app.fetch(new Request(`https://example.com${path}`, { method: "POST", headers: { origin: "https://example.com", authorization: "Bearer test-editor-token", ...headers }, body }), bindings, {} as ExecutionContext);
}
beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("public cache", () => {
  it("serves a cached page without counting site state", async () => {
    vi.stubGlobal("caches", { default: { match: async () => new Response("cached"), put: async () => {} } });
    const response = await app.fetch(new Request("https://example.com/"), env, { waitUntil() {} } as unknown as ExecutionContext);
    expect(await response.text()).toBe("cached");
    expect(dbModule.getSiteState).not.toHaveBeenCalled();
  });
});

describe("admin request origin", () => {
  it("rejects a cross-site admin action", async () => {
    const response = await request("/admin/discover", { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });
});

describe("admin Access authentication", () => {
  it("rejects a spoofed email header even with the editorial token", async () => {
    const response = await request("/admin/discover", { "cf-access-authenticated-user-email": "spoof@example.com" });
    expect(response.status).toBe(401);
    expect(env.PIPELINE_QUEUE.send).not.toHaveBeenCalled();
  });
  it("accepts a signed Access JWT and attributes review to verified claims", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "key-1", alg: "RS256" }] })));
    db.approveRevision.mockResolvedValue({ slug: "published" });
    const response = await request("/admin/revisions/rev-1/approve", {
      "cf-access-jwt-assertion": await jwt(), "cf-access-authenticated-user-email": "spoof@example.com",
      "content-type": "application/x-www-form-urlencoded",
    }, env, "note=checked");
    expect(response.status).toBe(302);
    expect(db.approveRevision).toHaveBeenCalledWith(undefined, "rev-1", "verified@example.com", "checked");
  });
  it.each([
    { exp: 1 }, { iss: "https://attacker.example.com" }, { aud: ["other"] },
    { nbf: Date.now() / 1000 + 1000 }, { exp: "9999999999" }, { email: undefined, sub: undefined },
  ])("rejects invalid claims %j", async (claims) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "key-1" }] })));
    expect((await request("/admin/discover", { "cf-access-jwt-assertion": await jwt(claims) })).status).toBe(401);
  });
  it("rejects wrong signatures, unsigned tokens and missing Access config", async () => {
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "key-1" }] })));
    for (const token of [await jwt({}, undefined, other.privateKey), await jwt({}, { alg: "none", kid: "key-1" }), "bad.jwt"] ) {
      expect((await request("/admin/discover", { "cf-access-jwt-assertion": token })).status).toBe(401);
    }
    expect((await request("/admin/discover", { "cf-access-jwt-assertion": await jwt() }, { ...env, ACCESS_AUD: undefined })).status).toBe(401);
  });
  it("requires the editorial token even with a valid JWT", async () => {
    expect((await request("/admin/discover", { authorization: "Bearer wrong", "cf-access-jwt-assertion": await jwt() })).status).toBe(401);
  });
  it("does not set a login cookie without Access verification", async () => {
    const response = await request("/admin/login", { "content-type": "application/x-www-form-urlencoded" }, env, "token=test-editor-token");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.status).toBe(401);
  });
  it("sets a login cookie with both valid credentials and accepts that cookie", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "key-1" }] })));
    const assertion = await jwt();
    const response = await request("/admin/login", { "cf-access-jwt-assertion": assertion, "content-type": "application/x-www-form-urlencoded" }, env, "token=test-editor-token");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("understory_admin=");
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect((await request("/admin/discover", { authorization: "", cookie, "cf-access-jwt-assertion": assertion })).status).toBe(302);
    expect((await request("/admin/discover", { authorization: "", cookie })).status).toBe(401);
  });
  it("preserves token-only dev login when Access is disabled", async () => {
    const response = await request("/admin/login", { "content-type": "application/x-www-form-urlencoded" }, { ...env, REQUIRE_ACCESS_JWT: "false" }, "token=test-editor-token");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("understory_admin=");
    expect((await request("/admin/discover", {}, { ...env, REQUIRE_ACCESS_JWT: "false" })).status).toBe(302);
  });
});

describe("admin cache isolation", () => {
  it.each(["/admin", "/admin/login", "/admin/logout", "/admin/discover", "/admin/missing", "/admin/revisions/id/approve"])("never caches %s", async (path) => {
    const match = vi.fn(); const put = vi.fn();
    vi.stubGlobal("caches", { default: { match, put } });
    const response = await request(path);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(match).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
  it("marks login pages and internal errors no-store", async () => {
    expect((await app.fetch(new Request("https://example.com/admin"), env, {} as ExecutionContext)).headers.get("cache-control")).toBe("no-store");
    db.listReviewQueue.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await app.fetch(new Request("https://example.com/admin", { headers: { authorization: "Bearer test-editor-token" } }), { ...env, REQUIRE_ACCESS_JWT: "false" }, {} as ExecutionContext);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
