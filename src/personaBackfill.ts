import type { DB } from './db.js';
import { fetchPersonas } from './steamAuth.js';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Give roster-created players their real Steam name and avatar.
 *
 * fetchPersona only ever ran in the login callback, so anyone the backend
 * learned about from a MATCH_ROSTER line kept their in-game nickname and no
 * avatar. Harmless until the queue page started showing faces.
 *
 * A null avatar is the marker for "never looked up": a real persona always
 * carries one, and a lookup that genuinely returns no avatar is rare enough
 * that retrying it on the next boot costs nothing.
 */
export async function backfillPersonas(db: DB, apiKey: string | null, fetchFn?: FetchFn): Promise<number> {
  if (!apiKey) return 0;
  const rows = db.prepare('SELECT steamid FROM players WHERE avatar IS NULL').all() as
    { steamid: string }[];
  if (rows.length === 0) return 0;

  const personas = await fetchPersonas(rows.map((r) => r.steamid), apiKey, fetchFn);
  if (personas.size === 0) return 0;

  let n = 0;
  db.transaction(() => {
    for (const [steamid, p] of personas) n += applyPersona(db, steamid, p);
  })();
  return n;
}

/**
 * Write a Steam persona onto the players row. Either half may be null, and a
 * null half leaves what is stored alone. An admin's display name outranks the
 * persona; the persona is still kept in steam_name. Returns rows changed.
 */
export function applyPersona(db: DB, steamid: string, p: { name: string | null; avatar: string | null }): number {
  if (p.name === null && p.avatar === null) return 0;
  return db.prepare(
    `UPDATE players SET steam_name = COALESCE(@name, steam_name),
            name = COALESCE(name_override, @name, name), avatar = COALESCE(@avatar, avatar)
      WHERE steamid = @steamid`,
  ).run({ name: p.name, avatar: p.avatar, steamid }).changes;
}
