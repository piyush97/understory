import type { ApiOrg } from "./api";

export const TRIAL_DAYS = 14;
export const TRIAL_REQUEST_LIMIT = 1_000;
export const PAID_REQUEST_LIMIT = 25_000;
export const SIGNUPS_PER_IP_PER_DAY = 3;

/**
 * Counts one trial signup for a hashed client IP. Returns false once the daily
 * cap is reached; the counter does not advance past the cap.
 */
export async function allowSignup(db: D1Database, ipHash: string, day: string): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO api_signups (ip_hash, day, count) VALUES (?, ?, 1)
       ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1
       WHERE count < ?
       RETURNING count`,
    )
    .bind(ipHash, day, SIGNUPS_PER_IP_PER_DAY)
    .first<{ count: number }>();
  return row !== null;
}

export type TrialInput = {
  orgId: string;
  name: string;
  email: string;
  keyId: string;
  keyPrefix: string;
  keyHash: string;
  now: Date;
};

/** Creates a trial org and its first key. Returns false when the email already has an org. */
export async function createTrialOrg(db: D1Database, input: TrialInput): Promise<boolean> {
  const now = input.now.toISOString();
  const trialEndsAt = new Date(input.now.getTime() + TRIAL_DAYS * 86_400_000).toISOString();
  const existing = await db
    .prepare("SELECT 1 AS found FROM api_orgs WHERE email = ?")
    .bind(input.email)
    .first<{ found: number }>();
  if (existing) return false;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO api_orgs (id, name, email, status, request_limit, trial_ends_at, created_at, updated_at)
           VALUES (?, ?, ?, 'trial', ?, ?, ?, ?)`,
        )
        .bind(input.orgId, input.name, input.email, TRIAL_REQUEST_LIMIT, trialEndsAt, now, now),
      db
        .prepare(
          `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, created_at)
           VALUES (?, ?, 'primary', ?, ?, ?)`,
        )
        .bind(input.keyId, input.orgId, input.keyPrefix, input.keyHash, now),
    ]);
  } catch (error) {
    // A concurrent signup for the same email loses the unique-index race.
    if (String(error).includes("UNIQUE")) return false;
    throw error;
  }
  return true;
}

export type OrgBillingRef = { id: string; email: string | null };

export async function findOrgForKeyHash(db: D1Database, keyHash: string): Promise<OrgBillingRef | null> {
  return db
    .prepare(
      `SELECT o.id, o.email FROM api_keys k JOIN api_orgs o ON o.id = k.org_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    )
    .bind(keyHash)
    .first<OrgBillingRef>();
}

export type SubscriptionUpdate = {
  orgId: string | null;
  subscriptionId: string;
  customerId: string | null;
  status: ApiOrg["status"];
  requestLimit: number;
  paidThrough: string | null;
  graceEndsAt: string | null;
  updatedAt: string;
};

/**
 * Applies a subscription state from the billing provider. Out-of-order deliveries
 * are ignored: an update older than the stored billing_updated_at changes nothing.
 * The org is matched by checkout custom data when present, else by subscription id.
 * Returns false when no org matched or the update was stale.
 */
export async function applySubscription(db: D1Database, update: SubscriptionUpdate): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE api_orgs
          SET status = ?, request_limit = ?, paid_through = ?,
              grace_ends_at = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(grace_ends_at, ?) END,
              ls_subscription_id = ?, ls_customer_id = COALESCE(?, ls_customer_id),
              billing_updated_at = ?, updated_at = ?
        WHERE (id = ? OR (? = '' AND ls_subscription_id = ?))
          AND (billing_updated_at IS NULL OR billing_updated_at <= ?)`,
    )
    .bind(
      update.status,
      update.requestLimit,
      update.paidThrough,
      update.graceEndsAt,
      update.graceEndsAt,
      update.subscriptionId,
      update.customerId,
      update.updatedAt,
      new Date().toISOString(),
      update.orgId ?? "",
      update.orgId ?? "",
      update.subscriptionId,
      update.updatedAt,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}
