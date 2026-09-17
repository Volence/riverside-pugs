import type { DB } from './db.js';
import { recordMatchDemos } from './demos.js';
import { recordMatchReplays } from './replays.js';

/** How far back a finished match is still re-scanned for its files. */
const WINDOW_HOURS = 6;

/**
 * Link demos and replay files that appeared after their match ended.
 *
 * On the box the backend shares, files are on disk as the match plays and the
 * live feed indexes them as they appear. A second game server (Chicago, NFO)
 * has no shared filesystem: its files are pulled over FTP minutes later, long
 * after MATCH_END. Without this they would sit in the directory unlinked and
 * never show on the match page.
 *
 * Cheap and idempotent: a readdir per recent match, and both record functions
 * upsert.
 */
export function reindexRecentMatches(db: DB, demoDir: string, replayDir: string): number {
  if (!demoDir && !replayDir) return 0;
  const rows = db.prepare(
    `SELECT id, token FROM matches
     WHERE token IS NOT NULL AND state IN ('completed', 'aborted')
       AND ended_at IS NOT NULL AND ended_at >= datetime('now', ?)`,
  ).all(`-${WINDOW_HOURS} hours`) as { id: number; token: string }[];
  let linked = 0;
  for (const m of rows) {
    try {
      if (demoDir) linked += recordMatchDemos(db, m.id, m.token, demoDir);
      if (replayDir) linked += recordMatchReplays(db, m.id, m.token, replayDir);
    } catch (err) {
      console.error(`[reindex] match ${m.id} failed:`, err);
    }
  }
  return linked;
}
