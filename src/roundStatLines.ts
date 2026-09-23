import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { currentOrdinal } from './liveView.js';

type Ev<K extends LogEvent['kind']> = Extract<LogEvent, { kind: K }>;

/** Resolve the ordinal for a round, handling UDP reorder.
 *
 *  Half-2 ROUND_STAT/ROUND_STATS_END/ROUND_MARK lines can arrive after their
 *  map's MAP_RESULT (UDP reorders datagrams). currentOrdinal counts
 *  match_live_maps rows, so if a new map's round row has been written at
 *  its go-live, currentOrdinal would name the NEXT map, not the one these
 *  lines belong to. Lines carry no map name, so the only reliable signal is
 *  the match_rounds row itself: look for an existing round of this half, and
 *  if one exists, it is the ordinal these lines belong to. Only if no round
 *  is recorded yet does currentOrdinal apply (early in half 1 of a new match
 *  or map). */
function roundOrdinal(db: DB, matchId: number, half: number): number {
  const row = db.prepare('SELECT MAX(ordinal) AS o FROM match_rounds WHERE match_id = ? AND half = ?').get(matchId, half) as { o: number | null } | undefined;
  return row?.o ?? currentOrdinal(db, matchId);
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
