import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as V from './validate.js';
import { ROOM_LIVE_SQL, sideOf } from './room.js';
import type { Side } from './veto.js';

/**
 * Reschedule proposals (tournaments plan T4, spec section 5): the only
 * writer of event_reschedules and of a match's agreed time (scheduled_at,
 * schedule_source). Same shape as room.ts: each mutation is one
 * transaction that re-reads, checks, writes and adds exactly one event_log
 * row; a refusal writes nothing (tests/eventLogGuard.test.ts, the schedule
 * guard). The window and the round default are stamped by play.ts; this
 * module only ever sets a time a captain agreed or staff chose.
 */

export type RescheduleStatus = 'open' | 'accepted' | 'auto_accepted' | 'declined' | 'countered' | 'withdrawn' | 'expired';
export interface RescheduleRow {
  id: number; event_match_id: number; side: Side; proposed_by: string; proposed_time: string; note: string; created_at: string;
  auto_accept_at: string | null; reminded_at: string | null; status: RescheduleStatus; responded_by: string | null; responded_at: string | null;
}
export interface ScheduleRules { autoAcceptHours: number; leadMinutes: number }

/** A proposal locks on its own only when made this long before its time (Ruling 6). */
export const AUTO_ACCEPT_MIN_AHEAD_MS = 48 * 3_600_000;
/** A proposed time is at least this far ahead (the room opens 20 minutes before it). */
export const PROPOSE_MIN_AHEAD_MS = 60 * 60_000;
/** The reminder goes out this long before the lock ... */
export const REMINDER_BEFORE_MS = 24 * 3_600_000;
/** ... but only when that is at least this long after the proposal (else the arrival DM says it all). */
export const REMINDER_MIN_GAP_MS = 60 * 60_000;

const iso = (now?: Date): string => (now ?? new Date()).toISOString();

export function scheduleRules(db: DB): ScheduleRules {
  return {
    autoAcceptHours: settingNumber(db, 'reschedule_autoaccept_hours', 24, { min: 1, max: 72, integer: true }),
    leadMinutes: settingNumber(db, 'event_window_lead_minutes', 20, { min: 5, max: 60, integer: true }),
  };
}

export function proposalsOf(db: DB, matchId: number): RescheduleRow[] {
  return db.prepare('SELECT * FROM event_reschedules WHERE event_match_id = ? ORDER BY id').all(matchId) as RescheduleRow[];
}
export function openProposal(db: DB, matchId: number): RescheduleRow | undefined {
  return db.prepare("SELECT * FROM event_reschedules WHERE event_match_id = ? AND status = 'open'").get(matchId) as RescheduleRow | undefined;
}
export function getProposal(db: DB, id: number): RescheduleRow | undefined {
  return db.prepare('SELECT * FROM event_reschedules WHERE id = ?').get(id) as RescheduleRow | undefined;
}

/** When an unanswered proposal locks (Ruling 6), or null when it needs an answer. */
export function autoAcceptAt(createdMs: number, proposedMs: number, hours: number): string | null {
  return proposedMs - createdMs >= AUTO_ACCEPT_MIN_AHEAD_MS ? new Date(createdMs + hours * 3_600_000).toISOString() : null;
}
/** When the 24-hour reminder goes out, or null when the arrival DM carries the lock time already. */
export function reminderAt(createdMs: number, autoAcceptIso: string | null): string | null {
  if (autoAcceptIso === null) return null;
  const t = Date.parse(autoAcceptIso) - REMINDER_BEFORE_MS;
  return t >= createdMs + REMINDER_MIN_GAP_MS ? new Date(t).toISOString() : null;
}

