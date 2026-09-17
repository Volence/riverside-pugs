import { randomBytes } from 'node:crypto';
import { rating } from 'openskill';
import type { DB } from './db.js';

export interface PlayerRow {
  steamid: string;
  name: string;
  avatar: string | null;
  status: 'invited' | 'active' | 'banned';
  is_admin: number;
  created_at: string;
  discord_id: string | null;
  discord_name: string | null;
}

export interface RatingRow {
  player_id: string;
  season_id: number;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
}

export function upsertPlayer(
  db: DB,
  p: { steamid: string; name: string; avatar: string | null },
  adminSteamIds: string[],
): void {
  const isAdmin = adminSteamIds.includes(p.steamid);
  db.prepare(
    `INSERT INTO players (steamid, name, avatar, status, is_admin)
     VALUES (@steamid, @name, @avatar, @status, @is_admin)
     ON CONFLICT(steamid) DO UPDATE SET
       name = excluded.name,
       avatar = excluded.avatar,
       is_admin = MAX(players.is_admin, excluded.is_admin),
       status = CASE WHEN excluded.is_admin = 1 THEN 'active' ELSE players.status END`,
  ).run({
    steamid: p.steamid,
    name: p.name,
    avatar: p.avatar,
    status: isAdmin ? 'active' : 'invited',
    is_admin: isAdmin ? 1 : 0,
  });
}

export function getPlayer(db: DB, steamid: string): PlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE steamid = ?').get(steamid) as PlayerRow | undefined;
}

export function activatePlayer(db: DB, steamid: string): void {
  db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(steamid);
}

export function currentSeasonId(db: DB): number {
  const row = db.prepare('SELECT id FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as { id: number };
  return row.id;
}

export function ensureRating(db: DB, steamid: string, seasonId?: number): RatingRow {
  const season = seasonId ?? currentSeasonId(db);
  const existing = db
    .prepare('SELECT * FROM player_ratings WHERE player_id = ? AND season_id = ?')
    .get(steamid, season) as RatingRow | undefined;
  if (existing) return existing;
  const r = rating(); // openskill defaults: mu=25, sigma=25/3
  db.prepare(
    'INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, ?, ?)',
  ).run(steamid, season, r.mu, r.sigma);
  return { player_id: steamid, season_id: season, mu: r.mu, sigma: r.sigma, wins: 0, losses: 0 };
}

export function getRatings(db: DB, steamids: string[]): Map<string, RatingRow> {
  const out = new Map<string, RatingRow>();
  for (const id of steamids) out.set(id, ensureRating(db, id));
  return out;
}

export type LinkResult = { ok: true } | { ok: false; error: 'discord_taken' };

/** Attach a Discord account to a player. Refuses an account already linked to
 *  someone else rather than moving it: that case is a second Steam account,
 *  and silently moving the link would orphan the first one's identity. */
export function linkDiscord(db: DB, steamid: string, discordId: string, discordName: string): LinkResult {
  const owner = playerByDiscordId(db, discordId);
  if (owner && owner.steamid !== steamid) return { ok: false, error: 'discord_taken' };
  db.prepare('UPDATE players SET discord_id = ?, discord_name = ? WHERE steamid = ?')
    .run(discordId, discordName, steamid);
  return { ok: true };
}

export function unlinkDiscord(db: DB, steamid: string): void {
  db.prepare('UPDATE players SET discord_id = NULL, discord_name = NULL WHERE steamid = ?').run(steamid);
}

export function playerByDiscordId(db: DB, discordId: string): PlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE discord_id = ?').get(discordId) as PlayerRow | undefined;
}

const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/** A one-time code the bot hands an unlinked Discord user. */
export function createLinkCode(db: DB, discordId: string, discordName: string, now: Date = new Date()): string {
  const code = randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO discord_link_codes (code, discord_id, discord_name, created_at) VALUES (?, ?, ?, ?)')
    .run(code, discordId, discordName, now.toISOString());
  // Housekeeping: codes are worthless once expired, so the table never grows.
  db.prepare('DELETE FROM discord_link_codes WHERE created_at < ?')
    .run(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
  return code;
}

/** Spend a link code. Null when unknown, already used, or expired. */
export function consumeLinkCode(
  db: DB, code: string, now: Date = new Date(),
): { discordId: string; discordName: string } | null {
  const row = db.prepare('SELECT * FROM discord_link_codes WHERE code = ?').get(code) as
    | { discord_id: string; discord_name: string; created_at: string; used_at: string | null }
    | undefined;
  if (!row || row.used_at) return null;
  if (now.getTime() - Date.parse(row.created_at) > LINK_CODE_TTL_MS) return null;
  db.prepare('UPDATE discord_link_codes SET used_at = ? WHERE code = ?').run(now.toISOString(), code);
  return { discordId: row.discord_id, discordName: row.discord_name };
}
