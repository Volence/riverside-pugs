import { CAMPAIGNS, DLC4_CAMPAIGNS } from './campaigns.js';

/**
 * The settings an admin may edit, with how each is validated.
 *
 * Settings used to be hand-edited in sqlite, and noShow.ts documents what that
 * cost: a blank noshow_minutes read as 0 and aborted every live match. Every
 * write through the panel goes through validateSetting, and only keys listed
 * here can be written at all.
 */
export type SettingType =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'string'; maxLength: number; allowEmpty: boolean }
  | { kind: 'campaigns' }
  | { kind: 'bool' }
  | { kind: 'intList'; min: number; max: number; maxItems: number };

export interface SettingDef {
  key: string;
  label: string;
  help: string;
  group: 'Queue' | 'Match' | 'Stats' | 'Discord' | 'Admin feed' | 'Penalties' | 'Replays';
  type: SettingType;
  /** Masked in the panel until revealed, and never written to the audit log. */
  secret?: boolean;
}

export const SETTINGS_SCHEMA: SettingDef[] = [
  { key: 'ready_seconds', group: 'Queue', label: 'Ready check seconds', help: 'How long everyone has to press Ready when the queue pops.', type: { kind: 'int', min: 15, max: 600 } },
  { key: 'input_pounce_min_rate', group: 'Stats', label: 'Pounce spam rate (presses/s)', help: 'Attack presses per second, in the air as a hunter, at or above which one pounce counts toward the pounce_spam input flag. It takes four such pounces in one match to flag anyone. A hand peaks near 8 a second and the measured macro holds 13, so keep this well above 9. Evidence for review only: nothing happens in game.', type: { kind: 'int', min: 10, max: 30 } },
  { key: 'input_pistol_min_rate', group: 'Stats', label: 'Pistol fire rate (presses/s)', help: 'Fire presses per second on a pistol, held for three seconds, at or above which a burst counts toward the pistol_rate input flag. It takes two such bursts in one match to flag anyone. A hand peaks near 8 a second and the measured macro holds 13 for as long as it is on. Evidence for review only: nothing happens in game.', type: { kind: 'int', min: 10, max: 30 } },
  { key: 'vote_seconds', group: 'Queue', label: 'Campaign vote seconds', help: 'How long the campaign vote runs.', type: { kind: 'int', min: 10, max: 300 } },
  { key: 'map_pool', group: 'Queue', label: 'Campaign pool', help: 'Campaigns offered in the vote.', type: { kind: 'campaigns' } },
  { key: 'invite_code', group: 'Queue', label: 'Invite code', help: 'Fallback way in for someone not in the Discord server.', type: { kind: 'string', maxLength: 64, allowEmpty: false }, secret: true },
  { key: 'noshow_minutes', group: 'Match', label: 'No-show minutes', help: 'A live match with too few players connected after this long is aborted.', type: { kind: 'int', min: 3, max: 60 } },
  { key: 'noshow_min_connected', group: 'Match', label: 'No-show minimum connected', help: 'Players that must have connected by the no-show deadline.', type: { kind: 'int', min: 1, max: 8 } },
  { key: 'no_round_minutes', group: 'Match', label: 'No-round minutes', help: 'A live match with no round played after this long is aborted.', type: { kind: 'int', min: 10, max: 120 } },
  { key: 'server_admin_flags', group: 'Match', label: 'Server admin flags', help: 'SourceMod flag letters every website admin gets on every game server. z is root, which is what the hand-written admins on the boxes already have. Narrow it with letters like bcdefg (generic, kick, ban, unban, slay, changemap).', type: { kind: 'string', maxLength: 26, allowEmpty: false } },
  { key: 'reset_map', group: 'Match', label: 'Reset map', help: 'Where a server is sent once a cancelled match has emptied it. A stock L4D1 map name, such as l4d_hospital01_apartment.', type: { kind: 'string', maxLength: 63, allowEmpty: false } },
  { key: 'standing_min_games', group: 'Stats', label: 'Badge minimum games', help: 'Games before a player is ranked for the top-5 per-match badges on their profile. The leaderboard\'s own provisional line is separate and stays at three.', type: { kind: 'int', min: 1, max: 200 } },
  { key: 'chemistry_min_games', group: 'Stats', label: 'Chemistry minimum games', help: 'Shared matches before a Best with or Worst against win rate is shown on a profile. Most played with is a count and has no minimum.', type: { kind: 'int', min: 1, max: 200 } },
  { key: 'endorse_budget', group: 'Stats', label: 'Endorsements per match', help: 'How many of the other seven players each player may endorse after a match.', type: { kind: 'int', min: 1, max: 7 } },
  { key: 'endorse_window_hours', group: 'Stats', label: 'Endorsement window (hours)', help: 'How long after a match ends endorsing stays open.', type: { kind: 'int', min: 1, max: 168 } },
  { key: 'endorse_title_min', group: 'Stats', label: 'Title minimum endorsements', help: 'Endorsements of one kind before that kind can become the title shown beside a name.', type: { kind: 'int', min: 1, max: 1000 } },
  { key: 'endorse_title_min_games', group: 'Stats', label: 'Title minimum games', help: 'Completed matches before any title is shown.', type: { kind: 'int', min: 1, max: 1000 } },
  { key: 'penalties_enabled', group: 'Penalties', label: 'No-show penalties', help: 'Missing a ready check or never connecting to a match earns an escalating queue timeout.', type: { kind: 'bool' } },
  { key: 'penalty_window_days', group: 'Penalties', label: 'Penalty window (days)', help: 'Offenses older than this stop counting.', type: { kind: 'int', min: 1, max: 60 } },
  { key: 'penalty_minutes', group: 'Penalties', label: 'Timeout ladder (minutes)', help: 'Timeout for the 1st, 2nd, 3rd... offense in the window. The last value repeats.', type: { kind: 'intList', min: 1, max: 43200, maxItems: 8 } },
  { key: 'ticket_mod_ban_max_minutes', group: 'Penalties', label: 'Longest ban a moderator can issue (minutes)', help: 'Moderators can ban from a ticket up to this long. Anything longer, or permanent, needs an admin. 10080 is seven days.', type: { kind: 'int', min: 1, max: 525600 } },
  { key: 'ticket_reports_per_day', group: 'Penalties', label: 'Reports per player per day', help: 'How many reports one player may file in 24 hours.', type: { kind: 'int', min: 1, max: 100 } },
  { key: 'leave_budget_seconds', group: 'Match', label: 'Reconnect allowance (seconds)', help: 'Total time each player may be disconnected during a match. The game pauses while they are gone; run out and the match ends as an abandon with an escalating ban (1, 3, then 7 days). Applies from the next match.', type: { kind: 'int', min: 60, max: 1800 } },
  { key: 'leave_auto_unpause', group: 'Match', label: 'Auto-unpause after a reconnect', help: 'On: the game unpauses on a 10 second countdown once everyone is back. Off: both teams type !ready.', type: { kind: 'bool' } },
  { key: 'clock_hold_max_minutes', group: 'Match', label: 'Longest clock hold (minutes)', help: 'How long an admin can hold a clock from the live board before it releases itself and says so in the admin feed. The game server enforces the same ceiling on its own, so a lost release cannot leave a match paused for ever. Applies from the next match.', type: { kind: 'int', min: 1, max: 120 } },
  { key: 'abandon_low_alert_seconds', group: 'Match', label: 'Low reconnect time warning (seconds)', help: 'When a disconnected player has this much reconnect time left, the admin feed says so once, with a link to the live board. 0 turns the warning off.', type: { kind: 'int', min: 0, max: 600 } },
  { key: 'discord_voice_enabled', group: 'Discord', label: 'Team voice channels', help: 'Create Team A and Team B voice channels per match and move players in.', type: { kind: 'bool' } },
  { key: 'discord_lobby_channel_id', group: 'Discord', label: 'Lobby voice channel id', help: 'Where players are sent when their match voice channels are deleted, if they were not pulled out of a channel of their own. Empty drops them out of voice.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'require_discord_to_queue', group: 'Discord', label: 'Require Discord to queue', help: 'Players must have Discord linked and be in the Discord server to join the queue.', type: { kind: 'bool' } },
  { key: 'require_voice_to_ready', group: 'Discord', label: 'Require voice to ready up', help: 'Players must be in a voice channel on the Discord server to press Ready, on the site and on the Discord card. Leaving voice during the ready check un-readies them. Allowed when the bot is down.', type: { kind: 'bool' } },
  { key: 'discord_invite_url', group: 'Discord', label: 'Discord invite link', help: 'Permanent invite shown on How to play and the signup checklist.', type: { kind: 'string', maxLength: 200, allowEmpty: true } },
  { key: 'discord_staff_role_id', group: 'Discord', label: 'Staff role id', help: 'Role given access to every match\'s team voice channels, so staff can drop into either side. Empty gives no role access.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'discord_admin_channel_id', group: 'Discord', label: 'Admin channel id', help: 'Private channel for the admin feed. Empty turns the feed off.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'discord_results_channel_id', group: 'Discord', label: 'Results channel id', help: 'Where match results are posted. Empty keeps them in the queue channel. Set it and the queue channel is left for queueing: a finished match\'s card and server-ready ping are removed once its result is posted.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'discord_tickets_forum_id', group: 'Discord', label: 'Tickets forum channel id', help: 'A forum channel hidden from everyone. The bot posts one thread per ticket and lets each linked moderator and admin in, one person at a time. Empty: tickets are worked on the site alone, and a new one is announced with a line in the admin channel.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'discord_tickets_channel_id', group: 'Discord', label: 'Tickets text channel id', help: 'A text channel everyone can see and nobody can post in. It only parents private threads: one per restricted ticket, whose members are that ticket\'s access list. Anyone with the Discord Administrator permission can still read them. Empty: restricted tickets get no Discord thread.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'ticket_store_attachments', group: 'Discord', label: 'Store ticket attachments', help: 'Download files posted in ticket threads and keep them on the server, because Discord\'s own links expire within a day. Off: the name, type and size are recorded and the file is not kept. Files already stored stay until they are removed.', type: { kind: 'bool' } },
  { key: 'ticket_attachment_max_mb', group: 'Discord', label: 'Largest ticket attachment (MB)', help: 'A bigger file is recorded and not stored.', type: { kind: 'int', min: 1, max: 500 } },
  { key: 'ticket_attachments_ticket_mb', group: 'Discord', label: 'Attachment space per ticket (MB)', help: 'Once one ticket holds this much, further files on it are recorded and not stored.', type: { kind: 'int', min: 1, max: 10000 } },
  { key: 'ticket_attachments_total_mb', group: 'Discord', label: 'Attachment space overall (MB)', help: 'Once every ticket together holds this much, no new file is stored and the admin channel is told. Removing messages frees space. These files are deliberately left out of the database backup, so that removing one removes every copy.', type: { kind: 'int', min: 1, max: 1000000 } },
  { key: 'admin_feed_reports', group: 'Admin feed', label: 'Reports', help: 'Post a line when a ticket opens or gets another report. Only while no tickets forum is set: with a forum, the ticket\'s own post is the announcement. Restricted tickets never post.', type: { kind: 'bool' } },
  { key: 'admin_feed_actions', group: 'Admin feed', label: 'Admin actions', help: 'Bans, unbans, voids, aborts, setting changes.', type: { kind: 'bool' } },
  { key: 'admin_feed_penalties', group: 'Admin feed', label: 'Penalties', help: 'Missed ready checks and no-shows.', type: { kind: 'bool' } },
  { key: 'admin_feed_accounts', group: 'Admin feed', label: 'Accounts', help: 'Players linking Discord and being activated.', type: { kind: 'bool' } },
  { key: 'admin_feed_problems', group: 'Admin feed', label: 'Problems', help: 'Matches aborted by the reapers, lost results, voice channel failures, and a player dropped twice while connecting (likely a modified game file).', type: { kind: 'bool' } },
  { key: 'discord_pug_role_id', group: 'Discord', label: 'Queue alert role id', help: 'Role pinged when the queue fills past a threshold. Members opt in with the Notify me button on the panel. Empty turns the alert off.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'discord_required_role_id', group: 'Discord', label: 'Required role id', help: 'Empty: any member of the Discord server is let in on linking. A role id: they must also have that role.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'discord_webhook_url', group: 'Discord', label: 'Webhook URL', help: 'Legacy announcements. Unused while the bot is running.', type: { kind: 'string', maxLength: 300, allowEmpty: true }, secret: true },
  { key: 'discord_queue_thresholds', group: 'Discord', label: 'Webhook queue thresholds', help: 'Queue sizes the legacy webhook announces.', type: { kind: 'intList', min: 1, max: 8, maxItems: 8 } },
  { key: 'replay_retention_days', group: 'Replays', label: 'Replay retention days', help: 'Replays older than this are pruned.', type: { kind: 'int', min: 7, max: 3650 } },
  { key: 'demo_retention_days', group: 'Replays', label: 'Match demo retention (days)', help: 'Match demos are deleted after this, and the download disappears from the match page.', type: { kind: 'int', min: 7, max: 3650 } },
  { key: 'demo_autorecord_days', group: 'Replays', label: 'Casual demo retention (days)', help: "SourceTV's own recordings of ordinary play, which nothing links to.", type: { kind: 'int', min: 1, max: 365 } },
  { key: 'replay_free_floor_gb', group: 'Replays', label: 'Free disk floor (GB)', help: 'Prune the oldest replays early when free space drops below this.', type: { kind: 'int', min: 1, max: 500 } },
];

const BY_KEY = new Map(SETTINGS_SCHEMA.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export type Validated = { ok: true; value: string } | { ok: false; error: string };

/** Turn a submitted value into the stored string, or say why not.
 *
 *  `campaignSlugs` is how a custom campaign becomes selectable: the pool is
 *  validated against whatever the registry currently holds, not against the
 *  base four. Callers without a registry to hand get CAMPAIGNS minus
 *  DLC4_CAMPAIGNS: the campaigns that need no install check at all, which is
 *  the only default that stays safe as CAMPAIGNS grows. Hardcoding the base
 *  four here would silently rot the moment a stock campaign starts requiring
 *  something to be installed, exactly as happened when dlc4 landed. */
export function validateSetting(
  key: string, raw: unknown, opts: { campaignSlugs?: Set<string> } = {},
): Validated {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: 'unknown setting' };
  const t = def.type;
  switch (t.kind) {
    case 'int': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < t.min || n > t.max) {
        return { ok: false, error: `must be a whole number between ${t.min} and ${t.max}` };
      }
      return { ok: true, value: String(n) };
    }
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, error: 'must be text' };
      const v = raw.trim();
      if (!v && !t.allowEmpty) return { ok: false, error: 'cannot be empty' };
      if (v.length > t.maxLength) return { ok: false, error: `at most ${t.maxLength} characters` };
      return { ok: true, value: v };
    }
    case 'bool':
      if (raw === true || raw === '1' || raw === 1) return { ok: true, value: '1' };
      if (raw === false || raw === '0' || raw === 0) return { ok: true, value: '0' };
      return { ok: false, error: 'must be on or off' };
    case 'campaigns': {
      if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'pick at least one campaign' };
      const known = opts.campaignSlugs
        ?? new Set(Object.keys(CAMPAIGNS).filter((slug) => !DLC4_CAMPAIGNS.has(slug)));
      const unknown = raw.filter((c) => typeof c !== 'string' || !known.has(c));
      if (unknown.length) return { ok: false, error: `unknown campaign: ${unknown.join(', ')}` };
      return { ok: true, value: JSON.stringify([...new Set(raw as string[])]) };
    }
    case 'intList': {
      if (!Array.isArray(raw) || raw.length > t.maxItems) return { ok: false, error: `a list of up to ${t.maxItems} numbers` };
      if (raw.some((n) => !Number.isInteger(n) || n < t.min || n > t.max)) {
        return { ok: false, error: `every number must be between ${t.min} and ${t.max}` };
      }
      return { ok: true, value: JSON.stringify(raw) };
    }
  }
}