/** The match, waiting in a live window stage with a window whose end has not passed, both teams in. */
function schedulable(db: DB, matchId: number, at: string): V.Checked<{ m: P.MatchRow; ev: E.EventRow }> {
  const m = P.getMatch(db, matchId);
  if (!m) return V.fail('match_not_found');
  const ev = E.getEvent(db, m.event_id)!;
  const stage = E.getStage(db, m.stage_id)!;
  if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
  if (m.entry_a === null || m.entry_b === null) return V.fail('match_not_open');
  if (![m.entry_a, m.entry_b].every((id) => N.isActive(N.getEntry(db, id)!))) return V.fail('entry_out');
  if (stage.scheduling !== 'window' || m.status !== 'waiting' || m.window_start === null || m.window_end === null || m.window_end <= at) {
    return V.fail('not_schedulable');
  }
  return V.ok({ m, ev });
}

/** A proposed time: inside the window, at least an hour ahead, not the time already set (Ruling 7). */
function timeIn(m: P.MatchRow, raw: unknown, at: string): string | null {
  const t = V.parseTime(raw);
  if (!t || t < m.window_start! || t > m.window_end! || t === m.scheduled_at) return null;
  return Date.parse(t) - Date.parse(at) >= PROPOSE_MIN_AHEAD_MS ? t : null;
}

function insertProposal(db: DB, m: P.MatchRow, side: Side, by: string, time: string, note: string, at: string, rules: ScheduleRules): number {
  const auto = autoAcceptAt(Date.parse(at), Date.parse(time), rules.autoAcceptHours);
  return Number(db.prepare(
    'INSERT INTO event_reschedules (event_match_id, side, proposed_by, proposed_time, note, created_at, auto_accept_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(m.id, side, by, time, note, at, auto).lastInsertRowid);
}
function closeProposal(db: DB, id: number, status: RescheduleStatus, by: string | null, at: string): void {
  db.prepare('UPDATE event_reschedules SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?').run(status, by, at, id);
}
function lockTime(db: DB, matchId: number, time: string, source: 'agreed' | 'staff'): void {
  db.prepare('UPDATE event_matches SET scheduled_at = ?, schedule_source = ? WHERE id = ?').run(time, source, matchId);
}

export function proposeTime(
  db: DB, o: { matchId: number; by: string; time: unknown; note?: unknown; rules: ScheduleRules; now?: Date },
): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const c = schedulable(db, o.matchId, at);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    const side = sideOf(db, m, o.by);
    if (!side) return V.fail('not_manager');
    if (openProposal(db, m.id)) return V.fail('proposal_open');
    const time = timeIn(m, o.time, at);
    if (!time) return V.fail('bad_time');
    const nr = V.normalizeReason(o.note);
    if (!nr.ok) return nr;
    const id = insertProposal(db, m, side, o.by, time, nr.value ?? '', at, o.rules);
    const p = getProposal(db, id)!;
    E.logEvent(db, ev.id, o.by, 'reschedule_proposed', at, { matchId: m.id, proposalId: id, side, time, autoAcceptAt: p.auto_accept_at });
    return V.ok(p);
  })();
}

/** The other side accepts (the time locks as agreed) or declines (nothing changes). */
export function respondProposal(db: DB, o: { matchId: number; by: string; accept: boolean; now?: Date }): V.Checked<{ m: P.MatchRow; proposal: RescheduleRow }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ m: P.MatchRow; proposal: RescheduleRow }> => {
    const c = schedulable(db, o.matchId, at);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    const side = sideOf(db, m, o.by);
    if (!side) return V.fail('not_manager');
    const p = openProposal(db, m.id);
    if (!p) return V.fail('no_proposal');
    if (p.side === side) return V.fail('own_proposal');
    // A time that passed while nobody answered cannot be accepted; the clock expires it.
    if (o.accept && p.proposed_time <= at) return V.fail('bad_time');
    closeProposal(db, p.id, o.accept ? 'accepted' : 'declined', o.by, at);
    if (o.accept) lockTime(db, m.id, p.proposed_time, 'agreed');
    E.logEvent(db, ev.id, o.by, o.accept ? 'reschedule_accepted' : 'reschedule_declined', at, { matchId: m.id, proposalId: p.id, side, time: p.proposed_time });
    return V.ok({ m: P.getMatch(db, m.id)!, proposal: getProposal(db, p.id)! });
  })();
}

