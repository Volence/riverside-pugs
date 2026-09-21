import type { DB } from '../db.js';
import { resolveAlias } from '../aliases.js';
import { currentSeasonId } from '../players.js';
import { displaySr } from '../rating.js';
import { RANKED_MIN_GAMES } from '../standings.js';
import { daysSinceLastBan, getSteamSignals } from '../steamSignals.js';

/**
 * The "Steam account" panel on the admin player page: the stored signals, put
 * next to what this site knows (first match, rating, who the lender is), plus
 * a few plain-worded flags.
 *
 * Every flag is context for a human and says so. A new account is what a new
 * player has; a ban may be from another game a decade ago; low hours may be a
 * second PC or years of offline play; a borrowed library is how a household
 * shares one. None of them is a verdict and none of them acts on anything.
 *
 * Admin-only. This is built for playerDetail and must never be reachable from
 * a public route.
 */

/** Created this close to the first match here reads as a new account. */
const NEW_ACCOUNT_DAYS = 30;
/** Fewer L4D1 hours than this is "low" for someone rated near the top. */
const LOW_HOURS = 50;
/** Rated players a season needs before "top quarter" means anything. */
const QUARTILE_MIN_PLAYERS = 4;

export type SteamFlagKind = 'new_account' | 'banned_elsewhere' | 'low_hours' | 'borrowed_game' | 'private_profile';

export interface SteamAccountView {
  checkedAt: string;
  /** Null for a private profile: Steam does not give the date. */
  createdAt: string | null;
  ageDays: number | null;
  /** What the account's age is measured against: the first match they were
   *  rostered in, or the day they joined the site when there is none yet. */
  reference: { kind: 'first_match' | 'joined'; at: string } | null;
  daysBeforeReference: number | null;
  visibility: 'public' | 'private' | 'unknown';
  /** False: the account never set up a community profile. */
  profileConfigured: boolean | null;
  bans: {
    vac: number; game: number;
    /** As of now, not as of the day Steam was asked. Null with no bans. */
    daysSinceLast: number | null;
    community: boolean; economy: string; checkedAt: string;
  } | null;
  /** Null: never learned. `hidden` carries the last figure seen, if any. */
  l4d1:
    | { state: 'visible'; hours: number }
    | { state: 'not_owned' }
    | { state: 'hidden'; lastSeenHours: number | null }
    | null;
  level: number | null;
  /** The last account seen lending this one the game, and the player here
   *  that account belongs to, following merges. */
  lender: {
    steamid: string; seenAt: string;
    player: { steamid: string; name: string; banned: boolean } | null;
  } | null;
  flags: { kind: SteamFlagKind; text: string }[];
}

/** SQLite's datetime('now') and the app's ISO strings, both as epoch ms. */
const parseTime = (t: string): number => Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
const days = (ms: number): number => Math.floor(ms / 86_400_000);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Rated in the top quarter of the current season, among players with enough
 *  games for a rating to mean something. False for anyone short of that. */
function topQuartile(db: DB, steamid: string): boolean {
  const season = currentSeasonId(db);
  const ranked = (db.prepare(
    `SELECT pr.player_id AS steamid, pr.mu, pr.sigma,
            (SELECT COUNT(*) FROM rating_history rh WHERE rh.player_id = pr.player_id AND rh.season_id = pr.season_id) AS games
       FROM player_ratings pr WHERE pr.season_id = ?`,
  ).all(season) as { steamid: string; mu: number; sigma: number; games: number }[])
    .filter((r) => r.games >= RANKED_MIN_GAMES);
  const me = ranked.find((r) => r.steamid === steamid);
  if (!me || ranked.length < QUARTILE_MIN_PLAYERS) return false;
  const mine = displaySr(me.mu, me.sigma);
  const higher = ranked.filter((r) => displaySr(r.mu, r.sigma) > mine).length;
  return higher / ranked.length < 0.25;
}

