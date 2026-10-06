import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as V from './validate.js';
import { ROOM_LIVE_SQL, sideOf } from './room.js';
import { other, type Side } from './veto.js';

/**
 * Reschedule proposals (tournaments plan T4, spec section 5): the only
 * writer of event_reschedules (the account merge apart, which moves its
 * steamids) and of a match's agreed time (scheduled_at, schedule_source).
 * Same shape as room.ts: each mutation is one
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
/** The three plan T5 margins are optional so a hand-built ScheduleRules
 *  (tests) keeps compiling; scheduleRules(db) always fills them. */
export interface ScheduleRules { autoAcceptHours: number; leadMinutes: number; minAheadMinutes?: number; autoAcceptMinAheadHours?: number; reminderHours?: number }

/** The seeded default of reschedule_autoaccept_min_ahead_hours: a proposal
 *  locks on its own only when made this long before its time (Ruling 6). */
export const AUTO_ACCEPT_MIN_AHEAD_MS = 48 * 3_600_000;
/** The seeded default of reschedule_min_ahead_minutes: a proposed time is at
 *  least this far ahead (the room opens 20 minutes before it). */
export const PROPOSE_MIN_AHEAD_MS = 60 * 60_000;
/** Structural (plan T5 Ruling 2): a guard derived from the two settings, not
 *  a policy. A proposal never locks later than this before its own time, so
 *  a large reschedule_autoaccept_hours setting shortens the wait instead of
 *  letting the lock fall after the time (review fix). With
 *  AUTO_ACCEPT_MIN_AHEAD_MS at 48 h the lock is always at least 24 h after
 *  the proposal. */
export const AUTO_ACCEPT_LOCK_BEFORE_MS = 24 * 3_600_000;
/** The seeded default of reschedule_reminder_hours: the reminder goes out this long before the lock ... */
export const REMINDER_BEFORE_MS = 24 * 3_600_000;
/** Structural (plan T5 Ruling 2): a guard derived from the two settings, not
 *  a policy. ... but only when that is at least this long after the
 *  proposal (else the arrival DM says it all). */
export const REMINDER_MIN_GAP_MS = 60 * 60_000;

const iso = (now?: Date): string => (now ?? new Date()).toISOString();

