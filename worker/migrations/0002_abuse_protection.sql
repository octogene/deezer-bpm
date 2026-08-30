ALTER TABLE sync_spaces
ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sync_spaces
ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sync_spaces
ADD COLUMN track_count INTEGER NOT NULL DEFAULT 0 CHECK (track_count >= 0);

ALTER TABLE sync_spaces
ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));

UPDATE sync_spaces
SET
  created_at = unixepoch(),
  last_active_at = unixepoch(),
  track_count = (
    SELECT COUNT(*)
    FROM overrides
    WHERE overrides.sync_hash = sync_spaces.sync_hash
  );

CREATE INDEX sync_spaces_by_activity
ON sync_spaces(active, last_active_at);

