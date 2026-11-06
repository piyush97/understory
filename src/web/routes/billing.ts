import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { bool } from "../../shared/env";
import { applySubscription, PAID_REQUEST_LIMIT, type SubscriptionUpdate } from "../../infrastructure/billing";

const GRACE_MS = 14 * 86_400_000;

type SubscriptionAttributes = {
  store_id?: number | string;
  variant_id?: number | string;
  customer_id?: number | string | null;
  status?: string;
  renews_at?: string | null;
  ends_at?: string | null;
  trial_ends_at?: string | null;
  updated_at?: string;
  test_mode?: boolean;
};

type WebhookPayload = {
  meta?: { event_name?: string; custom_data?: { org_id?: unknown } | null };
  data?: { type?: string; id?: string | number; attributes?: SubscriptionAttributes };
};

/**
 * Maps a Lemon Squeezy subscription to Understory access. Paid access always ends at
 * a provider-supplied date: renews_at for a current cycle, ends_at once cancelled.
 * Returns null for statuses Understory does not recognize.
 */
export function mapSubscription(
  attrs: SubscriptionAttributes,
): Pick<SubscriptionUpdate, "status" | "paidThrough" | "graceEndsAt"> | null {
  const updatedAt = attrs.updated_at ?? new Date().toISOString();
  switch (attrs.status) {
    case "active":
      return { status: "active", paidThrough: attrs.renews_at ?? null, graceEndsAt: null };
    case "on_trial":
      return { status: "active", paidThrough: attrs.trial_ends_at ?? null, graceEndsAt: null };
    case "cancelled":
      return { status: "active", paidThrough: attrs.ends_at ?? null, graceEndsAt: null };
    case "past_due":
      return {
        status: "past_due",
        paidThrough: attrs.renews_at ?? null,
        graceEndsAt: new Date(Date.parse(updatedAt) + GRACE_MS).toISOString(),
      };
    case "paused":
    case "unpaid":
    case "expired":
      return { status: "canceled", paidThrough: null, graceEndsAt: null };
    default:
      return null;
  }
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Constant-time HMAC-SHA256 check of the raw request body. */
export async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  const expected = hexToBytes(signature.trim());
  if (!expected) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, expected, new TextEncoder().encode(body));
}

export async function handleLemonSqueezyWebhook(c: Context<AppEnv>) {
  const secret = c.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "billing_not_configured" }, 503);
  const raw = await c.req.text();
  if (!(await verifySignature(secret, raw, c.req.header("x-signature") ?? ""))) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw) as WebhookPayload;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const event = payload.meta?.event_name ?? "";
  const attrs = payload.data?.attributes;
  // Invoice and order events carry no subscription state; subscription_updated follows them.
  if (!event.startsWith("subscription_") || payload.data?.type !== "subscriptions" || !attrs) {
    return c.json({ ok: true, applied: false, reason: "ignored_event" });
  }
  if (
    String(attrs.store_id) !== c.env.LEMONSQUEEZY_STORE_ID ||
    String(attrs.variant_id) !== c.env.LEMONSQUEEZY_VARIANT_ID ||
    Boolean(attrs.test_mode) !== bool(c.env.LEMONSQUEEZY_TEST_MODE)
  ) {
    return c.json({ ok: true, applied: false, reason: "other_product" });
  }
  const mapped = mapSubscription(attrs);
  if (!mapped || !attrs.updated_at || payload.data?.id === undefined) {
    return c.json({ ok: true, applied: false, reason: "unknown_status" });
  }
  const orgId = payload.meta?.custom_data?.org_id;
  const applied = await applySubscription(c.env.DB, {
    ...mapped,
    orgId: typeof orgId === "string" && orgId.startsWith("org_") ? orgId : null,
    subscriptionId: String(payload.data.id),
    customerId: attrs.customer_id == null ? null : String(attrs.customer_id),
    requestLimit: PAID_REQUEST_LIMIT,
    updatedAt: attrs.updated_at,
  });
  return c.json({ ok: true, applied });
}
