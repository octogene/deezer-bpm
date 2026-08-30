-- 0002's backfill (and the advance query it mirrored) counted deletion
-- tombstones (overrides.deleted = 1) toward track_count, so a space that had
-- ever accumulated deletions could get permanently stuck at its capacity
-- cap even after most of its tracks were removed. Recompute track_count for
-- every space using only live (non-deleted) rows.
UPDATE sync_spaces
SET track_count = (
  SELECT COUNT(*)
  FROM overrides
  WHERE overrides.sync_hash = sync_spaces.sync_hash
    AND overrides.deleted = 0
);
