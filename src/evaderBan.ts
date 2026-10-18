import type { DB } from './db.js';
import { addMember, personById, personOf } from './evaderPeople.js';
import { banFromHoldTx, holdById, openHoldOf } from './altHolds.js';
import { insertBan } from './admin/players.js';
import { publishBanChange } from './banEvents.js';
import { getPlayer } from './players.js';

/**
 * "Ban as same person": a moderator looked at a fingerprint hold or alert and
 * agrees the account is that known evader. It becomes an ordinary permanent
 * ban (the public list shows it), and the account, with its Discord if one is
 * linked, joins the person's record: its connections are watched from now on
 * and its presses join the pooled fingerprint (the cache is marked stale by
 * addMember), so the next account is checked against everything they have
 * played on. The reason shown to the player stays vague about how they were
 * caught. Admin-only is enforced by the route, not here.
 */

export function sameReason(label: string): string {
  return `Ban evasion: another account of ${label}`;
}

/** An ordinary (not alt_hold) ban in force with no end. A timeout that runs
 *  out is not enough: the evasion ban is permanent and must outlast it. */
function permanentlyBanned(db: DB, steamid: string, now: Date): boolean {
  return db.prepare(
    `SELECT 1 FROM bans WHERE player_id = ? AND kind <> 'alt_hold' AND lifted_at IS NULL AND expires_at IS NULL
       AND created_at <= ? LIMIT 1`,
  ).get(steamid, now.toISOString()) !== undefined;
}

export type BanSameResult = 'banned' | 'no_person' | 'closed' | 'hold_settled' | 'hold_mismatch' | 'member_elsewhere';

/**
 * Everything lands in one transaction (the ban, the hold it settles, both
 * memberships) and the ban change is published once, after the commit, since
 * a subscriber may dial RCON. Nothing is written when the answer is a refusal.
 */
export function banAsSamePerson(
  db: DB, opts: { steamid: string; personId: number; by: string; holdId?: number; now?: Date },
): BanSameResult {
  const now = opts.now ?? new Date();
  const person = personById(db, opts.personId);
  if (!person) return 'no_person';
  if (person.closedAt) return 'closed';
  if (opts.holdId !== undefined) {
    const h = holdById(db, opts.holdId);
    if (h && h.steamid !== opts.steamid) return 'hold_mismatch';
  }
  const discord = getPlayer(db, opts.steamid)?.discord_id ?? null;
  for (const [kind, ident] of [['steam', opts.steamid], ...(discord ? [['discord', discord]] : [])] as ['steam' | 'discord', string][]) {
    const other = personOf(db, kind, ident);
    if (other && other.id !== opts.personId) return 'member_elsewhere';
  }
  const reason = sameReason(person.label);
  const how = 'ban as same person';
  let settled = true;
  let banned = false;
  db.transaction(() => {
    const holdId = opts.holdId ?? openHoldOf(db, opts.steamid)?.id;
    if (holdId !== undefined) {
      settled = banFromHoldTx(db, holdId, opts.by, reason, now);
      if (!settled) return;
      banned = true;
    } else if (!permanentlyBanned(db, opts.steamid, now)) {
      insertBan(db, opts.steamid, opts.by, reason, null, now);
      banned = true;
    }
    // Already banned for good: no second live ban row (and no second
    // engine ban), but the account still joins the person.
    addMember(db, opts.personId, 'steam', opts.steamid, opts.by, how, now);
    if (discord) addMember(db, opts.personId, 'discord', discord, opts.by, how, now);
  })();
  if (!settled) return 'hold_settled';
  if (banned) publishBanChange({ kind: 'ban', steamid: opts.steamid, reason });
  return 'banned';
}
