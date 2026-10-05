import type { DB } from './db.js';

/** The steps of an in-game !gg vote, as pug-gg.inc's GG line names them. */
export const GG_EVENTS = ['start', 'agree', 'pass', 'fail', 'dropped', 'refused'] as const;
export type GgEvent = typeof GG_EVENTS[number];

export interface GgLine {
  token: string;
  event: GgEvent;
  team: 'a' | 'b';
  /** Who typed !gg: set on start, agree and refused, null on team outcomes. */
  steamid: string | null;
  /** Why a !gg was refused or a vote dropped (winnable, cooldown, ...). */
  reason: string | null;
  /** Points behind and the ceiling it was judged on; null when not worked out. */
  gap: number | null;
  best: number | null;
  yes: number;
  need: number;
}

/**
 * Keep one row per step of a !gg vote, so staff can see who tried to forfeit
 * and how it went, and so a player's attempts can be counted. Lines for a
 * token that names no match (a !gg typed on an idle box) are dropped.
 */
export function recordGgLine(db: DB, ev: GgLine): number | null {
  const row = db.prepare('SELECT id FROM matches WHERE token = ?').get(ev.token) as { id: number } | undefined;
  if (!row) return null;
  db.prepare(
    `INSERT INTO match_gg_votes (match_id, event, team, player_id, reason, gap, best, yes, need)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, ev.event, ev.team, ev.steamid, ev.reason, ev.gap, ev.best, ev.yes, ev.need);
  return row.id;
}

/** A player's forfeit record: matches their team forfeited, and how many
 *  times they started a !gg vote, in completed PUGs. */
export function forfeitRecord(db: DB, steamid: string, completedSql: string): { forfeits: number; ggStarted: number } {
  const f = db.prepare(
    `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND m.forfeit_team = mp.team AND ${completedSql}`,
  ).get(steamid) as { n: number };
  const g = db.prepare(
    `SELECT COUNT(DISTINCT g.match_id) AS n FROM match_gg_votes g JOIN matches m ON m.id = g.match_id
     WHERE g.player_id = ? AND g.event = 'start' AND ${completedSql}`,
  ).get(steamid) as { n: number };
  return { forfeits: f.n, ggStarted: g.n };
}
