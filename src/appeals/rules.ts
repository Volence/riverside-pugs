import type { DB } from '../db.js';
import { getSetting, settingNumber } from '../settings.js';
import { getPlayer } from '../players.js';
import {
  DENIAL_STATES, OPEN_STATES, refColumn, type AppealRef, type Appealable, type Appellant,
} from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function appealSettings(db: DB) {
  return {
    enabled: getSetting(db, 'appeals_enabled') === '1',
    minBanHours: settingNumber(db, 'appeal_min_ban_hours', 24, { min: 0, integer: true }),
    cooldownDays: settingNumber(db, 'appeal_cooldown_days', 7, { min: 0, integer: true }),
    maxPerBan: settingNumber(db, 'appeal_max_per_ban', 2, { min: 1, integer: true }),
    textMax: settingNumber(db, 'appeal_text_max', 1500, { min: 1, integer: true }),
    answerMax: settingNumber(db, 'appeal_answer_max', 800, { min: 1, integer: true }),
    answerHours: settingNumber(db, 'appeal_answer_hours', 72, { min: 1, integer: true }),
    maxReplies: settingNumber(db, 'appeal_max_replies', 30, { min: 1, integer: true }),
  };
}

export function appellantFromSteam(db: DB, steamid: string): Appellant {
  const p = getPlayer(db, steamid);
  return { steamids: [steamid], discordId: p?.discord_id ?? null, name: p?.name ?? steamid };
}

/** Every account this Discord is linked to now or was before: a banned
 *  account cannot unlink, so "before" mostly covers an alt hold, where the
 *  Discord moved to the held account from the one it came from. */
export function appellantFromDiscord(db: DB, discordId: string, name: string): Appellant {
  const steamids = (db.prepare(
    `SELECT steamid FROM players WHERE discord_id = ?
     UNION SELECT steamid FROM discord_link_history WHERE discord_id = ?`,
  ).all(discordId, discordId) as { steamid: string }[]).map((r) => r.steamid);
  return { steamids, discordId, name };
}

/** Every ban, hold and Discord sanction in force against this person,
 *  newest first. The only source of "what may this person appeal", so a ref
 *  that is not in here is not theirs. */
export function activeTargets(db: DB, who: Appellant, now = new Date()): Appealable[] {
  const iso = now.toISOString();
  const out: Appealable[] = [];
  for (const steamid of who.steamids) {
    const bans = db.prepare(
      `SELECT id, player_id, reason, created_by, created_at, expires_at, kind, ticket_id, no_appeal FROM bans
       WHERE player_id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC`,
    ).all(steamid, iso) as {
      id: number; player_id: string; reason: string; created_by: string; created_at: string;
      expires_at: string | null; kind: string; ticket_id: number | null; no_appeal: number;
    }[];
    for (const b of bans) {
      out.push({
        ref: { kind: 'ban', id: b.id }, steamid: b.player_id, discordId: null, reason: b.reason,
        createdBy: b.created_by, createdAt: b.created_at, endsAt: b.expires_at, hold: b.kind === 'alt_hold',
        sanctionKind: null, ticketId: b.ticket_id, noAppeal: b.no_appeal === 1,
      });
    }
  }
  if (who.discordId) {
    const rows = db.prepare(
      `SELECT id, discord_id, kind, until, reason, ticket_id, created_by, created_at, no_appeal FROM discord_sanctions
       WHERE discord_id = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?) ORDER BY id DESC`,
    ).all(who.discordId, iso) as {
      id: number; discord_id: string; kind: 'timeout' | 'ban'; until: string | null; reason: string;
      ticket_id: number | null; created_by: string; created_at: string; no_appeal: number;
    }[];
    for (const s of rows) {
      out.push({
        ref: { kind: 'sanction', id: s.id }, steamid: null, discordId: s.discord_id, reason: s.reason,
        createdBy: s.created_by, createdAt: s.created_at, endsAt: s.until, hold: false,
        sanctionKind: s.kind, ticketId: s.ticket_id, noAppeal: s.no_appeal === 1,
      });
    }
  }
  return out;
}

export type Refusal = 'disabled' | 'nothing_to_appeal' | 'too_short' | 'already_open' | 'cooldown' | 'limit_reached' | 'marked_final';
export type Verdict = { ok: true; target: Appealable } | { ok: false; reason: Refusal; opensAt?: string };

