import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { FEED_SETTING, type AdminEvent } from '../adminFeed.js';

/**
 * Which staff channel each feed line belongs in (owner, 2026-10-04): the mod
 * channel for lines a moderator should act on, the admin log for automatic
 * ones. Mods can read both; the split is about noise, not access.
 *
 * A Record, so a new event kind does not compile until somebody decides
 * where it goes. LilAC, input and cvar flags stay in the admin log because
 * they are frequent and reviewed in batches on Needs a look; spray crashes
 * and SourceTV watch are rare and need someone to act.
 */
export const FEED_DESTINATION: Record<AdminEvent['kind'], 'mod' | 'admin'> = {
  report: 'mod',
  appeal: 'mod',
  admin_action: 'admin', // per action, see MOD_ACTIONS
  penalty: 'admin',
  account: 'admin',
  problem: 'admin',
  abandon: 'admin',
  clock: 'admin',
  signon_drop: 'admin',
  input_flag: 'admin',
  cvar_flag: 'admin',
  conduct_flag: 'mod',
  lilac_flag: 'admin',
  spray_exploit: 'mod',
  steam_signal: 'admin',
  sourcetv_watch: 'mod',
  staff_message: 'mod',
  rename_digest: 'admin',
  alt: 'mod',
  ip_match: 'mod',
};

/** Audit actions that are moderation. Anything not listed is the admin log. */
export const MOD_ACTIONS: ReadonlySet<string> = new Set([
  'ban', 'unban', 'alt_lift', 'alt_ban', 'evader_flag', 'evader_clear', 'ip_watch_add', 'ip_watch_remove', 'note', 'looked_at',
  'clear_penalty', 'clear_penalties', 'queue_remove', 'practice_kick', 'leave_clock',
  'ticket_open', 'ticket_claim', 'ticket_restrict', 'ticket_access', 'ticket_close', 'ticket_reopen', 'ticket_ban',
  'ticket_remove', 'ticket_discord_sanction', 'ticket_discord_sanction_lift', 'ticket_contact', 'ticket_chat_join', 'ticket_chat_end',
  'appeal_ask', 'appeal_accept', 'appeal_shorten', 'appeal_deny', 'appeal_final', 'appeal_unfinal',
]);

export function destinationOf(e: AdminEvent): 'mod' | 'admin' {
  if (e.kind === 'admin_action') return MOD_ACTIONS.has(e.action) ? 'mod' : 'admin';
  return FEED_DESTINATION[e.kind];
}

/** The mod channel when one is set, else the admin channel, else ''. */
export function modChannelOrAdmin(db: DB): string {
  return (getSetting(db, 'discord_mod_channel_id') ?? '') || (getSetting(db, 'discord_admin_channel_id') ?? '');
}

/** Where this line posts, or null for nowhere (its kind is switched off, or
 *  its channel is not set). An empty mod channel sends mod lines to the
 *  admin channel, as before the split. */
export function feedChannel(db: DB, e: AdminEvent): string | null {
  if (getSetting(db, FEED_SETTING[e.kind]) === '0') return null;
  const id = destinationOf(e) === 'mod' ? modChannelOrAdmin(db) : (getSetting(db, 'discord_admin_channel_id') ?? '');
  return id || null;
}
