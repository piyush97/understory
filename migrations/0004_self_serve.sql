-- Self-serve trials and Lemon Squeezy billing.
ALTER TABLE api_orgs ADD COLUMN email TEXT;
ALTER TABLE api_orgs ADD COLUMN ls_subscription_id TEXT;
ALTER TABLE api_orgs ADD COLUMN ls_customer_id TEXT;
ALTER TABLE api_orgs ADD COLUMN billing_updated_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS api_orgs_email ON api_orgs (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS api_orgs_ls_subscription ON api_orgs (ls_subscription_id)
  WHERE ls_subscription_id IS NOT NULL;

-- Daily trial signups per hashed client IP. Raw IPs are never stored.
CREATE TABLE IF NOT EXISTS api_signups (
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