export function scheduleRules(db: DB): ScheduleRules {
  return {
    autoAcceptHours: settingNumber(db, 'reschedule_autoaccept_hours', 24, { min: 1, max: 72, integer: true }),
    leadMinutes: settingNumber(db, 'event_window_lead_minutes', 20, { min: 5, max: 60, integer: true }),
    minAheadMinutes: settingNumber(db, 'reschedule_min_ahead_minutes', PROPOSE_MIN_AHEAD_MS / 60_000, { min: 60, max: 1440, integer: true }),
    autoAcceptMinAheadHours: settingNumber(db, 'reschedule_autoaccept_min_ahead_hours', AUTO_ACCEPT_MIN_AHEAD_MS / 3_600_000, { min: 25, max: 168, integer: true }),
    reminderHours: settingNumber(db, 'reschedule_reminder_hours', REMINDER_BEFORE_MS / 3_600_000, { min: 1, max: 48, integer: true }),
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

/** When an unanswered proposal locks (Ruling 6): the setting's hours after
 *  it was made, but no later than AUTO_ACCEPT_LOCK_BEFORE_MS before its
 *  time; null when it needs an answer. roomOpensMs is when the room opens
 *  at the time the match carries now (its scheduled_at minus the lead), or
 *  null with no time set: a lock that would fall after it needs an answer
 *  instead, since the room opens at the old time first (final review). */
export function autoAcceptAt(createdMs: number, proposedMs: number, hours: number, roomOpensMs: number | null = null, minAheadMs: number = AUTO_ACCEPT_MIN_AHEAD_MS): string | null {
  if (proposedMs - createdMs < minAheadMs) return null;
  const lock = Math.min(createdMs + hours * 3_600_000, proposedMs - AUTO_ACCEPT_LOCK_BEFORE_MS);
  if (roomOpensMs !== null && lock > roomOpensMs) return null;
  return new Date(lock).toISOString();
}
/** When the reminder goes out, or null when the arrival DM carries the lock time already. */
export function reminderAt(createdMs: number, autoAcceptIso: string | null, beforeMs: number = REMINDER_BEFORE_MS): string | null {
  if (autoAcceptIso === null) return null;
  const t = Date.parse(autoAcceptIso) - beforeMs;
  return t >= createdMs + REMINDER_MIN_GAP_MS ? new Date(t).toISOString() : null;
}

/** The match, waiting in a live window stage with a window whose end has not passed, both teams in.
 *  Read-only: the room view (roomViews.ts) asks it too, so its buttons match what the writes accept. */
export function schedulable(db: DB, matchId: number, at: string): V.Checked<{ m: P.MatchRow; ev: E.EventRow }> {
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

/** The window still holds this time (staff may have moved it since the proposal). */
const inWindow = (m: P.MatchRow, t: string): boolean => m.window_start !== null && m.window_end !== null && t >= m.window_start && t <= m.window_end;

/** A proposed time: inside the window, at least the margin ahead, not the time already set (Ruling 7). */
function timeIn(m: P.MatchRow, raw: unknown, at: string, minAheadMs: number): string | null {
  const t = V.parseTime(raw);
  if (!t || t < m.window_start! || t > m.window_end! || t === m.scheduled_at) return null;
  return Date.parse(t) - Date.parse(at) >= minAheadMs ? t : null;
}

function insertProposal(db: DB, m: P.MatchRow, side: Side, by: string, time: string, note: string, at: string, rules: ScheduleRules): number {
  const opens = m.scheduled_at === null ? null : Date.parse(m.scheduled_at) - rules.leadMinutes * 60_000;
  const auto = autoAcceptAt(Date.parse(at), Date.parse(time), rules.autoAcceptHours, opens, rules.autoAcceptMinAheadHours !== undefined ? rules.autoAcceptMinAheadHours * 3_600_000 : AUTO_ACCEPT_MIN_AHEAD_MS);
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
    const time = timeIn(m, o.time, at, o.rules.minAheadMinutes !== undefined ? o.rules.minAheadMinutes * 60_000 : PROPOSE_MIN_AHEAD_MS);
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
    if (o.accept && (p.proposed_time <= at || !inWindow(m, p.proposed_time))) return V.fail('bad_time');
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
    const time = timeIn(m, o.time, at, o.rules.minAheadMinutes !== undefined ? o.rules.minAheadMinutes * 60_000 : PROPOSE_MIN_AHEAD_MS);
    // A counter at the open proposal's own time is an accept, not a counter (final review).
    if (!time || time === p.proposed_time) return V.fail('bad_time');
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

/** Ruling 10: staff set any future time on a waiting window-stage match; an
 *  open proposal expires with it. A match held from waiting (the window
 *  end's hold) takes a time too, and the same row releases the hold back to
 *  waiting (final review: staff's natural action on that hold). */
export function staffSetTime(db: DB, o: { matchId: number; by: string; time: unknown; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    const ev = E.getEvent(db, m.event_id)!;
    const stage = E.getStage(db, m.stage_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    const heldFromWaiting = m.status === 'admin_hold' && m.hold_from === 'waiting';
    if (stage.scheduling !== 'window' || (m.status !== 'waiting' && !heldFromWaiting) || m.entry_a === null || m.entry_b === null) return V.fail('not_schedulable');
    if (![m.entry_a, m.entry_b].every((id) => N.isActive(N.getEntry(db, id)!))) return V.fail('entry_out');
    const time = V.parseTime(o.time);
    if (!time || time <= at) return V.fail('bad_time');
    const p = openProposal(db, m.id);
    if (p) closeProposal(db, p.id, 'expired', o.by, at);
    if (heldFromWaiting) {
      db.prepare("UPDATE event_matches SET status = 'waiting', hold_reason = NULL, hold_from = NULL, deadline = NULL WHERE id = ?").run(m.id);
    }
    lockTime(db, m.id, time, 'staff');
    E.logEvent(db, ev.id, o.by, 'match_time_set', at, {
      matchId: m.id, time, was: m.scheduled_at, expired: p?.id ?? null, ...(heldFromWaiting ? { released: m.hold_reason } : {}),
    });
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

/** Ruling 6: still open, due, and the match still schedulable (event and
 *  stage live, both entries in, waiting in its window) with the proposed
 *  time ahead and inside the window; else 'changed' or schedulable's key. */
export function autoAccept(db: DB, o: { proposalId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const p = getProposal(db, o.proposalId);
    if (!p || p.status !== 'open' || p.auto_accept_at === null || p.auto_accept_at > at || p.proposed_time <= at) return V.fail('changed');
    const c = schedulable(db, p.event_match_id, at);
    if (!c.ok) return c;
    const { m } = c.value;
    if (!inWindow(m, p.proposed_time)) return V.fail('changed');
    closeProposal(db, p.id, 'auto_accepted', null, at);
    lockTime(db, m.id, p.proposed_time, 'agreed');
    E.logEvent(db, m.event_id, null, 'reschedule_auto_accepted', at, { matchId: m.id, proposalId: p.id, side: p.side, time: p.proposed_time });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

export function remindersDue(db: DB, now: Date): RescheduleRow[] {
  // A lock already due goes out on its own: no reminder after downtime (final review).
  const at = now.toISOString();
  const hours = scheduleRules(db).reminderHours;
  const before = hours !== undefined ? hours * 3_600_000 : REMINDER_BEFORE_MS;
  const rows = db.prepare(`${OPEN_SQL} AND r.reminded_at IS NULL AND r.auto_accept_at IS NOT NULL AND r.auto_accept_at > ? ORDER BY r.id`).all(at) as RescheduleRow[];
  return rows.filter((r) => { const t = reminderAt(Date.parse(r.created_at), r.auto_accept_at, before); return t !== null && t <= at; });
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

export function expireProposal(db: DB, o: { proposalId: number; reason: 'time_passed' | 'window_ended' | 'room_opened'; now?: Date }): V.Checked<RescheduleRow> {
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

/** Window-stage matches still waiting past their window's end (Ruling 8),
 *  both teams known. A staff time, or any time set past the window end, is
 *  a time the match keeps: the clock opens its room then, never forfeits it. */
export function expiredWindows(db: DB, now: Date): P.MatchRow[] {
  return db.prepare(
    `SELECT m.* FROM event_matches m JOIN event_stages s ON s.id = m.stage_id
     WHERE ${ROOM_LIVE_SQL} AND s.scheduling = 'window' AND m.status = 'waiting' AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL
       AND m.window_end IS NOT NULL AND m.window_end <= ?
       AND (m.schedule_source IS NULL OR m.schedule_source <> 'staff') AND (m.scheduled_at IS NULL OR m.scheduled_at <= m.window_end)
     ORDER BY m.id`,
  ).all(now.toISOString()) as P.MatchRow[];
}

/** Ruling 8: the side that made no proposal and answered none while the
 *  other side made at least one; null when both acted or neither did, and
 *  null once a time was locked (a proposal accepted or auto-accepted, or the
 *  match carries an agreed or staff time): a locked time is never forfeited.
 *  An accept, a decline or a counter is an answer by the side opposite the
 *  proposal (taken from the proposal, not from who manages the team now); a
 *  withdrawal is the proposer's own act; a staff expiry marks nobody. */
export function silentSide(db: DB, m: P.MatchRow): Side | null {
  if (m.schedule_source === 'agreed' || m.schedule_source === 'staff') return null;
  const acted = { a: false, b: false };
  const proposed = { a: false, b: false };
  for (const p of proposalsOf(db, m.id)) {
    if (p.status === 'accepted' || p.status === 'auto_accepted') return null;
    proposed[p.side] = true;
    acted[p.side] = true;
    if (p.status === 'declined' || p.status === 'countered') acted[other(p.side)] = true;
  }
  if (acted.a === acted.b) return null;
  const silent: Side = acted.a ? 'b' : 'a';
  return proposed[other(silent)] ? silent : null;
}
