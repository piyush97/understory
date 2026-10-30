ALTER TABLE articles ADD COLUMN selection_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN selection_reason TEXT;
ALTER TABLE articles ADD COLUMN duplicate_of TEXT;

CREATE INDEX articles_lead_idx
  ON articles (status, selection_score DESC, published_at DESC);

CREATE INDEX articles_selection_idx
  ON articles (status, selection_score);
