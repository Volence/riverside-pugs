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
  // for a restricted ticket or a ticket about staff. It names the reporter
  // (owner ruling 2026-09-25: staff must see who reported whom). `created` is
  // whether the report opened the ticket or joined one.
  | { kind: 'report'; ticketId: number; targetId: string | null; targetName: string; reporterId: string | null; reporterName: string; category: string; created: boolean }
  | { kind: 'admin_action'; adminId: string; action: string; target: string; detail: Record<string, unknown> }
  | { kind: 'penalty'; steamid: string; penalty: 'ready_fail' | 'no_show'; matchId: number | null }
  | { kind: 'account'; steamid: string; what: 'linked' | 'activated'; discordName?: string }
  // `link` is a site path the Discord poster turns into a link.
  | { kind: 'problem'; text: string; matchId?: number; link?: { label: string; path: string } }
  | { kind: 'abandon'; steamid: string; matchId: number; minutes: number }
  // The live board's clocks. low_allowance: a dropped player is nearly out of
  // reconnect time, once per drop, so an admin can hold the clock before it
  // ends the match. hold_expired: a hold reached its ceiling and released
  // itself. Both link to the board, where the buttons are.
  | { kind: 'clock'; what: 'low_allowance' | 'hold_expired'; steamid: string; matchId: number; remainingS: number }
  // A steamid dropped while connecting for the second time in ten minutes
  // without getting in between. `name` is the in-game name off the drop line,
  // because the steamid is often nobody the site knows. `count` is the drops in
  // that window, `total` every drop on record. `campaign` is set only when the
  // drop's server was running a live match on a custom campaign: there the
  // likely cause is the campaign's own VPK (missing, stale, or installed
  // without restarting the game), not the file consistency list.
  | { kind: 'signon_drop'; steamid: string; name: string; count: number; total: number; campaign?: { slug: string; name: string } }
  // An input signature fired on a player for the first time in a match. Fires
  // once per player per match, never per burst: a macro trips on every pounce
  // and per-burst posting would bury the feed under one player's round. This is
  // evidence to look at, not a verdict.
  // Little Anti-Cheat raised a flag on a player. Posted once per player per
  // cheat per match; LilAC fires repeatedly while a cheat looks active.
  | { kind: 'lilac_flag'; steamid: string; cheat: string; banned: boolean; matchId: number | null }
  // A player uploaded or sprayed a crash spray (src/logParse.ts spray_exploit).
  // Already blocked on the server; posted so staff know someone tried. Once
  // per player per spray file per hour.
  | { kind: 'spray_exploit'; steamid: string; crc: string; matchId: number | null; serverId: number | null }
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
  }
  // A SourceTV spectator joined from the same connection (hashed IP) as one
  // or more players rostered in the match live on that server. Published at
  // most once per match per hashed connection: not for a spectator matching
  // nobody, not for a match that spectator is not rostered in, and not again
  // for a later reconnect on the same connection in the same match (a
  // spectator is dropped and reconnects at every map change). `steamids`
  // carries every matched player in one post. Evidence a connection is
  // shared, not a claim the spectator is any of them: a household or a LAN
  // cafe looks the same as one person watching their own game.
  | { kind: 'sourcetv_watch'; matchId: number; serverId: number; spectatorName: string; steamids: string[] }
  // A player's /staff message (src/serverChat.ts). One per player per ten
  // minutes; the chat drawer on Live holds the whole conversation.
  | { kind: 'staff_message'; steamid: string; serverId: number; text: string }
  // The once-a-day rename digest (src/playerNames.ts): every player who played
  // a match under a name new to them since the last one, with their names in
  // the order first used. One post for the day rather than one per rename,
  // because people rename for fun and staff only need to keep up.
  | { kind: 'rename_digest'; players: { steamid: string; chain: string[]; earlier: number }[] }
  // A Discord account arrived from a different Steam account (src/altHolds.ts).
  // 'hold': the new account is on an alt hold until staff look. 'moved': the
  // same, but no hold was placed (staff cleared this pair before, or the
  // account is staff). 'discord_swap': a Steam account took a different
  // Discord than the one it had, which is reported and nothing more.
  | {
    kind: 'alt'; steamid: string; discordName: string;
    what: 'hold' | 'moved' | 'discord_swap'; otherSteamid?: string; previousDiscordName?: string;
  }
  /** A ban appeal was filed, or denied at once for a slur. Quiet appeals
   *  (by staff, or from a restricted ticket) never publish this. */
  | { kind: 'appeal'; appealId: number; what: 'filed' | 'auto_denied'; name: string; slurs: string[] };

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
  spray_exploit: 'admin_feed_problems',
  steam_signal: 'admin_feed_problems',
  sourcetv_watch: 'admin_feed_problems',
  staff_message: 'admin_feed_staff_messages',
  rename_digest: 'admin_feed_renames',
  alt: 'admin_feed_problems',
  appeal: 'admin_feed_reports',
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
