import { CAMPAIGNS } from './campaigns.js';

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
  group: 'Queue' | 'Match' | 'Discord' | 'Penalties' | 'Replays';
  type: SettingType;
  /** Masked in the panel until revealed, and never written to the audit log. */
  secret?: boolean;
}

export const SETTINGS_SCHEMA: SettingDef[] = [
  { key: 'ready_seconds', group: 'Queue', label: 'Ready check seconds', help: 'How long everyone has to press Ready when the queue pops.', type: { kind: 'int', min: 15, max: 600 } },
  { key: 'vote_seconds', group: 'Queue', label: 'Campaign vote seconds', help: 'How long the campaign vote runs.', type: { kind: 'int', min: 10, max: 300 } },
  { key: 'map_pool', group: 'Queue', label: 'Campaign pool', help: 'Campaigns offered in the vote.', type: { kind: 'campaigns' } },
  { key: 'invite_code', group: 'Queue', label: 'Invite code', help: 'Fallback way in for someone not in the Discord server.', type: { kind: 'string', maxLength: 64, allowEmpty: false }, secret: true },
  { key: 'noshow_minutes', group: 'Match', label: 'No-show minutes', help: 'A live match with too few players connected after this long is aborted.', type: { kind: 'int', min: 3, max: 60 } },
  { key: 'noshow_min_connected', group: 'Match', label: 'No-show minimum connected', help: 'Players that must have connected by the no-show deadline.', type: { kind: 'int', min: 1, max: 8 } },
  { key: 'no_round_minutes', group: 'Match', label: 'No-round minutes', help: 'A live match with no round played after this long is aborted.', type: { kind: 'int', min: 10, max: 120 } },
  { key: 'penalties_enabled', group: 'Penalties', label: 'No-show penalties', help: 'Missing a ready check or never connecting to a match earns an escalating queue timeout.', type: { kind: 'bool' } },
  { key: 'penalty_window_days', group: 'Penalties', label: 'Penalty window (days)', help: 'Offenses older than this stop counting.', type: { kind: 'int', min: 1, max: 60 } },
  { key: 'penalty_minutes', group: 'Penalties', label: 'Timeout ladder (minutes)', help: 'Timeout for the 1st, 2nd, 3rd... offense in the window. The last value repeats.', type: { kind: 'intList', min: 1, max: 43200, maxItems: 8 } },
  { key: 'discord_voice_enabled', group: 'Discord', label: 'Team voice channels', help: 'Create Team A and Team B voice channels per match and move players in.', type: { kind: 'bool' } },
  { key: 'discord_required_role_id', group: 'Discord', label: 'Required role id', help: 'Empty: any member of the Discord server is let in on linking. A role id: they must also have that role.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'discord_webhook_url', group: 'Discord', label: 'Webhook URL', help: 'Legacy announcements. Unused while the bot is running.', type: { kind: 'string', maxLength: 300, allowEmpty: true }, secret: true },
  { key: 'discord_queue_thresholds', group: 'Discord', label: 'Webhook queue thresholds', help: 'Queue sizes the legacy webhook announces.', type: { kind: 'intList', min: 1, max: 8, maxItems: 8 } },
  { key: 'replay_retention_days', group: 'Replays', label: 'Replay retention days', help: 'Replays older than this are pruned.', type: { kind: 'int', min: 7, max: 3650 } },
  { key: 'replay_free_floor_gb', group: 'Replays', label: 'Free disk floor (GB)', help: 'Prune the oldest replays early when free space drops below this.', type: { kind: 'int', min: 1, max: 500 } },
];

const BY_KEY = new Map(SETTINGS_SCHEMA.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export type Validated = { ok: true; value: string } | { ok: false; error: string };

/** Turn a submitted value into the stored string, or say why not. */
export function validateSetting(key: string, raw: unknown): Validated {
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
      const unknown = raw.filter((c) => typeof c !== 'string' || !CAMPAIGNS[c]);
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
