import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { currentOrdinal } from './liveView.js';

type Ev<K extends LogEvent['kind']> = Extract<LogEvent, { kind: K }>;

/** Resolve the ordinal for a round, handling UDP reorder.
 *
 *  Half 1 always uses currentOrdinal: it is the first line of a new map, so
 *  there is nothing earlier it could have reordered behind. Using MAX(ordinal)
 *  here (the old rule) was the bug: if a map's ROUND_START datagram was lost,
 *  no match_rounds row exists yet at (currentOrdinal, 1), so MAX(ordinal) fell
 *  back to the PREVIOUS map's row and every stat and skill_detect for the new
 *  map's half 1 silently overwrote that map's instead.
 *
 *  Half-2 ROUND_STAT/ROUND_STATS_END/ROUND_MARK lines can arrive after their
 *  map's MAP_RESULT (UDP reorders datagrams). currentOrdinal counts
 *  match_live_maps rows, so once a new map's go-live has landed, currentOrdinal
 *  names the NEW map, not the one these reordered half-2 lines belong to.
 *  Lines carry no map name, so the signal used is the match_rounds row itself:
 *  if a round already exists at currentOrdinal (either half, meaning this map
 *  has started), these lines belong there; otherwise, if the PREVIOUS map has
 *  a half-2 row, they reordered behind that map's MAP_RESULT and belong there
 *  instead. Only when neither holds (a genuinely new match or map with no
 *  round recorded anywhere yet) does currentOrdinal apply on its own. */
function roundOrdinal(db: DB, matchId: number, half: number): number {
  const c = currentOrdinal(db, matchId);
  if (half === 1) return c;
  const hasRow = (ordinal: number, h: number): boolean =>
    !!db.prepare('SELECT 1 FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?').get(matchId, ordinal, h);
  if (hasRow(c, 1) || hasRow(c, 2)) return c;
  if (c > 0 && hasRow(c - 1, 2)) return c - 1;
  return c;
}

/** Per-round deltas for the balance metrics. Upsert, never add: UDP can
 *  duplicate a datagram and the plugin sends each value once per round. */
export function recordRoundStat(db: DB, matchId: number, ev: Ev<'round_stat'>): void {
  const ordinal = roundOrdinal(db, matchId, ev.half);
  const ins = db.prepare(`INSERT INTO match_round_stats (match_id, ordinal, half, player_id, stat, value)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (match_id, ordinal, half, player_id, stat) DO UPDATE SET value = excluded.value`);
  db.transaction(() => {
    for (const [stat, value] of Object.entries(ev.stats)) ins.run(matchId, ordinal, ev.half, ev.steamid, stat, value);
  })();
}

export function recordRoundStatsEnd(db: DB, matchId: number, ev: Ev<'round_stats_end'>): void {
  const ordinal = roundOrdinal(db, matchId, ev.half);
  db.prepare('UPDATE match_rounds SET skill_detect = ? WHERE match_id = ? AND ordinal = ? AND half = ?')
    .run(ev.skillDetect ? 1 : 0, matchId, ordinal, ev.half);
}

export function recordRoundMark(db: DB, matchId: number, ev: Ev<'round_mark'>): void {
  const ordinal = roundOrdinal(db, matchId, ev.half);
  db.prepare(`INSERT OR IGNORE INTO match_round_marks (match_id, ordinal, half, kind, t_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(matchId, ordinal, ev.half, ev.mark, ev.tMs);
}

/** Delete stale per-round stats and markers from a replayed or restarted half.
 *  Called when a ROUND_START is recorded for a half that already holds data. */
export function resetRoundLines(db: DB, matchId: number, ordinal: number, half: 1 | 2): void {
  db.transaction(() => {
    db.prepare('DELETE FROM match_round_stats WHERE match_id = ? AND ordinal = ? AND half = ?').run(matchId, ordinal, half);
    db.prepare('DELETE FROM match_round_marks WHERE match_id = ? AND ordinal = ? AND half = ?').run(matchId, ordinal, half);
  })();
}
