import type { ApiKeyAuth, ApiOrg } from "../../infrastructure/api";
import { findApiKey } from "../../infrastructure/api";

export const BURST_LIMIT = 60;
export const BURST_WINDOW_MS = 60_000;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A key is valid only while the organization has paid access. Trialing orgs get
 * a date-bound allowance; past-due orgs keep access through their grace date so
 * a failed renewal does not cut a working integration off mid-sync.
 */
export function hasAccess(org: ApiOrg, now: Date): boolean {
  const stamp = now.toISOString();
  switch (org.status) {
    case "active":
      return org.paidThrough !== null && org.paidThrough >= stamp;
    case "past_due":
      return org.graceEndsAt !== null && org.graceEndsAt >= stamp;
    case "trial":
      return org.trialEndsAt !== null && org.trialEndsAt >= stamp;
    default:
      return false;
  }
}

export type AuthOutcome =
  | { ok: true; auth: ApiKeyAuth }
  | { ok: false; reason: "missing" | "invalid" | "inactive" };

export async function authenticateApiRequest(
  db: D1Database,
  authorization: string | undefined,
  now: Date,
): Promise<AuthOutcome> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "");
  if (!match) return { ok: false, reason: "missing" };
  const auth = await findApiKey(db, await sha256Hex(match[1]!));
  if (!auth) return { ok: false, reason: "invalid" };
  if (!hasAccess(auth.org, now)) return { ok: false, reason: "inactive" };
  return { ok: true, auth };
}

export function windowStart(now: Date): string {
  return new Date(Math.floor(now.getTime() / BURST_WINDOW_MS) * BURST_WINDOW_MS).toISOString();
}

export function billingPeriodStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Seconds until the current burst window rolls over (at least 1). */
export function retryAfterSeconds(now: Date): number {
  const elapsed = now.getTime() % BURST_WINDOW_MS;
  return Math.max(1, Math.ceil((BURST_WINDOW_MS - elapsed) / 1000));
}
