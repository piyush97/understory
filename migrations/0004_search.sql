-- Full-text search over published explainers.
-- Plain FTS5 table (no external content): D1 ships FTS5, and an external
-- content table would need per-row rebuild triggers we do not want.
--
-- Sync strategy: maintenance-free. Publication paths (approveRevision and
-- automatic publication in insertRevision) delete and re-insert the article's
-- row inside the same transaction, so corrections refresh the index. Reads
-- join articles with status = 'published', so stale rows never surface.
--
-- This seed is re-runnable: it clears and rebuilds from the current published
-- set, which is also the recovery path if the index ever drifts.

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  article_id UNINDEXED,
  slug UNINDEXED,
  title,
  dek,
  body,
  tokenize = 'unicode61'
);

DELETE FROM search_index;

INSERT INTO search_index (article_id, slug, title, dek, body)
SELECT a.id, a.slug,
       COALESCE(a.context_headline, a.original_title),
       COALESCE(a.dek, ''),
       r.content_json
FROM articles a
JOIN explanation_revisions r ON r.id = a.published_revision_id
WHERE a.status = 'published';
