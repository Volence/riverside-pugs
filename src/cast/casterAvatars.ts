import type { DB } from '../db.js';
import type { CasterLine } from './types.js';

/**
 * The avatar for each caster line, for the Casters scene's no-camera tile.
 * A caster line is free text, so it is matched to a site account: the handle
 * against a linked Twitch name first (the usual handle), then the name
 * against the player name, then the Discord name. Only a single account with
 * an avatar counts; two players called "Mike" give no avatar rather than the
 * wrong face on stream.
 */
export function casterAvatars(db: DB, casters: CasterLine[]): (string | null)[] {
  const one = (sql: string, v: string): string | null => {
    if (!v) return null;
    const rows = db.prepare(sql).all(v) as { avatar: string }[];
    return rows.length === 1 ? rows[0]!.avatar : null;
  };
  return casters.map((c) => {
    const handle = c.handle.trim().replace(/^@/, '').replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//i, '').replace(/\/+$/, '');
    const name = c.name.trim();
    return one('SELECT avatar FROM players WHERE twitch_name = ? COLLATE NOCASE AND avatar IS NOT NULL', handle)
      ?? one('SELECT avatar FROM players WHERE name = ? COLLATE NOCASE AND avatar IS NOT NULL', name)
      ?? one('SELECT avatar FROM players WHERE discord_name = ? COLLATE NOCASE AND avatar IS NOT NULL', name);
  });
}
