import { randomBytes } from 'node:crypto';
import { rating } from 'openskill';
import type { DB } from './db.js';
import {
  LINK_PLATFORMS, isPlatform, linkUrl,
  validateBio, validateCountry, validateHandle, validatePronouns,
} from './profileFields.js';

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

export interface ProfileFields {
  bio: string | null;
  pronouns: string | null;
  country: string | null;
  /** platform key -> handle, only for platforms the player actually filled in. */
  links: Record<string, string>;
}

export interface SocialLink {
  platform: string;
  label: string;
  handle: string;
  url: string;
}

export function getProfileFields(db: DB, steamid: string): ProfileFields {
  const row = db.prepare('SELECT bio, pronouns, country FROM players WHERE steamid = ?')
    .get(steamid) as { bio: string | null; pronouns: string | null; country: string | null } | undefined;
  const links: Record<string, string> = {};
  const rows = db.prepare('SELECT platform, handle FROM player_links WHERE player_id = ?')
    .all(steamid) as { platform: string; handle: string }[];
  for (const r of rows) links[r.platform] = r.handle;
  return {
    bio: row?.bio ?? null,
    pronouns: row?.pronouns ?? null,
    country: row?.country ?? null,
    links,
  };
}

/** The saved handles as links, in LINK_PLATFORMS order so the chips on a
 *  profile do not reorder themselves between page loads. A row whose platform
 *  is no longer known is skipped rather than guessed at. */
export function socialLinks(db: DB, steamid: string): SocialLink[] {
  const { links } = getProfileFields(db, steamid);
  const out: SocialLink[] = [];
  for (const p of LINK_PLATFORMS) {
    const handle = links[p.key];
    if (!handle) continue;
    const url = linkUrl(p.key, handle);
    if (!url) continue;
    out.push({ platform: p.key, label: p.label, handle, url });
  }
  return out;
}

/**
 * Validate and save a player's own profile fields.
 *
 * All or nothing, inside a transaction. A form where one bad field silently
 * discards the others while keeping the rest is worse than one that refuses:
 * the player cannot see which half landed.
 *
 * A platform absent from `links` is left alone rather than cleared, so a
 * caller sending a partial body cannot wipe fields it never showed. Clearing
 * is done by sending an empty string, which is what the editor sends.
 */
export function saveProfileFields(
  db: DB,
  steamid: string,
  input: unknown,
): { ok: true } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'invalid body' };
  const body = input as Record<string, unknown>;

  const bio = validateBio(body.bio);
  if (!bio.ok) return { ok: false, error: bio.error };
  const pronouns = validatePronouns(body.pronouns);
  if (!pronouns.ok) return { ok: false, error: pronouns.error };
  const country = validateCountry(body.country);
  if (!country.ok) return { ok: false, error: country.error };

  const rawLinks = body.links;
  if (rawLinks !== undefined && (typeof rawLinks !== 'object' || rawLinks === null)) {
    return { ok: false, error: 'invalid links' };
  }
  const handles: { platform: string; handle: string | null }[] = [];
  for (const [platform, raw] of Object.entries((rawLinks ?? {}) as Record<string, unknown>)) {
    if (!isPlatform(platform)) return { ok: false, error: `unknown platform: ${platform}` };
    const v = validateHandle(platform, raw);
    if (!v.ok) return { ok: false, error: v.error };
    handles.push({ platform, handle: v.value });
  }

  const write = db.transaction(() => {
    db.prepare('UPDATE players SET bio = ?, pronouns = ?, country = ? WHERE steamid = ?')
      .run(bio.value, pronouns.value, country.value, steamid);
    const del = db.prepare('DELETE FROM player_links WHERE player_id = ? AND platform = ?');
    const put = db.prepare(
      `INSERT INTO player_links (player_id, platform, handle) VALUES (?,?,?)
       ON CONFLICT(player_id, platform) DO UPDATE SET handle = excluded.handle`,
    );
    for (const { platform, handle } of handles) {
      if (handle === null) del.run(steamid, platform);
      else put.run(steamid, platform, handle);
    }
  });
  write();
  return { ok: true };
}

/** Attach a Twitch channel. Fails when another player already holds it, which
 *  the partial unique index enforces; relinking your own is fine. */
export function linkTwitch(
  db: DB,
  steamid: string,
  twitchId: string,
  twitchName: string,
): { ok: boolean } {
  const owner = db.prepare('SELECT steamid FROM players WHERE twitch_id = ?').get(twitchId) as
    | { steamid: string } | undefined;
  if (owner && owner.steamid !== steamid) return { ok: false };
  db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?')
    .run(twitchId, twitchName, steamid);
  return { ok: true };
}

/** The single off switch: no id, no cached status, so no listing anywhere. */
export function unlinkTwitch(db: DB, steamid: string): void {
  const drop = db.transaction(() => {
    db.prepare('UPDATE players SET twitch_id = NULL, twitch_name = NULL WHERE steamid = ?').run(steamid);
    db.prepare('DELETE FROM twitch_status WHERE player_id = ?').run(steamid);
  });
  drop();
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
