import type { DB } from './db.js';
import { getSetting } from './settings.js';

export type PenaltyKind = 'ready_fail' | 'no_show';

const DEFAULT_LADDER = [5, 15, 60, 1440];

function enabled(db: DB): boolean {
  return getSetting(db, 'penalties_enabled') !== '0';
}

function windowDays(db: DB): number {
  const n = Number(getSetting(db, 'penalty_window_days'));
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function ladder(db: DB): number[] {
  try {
    const v = JSON.parse(getSetting(db, 'penalty_minutes') ?? '');
    if (Array.isArray(v) && v.length && v.every((x) => Number.isInteger(x) && x > 0)) return v;
  } catch { /* fall through to the default */ }
  return DEFAULT_LADDER;
}

/** Note an offense. No-op when penalties are switched off. */
export function recordPenalty(db: DB, steamid: string, kind: PenaltyKind, matchId: number | null, now = new Date()): void {
  if (!enabled(db)) return;
  db.prepare('INSERT INTO penalties (player_id, kind, match_id, created_at) VALUES (?, ?, ?, ?)')
    .run(steamid, kind, matchId, now.toISOString());
}

/**
 * The queue timeout a player is serving right now, or null.
 *
 * Escalates with the number of uncleared offenses inside the window: the
 * first costs 5 minutes, then 15, 60, and a day for every one after that.
 * Timed from the most recent offense, so an old one cannot keep someone out.
 */
export function activeTimeout(db: DB, steamid: string, now = new Date()): { until: Date; offenses: number } | null {
  if (!enabled(db)) return null;
  const since = new Date(now.getTime() - windowDays(db) * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(
    `SELECT created_at FROM penalties
     WHERE player_id = ? AND cleared_at IS NULL AND created_at >= ? AND created_at <= ?
     ORDER BY created_at DESC`,
  ).all(steamid, since, now.toISOString()) as { created_at: string }[];
  if (rows.length === 0) return null;
  const steps = ladder(db);
  const minutes = steps[Math.min(rows.length, steps.length) - 1];
  const until = new Date(Date.parse(rows[0].created_at) + minutes * 60_000);
  return until > now ? { until, offenses: rows.length } : null;
}

export function clearPenalties(db: DB, steamid: string, by: string, now = new Date()): number {
  return db.prepare('UPDATE penalties SET cleared_by = ?, cleared_at = ? WHERE player_id = ? AND cleared_at IS NULL')
    .run(by, now.toISOString(), steamid).changes;
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
