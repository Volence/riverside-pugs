import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { currentOrdinal } from './liveView.js';

type Ev<K extends LogEvent['kind']> = Extract<LogEvent, { kind: K }>;

/** Per-round deltas for the balance metrics. Upsert, never add: UDP can
 *  duplicate a datagram and the plugin sends each value once per round. */
export function recordRoundStat(db: DB, matchId: number, ev: Ev<'round_stat'>): void {
  const ordinal = currentOrdinal(db, matchId);
  const ins = db.prepare(`INSERT INTO match_round_stats (match_id, ordinal, half, player_id, stat, value)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (match_id, ordinal, half, player_id, stat) DO UPDATE SET value = excluded.value`);
  db.transaction(() => {
    for (const [stat, value] of Object.entries(ev.stats)) ins.run(matchId, ordinal, ev.half, ev.steamid, stat, value);
  })();
}

export function recordRoundStatsEnd(db: DB, matchId: number, ev: Ev<'round_stats_end'>): void {
  db.prepare('UPDATE match_rounds SET skill_detect = ? WHERE match_id = ? AND ordinal = ? AND half = ?')
    .run(ev.skillDetect ? 1 : 0, matchId, currentOrdinal(db, matchId), ev.half);
}

export function recordRoundMark(db: DB, matchId: number, ev: Ev<'round_mark'>): void {
  db.prepare(`INSERT OR IGNORE INTO match_round_marks (match_id, ordinal, half, kind, t_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(matchId, currentOrdinal(db, matchId), ev.half, ev.mark, ev.tMs);
}
