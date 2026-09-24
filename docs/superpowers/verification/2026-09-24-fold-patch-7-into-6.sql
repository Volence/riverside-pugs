-- One-off repair, NOT RUN. Needs the owner's go-ahead.
--
-- Folds balance patch 7 into patch 6. Patch 7 was detected on Dallas at
-- 2026-09-24 05:41:10 (match 169, 8 rounds) only because l4d_tvwatch.smx was
-- new; at the 06:27 boot l4d_tvwatch joined the ignored list and the
-- refingerprint merged 7 into 6 (fingerprint set to NULL), leaving its 8
-- rounds on 7. Their inventories are identical once l4d_tvwatch is ignored
-- (pug-match.smx also differs, but it is versionless).
--
-- Same effect as `scripts/merge-balance-patches.ts <db> 6 7 --apply`, except
-- that it leaves balance_server_state alone: the script rewrites every
-- server's stored inventory to patch 6's, which carries the older pug-match
-- hash, so Dallas's next sighting would post a "config changed" alert.
--
-- Run only while no match is live (a live match can tag rounds mid-repair):
--   sqlite3 /home/pug/app/data/pug.db < 2026-09-24-fold-patch-7-into-6.sql
-- Back the database up first. Checked on a copy of the 06:3x snapshot:
-- moves 8 match_rounds, 0 round_metric_context rows (8 once match 169 is
-- computed), 1 server sighting.

-- .bail on: the sqlite3 shell otherwise carries on after a failed statement.
-- Each guard is a CHECK that fails (and stops the script) when its condition
-- does not hold.
.bail on
BEGIN;
CREATE TEMP TABLE guard_no_live_match (n INTEGER CHECK (n = 0));
INSERT INTO guard_no_live_match SELECT COUNT(*) FROM matches WHERE state IN ('live', 'configuring');
CREATE TEMP TABLE guard_patch_7_merged (n INTEGER CHECK (n = 1));
INSERT INTO guard_patch_7_merged SELECT COUNT(*) FROM balance_patches
  WHERE id = 7 AND source = 'detected' AND fingerprint IS NULL;

UPDATE match_rounds SET patch_id = 6 WHERE patch_id = 7;
UPDATE round_metric_context SET patch_id = 6 WHERE patch_id = 7;
INSERT INTO balance_patch_servers (patch_id, server_id, first_seen_at, last_seen_at)
  SELECT 6, server_id, first_seen_at, last_seen_at FROM balance_patch_servers WHERE patch_id = 7
  ON CONFLICT (patch_id, server_id) DO UPDATE SET
    first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
    last_seen_at  = MAX(last_seen_at, excluded.last_seen_at);
DELETE FROM balance_patch_servers WHERE patch_id = 7;
UPDATE balance_server_state SET patch_id = 6 WHERE patch_id = 7;
DELETE FROM balance_patches WHERE id = 7;
COMMIT;
