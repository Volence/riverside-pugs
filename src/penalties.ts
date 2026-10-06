import type { DB } from './db.js';
import { getSetting } from './settings.js';
import { publishAdminEvent } from './adminFeed.js';

export type PenaltyKind = 'ready_fail' | 'no_show';

const DEFAULT_LADDER = [5, 15, 60, 1440];
/** Never connecting to a match costs seven other people a whole evening's
 *  slot, where a missed ready check costs them a minute, so it has its own,
 *  much steeper ladder (owner, 2026-09-29). */
const DEFAULT_NOSHOW_LADDER = [60, 180, 1440];

function enabled(db: DB): boolean {
  return getSetting(db, 'penalties_enabled') !== '0';
}

function windowDays(db: DB): number {
  const n = Number(getSetting(db, 'penalty_window_days'));
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function ladder(db: DB, kind: PenaltyKind): number[] {
  const [key, fallback] = kind === 'no_show'
    ? ['noshow_penalty_minutes', DEFAULT_NOSHOW_LADDER]
    : ['penalty_minutes', DEFAULT_LADDER];
  try {
    const v = JSON.parse(getSetting(db, key) ?? '');
    if (Array.isArray(v) && v.length && v.every((x) => Number.isInteger(x) && x > 0)) return v;
  } catch { /* fall through to the default */ }
  return fallback;
}

/** Note an offense. No-op when penalties are switched off. */
export function recordPenalty(db: DB, steamid: string, kind: PenaltyKind, matchId: number | null, now = new Date()): void {
  if (!enabled(db)) return;
  db.prepare('INSERT INTO penalties (player_id, kind, match_id, created_at) VALUES (?, ?, ?, ?)')
    .run(steamid, kind, matchId, now.toISOString());
  publishAdminEvent({ kind: 'penalty', steamid, penalty: kind, matchId });
}

export interface ActiveTimeout {
  until: Date;
  /** Offenses of `kind` in the window, the count that picked the rung. */
  offenses: number;
  /** Which ladder the timeout came from. */
  kind: PenaltyKind;
}

/** One ladder's timeout, or null when it is not running at `now`. */
function ladderTimeout(db: DB, steamid: string, kind: PenaltyKind, now: Date): ActiveTimeout | null {
  const since = new Date(now.getTime() - windowDays(db) * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(
    `SELECT created_at FROM penalties
     WHERE player_id = ? AND kind = ? AND cleared_at IS NULL AND created_at >= ? AND created_at <= ?
     ORDER BY created_at DESC`,
  ).all(steamid, kind, since, now.toISOString()) as { created_at: string }[];
  if (rows.length === 0) return null;
  const steps = ladder(db, kind);
  const minutes = steps[Math.min(rows.length, steps.length) - 1];
  const until = new Date(Date.parse(rows[0].created_at) + minutes * 60_000);
  return until > now ? { until, offenses: rows.length, kind } : null;
}

/**
 * The queue timeout a player is serving right now, or null.
 *
 * Two ladders, each counted over its own kind only: missed ready checks climb
 * penalty_minutes and no-shows climb noshow_penalty_minutes, so a player's
 * first no-show costs the no-show rung one however many ready checks they
 * missed, and the other way about. The window is shared. Each ladder is timed
 * from its own most recent offense, so an old one cannot keep someone out, and
 * the player serves whichever of the two ends later.
 */
export function activeTimeout(db: DB, steamid: string, now = new Date()): ActiveTimeout | null {
  if (!enabled(db)) return null;
  const a = ladderTimeout(db, steamid, 'ready_fail', now);
  const b = ladderTimeout(db, steamid, 'no_show', now);
  if (!a || !b) return a ?? b;
  return b.until > a.until ? b : a;
}

/** What a timeout is for, in words, for the surfaces that tell the player. */
export function timeoutCause(kind: PenaltyKind): string {
  return kind === 'no_show' ? 'not connecting to a match' : 'missed ready checks';
}

export function clearPenalties(db: DB, steamid: string, by: string, now = new Date()): number {
  return db.prepare('UPDATE penalties SET cleared_by = ?, cleared_at = ? WHERE player_id = ? AND cleared_at IS NULL')
    .run(by, now.toISOString(), steamid).changes;
}

/** Clear one offense, for the per-row button on the player file: the right
 *  answer to "that no-show was our server's fault" without also wiping the
 *  ready checks they really did miss. The player's id is part of the match so
 *  a stale page cannot clear somebody else's row. */
export function clearPenalty(db: DB, steamid: string, id: number, by: string, now = new Date()): boolean {
  return db.prepare('UPDATE penalties SET cleared_by = ?, cleared_at = ? WHERE id = ? AND player_id = ? AND cleared_at IS NULL')
    .run(by, now.toISOString(), id, steamid).changes > 0;
}

/** Clear the no-shows one match handed out, for an abort whose no-shows were
 *  not the players' doing. Returns who had one cleared. */
export function clearMatchNoShows(db: DB, matchId: number, by: string, now = new Date()): string[] {
  const rows = db.prepare(
    "SELECT id, player_id FROM penalties WHERE match_id = ? AND kind = 'no_show' AND cleared_at IS NULL",
  ).all(matchId) as { id: number; player_id: string }[];
  const clear = db.prepare('UPDATE penalties SET cleared_by = ?, cleared_at = ? WHERE id = ?');
  for (const r of rows) clear.run(by, now.toISOString(), r.id);
  return rows.map((r) => r.player_id);
}

/**
 * The queue timeout one recorded offense handed out when it was recorded:
 * its rung on its own ladder, counted the way ladderTimeout counts, over the
 * window up to and including it. Null for no such row. Cleared rows still
 * answer, with `cleared` set, so a record can say what was taken back.
 */
export function offenseTimeout(db: DB, penaltyId: number):
  { minutes: number; offense: number; windowDays: number; cleared: boolean } | null {
  const row = db.prepare('SELECT player_id, kind, created_at, cleared_at FROM penalties WHERE id = ?').get(penaltyId) as
    { player_id: string; kind: PenaltyKind; created_at: string; cleared_at: string | null } | undefined;
  if (!row) return null;
  const since = new Date(Date.parse(row.created_at) - windowDays(db) * 24 * 60 * 60 * 1000).toISOString();
  // Offenses cleared since are left out, as ladderTimeout leaves them out:
  // what this one costs now, which is what staff act on.
  const n = (db.prepare(
    `SELECT COUNT(*) AS n FROM penalties WHERE player_id = ? AND kind = ? AND created_at >= ? AND created_at <= ?
       AND (cleared_at IS NULL OR id = ?)`,
  ).get(row.player_id, row.kind, since, row.created_at, penaltyId) as { n: number }).n;
  const steps = ladder(db, row.kind);
  return { minutes: steps[Math.min(n, steps.length) - 1], offense: n, windowDays: windowDays(db), cleared: row.cleared_at !== null };
}

export interface PenaltyRow {
  id: number;
  kind: PenaltyKind;
  matchId: number | null;
  createdAt: string;
  clearedBy: string | null;
  clearedAt: string | null;
}

export function penaltyHistory(db: DB, steamid: string, limit = 50): PenaltyRow[] {
  return (db.prepare('SELECT * FROM penalties WHERE player_id = ? ORDER BY id DESC LIMIT ?').all(steamid, limit) as {
    id: number; kind: PenaltyKind; match_id: number | null; created_at: string; cleared_by: string | null; cleared_at: string | null;
  }[]).map((r) => ({ id: r.id, kind: r.kind, matchId: r.match_id, createdAt: r.created_at, clearedBy: r.cleared_by, clearedAt: r.cleared_at }));
}

/** Offenses in the window, cleared or not excluded, for the admin player list. */
export function recentOffenses(db: DB, steamid: string, now = new Date()): number {
  const since = new Date(now.getTime() - windowDays(db) * 24 * 60 * 60 * 1000).toISOString();
  return (db.prepare('SELECT COUNT(*) AS n FROM penalties WHERE player_id = ? AND cleared_at IS NULL AND created_at >= ?')
    .get(steamid, since) as { n: number }).n;
}
