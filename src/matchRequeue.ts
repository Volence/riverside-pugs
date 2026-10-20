import type { DB } from './db.js';

/**
 * Queue again when the match ends (owner idea 2026-10-20): a player types !rq
 * in game, or flips the toggle on the site, and is put back in the queue the
 * moment their match is completed, instead of going back to Discord or the
 * site to press Join. They join at the BACK, like anyone joining: the people
 * already waiting are not jumped. Every queue rule still applies at that
 * moment (Matchmaker.join): a ban, a timeout or the Discord requirement turns
 * the request down then, and the end-of-match note says so.
 *
 * Only for queue PUGs: a scrim, a tournament game or a booking has its own
 * next game and nothing to requeue into.
 */

/** How long after a match ends a late !rq still counts. The plugin keeps
 *  players on the server about eight seconds past the end, so this only has
 *  to cover that window and a slow log line. */
export const LATE_REQUEUE_MS = 2 * 60 * 1000;

export interface RequeueMatch {
  id: number;
  state: string;
  endedAt: string | null;
}

/** The match this player may ask to be requeued from: a queue PUG they are
 *  rostered on that is live, or completed within LATE_REQUEUE_MS. `matchId`
 *  is the one the request named (the plugin's, or the page's). Null when the
 *  request does not fit. `serverId`, when given, must be the match's box: a
 *  line from one server cannot speak for a match on another. */
export function requeueMatchFor(
  db: DB, matchId: number, steamid: string, serverId: number | null = null, now = new Date(),
): RequeueMatch | null {
  const m = db.prepare(
    `SELECT m.id, m.state, m.ended_at, m.server_id, m.kind, m.booking_id FROM matches m
     JOIN match_players p ON p.match_id = m.id AND p.player_id = ?
     WHERE m.id = ?`,
  ).get(steamid, matchId) as { id: number; state: string; ended_at: string | null; server_id: number | null; kind: string; booking_id: number | null } | undefined;
  if (!m || m.kind !== 'pug' || m.booking_id !== null) return null;
  if (serverId !== null && m.server_id !== serverId) return null;
  if (m.state === 'live') return { id: m.id, state: m.state, endedAt: null };
  if (m.state === 'completed' && m.ended_at !== null) {
    const ended = Date.parse(`${m.ended_at.replace(' ', 'T')}Z`);
    if (Number.isFinite(ended) && now.getTime() - ended <= LATE_REQUEUE_MS) return { id: m.id, state: m.state, endedAt: m.ended_at };
  }
  return null;
}

export function setRequeue(db: DB, matchId: number, steamid: string, on: boolean, now = new Date()): void {
  if (on) {
    db.prepare('INSERT OR IGNORE INTO match_requeue (match_id, player_id, at) VALUES (?, ?, ?)').run(matchId, steamid, now.toISOString());
  } else {
    db.prepare('DELETE FROM match_requeue WHERE match_id = ? AND player_id = ?').run(matchId, steamid);
  }
}

export function wantsRequeue(db: DB, matchId: number, steamid: string): boolean {
  return db.prepare('SELECT 1 FROM match_requeue WHERE match_id = ? AND player_id = ?').get(matchId, steamid) !== undefined;
}

/** Everyone on this match who asked, in the order they asked. */
export function requeueOptIns(db: DB, matchId: number): string[] {
  return (db.prepare('SELECT player_id FROM match_requeue WHERE match_id = ? ORDER BY at, player_id').all(matchId) as { player_id: string }[])
    .map((r) => r.player_id);
}

/** What one requeue attempt came to, for the end-of-match note. */
export type RequeueResult = { ok: true } | { ok: false; error: string };
