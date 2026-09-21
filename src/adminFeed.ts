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
  // A report landed on a normal ticket. `created` is whether it opened the
  // ticket or joined one. Never published for a restricted ticket, and it
  // carries no reporter: the feed channel is wider than the ticket.
  | { kind: 'report'; ticketId: number; targetId: string; category: string; created: boolean }
  | { kind: 'admin_action'; adminId: string; action: string; target: string; detail: Record<string, unknown> }
  | { kind: 'penalty'; steamid: string; penalty: 'ready_fail' | 'no_show'; matchId: number | null }
  | { kind: 'account'; steamid: string; what: 'linked' | 'activated'; discordName?: string }
  | { kind: 'problem'; text: string; matchId?: number }
  | { kind: 'abandon'; steamid: string; matchId: number; minutes: number }
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
  | { kind: 'input_flag'; steamid: string; matchId: number | null; signature: string; detail: string };

/** The settings toggle that silences each kind in the admin channel. */
export const FEED_SETTING: Record<AdminEvent['kind'], string> = {
  report: 'admin_feed_reports',
  admin_action: 'admin_feed_actions',
  penalty: 'admin_feed_penalties',
  account: 'admin_feed_accounts',
  problem: 'admin_feed_problems',
  abandon: 'admin_feed_penalties',
  signon_drop: 'admin_feed_problems',
  input_flag: 'admin_feed_problems',
  lilac_flag: 'admin_feed_problems',
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