/** The other side answers with its own time: the open proposal closes as countered and the new one opens, one row. */
export function counterProposal(
  db: DB, o: { matchId: number; by: string; time: unknown; note?: unknown; rules: ScheduleRules; now?: Date },
): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const c = schedulable(db, o.matchId, at);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    const side = sideOf(db, m, o.by);
    if (!side) return V.fail('not_manager');
    const p = openProposal(db, m.id);
    if (!p) return V.fail('no_proposal');
    if (p.side === side) return V.fail('own_proposal');
    const time = timeIn(m, o.time, at);
    if (!time) return V.fail('bad_time');
    const nr = V.normalizeReason(o.note);
    if (!nr.ok) return nr;
    closeProposal(db, p.id, 'countered', o.by, at);
    const id = insertProposal(db, m, side, o.by, time, nr.value ?? '', at, o.rules);
    const next = getProposal(db, id)!;
    E.logEvent(db, ev.id, o.by, 'reschedule_countered', at, { matchId: m.id, countered: p.id, proposalId: id, side, time, autoAcceptAt: next.auto_accept_at });
    return V.ok(next);
  })();
}

export function withdrawProposal(db: DB, o: { matchId: number; by: string; now?: Date }): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const c = schedulable(db, o.matchId, at);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    const side = sideOf(db, m, o.by);
    if (!side) return V.fail('not_manager');
    const p = openProposal(db, m.id);
    if (!p) return V.fail('no_proposal');
    if (p.side !== side) return V.fail('not_your_proposal');
    closeProposal(db, p.id, 'withdrawn', o.by, at);
    E.logEvent(db, ev.id, o.by, 'reschedule_withdrawn', at, { matchId: m.id, proposalId: p.id, side });
    return V.ok(getProposal(db, p.id)!);
  })();
}

