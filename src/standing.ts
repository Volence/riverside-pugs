import type { DB } from './db.js';
import { getPlayer, type PlayerRow } from './players.js';
import { resolveAlias } from './aliases.js';
import { hasActiveBan } from './banState.js';

/**
 * Whether a SteamID may act as a player right now, and if not, why not.
 *
 * One answer for every surface. The website's guards, the Discord buttons
 * and the Discord commands each used to ask their own version of this, and
 * the versions drifted: `/report` on Discord checked nothing the web route
 * checks, and nothing anywhere asked whether the account had been merged
 * away. A rule enforced on one surface is a rule with a way round it.
 *
 *  - `unknown`   no player row.
 *  - `merged`    the SteamID is an alias of another account. It may hold a row
 *                left over from before logins refused aliases; that row is
 *                not an identity and must not be allowed to act as one.
 *  - `banned`    status says so, or the bans table does. The table is the
 *                authority and status is a cached consequence of it, so the
 *                two are both asked rather than trusting that they agree.
 *  - `inactive`  not yet through the invite or Discord gate.
 */
export type Standing = 'ok' | 'unknown' | 'merged' | 'banned' | 'inactive';

export function standingOf(db: DB, player: PlayerRow | undefined, now = new Date()): Standing {
  if (!player) return 'unknown';
  if (resolveAlias(db, player.steamid) !== player.steamid) return 'merged';
  if (player.status === 'banned' || hasActiveBan(db, player.steamid, now)) return 'banned';
  return player.status === 'active' ? 'ok' : 'inactive';
}

/** An active, unbanned, unmerged player. */
export function inGoodStanding(db: DB, steamid: string, now = new Date()): boolean {
  return standingOf(db, getPlayer(db, steamid), now) === 'ok';
}

/** What a merged alt is told, wherever it turns up. Never names the main. */
export const MERGED_MESSAGE =
  'This Steam account has been merged into another account. Sign in with your main Steam account instead, or contact an admin if that is wrong.';
