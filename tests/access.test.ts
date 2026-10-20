import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let pair: CryptoKeyPair;
let second: CryptoKeyPair;
let jwk: JsonWebKey;
let jwk2: JsonWebKey;
let verify: typeof import("../src/shared/access").verifyAccessJwt;
const config = { ACCESS_TEAM_DOMAIN: "access-tests.cloudflareaccess.com", ACCESS_AUD: "audience" };
const issuer = `https://${config.ACCESS_TEAM_DOMAIN}`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function token(kid = "one", key?: CryptoKey, expiresIn = 600) {
  const input = `${encode({ alg: "RS256", kid })}.${encode({ iss: issuer, aud: ["audience"], exp: Date.now() / 1000 + expiresIn, sub: "subject" })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key ?? pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}
beforeAll(async () => {
  const generate = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  [pair, second] = await Promise.all([generate(), generate()]);
  [jwk, jwk2] = await Promise.all([crypto.subtle.exportKey("jwk", pair.publicKey), crypto.subtle.exportKey("jwk", second.publicKey)]);
});
beforeEach(async () => {
  vi.resetModules();
  verify = (await import("../src/shared/access")).verifyAccessJwt;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const keyResponse = (key = jwk, kid = "one") => Response.json({ keys: [{ ...key, kid }] });

describe("bounded Access key retrieval", () => {
  it("rejects a token that expires while initial JWKS retrieval is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      return keyResponse();
    }));
    expect(await verify(await token("one", pair.privateKey, 1), config)).toBeNull();
  });
  it("rejects a token that expires while rotated JWKS retrieval is pending", async () => {
    const fetch = vi.fn().mockImplementationOnce(async () => keyResponse()).mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      return keyResponse(jwk2, "two");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await verify(await token(), config)).toBe("subject");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await verify(await token("two", second.privateKey, 1), config)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("fetches only the configured issuer endpoint and caches verified keys", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => keyResponse()); vi.stubGlobal("fetch", fetch);
    const signed = await token();
    expect(await verify(signed, config)).toBe("subject");
    expect(await verify(signed, config)).toBe("subject");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${issuer}/cdn-cgi/access/certs`);
  });
  it("refreshes a rotated key after the cooldown without allowing random-kid fetch storms", async () => {
    const fetch = vi.fn().mockImplementationOnce(async () => keyResponse()).mockImplementation(async () => keyResponse(jwk2, "two"));
    vi.stubGlobal("fetch", fetch);
    expect(await verify(await token(), config)).toBe("subject");
    for (let i = 0; i < 5; i++) expect(await verify(await token(`unknown-${i}`), config)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await verify(await token("two", second.privateKey), config)).toBe("subject");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("fails closed with throttled retries when JWKS is unavailable", async () => {
    const fetch = vi.fn(async () => { throw new Error("offline"); }); vi.stubGlobal("fetch", fetch);
    const signed = await token();
    expect(await verify(signed, config)).toBeNull();
    expect(await verify(signed, config)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await verify(signed, config)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not accept stale signing keys when a refresh fails", async () => {
    const fetch = vi.fn().mockImplementationOnce(async () => keyResponse()).mockRejectedValue(new Error("offline")); vi.stubGlobal("fetch", fetch);
    expect(await verify(await token(), config)).toBe("subject");
    await vi.advanceTimersByTimeAsync(300_001);
    expect(await verify(await token(), config)).toBeNull();
  });
  it("rejects oversized JWKS, redirects, and invalid issuer configuration", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(64_001))); vi.stubGlobal("fetch", fetch);
    expect(await verify(await token(), config)).toBeNull();
    for (const domain of ["http://access-tests.cloudflareaccess.com", "https://evil.example", "access-tests.cloudflareaccess.com/path", "user@access-tests.cloudflareaccess.com"]) {
      expect(await verify(await token(), { ...config, ACCESS_TEAM_DOMAIN: domain })).toBeNull();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.resetModules(); verify = (await import("../src/shared/access")).verifyAccessJwt;
    fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/jwks" } }));
    expect(await verify(await token(), config)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
