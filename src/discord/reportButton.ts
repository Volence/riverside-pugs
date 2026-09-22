import type { DB } from '../db.js';

/** A player the reporter could mean. */
export interface Candidate { steamid: string; name: string }

/**
 * Everyone the reporter has shared a match with, most recent match first,
 * one row each. Feeds the form's dropdown, which Discord caps at 25 options:
 * the default of 24 leaves room for the sentinel option.
 */
export function recentCoPlayers(db: DB, steamid: string, limit = 24): Candidate[] {
  return db.prepare(
    `SELECT p.steamid AS steamid, p.name AS name, MAX(mine.match_id) AS last_match
       FROM match_players mine
       JOIN match_players theirs
         ON theirs.match_id = mine.match_id AND theirs.player_id != mine.player_id
       JOIN players p ON p.steamid = theirs.player_id
      WHERE mine.player_id = ?
      GROUP BY p.steamid
      ORDER BY last_match DESC
      LIMIT ?`,
  ).all(steamid, limit) as Candidate[];
}

/**
 * Players whose name the reporter may have typed. Exact matches win outright:
 * someone called "Bob" must not be buried by everyone called "Bobby". Only
 * when nothing matches exactly do we widen to a substring.
 *
 * The typed text goes into LIKE, so '%' and '_' are escaped. Without this a
 * reporter typing '%' matches the whole player list, which reads as the
 * feature being broken rather than as a wildcard.
 */
export function resolveByName(db: DB, typed: string, limit = 6): Candidate[] {
  const name = typed.trim();
  if (!name) return [];
  const exact = db.prepare(
    'SELECT steamid, name FROM players WHERE lower(name) = lower(?) ORDER BY name LIMIT ?',
  ).all(name, limit) as Candidate[];
  if (exact.length > 0) return exact;
  const escaped = name.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.prepare(
    `SELECT steamid, name FROM players
      WHERE lower(name) LIKE '%' || lower(?) || '%' ESCAPE '\\'
      ORDER BY name LIMIT ?`,
  ).all(escaped, limit) as Candidate[];
}
