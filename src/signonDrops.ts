import type { DB } from './db.js';

/**
 * Storage for SIGNON_DROP lines: a client that connected, never entered the
 * game and left by its own hand on a map that forced files. See the table's
 * comment in db.ts for why this is a hint and never an accusation.
 */

/** Two drops by one steamid inside this window, with no entry between them,
 *  are what the admin feed calls a repeat. */
export const STREAK_WINDOW_MS = 10 * 60_000;

/** A second row for the same steamid this soon after the last is the same
 *  datagram delivered twice, not a second attempt: nobody clicks through the
 *  rejection dialog, reconnects and gets rejected again in three seconds. */
const DUPLICATE_MS = 3_000;

export interface SignonDropInput { steamid: string; name: string; secs: number; forced: number }

export interface SignonDropRow {
  id: number;
  name: string;
  secsConnected: number;
  forcedCount: number;
  at: string;
  enteredAfterAt: string | null;
}

export interface RecordedDrop {
  id: number;
  /** Drops by this steamid in the last ten minutes with no entry since,
   *  this one included. 1 is a first drop. */
  streak: number;
  /** Every drop on record for this steamid, this one included. */
  total: number;
}

/** Store one drop. Null when it is a duplicate datagram, which stores nothing. */
export function recordSignonDrop(db: DB, d: SignonDropInput, now = new Date()): RecordedDrop | null {
  const iso = now.toISOString();
  const dupSince = new Date(now.getTime() - DUPLICATE_MS).toISOString();
  const dup = db.prepare('SELECT 1 FROM signon_drops WHERE steamid = ? AND at > ? AND at <= ? LIMIT 1')
    .get(d.steamid, dupSince, iso);
  if (dup) return null;

  const id = Number(db.prepare(
    'INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at) VALUES (?, ?, ?, ?, ?)',
  ).run(d.steamid, d.name, d.secs, d.forced, iso).lastInsertRowid);

  const since = new Date(now.getTime() - STREAK_WINDOW_MS).toISOString();
  const { streak } = db.prepare(
    'SELECT COUNT(*) AS streak FROM signon_drops WHERE steamid = ? AND entered_after_at IS NULL AND at > ? AND at <= ?',
  ).get(d.steamid, since, iso) as { streak: number };
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM signon_drops WHERE steamid = ?')
    .get(d.steamid) as { total: number };
  return { id, streak, total };
}

/**
 * The steamid was seen in game. Stamps every drop of theirs that has no entry
 * yet, which also ends the streak: the next drop counts from one again.
 * Returns how many rows were stamped.
 */
export function markEntered(db: DB, steamid: string, now = new Date()): number {
  return db.prepare('UPDATE signon_drops SET entered_after_at = ? WHERE steamid = ? AND entered_after_at IS NULL')
    .run(now.toISOString(), steamid).changes;
}

/** Count, last time and the newest rows, for the admin player page. */
export function signonDropSummary(
  db: DB, steamid: string, limit = 50,
): { count: number; lastAt: string | null; rows: SignonDropRow[] } {
  const { count, lastAt } = db.prepare('SELECT COUNT(*) AS count, MAX(at) AS lastAt FROM signon_drops WHERE steamid = ?')
    .get(steamid) as { count: number; lastAt: string | null };
  const rows = (db.prepare(
    `SELECT id, name, secs_connected, forced_count, at, entered_after_at
     FROM signon_drops WHERE steamid = ? ORDER BY id DESC LIMIT ?`,
  ).all(steamid, limit) as {
    id: number; name: string; secs_connected: number; forced_count: number; at: string; entered_after_at: string | null;
  }[]).map((r) => ({
    id: r.id, name: r.name, secsConnected: r.secs_connected, forcedCount: r.forced_count,
    at: r.at, enteredAfterAt: r.entered_after_at,
  }));
  return { count, lastAt, rows };
}
