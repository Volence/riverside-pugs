import type { DB } from '../db.js';
import type { FileViewer } from '../admin/fileAccess.js';
import { activeTargets, appealSettings, judge, refusalText } from './rules.js';
import { canSeeAppeal, decideCheck } from './access.js';
import { playerLine } from './templates.js';
import { targetInForce } from './store.js';
import { OPEN_STATES, refColumn, type AppealRef, type AppealRow, type AppealState, type Appellant } from './types.js';

export interface PlayerAppealItem {
  ref: AppealRef;
  hold: boolean;
  sanctionKind: 'timeout' | 'ban' | null;
  reason: string;
  endsAt: string | null;
  canAppeal: boolean;
  refusal: string | null;
  appeal: { id: number; state: AppealState; question: string | null; answerBy: string | null; line: string | null; filedAt: string } | null;
}

export interface MyAppeals { enabled: boolean; name: string; textMax: number; answerMax: number; items: PlayerAppealItem[] }

export function playerView(db: DB, who: Appellant, now = new Date()): MyAppeals {
  const s = appealSettings(db);
  const items = activeTargets(db, who, now).map((t): PlayerAppealItem => {
    const v = judge(db, t, now);
    const latest = db.prepare(`SELECT * FROM appeals WHERE ${refColumn(t.ref)} = ? AND state != 'moot' ORDER BY id DESC LIMIT 1`)
      .get(t.ref.id) as AppealRow | undefined;
    return {
      ref: t.ref, hold: t.hold, sanctionKind: t.sanctionKind, reason: t.reason, endsAt: t.endsAt,
      canAppeal: v.ok, refusal: v.ok || v.reason === 'already_open' ? null : refusalText(v),
      appeal: latest ? {
        id: latest.id, state: latest.state, question: latest.state === 'asked' ? latest.question : null,
        answerBy: latest.state === 'asked' ? new Date(Date.parse(latest.asked_at!) + s.answerHours * 3600_000).toISOString() : null,
        line: playerLine(db, latest, now), filedAt: latest.created_at,
      } : null,
    };
  });
  return { enabled: s.enabled, name: who.name, textMax: s.textMax, answerMax: s.answerMax, items };
}

export interface StaffAppealRow {
  id: number; state: AppealState; name: string; steamid: string | null; discordId: string | null;
  about: 'ban' | 'hold' | 'timeout' | 'discord ban'; filedAt: string; decidedAt: string | null;
}

export interface StaffAppealDetail extends StaffAppealRow {
  whatHappened: string; whyLift: string;
  question: string | null; askedByName: string | null; askedAt: string | null;
  answer: string | null; answeredAt: string | null; answerBy: string | null;
  decidedByName: string | null; newExpiresAt: string | null; slurs: string[];
  target: { reason: string; createdByName: string; createdAt: string; endsAt: string | null; ticketId: number | null; noAppeal: boolean; inForce: boolean };
  earlier: { id: number; state: AppealState; decidedAt: string | null }[];
  canDecide: boolean; canShorten: boolean; canMarkFinal: boolean;
}

const nameOf = (db: DB, steamid: string | null): string | null => {
  if (!steamid) return null;
  if (steamid === 'system') return 'automatic';
  return (db.prepare('SELECT name FROM players WHERE steamid = ?').get(steamid) as { name: string } | undefined)?.name ?? steamid;
};

function about(db: DB, row: AppealRow): StaffAppealRow['about'] {
  if (row.ban_id !== null) {
    const k = db.prepare('SELECT kind FROM bans WHERE id = ?').get(row.ban_id) as { kind: string } | undefined;
    return k?.kind === 'alt_hold' ? 'hold' : 'ban';
  }
  const k = db.prepare('SELECT kind FROM discord_sanctions WHERE id = ?').get(row.sanction_id) as { kind: string } | undefined;
  return k?.kind === 'ban' ? 'discord ban' : 'timeout';
}

const toRow = (db: DB, r: AppealRow): StaffAppealRow => ({
  id: r.id, state: r.state, name: r.appellant_name || nameOf(db, r.steamid) || r.discord_id || '?', steamid: r.steamid,
  discordId: r.discord_id, about: about(db, r), filedAt: r.created_at, decidedAt: r.decided_at,
});

export function staffAppeals(db: DB, viewer: FileViewer, which: 'open' | 'closed'): StaffAppealRow[] {
  const inOpen = OPEN_STATES.map((s) => `'${s}'`).join(',');
  const rows = db.prepare(`SELECT * FROM appeals WHERE state ${which === 'open' ? 'IN' : 'NOT IN'} (${inOpen}) ORDER BY id ${which === 'open' ? 'ASC' : 'DESC'} LIMIT 200`)
    .all() as AppealRow[];
  return rows.filter((r) => canSeeAppeal(db, viewer, r)).map((r) => toRow(db, r));
}

export function staffAppeal(db: DB, viewer: FileViewer, id: number, now = new Date()): StaffAppealDetail | null {
  const r = db.prepare('SELECT * FROM appeals WHERE id = ?').get(id) as AppealRow | undefined;
  if (!r || !canSeeAppeal(db, viewer, r)) return null;
  const t = (r.ban_id !== null
    ? db.prepare('SELECT reason, created_by, created_at, expires_at AS ends_at, ticket_id, no_appeal FROM bans WHERE id = ?').get(r.ban_id)
    : db.prepare('SELECT reason, created_by, created_at, until AS ends_at, ticket_id, no_appeal FROM discord_sanctions WHERE id = ?').get(r.sanction_id)) as
    { reason: string; created_by: string; created_at: string; ends_at: string | null; ticket_id: number | null; no_appeal: number };
  const col = r.ban_id !== null ? 'ban_id' : 'sanction_id';
  const earlier = db.prepare(`SELECT id, state, decided_at FROM appeals WHERE ${col} = ? AND id != ? ORDER BY id`)
    .all(r.ban_id ?? r.sanction_id, r.id) as { id: number; state: AppealState; decided_at: string | null }[];
  const ab = about(db, r);
  const canDecide = decideCheck(db, viewer, r).ok;
  const s = appealSettings(db);
  return {
    ...toRow(db, r),
    whatHappened: r.what_happened, whyLift: r.why_lift,
    question: r.question, askedByName: nameOf(db, r.asked_by), askedAt: r.asked_at,
    answer: r.answer, answeredAt: r.answered_at,
    answerBy: r.state === 'asked' ? new Date(Date.parse(r.asked_at!) + s.answerHours * 3600_000).toISOString() : null,
    decidedByName: nameOf(db, r.decided_by), newExpiresAt: r.new_expires_at, slurs: r.slurs ? JSON.parse(r.slurs) as string[] : [],
    target: {
      reason: t.reason, createdByName: nameOf(db, t.created_by) ?? '', createdAt: t.created_at, endsAt: t.ends_at,
      ticketId: t.ticket_id, noAppeal: t.no_appeal === 1, inForce: targetInForce(db, r, now),
    },
    earlier: earlier.map((e) => ({ id: e.id, state: e.state, decidedAt: e.decided_at })),
    canDecide,
    canShorten: canDecide && ab === 'ban',
    canMarkFinal: viewer.isAdmin,
  };
}
