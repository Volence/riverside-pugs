import { randomBytes } from 'node:crypto';
import { rating } from 'openskill';
import type { DB } from './db.js';
import { hasActiveBan } from './banState.js';
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
  /** May work tickets. Nothing else: no settings, no game server rights. */
  is_mod: number;
  created_at: string;
  discord_id: string | null;
  discord_name: string | null;
  bio: string | null;
  pronouns: string | null;
  country: string | null;
  /** Canonical Twitch identity. Never leaves the server: it is a join key, and
   *  the login beside it is the only Twitch identifier the API serves. */
  twitch_id: string | null;
  twitch_name: string | null;
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

/** How recently a Discord account must have left another Steam account for
 *  its arrival on this one to be worth telling the admins about. */
export const DISCORD_MOVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type LinkResult =
  | {
    ok: true;
    /** The different Steam account this Discord was on inside the window. */
    movedFrom?: { steamid: string; unlinkedAt: string };
  }
  | { ok: false; error: 'discord_taken' | 'already_linked' | 'discord_banned' };

/** Attach a Discord account to a player. Refuses an account already linked to
 *  someone else rather than moving it: that case is a second Steam account,
 *  and silently moving the link would orphan the first one's identity.
 *
 *  Refuses to REPLACE a link as well. A link is what lets somebody queue,
 *  ready up and be sent the match password from Discord as this player, so a
 *  new one landing on top of the old must be a decision (unlink, then link)
 *  and never the side effect of following a URL somebody else sent.
 *
 *  And refuses a Discord account whose most recent other Steam account is
 *  banned. The Discord account is the anchor that makes "everyone on their
 *  main" enforceable, so a ban has to follow it: otherwise the banned player
 *  unlinks, signs in on a second Steam account and links the same Discord.
 *
 *  Every link is written to discord_link_history, in the same transaction. */
export function linkDiscord(
  db: DB, steamid: string, discordId: string, discordName: string,
  opts: { by?: string; now?: Date } = {},
): LinkResult {
  const now = opts.now ?? new Date();
  const owner = playerByDiscordId(db, discordId);
  if (owner && owner.steamid !== steamid) return { ok: false, error: 'discord_taken' };
  const current = getPlayer(db, steamid)?.discord_id ?? null;
  if (current && current !== discordId) return { ok: false, error: 'already_linked' };

  const last = db.prepare(
    `SELECT steamid, unlinked_at FROM discord_link_history
     WHERE discord_id = ? AND steamid != ? ORDER BY id DESC LIMIT 1`,
  ).get(discordId, steamid) as { steamid: string; unlinked_at: string | null } | undefined;
  if (last && hasActiveBan(db, last.steamid, now)) return { ok: false, error: 'discord_banned' };

  db.transaction(() => {
    db.prepare('UPDATE players SET discord_id = ?, discord_name = ? WHERE steamid = ?')
      .run(discordId, discordName, steamid);
    const open = db.prepare(
      'SELECT id FROM discord_link_history WHERE steamid = ? AND discord_id = ? AND unlinked_at IS NULL',
    ).get(steamid, discordId) as { id: number } | undefined;
    if (open) {
      db.prepare('UPDATE discord_link_history SET discord_name = ? WHERE id = ?').run(discordName, open.id);
    } else {
      db.prepare(
        'INSERT INTO discord_link_history (steamid, discord_id, discord_name, linked_at, linked_by) VALUES (?, ?, ?, ?, ?)',
      ).run(steamid, discordId, discordName, now.toISOString(), opts.by ?? steamid);
    }
  })();

  const recent = last?.unlinked_at && now.getTime() - Date.parse(last.unlinked_at) <= DISCORD_MOVE_WINDOW_MS;
  // Only when it actually moved: a relink of the link already held is not news.
  return recent && current !== discordId
    ? { ok: true, movedFrom: { steamid: last.steamid, unlinkedAt: last.unlinked_at! } }
    : { ok: true };
}

/** Detach a player's Discord, and close its history row. `by` is who did it:
 *  the player themselves, or the admin whose panel it came from. */
