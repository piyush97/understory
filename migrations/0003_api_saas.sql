-- Hosted read API: organizations, keys, metering, and the change feed.
-- Access is granted from these rows only.

CREATE TABLE api_orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'trial'
    CHECK (status IN ('trial', 'active', 'past_due', 'canceled')),
  request_limit INTEGER NOT NULL DEFAULT 1000,
  trial_ends_at TEXT,
  paid_through TEXT,
  grace_ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES api_orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);

CREATE INDEX api_keys_org_idx ON api_keys(org_id, revoked_at);

CREATE TABLE api_usage (
  org_id TEXT NOT NULL REFERENCES api_orgs(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  limit_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, period_start)
);

CREATE TABLE api_burst (
  org_id TEXT NOT NULL REFERENCES api_orgs(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, window_start)
);

CREATE TABLE api_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  revision_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('published', 'corrected', 'withdrawn')),
  occurred_at TEXT NOT NULL
);

CREATE INDEX api_changes_article_idx ON api_changes(article_id, sequence);

-- Bootstrap the feed so existing published revisions are reachable by clients
-- that start syncing after this migration ships.
INSERT INTO api_changes (article_id, revision_id, type, occurred_at)
SELECT a.id, a.published_revision_id, 'published', COALESCE(r.reviewed_at, r.created_at)
FROM articles a
JOIN explanation_revisions r ON r.id = a.published_revision_id
WHERE a.status = 'published';