export function steamAccountView(db: DB, steamid: string, now = new Date()): SteamAccountView | null {
  const row = getSteamSignals(db, steamid);
  if (!row) return null;
  const flags: SteamAccountView['flags'] = [];

  const first = db.prepare(
    `SELECT MIN(m.created_at) AS at FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.player_id = ?`,
  ).get(steamid) as { at: string | null };
  const joined = db.prepare('SELECT created_at AS at FROM players WHERE steamid = ?').get(steamid) as { at: string } | undefined;
  const refAt = first.at ?? joined?.at ?? null;
  const reference: SteamAccountView['reference'] = refAt
    ? { kind: first.at ? 'first_match' : 'joined', at: new Date(parseTime(refAt)).toISOString() }
    : null;
  const createdMs = row.time_created === null ? null : row.time_created * 1000;
  const daysBeforeReference = createdMs !== null && reference
    ? Math.max(0, days(Date.parse(reference.at) - createdMs))
    : null;
  if (daysBeforeReference !== null && daysBeforeReference < NEW_ACCOUNT_DAYS) {
    const what = reference!.kind === 'first_match' ? 'their first match here' : 'they joined here';
    flags.push({
      kind: 'new_account',
      text: `New account: created ${plural(daysBeforeReference, 'day')} before ${what}. New players are also new accounts.`,
    });
  }

  let bans: SteamAccountView['bans'] = null;
  if (row.bans_checked_at) {
    const vac = row.vac_bans ?? 0;
    const game = row.game_bans ?? 0;
    const since = vac + game > 0 ? daysSinceLastBan(row, now) : null;
    bans = {
      vac, game, daysSinceLast: since, community: row.community_banned === 1,
      economy: row.economy_ban ?? 'none', checkedAt: row.bans_checked_at,
    };
    if (vac + game > 0) {
      const parts = [vac ? plural(vac, 'VAC ban') : '', game ? plural(game, 'game ban') : ''].filter(Boolean).join(' and ');
      const when = since === null ? '' : since === 0 ? ', the latest today' : `, the latest ${plural(since, 'day')} ago`;
      flags.push({
        kind: 'banned_elsewhere',
        text: `Banned elsewhere: ${parts} on this Steam account${when}. Steam does not say which game.`,
      });
    }
  }

  let l4d1: SteamAccountView['l4d1'] = null;
  const hours = row.l4d1_minutes === null ? null : Math.floor(row.l4d1_minutes / 60);
  if (row.games_visible === 0) l4d1 = { state: 'hidden', lastSeenHours: hours };
  else if (row.games_visible === 1) l4d1 = hours === null ? { state: 'not_owned' } : { state: 'visible', hours };
  if (l4d1?.state === 'visible' && l4d1.hours < LOW_HOURS && topQuartile(db, steamid)) {
    flags.push({
      kind: 'low_hours',
      text: `Low hours: ${l4d1.hours} h of L4D1 on this account while rated in the top quarter of the season. Hours on another account or offline do not show here.`,
    });
  }

  let lender: SteamAccountView['lender'] = null;
  if (row.lender_id && row.lender_seen_at) {
    const p = db.prepare('SELECT steamid, name, status FROM players WHERE steamid = ?')
      .get(resolveAlias(db, row.lender_id)) as { steamid: string; name: string; status: string } | undefined;
    lender = {
      steamid: row.lender_id, seenAt: row.lender_seen_at,
      player: p ? { steamid: p.steamid, name: p.name, banned: p.status === 'banned' } : null,
    };
    const who = p?.name ?? row.lender_id;
    flags.push({
      kind: 'borrowed_game',
      text: `Borrowed game: last seen playing on a copy shared by ${who} through Steam Family Sharing. ${
        lender.player?.banned ? `${who} is banned here.` : 'Households share libraries.'}`,
    });
  }

  const visibility = row.visibility === null ? 'unknown' : row.visibility === 3 ? 'public' : 'private';
  if (visibility === 'private') {
    flags.push({
      kind: 'private_profile',
      text: 'Private profile: Steam will not show this account\'s age, hours or level. Plenty of people keep it that way.',
    });
  }

  return {
    checkedAt: row.checked_at,
    createdAt: createdMs === null ? null : new Date(createdMs).toISOString(),
    ageDays: createdMs === null ? null : Math.max(0, days(now.getTime() - createdMs)),
    reference,
    daysBeforeReference,
    visibility,
    profileConfigured: row.profile_state === null ? (row.visibility === null ? null : false) : row.profile_state === 1,
    bans,
    l4d1,
    level: row.steam_level,
    lender,
    flags,
  };
}