export function unlinkDiscord(db: DB, steamid: string, by: string = steamid, now: Date = new Date()): void {
  const current = getPlayer(db, steamid);
  if (!current?.discord_id) return;
  const iso = now.toISOString();
  db.transaction(() => {
    const closed = db.prepare(
      'UPDATE discord_link_history SET unlinked_at = ?, unlinked_by = ? WHERE steamid = ? AND discord_id = ? AND unlinked_at IS NULL',
    ).run(iso, by, steamid, current.discord_id).changes;
    // A link with no open row was made before the table existed and missed
    // the backfill. The unlink is the half that matters, so it is recorded
    // anyway rather than lost.
    if (closed === 0) {
      db.prepare(
        `INSERT INTO discord_link_history (steamid, discord_id, discord_name, linked_at, linked_by, unlinked_at, unlinked_by)
         VALUES (?, ?, ?, ?, 'backfill', ?, ?)`,
      ).run(steamid, current.discord_id, current.discord_name ?? '', iso, iso, by);
    }
    db.prepare('UPDATE players SET discord_id = NULL, discord_name = NULL WHERE steamid = ?').run(steamid);
  })();
}

export interface DiscordHistoryRow {
  discordId: string;
  discordName: string;
  linkedAt: string;
  linkedBy: string;
  unlinkedAt: string | null;
  unlinkedBy: string | null;
  /** Every OTHER Steam account that has held this Discord account. */
  others: { steamid: string; name: string | null; linkedAt: string; unlinkedAt: string | null }[];
}

/** One account's Discord links, newest first, each with who else has held
 *  that Discord account. For the admin player page: "this Discord was
 *  previously linked to X" is the sentence this exists to make possible. */
export function discordHistoryOf(db: DB, steamid: string): DiscordHistoryRow[] {
  const mine = db.prepare(
    'SELECT * FROM discord_link_history WHERE steamid = ? ORDER BY id DESC',
  ).all(steamid) as {
    discord_id: string; discord_name: string; linked_at: string; linked_by: string;
    unlinked_at: string | null; unlinked_by: string | null;
  }[];
  const others = db.prepare(
    `SELECT h.steamid, p.name, h.linked_at AS linkedAt, h.unlinked_at AS unlinkedAt
     FROM discord_link_history h LEFT JOIN players p ON p.steamid = h.steamid
     WHERE h.discord_id = ? AND h.steamid != ? ORDER BY h.id DESC`,
  );
  return mine.map((r) => ({
    discordId: r.discord_id,
    discordName: r.discord_name,
    linkedAt: r.linked_at,
    linkedBy: r.linked_by,
    unlinkedAt: r.unlinked_at,
    unlinkedBy: r.unlinked_by,
    others: others.all(r.discord_id, steamid) as DiscordHistoryRow['others'],
  }));
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

type LinkCodeRow = { discord_id: string; discord_name: string; created_at: string; used_at: string | null };

/** A link code that could still be spent right now, or undefined. */
function pendingLinkCode(db: DB, code: string, now: Date): LinkCodeRow | undefined {
  const row = db.prepare('SELECT * FROM discord_link_codes WHERE code = ?').get(code) as LinkCodeRow | undefined;
  if (!row || row.used_at) return undefined;
  if (now.getTime() - Date.parse(row.created_at) > LINK_CODE_TTL_MS) return undefined;
  return row;
}

/** Whose Discord a link code is for, WITHOUT spending it. The link page shows
 *  this and asks before anything is attached to anyone. */
export function peekLinkCode(
  db: DB, code: string, now: Date = new Date(),
): { discordId: string; discordName: string } | null {
  const row = pendingLinkCode(db, code, now);
  return row ? { discordId: row.discord_id, discordName: row.discord_name } : null;
}

/** Spend a link code. Null when unknown, already used, or expired. */
export function consumeLinkCode(
  db: DB, code: string, now: Date = new Date(),
): { discordId: string; discordName: string } | null {
  const row = pendingLinkCode(db, code, now);
  if (!row) return null;
  db.prepare('UPDATE discord_link_codes SET used_at = ? WHERE code = ?').run(now.toISOString(), code);
  return { discordId: row.discord_id, discordName: row.discord_name };
}
