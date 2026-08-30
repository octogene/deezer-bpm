CREATE TABLE sync_spaces (
  sync_hash TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE overrides (
  sync_hash TEXT NOT NULL,
  track_id TEXT NOT NULL,
  bpm INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (sync_hash, track_id),
  FOREIGN KEY (sync_hash) REFERENCES sync_spaces(sync_hash) ON DELETE CASCADE,
  CHECK (
    (deleted = 1 AND bpm IS NULL) OR
    (deleted = 0 AND bpm BETWEEN 1 AND 999)
  )
);

-- track_id is part of the key so the delta query's keyset pagination
-- (ORDER BY revision, track_id) is served entirely from this index.
CREATE INDEX overrides_by_revision
  ON overrides(sync_hash, revision, track_id);
