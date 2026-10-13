import type { DB } from './db.js';

/**
 * Whether a SteamID is under a ban right now.
 *
 * A leaf on purpose: no imports beyond the DB type, so anything may ask (the
 * link rules in players.ts, the self-started roster, the admin list pushed to
 * the game servers) without pulling in the admin panel's player module and
 * the import cycle that comes with it. `activeBan` in admin/players.ts answers
 * the richer question (which ban, by whom) with the same WHERE clause.
 *
 * The bans table is the authority, not players.status: status is a cached
 * consequence of it, and the 60 second reaper is what keeps the two in step.
 */
export function hasActiveBan(db: DB, steamid: string, now = new Date()): boolean {
  return db.prepare(
    'SELECT 1 FROM bans WHERE player_id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1',
  ).get(steamid, now.toISOString()) !== undefined;
}

/** SQL for "this player is not under a ban right now", for public boards that
 *  should not list banned players. `col` is the steamid column to test; the
 *  fragment takes one parameter, the current time as an ISO string. Same
 *  WHERE clause as hasActiveBan. */
export function notBannedSql(col: string): string {
  return `NOT EXISTS (SELECT 1 FROM bans b WHERE b.player_id = ${col}
            AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > ?))`;
}
