import type { DB } from './db.js';
import { hasUnsafeChars } from './profileFields.js';
import { findSlurs } from './slurs.js';

/**
 * Display names an admin sets, for players whose Steam name says nothing
 * ("'", a lone combining mark) or is not what anyone calls them.
 *
 * Website and Discord only. `players.name` is what every page, card and
 * label already reads, so setting one writes it there and keeps the Steam
 * persona in `steam_name`; upsertPlayer and the persona backfill refresh
 * `steam_name` and leave `name` alone while an override is set. The game
 * server is not told: in game they keep whatever Steam name they have.
 */

export const DISPLAY_NAME_MAX = 32;

export type DisplayNameCheck = { ok: true; name: string } | { ok: false; error: string };

export function validateDisplayName(raw: unknown): DisplayNameCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'a display name must be text' };
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'a display name cannot be empty' };
  if ([...name].length > DISPLAY_NAME_MAX) return { ok: false, error: `a display name is at most ${DISPLAY_NAME_MAX} characters` };
  if (hasUnsafeChars(name)) return { ok: false, error: 'that name has invisible or control characters in it' };
  // The whole point is a name people can read and type, so it needs at least
  // one letter or digit, not only punctuation and combining marks.
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, error: 'a display name needs at least one letter or digit' };
  if (findSlurs(name).length > 0) return { ok: false, error: 'that name has a slur in it' };
  return { ok: true, name };
}

export interface DisplayNameChange { from: string; to: string; steamName: string }

/** Set (or with null, clear) a player's display name. Returns what changed,
 *  or null for no such player. Clearing puts the Steam persona back. */
export function setDisplayName(db: DB, steamid: string, name: string | null): DisplayNameChange | null {
  const row = db.prepare('SELECT name, steam_name FROM players WHERE steamid = ?').get(steamid) as
    { name: string; steam_name: string | null } | undefined;
  if (!row) return null;
  // A row older than the column still holds the persona in `name`; keep it
  // before the override covers it up.
  const steamName = row.steam_name ?? row.name;
  db.prepare('UPDATE players SET steam_name = ?, name_override = ?, name = ? WHERE steamid = ?')
    .run(steamName, name, name ?? steamName, steamid);
  return { from: row.name, to: name ?? steamName, steamName };
}
