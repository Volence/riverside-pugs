import type { DB } from '../db.js';

/**
 * One side of a report. A player whenever the Discord account is linked; a
 * Discord member only when there is no player to point at. fileReport is the
 * one place that decides which (see filing.ts).
 */
export type Person =
  | { kind: 'player'; steamid: string }
  | { kind: 'discord'; discordId: string; name: string };

/** The one encoding of a person as a single string, used by the unique index
 *  tickets_one_open and every duplicate rule. A steamid is digits only, so it
 *  can never start with 'd:'. */
export const personKey = (p: Person): string => (p.kind === 'player' ? p.steamid : `d:${p.discordId}`);

export const TARGET_KEY_SQL = "COALESCE(t.target_id, 'd:' || t.target_discord_id)";
export const REPORTER_KEY_SQL = "COALESCE(r.reporter_id, 'd:' || r.reporter_discord_id)";

export interface TargetColumns { target_id: string | null; target_discord_id: string | null; target_name: string }

export function targetOf(row: TargetColumns): Person {
  return row.target_id !== null
    ? { kind: 'player', steamid: row.target_id }
    : { kind: 'discord', discordId: row.target_discord_id!, name: row.target_name };
}

/** A readable name for the accused. Not escaped: callers escape for their
 *  own surface, as they do for player names today. */
export function targetLabel(db: DB, row: TargetColumns): string {
  if (row.target_id !== null) {
    return (db.prepare('SELECT name FROM players WHERE steamid = ?').get(row.target_id) as { name: string } | undefined)?.name ?? row.target_id;
  }
  return row.target_name || 'a Discord member';
}
