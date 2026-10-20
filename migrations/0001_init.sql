-- Understory schema, revision 1.
-- SQLite/D1. All timestamps are ISO-8601 UTC strings.

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO meta (key, value) VALUES
  ('publication_version', '0'),
  ('schema_version', '1');

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site_url TEXT NOT NULL,
  feed_url TEXT,
  host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX sources_feed_idx ON sources (feed_url) WHERE feed_url IS NOT NULL;
CREATE INDEX sources_host_idx ON sources (host);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources (id),
  canonical_url TEXT NOT NULL,
  original_title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  author TEXT,
  summary TEXT,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered', 'extracting', 'generating', 'review', 'published', 'failed', 'skipped')),
  context_headline TEXT,
  dek TEXT,
  topic_id TEXT,
  reading_minutes INTEGER,
  published_revision_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX articles_url_idx ON articles (canonical_url);
CREATE UNIQUE INDEX articles_slug_idx ON articles (slug);
CREATE INDEX articles_published_idx ON articles (status, published_at DESC, id DESC);
CREATE INDEX articles_source_idx ON articles (source_id, published_at DESC);
CREATE INDEX articles_topic_idx ON articles (topic_id, published_at DESC);

CREATE TABLE article_snapshots (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  extractor_version TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  final_url TEXT,
  http_status INTEGER,
  UNIQUE (article_id, source_hash)
);

CREATE INDEX snapshots_article_idx ON article_snapshots (article_id, fetched_at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('extract', 'generate', 'discover')),
  article_id TEXT REFERENCES articles (id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'done', 'failed', 'deferred')),
  attempts INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  next_run_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX jobs_idempotency_idx ON jobs (idempotency_key);
CREATE INDEX jobs_ready_idx ON jobs (state, next_run_at);
CREATE INDEX jobs_article_idx ON jobs (article_id, kind);

CREATE TABLE explanation_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES article_snapshots (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'published', 'rejected')),
  content_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT,
  UNIQUE (article_id, snapshot_id, model_id, prompt_version, schema_version)
);

CREATE INDEX revisions_article_idx ON explanation_revisions (article_id, status, created_at DESC);
CREATE INDEX revisions_review_idx ON explanation_revisions (status, created_at ASC);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES explanation_revisions (id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note TEXT,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX reviews_revision_idx ON reviews (revision_id, created_at DESC);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE article_topics (
  article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, topic_id)
);

CREATE INDEX article_topics_topic_idx ON article_topics (topic_id, article_id);

CREATE TABLE ai_budget (
  day TEXT PRIMARY KEY,
  reserved_neurons INTEGER NOT NULL DEFAULT 0,
  used_neurons INTEGER NOT NULL DEFAULT 0,
  generations INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX articles_published_only_idx
  ON articles (published_at DESC, id DESC)
  WHERE status = 'published';
