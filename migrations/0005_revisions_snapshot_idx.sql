-- Index the explanation_revisions.snapshot_id foreign key. Without it, every
-- "is this snapshot referenced" check in getSnapshotStorageReport and every
-- ON DELETE CASCADE from article_snapshots scans the whole revisions table.
-- Additive only: no rows are changed.
CREATE INDEX IF NOT EXISTS revisions_snapshot_idx ON explanation_revisions (snapshot_id);
