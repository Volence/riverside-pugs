import type { DB } from './db.js';
import { fetchPersonas } from './steamAuth.js';

type FetchFn = typeof fetch;

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

  const update = db.prepare('UPDATE players SET name = ?, avatar = ? WHERE steamid = ?');
  let n = 0;
  db.transaction(() => {
    for (const [steamid, p] of personas) {
      update.run(p.name, p.avatar, steamid);
      n++;
    }
  })();
  return n;
}