/** Settled appeals on this ref that count: everything but open ones and moot. */
function counted(db: DB, ref: AppealRef): { n: number; lastDenial: string | null } {
  const col = refColumn(ref);
  const open = OPEN_STATES.map(() => '?').join(',');
  const deny = DENIAL_STATES.map(() => '?').join(',');
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM appeals WHERE ${col} = ? AND state NOT IN (${open}) AND state != 'moot'`)
    .get(ref.id, ...OPEN_STATES) as { n: number }).n;
  const last = db.prepare(`SELECT MAX(decided_at) AS at FROM appeals WHERE ${col} = ? AND state IN (${deny})`)
    .get(ref.id, ...DENIAL_STATES) as { at: string | null };
  return { n, lastDenial: last.at };
}

/** The rules for one ban already known to be the appellant's and in force. */
export function judge(db: DB, target: Appealable, now = new Date()): Verdict {
  const s = appealSettings(db);
  if (!s.enabled) return { ok: false, reason: 'disabled' };
  if (target.noAppeal) return { ok: false, reason: 'marked_final' };
  if (!target.hold && target.endsAt !== null
    && Date.parse(target.endsAt) - Date.parse(target.createdAt) < s.minBanHours * HOUR_MS) {
    return { ok: false, reason: 'too_short' };
  }
  const col = refColumn(target.ref);
  const open = db.prepare(`SELECT 1 FROM appeals WHERE ${col} = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`)
    .get(target.ref.id, ...OPEN_STATES);
  if (open) return { ok: false, reason: 'already_open' };
  const c = counted(db, target.ref);
  if (c.n >= s.maxPerBan) return { ok: false, reason: 'limit_reached' };
  if (c.lastDenial) {
    const opens = Date.parse(c.lastDenial) + s.cooldownDays * DAY_MS;
    if (opens > now.getTime()) return { ok: false, reason: 'cooldown', opensAt: new Date(opens).toISOString() };
  }
  return { ok: true, target };
}

export function canAppeal(db: DB, who: Appellant, ref: AppealRef, now = new Date()): Verdict {
  if (!appealSettings(db).enabled) return { ok: false, reason: 'disabled' };
  const target = activeTargets(db, who, now).find((t) => t.ref.kind === ref.kind && t.ref.id === ref.id);
  if (!target) return { ok: false, reason: 'nothing_to_appeal' };
  return judge(db, target, now);
}

const fmtDate = (iso: string) => new Date(iso).toUTCString().replace(/:\d\d GMT$/, ' UTC');

export function refusalText(v: Extract<Verdict, { ok: false }>): string {
  switch (v.reason) {
    case 'disabled': return 'Appeals are not open right now. Message a moderator in the Discord instead.';
    case 'nothing_to_appeal': return 'You have nothing to appeal.';
    case 'too_short': return 'This ban is too short to appeal. It ends on its own soon.';
    case 'already_open': return 'You already have an appeal open for this. Staff will get to it.';
    case 'cooldown': return `Your last appeal for this was turned down. You can appeal again after ${fmtDate(v.opensAt!)}.`;
    case 'limit_reached': return 'You have used every appeal for this ban.';
    case 'marked_final': return 'This ban cannot be appealed.';
  }
}

/** When this ban may next be appealed, judged on settled appeals alone, or
 *  null when it never may (the limit is reached). For the denial message. */
export function nextAppealAt(db: DB, ref: AppealRef, now = new Date()): string | null {
  const s = appealSettings(db);
  const c = counted(db, ref);
  if (c.n >= s.maxPerBan) return null;
  if (!c.lastDenial) return now.toISOString();
  return new Date(Math.max(now.getTime(), Date.parse(c.lastDenial) + s.cooldownDays * DAY_MS)).toISOString();
}

export const refKey = (ref: AppealRef): string => `${ref.kind}:${ref.id}`;

export function parseRefKey(s: string): AppealRef | null {
  const m = /^(ban|sanction):(\d{1,12})$/.exec(s);
  return m ? { kind: m[1] as 'ban' | 'sanction', id: Number(m[2]) } : null;
}
