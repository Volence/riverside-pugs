import type { DB } from './db.js';

/** Steam avatar URLs for a set of players, for boards that list people by
 *  SteamID only. One query; a player without a row or an avatar maps to null. */
export function avatarsOf(db: DB, steamids: Iterable<string>): Map<string, string | null> {
  const ids = [...new Set(steamids)];
  const out = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return out;
  const rows = db.prepare(`SELECT steamid, avatar FROM players WHERE steamid IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { steamid: string; avatar: string | null }[];
  for (const r of rows) out.set(r.steamid, r.avatar);
  return out;
}
