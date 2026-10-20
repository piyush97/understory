import { fetchPublicText } from "./fetch";

type AccessConfig = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };
type AccessKey = JsonWebKey & { kid: string; alg?: string; use?: string };
type KeySet = { keys: AccessKey[]; fetchedAt: number };
const cache = new Map<string, KeySet>();
const pending = new Map<string, Promise<KeySet>>();
const MAX_AGE = 5 * 60_000;
const REFRESH_INTERVAL = 30_000;

function issuerFor(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

async function loadKeys(issuer: string): Promise<KeySet> {
  const running = pending.get(issuer);
  if (running) return running;
  if (pending.size >= 8) throw new Error("Access key fetch busy");
  const task = (async () => {
    const result = await fetchPublicText(`${issuer}/cdn-cgi/access/certs`, {
      maxBytes: 64_000, timeoutMs: 5_000, maxRedirects: 0, headers: { Accept: "application/json" },
    });
    const data: unknown = JSON.parse(result.text);
    const keys = data && typeof data === "object" && "keys" in data ? data.keys : undefined;
    if (!Array.isArray(keys) || keys.length > 32) throw new Error("Invalid Access key set");
    const valid = keys.filter((key): key is AccessKey => key && typeof key === "object" && typeof key.kid === "string" && key.kid.length <= 256 &&
      key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig") && typeof key.n === "string" && typeof key.e === "string");
    if (!valid.length) throw new Error("No Access signing keys");
    const entry = { keys: valid, fetchedAt: Date.now() };
    if (!cache.has(issuer) && cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(issuer, entry);
    return entry;
  })();
  pending.set(issuer, task);
  try { return await task; }
  catch (error) {
    if (!cache.has(issuer) && cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(issuer, { keys: [], fetchedAt: Date.now() });
    throw error;
  } finally { pending.delete(issuer); }
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid JWT encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}
function object(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(value)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JWT object");
  return parsed as Record<string, unknown>;
}

function validTimes(claims: Record<string, unknown>): boolean {
  const now = Date.now() / 1000;
  return typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > now &&
    (claims.nbf === undefined || (typeof claims.nbf === "number" && Number.isFinite(claims.nbf) && claims.nbf <= now)) &&
    (claims.iat === undefined || (typeof claims.iat === "number" && Number.isFinite(claims.iat) && claims.iat <= now));
}

/** Return only a cryptographically verified reviewer, or null (including misconfiguration/outage). */
export async function verifyAccessJwt(token: string | undefined, config: AccessConfig): Promise<string | null> {
  const issuer = issuerFor(config.ACCESS_TEAM_DOMAIN);
  const audience = config.ACCESS_AUD?.trim();
  if (!issuer || !audience || !token || token.length > 16_384) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, payload, signature] = parts as [string, string, string];
    const header = object(head);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 256 || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined) return null;
    const claims = object(payload);
    if (claims.iss !== issuer || !validTimes(claims) ||
        !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.every((item) => typeof item === "string") && claims.aud.includes(audience)))) return null;
    const reviewer = typeof claims.email === "string" && claims.email.trim() ? claims.email : claims.sub;
    if (typeof reviewer !== "string" || !reviewer.trim() || reviewer.length > 512) return null;
    let entry = cache.get(issuer);
    if (!entry || Date.now() - entry.fetchedAt >= MAX_AGE) entry = await loadKeys(issuer);
    const verify = async (keys: AccessKey[]) => {
      const jwk = keys.find((key) => key.kid === header.kid);
      if (!jwk) return false;
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(signature), new TextEncoder().encode(`${head}.${payload}`));
    };
    if (await verify(entry.keys)) return validTimes(claims) ? reviewer : null;
    // Unknown/rotated keys refresh at most once per interval, not once per attacker-supplied kid.
    if (Date.now() - entry.fetchedAt >= REFRESH_INTERVAL) {
      entry = await loadKeys(issuer);
      if (await verify(entry.keys)) return validTimes(claims) ? reviewer : null;
    }
    return null;
  } catch { return null; }
}