/** Ruling 10: staff set any future time on a waiting window-stage match; an open proposal expires with it. */
export function staffSetTime(db: DB, o: { matchId: number; by: string; time: unknown; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    const ev = E.getEvent(db, m.event_id)!;
    const stage = E.getStage(db, m.stage_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    if (stage.scheduling !== 'window' || m.status !== 'waiting' || m.entry_a === null || m.entry_b === null) return V.fail('not_schedulable');
    const time = V.parseTime(o.time);
    if (!time || time <= at) return V.fail('bad_time');
    const p = openProposal(db, m.id);
    if (p) closeProposal(db, p.id, 'expired', o.by, at);
    lockTime(db, m.id, time, 'staff');
    E.logEvent(db, ev.id, o.by, 'match_time_set', at, { matchId: m.id, time, was: m.scheduled_at, expired: p?.id ?? null });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

// ---------- the clock's duties (src/events/roomClock.ts) ----------

/** Open proposals of waiting matches in live events and stages: the base of every due list. */
const OPEN_SQL = `SELECT r.* FROM event_reschedules r JOIN event_matches m ON m.id = r.event_match_id
  WHERE ${ROOM_LIVE_SQL} AND r.status = 'open' AND m.status = 'waiting'`;

export function autoAcceptDue(db: DB, now: Date): RescheduleRow[] {
  const at = now.toISOString();
  return db.prepare(`${OPEN_SQL} AND r.auto_accept_at IS NOT NULL AND r.auto_accept_at <= ? AND r.proposed_time > ? ORDER BY r.id`).all(at, at) as RescheduleRow[];
}

/** Ruling 6: still open, due, and the match still waiting with a future time; else 'changed'. */
export function autoAccept(db: DB, o: { proposalId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const p = getProposal(db, o.proposalId);
    if (!p || p.status !== 'open' || p.auto_accept_at === null || p.auto_accept_at > at || p.proposed_time <= at) return V.fail('changed');
    const m = P.getMatch(db, p.event_match_id);
    if (!m || m.status !== 'waiting') return V.fail('changed');
    closeProposal(db, p.id, 'auto_accepted', null, at);
    lockTime(db, m.id, p.proposed_time, 'agreed');
    E.logEvent(db, m.event_id, null, 'reschedule_auto_accepted', at, { matchId: m.id, proposalId: p.id, side: p.side, time: p.proposed_time });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

export function remindersDue(db: DB, now: Date): RescheduleRow[] {
  const rows = db.prepare(`${OPEN_SQL} AND r.reminded_at IS NULL AND r.auto_accept_at IS NOT NULL ORDER BY r.id`).all() as RescheduleRow[];
  const at = now.toISOString();
  return rows.filter((r) => { const t = reminderAt(Date.parse(r.created_at), r.auto_accept_at); return t !== null && t <= at; });
}

export function noteReminded(db: DB, o: { proposalId: number; now?: Date }): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const p = getProposal(db, o.proposalId);
    if (!p || p.status !== 'open' || p.reminded_at !== null) return V.fail('changed');
    db.prepare('UPDATE event_reschedules SET reminded_at = ? WHERE id = ?').run(at, p.id);
    const m = P.getMatch(db, p.event_match_id)!;
    E.logEvent(db, m.event_id, null, 'reschedule_reminded', at, { matchId: m.id, proposalId: p.id, side: p.side, autoAcceptAt: p.auto_accept_at });
    return V.ok(getProposal(db, p.id)!);
  })();
}

/** Open proposals whose time came with no answer. */
export function staleProposals(db: DB, now: Date): RescheduleRow[] {
  return db.prepare(`${OPEN_SQL} AND r.proposed_time <= ? ORDER BY r.id`).all(now.toISOString()) as RescheduleRow[];
}

export function expireProposal(db: DB, o: { proposalId: number; reason: 'time_passed' | 'window_ended'; now?: Date }): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const p = getProposal(db, o.proposalId);
    if (!p || p.status !== 'open') return V.fail('changed');
    closeProposal(db, p.id, 'expired', null, at);
    const m = P.getMatch(db, p.event_match_id)!;
    E.logEvent(db, m.event_id, null, 'reschedule_expired', at, { matchId: m.id, proposalId: p.id, side: p.side, reason: o.reason });
    return V.ok(getProposal(db, p.id)!);
  })();
}

/** Window-stage matches still waiting past their window's end (Ruling 8), both teams known. */
export function expiredWindows(db: DB, now: Date): P.MatchRow[] {
  return db.prepare(
    `SELECT m.* FROM event_matches m JOIN event_stages s ON s.id = m.stage_id
     WHERE ${ROOM_LIVE_SQL} AND s.scheduling = 'window' AND m.status = 'waiting' AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL
       AND m.window_end IS NOT NULL AND m.window_end <= ? ORDER BY m.id`,
  ).all(now.toISOString()) as P.MatchRow[];
}

/** Ruling 8: the side that made no proposal and answered none while the
 *  other side made at least one; null when both acted or neither did. A
 *  counter, a decline, a withdrawal and a staff expiry all count as an
 *  answer by the side whose manager gave it. */
export function silentSide(db: DB, m: P.MatchRow): Side | null {
  const acted = { a: false, b: false };
  const proposed = { a: false, b: false };
  for (const p of proposalsOf(db, m.id)) {
    proposed[p.side] = true;
    acted[p.side] = true;
    if (p.responded_by !== null) {
      const s = sideOf(db, m, p.responded_by);
      if (s) acted[s] = true;
    }
  }
  if (acted.a === acted.b) return null;
  const silent: Side = acted.a ? 'b' : 'a';
  return proposed[silent === 'a' ? 'b' : 'a'] ? silent : null;
}
