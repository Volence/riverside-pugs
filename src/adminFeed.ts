/**
 * Things admins want to hear about as they happen, published from wherever
 * they occur and delivered to the Discord admin channel by the bot.
 *
 * A process-wide bus rather than a dependency threaded through every call
 * site: the sources (reapers, penalties, report filing, the audit log, Discord
 * linking) are deep in modules that otherwise know nothing about Discord, and
 * a missing subscriber must cost nothing. Publishing never throws.
 */

export type AdminEvent =
  // A report landed on a normal ticket that has no Discord thread because no
  // tickets forum is set. Published by TicketSync, never by filing, and never
  // for a restricted ticket or a ticket about staff. It carries no reporter:
  // the feed channel is wider than the ticket. `created` is whether the
  // report opened the ticket or joined one.
  | { kind: 'report'; ticketId: number; targetId: string | null; targetName: string; category: string; created: boolean }
  | { kind: 'admin_action'; adminId: string; action: string; target: string; detail: Record<string, unknown> }
  | { kind: 'penalty'; steamid: string; penalty: 'ready_fail' | 'no_show'; matchId: number | null }
  | { kind: 'account'; steamid: string; what: 'linked' | 'activated'; discordName?: string }
  | { kind: 'problem'; text: string; matchId?: number }
  | { kind: 'abandon'; steamid: string; matchId: number; minutes: number }
  // The live board's clocks. low_allowance: a dropped player is nearly out of
  // reconnect time, once per drop, so an admin can hold the clock before it
  // ends the match. hold_expired: a hold reached its ceiling and released
  // itself. Both link to the board, where the buttons are.
  | { kind: 'clock'; what: 'low_allowance' | 'hold_expired'; steamid: string; matchId: number; remainingS: number }
  // A steamid dropped while connecting for the second time in ten minutes
  // without getting in between. `name` is the in-game name off the drop line,
  // because the steamid is often nobody the site knows. `count` is the drops in
  // that window, `total` every drop on record.
  | { kind: 'signon_drop'; steamid: string; name: string; count: number; total: number }
  // An input signature fired on a player for the first time in a match. Fires
  // once per player per match, never per burst: a macro trips on every pounce
  // and per-burst posting would bury the feed under one player's round. This is
  // evidence to look at, not a verdict.
  // Little Anti-Cheat raised a flag on a player. Posted once per player per
  // cheat per match; LilAC fires repeatedly while a cheat looks active.
  | { kind: 'lilac_flag'; steamid: string; cheat: string; banned: boolean; matchId: number | null }
  | { kind: 'input_flag'; steamid: string; matchId: number | null; signature: string; detail: string }
  // A client setting out of bounds (cpu_level 0). Posted once per player per
  // match, and only for a player in a live match.
  // A slur in chat or in a name, from any human on a game server, in a match
  // or not (src/conductFlags.ts). `slurs` names the kinds found, never the
  // word list. Chat posts at most once a minute per player and a name once
  // per player per name; every line is still stored on the player's file.
  | {
    kind: 'conduct_flag'; steamid: string; where: 'chat' | 'name'; text: string;
    slurs: string[]; matchId: number | null; serverId: number | null;
  }
  | { kind: 'cvar_flag'; steamid: string; matchId: number; cvar: string; value: number; act: 'held' | 'fixed' | 'live' }
  // Something Steam says about a player rostered in a live match: a VAC or
  // game ban less than a year old, or a game borrowed through Family Sharing
  // from an account that is banned here. Posted once per player per condition,
  // not once per match. Context for an admin, not a verdict: a ban in another
  // game is not a ban in this one, and a sibling's library is still a library.
  | {
    kind: 'steam_signal'; steamid: string; matchId: number | null;
    signal:
      | { what: 'recent_ban'; vacBans: number; gameBans: number; daysSinceLastBan: number }
      | { what: 'banned_lender'; lenderId: string };
  };

/** The settings toggle that silences each kind in the admin channel. */
export const FEED_SETTING: Record<AdminEvent['kind'], string> = {
  report: 'admin_feed_reports',
  admin_action: 'admin_feed_actions',
  penalty: 'admin_feed_penalties',
  account: 'admin_feed_accounts',
  problem: 'admin_feed_problems',
  abandon: 'admin_feed_penalties',
  clock: 'admin_feed_problems',
  signon_drop: 'admin_feed_problems',
  input_flag: 'admin_feed_problems',
  cvar_flag: 'admin_feed_problems',
  conduct_flag: 'admin_feed_conduct',
  lilac_flag: 'admin_feed_problems',
  steam_signal: 'admin_feed_problems',
};

type Listener = (e: AdminEvent) => void;
const listeners = new Set<Listener>();

export function publishAdminEvent(e: AdminEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch (err) {
      console.error('[adminFeed] listener failed:', err);
    }
  }
}

export function subscribeAdminEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
