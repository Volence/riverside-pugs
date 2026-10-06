import type { DB } from '../db.js';
import { bracketMatches, type BracketData } from './bracket.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as V from './validate.js';
import { weekWindow } from './league.js';

/**
 * Every write to event_matches, and the moves of an event and its stages
 * once play starts (tournaments plan T2). Same shape as events.ts and
 * entries.ts: each mutation is one synchronous transaction that re-reads,
 * checks, writes and adds exactly one event_log row; a refusal writes
 * nothing (tests/eventLogGuard.test.ts). The async work (brackets-manager,
 * pairing) happens before, in src/events/flow.ts, which passes its output in
 * here. Anything that may have moved since is checked again inside the
 * transaction and refused as 'changed', and a bracket write carries the
 * revision it was built on.
 */

export type MatchStatus = 'pending' | 'waiting' | 'veto' | 'lineup' | 'booking' | 'connect' | 'live' | 'confirming' | 'done' | 'forfeit' | 'bye' | 'admin_hold';
export interface MatchRow {
  id: number; event_id: number; stage_id: number; grp: number; round: number; slot: number; bm_match_id: number | null;
  entry_a: number | null; entry_b: number | null; status: MatchStatus; best_of: number; not_before: string | null;
  scheduled_at: string | null; window_start: string | null; window_end: string | null; booking_id: number | null;
  winner_entry: number | null; score_a: number | null; score_b: number | null; result_source: 'auto' | 'admin' | 'forfeit' | null;
  created_at: string; finished_at: string | null;
  room_opened_at: string | null; room_higher: 'a' | 'b' | null; room_seed: number | null; ready_a_at: string | null;
  ready_b_at: string | null; deadline: string | null; hold_reason: string | null;
  booked_at: string | null; server_alerted_at: string | null; confirm_a_at: string | null; confirm_b_at: string | null;
  dispute_side: 'a' | 'b' | null; dispute_by: string | null; dispute_reason: string | null; disputed_at: string | null;
  /** Plan T3c: the status a hold came from, and the staff freeze mirrored from the box. */
  hold_from: MatchStatus | null; admin_pause_at: string | null; admin_pause_by: string | null;
  /** Plan T4: where scheduled_at came from (the round default, an agreed proposal, staff); null with no time. */
  schedule_source: 'default' | 'agreed' | 'staff' | null;
}
export interface NewRound { round: number; pairs: [number, number][]; bye: number | null }
export interface StagePlan { stageId: number; entrants: number[]; bracket: BracketData | null; rounds: NewRound[] }
export interface StageOutcome { ranks: { entryId: number; rank: number }[]; advance: number[] }

export const RESOLVED: ReadonlySet<MatchStatus> = new Set<MatchStatus>(['done', 'forfeit', 'bye']);
/** States of a match whose room is open (plan T3a; T3b uses connect, live
 *  and confirming). A result may be entered from any of them. */
export const ROOM_OPEN: ReadonlySet<MatchStatus> = new Set<MatchStatus>(['veto', 'lineup', 'booking', 'connect', 'live', 'confirming', 'admin_hold']);

const iso = (now?: Date): string => (now ?? new Date()).toISOString();
const sameList = (x: number[], y: number[]): boolean => x.length === y.length && x.every((v, i) => v === y[i]);

export function getMatch(db: DB, id: number): MatchRow | undefined {
  return db.prepare('SELECT * FROM event_matches WHERE id = ?').get(id) as MatchRow | undefined;
}
export function matchesOf(db: DB, stageId: number): MatchRow[] {
  return db.prepare('SELECT * FROM event_matches WHERE stage_id = ? ORDER BY grp, round, slot').all(stageId) as MatchRow[];
}
export function stageEntrants(stage: E.StageRow): number[] {
  return stage.entrants_json ? JSON.parse(stage.entrants_json) as number[] : [];
}
export function stageBracket(stage: E.StageRow): BracketData | null {
  return stage.bracket_json ? JSON.parse(stage.bracket_json) as BracketData : null;
}
/** Entries still in the event that have a seed, best seed first. */
export function activeSeeded(db: DB, eventId: number): number[] {
  return N.entriesOf(db, eventId).filter((e) => N.isActive(e) && e.seed !== null)
    .sort((a, b) => a.seed! - b.seed!).map((e) => e.id);
}
/** Rounds a paired-as-it-goes stage plays; null for bracket stages and
 *  round robin leagues, whose matches all exist from the start. */
export function totalRounds(stage: E.StageRow): number | null {
  const s = E.stageSettingsOf(stage);
  if (s.type === 'swiss') return (s.config as V.StageConfigs['swiss']).rounds;
  if (s.type === 'league') {
    const c = s.config as V.StageConfigs['league'];
    return c.pairing === 'swiss' ? c.matches : null;
  }
  return null;
}

/** What a round's matches are stamped with (plan T4 Ruling 2): the stage's
 *  schedule row; else, for a league, its week as the window with no
 *  default time (Ruling 4); else nothing. fallbackStart is the day week 1
 *  starts when the league has no season start and the stage no started_at
 *  yet (openStage writes started_at before it inserts rounds). */
export function roundTimes(stage: E.StageRow, round: number, fallbackStart: string): { at: string | null; from: string | null; to: string | null } {
  const row = E.scheduleOf(stage).find((r) => r.round === round);
  if (row) return { at: row.at, from: row.from, to: row.to };
  const s = E.stageSettingsOf(stage);
  if (s.type !== 'league') return { at: null, from: null, to: null };
  const c = s.config as V.StageConfigs['league'];
  const w = weekWindow(c.seasonStart ?? (stage.started_at ?? fallbackStart).slice(0, 10), round, c.matchesPerWeek);
  return { at: null, from: w.from, to: w.to };
}

interface Stamp { not_before: string | null; scheduled_at: string | null; source: 'default' | null; from: string | null; to: string | null }

const NO_STAMP: Stamp = { not_before: null, scheduled_at: null, source: null, from: null, to: null };

/** A window stage's match carries the default time and the window; a
 *  rolling stage's match carries the date as not_before (Ruling 3). A bye
 *  or a row written already resolved is never played, so it gets NO_STAMP. */
function stampOf(db: DB, stageId: number, round: number, at: string): Stamp {
  const stage = E.getStage(db, stageId)!;
  const t = roundTimes(stage, round, at);
  return stage.scheduling === 'window'
    ? { not_before: null, scheduled_at: t.at, source: t.at !== null ? 'default' : null, from: t.from, to: t.to }
    : { not_before: t.at, scheduled_at: null, source: null, from: null, to: null };
}

function insertRound(db: DB, eventId: number, stageId: number, r: NewRound, at: string): void {
  const ins = db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, winner_entry, created_at, finished_at,
       not_before, scheduled_at, schedule_source, window_start, window_end)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const s = stampOf(db, stageId, r.round, at);
  r.pairs.forEach(([a, b], i) => ins.run(eventId, stageId, r.round, i + 1, a, b, 'waiting', null, at, null, s.not_before, s.scheduled_at, s.source, s.from, s.to));
  if (r.bye !== null) ins.run(eventId, stageId, r.round, r.pairs.length + 1, r.bye, null, 'bye', r.bye, at, at, null, null, null, null, null);
}

/** Brings the stage's rows in line with its bracket: inserts new matches,
 *  updates teams, states and results, and deletes rows of matches that are no
 *  longer played and have no result (a grand final reset that turned out not
 *  to be needed after a correction). result_source is set by recordResult for
 *  the match it reports; a row whose result the bracket dropped loses it. */
function syncBracket(db: DB, eventId: number, stageId: number, data: BracketData, at: string): void {
  const rows = new Map(matchesOf(db, stageId).filter((m) => m.bm_match_id !== null).map((m) => [m.bm_match_id!, m]));
  const ins = db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, bm_match_id, entry_a, entry_b, status, winner_entry, score_a, score_b, created_at, finished_at,
       not_before, scheduled_at, schedule_source, window_start, window_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upd = db.prepare(
    `UPDATE event_matches SET entry_a = ?, entry_b = ?, status = ?, winner_entry = ?, score_a = ?, score_b = ?,
       result_source = ?, finished_at = ? WHERE id = ?`,
  );
  const seen = new Set<number>();
  for (const b of bracketMatches(data)) {
    seen.add(b.bmId);
    const status: MatchStatus = b.state === 'done' ? (b.forfeit ? 'forfeit' : 'done') : b.state === 'ready' ? 'waiting' : 'pending';
    const resolved = b.state === 'done';
    const row = rows.get(b.bmId);
    if (!row) {
      const s = resolved ? NO_STAMP : stampOf(db, stageId, b.round, at);
      ins.run(eventId, stageId, b.group, b.round, b.number, b.bmId, b.a, b.b, status, b.winner, b.scoreA, b.scoreB, at, resolved ? at : null,
        s.not_before, s.scheduled_at, s.source, s.from, s.to);
      continue;
    }
    // A match whose room is open keeps its room state while its bracket
    // match is still ready (plan T3a); recordResult refuses any change to
    // its teams (room_open_downstream) before this runs.
    const keep = ROOM_OPEN.has(row.status) && b.state === 'ready';
    upd.run(b.a, b.b, keep ? row.status : status, b.winner, b.scoreA, b.scoreB, resolved ? row.result_source : null, resolved ? row.finished_at ?? at : null, row.id);
  }
  const del = db.prepare('DELETE FROM event_matches WHERE id = ?');
  for (const [bmId, row] of rows) if (!seen.has(bmId) && !RESOLVED.has(row.status)) del.run(row.id);
}

function openStage(db: DB, eventId: number, plan: StagePlan, at: string): void {
  db.prepare(
    "UPDATE event_stages SET status = 'live', started_at = ?, entrants_json = ?, bracket_json = ?, bracket_rev = 1, updated_at = ? WHERE id = ?",
  ).run(at, JSON.stringify(plan.entrants), plan.bracket ? JSON.stringify(plan.bracket) : null, at, plan.stageId);
  if (plan.bracket) syncBracket(db, eventId, plan.stageId, plan.bracket, at);
  for (const r of plan.rounds) insertRound(db, eventId, plan.stageId, r, at);
}

/** Ruling 5: checkin or registration -> live, once the list is final, with
 *  the first stage built from the active seeded entries. by is null when the
 *  clock starts it. */
export function startEvent(db: DB, o: { eventId: number; by: string | null; plan: StagePlan; now?: Date }): V.Checked<E.EventRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<E.EventRow> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (ev.entry_kind !== 'team' || !V.nextStatusAllowed(ev.status, 'live')) return V.fail('wrong_status');
    if (ev.locked_at === null) return V.fail('list_not_final');
    // Stages can still be edited or reordered after registration opens, so
    // the chain checked at publish may no longer hold (final review fix 3).
    const chain = E.chainOf(db, ev);
    if (!chain.ok) return chain;
    const first = E.stagesOf(db, ev.id)[0];
    if (!first || first.status !== 'pending') return V.fail('wrong_status');
    const seeded = activeSeeded(db, ev.id);
    if (seeded.length < 2) return V.fail('too_few_entries');
    if (o.plan.stageId !== first.id || !sameList(o.plan.entrants, seeded)) return V.fail('changed');
    db.prepare("UPDATE events SET status = 'live', live_at = ?, updated_at = ? WHERE id = ?").run(at, at, ev.id);
    openStage(db, ev.id, o.plan, at);
    E.logEvent(db, ev.id, o.by, 'event_started', at, { stageId: first.id, entries: seeded.length });
    return V.ok(E.getEvent(db, ev.id)!);
  })();
}

function laterRound(db: DB, stageId: number, round: number): boolean {
  return !!db.prepare('SELECT 1 FROM event_matches WHERE stage_id = ? AND round > ? LIMIT 1').get(stageId, round);
}

/** A result or a correction (Rulings 1 and 8). A correction to a table match
 *  (no bracket) is locked once a later round exists, but only for a stage
 *  that pairs as it goes (Swiss, or a league with Swiss pairing;
 *  totalRounds returns a round count there). A round robin league writes
 *  every round at the start instead, so a later round's row existing never
 *  means anything there depends on this one's result, and the lock does not
 *  apply. For a bracket match, bracket is the stage's bracket after the
 *  library took the result, built on baseRev. by null is the engine (a
 *  disqualification forfeit, Ruling 9). */
export function recordResult(
  db: DB, o: {
    matchId: number; by: string | null; result: V.ResultInput; bracket: { data: BracketData; baseRev: number } | null; now?: Date;
    /** 'auto' is the series engine's result (plan T3b); a forfeit is always 'forfeit'. */
    source?: 'auto' | 'admin';
  },
): V.Checked<MatchRow> {
  const at = iso(o.now);
  const source = o.result.forfeit ? 'forfeit' : o.source ?? 'admin';
  return db.transaction((): V.Checked<MatchRow> => {
    const m = getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    const stage = E.getStage(db, m.stage_id)!;
    const ev = E.getEvent(db, m.event_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    // A first result comes from waiting or from any open room state (plan
    // T3a: staff may enter one at any point of the room).
    const first = m.status === 'waiting' || ROOM_OPEN.has(m.status);
    if (m.entry_a === null || m.entry_b === null || !(first || m.status === 'done' || m.status === 'forfeit')) return V.fail('match_not_open');
    if ((m.bm_match_id === null) !== (o.bracket === null)) return V.fail('bad_request');
    const correction = !first;
    if (correction && m.bm_match_id === null && totalRounds(stage) !== null && laterRound(db, stage.id, m.round)) return V.fail('result_locked');
    const winner = o.result.winner === 'a' ? m.entry_a : m.entry_b;
    // A dropped or disqualified team never beats one still in, even by a
    // correction; with both sides out, staff may resolve it either way (Ruling 9).
    const loser = winner === m.entry_a ? m.entry_b : m.entry_a;
    const isOut = (id: number) => !N.isActive(N.getEntry(db, id)!);
    if (isOut(winner) && !isOut(loser)) return V.fail('winner_out');
    if (o.bracket) {
      if (stage.bracket_rev !== o.bracket.baseRev) return V.fail('changed');
      // Ruling 14: never change the teams of a match whose room is open.
      const byBm = new Map(bracketMatches(o.bracket.data).map((b) => [b.bmId, b]));
      for (const row of matchesOf(db, stage.id)) {
        if (row.id === m.id || !ROOM_OPEN.has(row.status) || row.bm_match_id === null) continue;
        const b = byBm.get(row.bm_match_id);
        if (!b || b.a !== row.entry_a || b.b !== row.entry_b) return V.fail('room_open_downstream');
      }
      db.prepare('UPDATE event_stages SET bracket_json = ?, bracket_rev = bracket_rev + 1, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(o.bracket.data), at, stage.id);
      syncBracket(db, ev.id, stage.id, o.bracket.data, at);
      if (getMatch(db, m.id)?.winner_entry !== winner) throw new Error(`bracket disagrees with the result of event match ${m.id}`);
    }
    db.prepare(
      'UPDATE event_matches SET status = ?, winner_entry = ?, score_a = ?, score_b = ?, result_source = ?, finished_at = ?, deadline = NULL WHERE id = ?',
    ).run(o.result.forfeit ? 'forfeit' : 'done', winner, o.result.scoreA, o.result.scoreB, source, at, m.id);
    E.logEvent(db, ev.id, o.by, 'result_recorded', at, {
      matchId: m.id, winner, scoreA: o.result.scoreA, scoreB: o.result.scoreB, forfeit: o.result.forfeit, correction, source,
    });
    return V.ok(getMatch(db, m.id)!);
  })();
}

/** The next Swiss or Swiss-paired league round (Ruling 6), once every match
 *  of the stage has a result. Refused with no pairs and no bye (fewer than 2
 *  entrants left to pair), so an empty round is never written; the caller
 *  ends the stage instead. Always the engine. */
export function addRound(db: DB, o: { stageId: number; round: NewRound; now?: Date }): V.Checked<null> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<null> => {
    const stage = E.getStage(db, o.stageId);
    if (!stage) return V.fail('stage_not_found');
    const ev = E.getEvent(db, stage.event_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    const ms = matchesOf(db, stage.id);
    const last = Math.max(0, ...ms.map((m) => m.round));
    if (o.round.round !== last + 1 || ms.some((m) => !RESOLVED.has(m.status))) return V.fail('changed');
    const total = totalRounds(stage);
    if (total === null || o.round.round > total) return V.fail('wrong_status');
    if (o.round.pairs.length === 0 && o.round.bye === null) return V.fail('changed');
    insertRound(db, ev.id, stage.id, o.round, at);
    E.logEvent(db, ev.id, null, 'round_paired', at, { stageId: stage.id, round: o.round.round, pairs: o.round.pairs.length, bye: o.round.bye });
    return V.ok(null);
  })();
}

/** Ends a stage whose every match has a result (Rulings 13 and 14). With a
 *  next plan, entrants not advancing become eliminated, placed below the
 *  advancers in rank order, and the next stage goes live. Without one, the
 *  ranked entrants are placed and the event finishes. Disqualified entries
 *  are never touched. Always the engine. */
export function finishStage(db: DB, o: { stageId: number; outcome: StageOutcome; next: StagePlan | null; now?: Date }): V.Checked<{ eventFinished: boolean }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ eventFinished: boolean }> => {
    const stage = E.getStage(db, o.stageId);
    if (!stage) return V.fail('stage_not_found');
    const ev = E.getEvent(db, stage.event_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    const ms = matchesOf(db, stage.id);
    if (ms.length === 0 || ms.some((m) => !RESOLVED.has(m.status))) return V.fail('changed');
    if (o.next) {
      const nextStage = E.getStage(db, o.next.stageId);
      if (!nextStage || nextStage.event_id !== ev.id || nextStage.ordinal !== stage.ordinal + 1 || nextStage.status !== 'pending'
        || !sameList(o.next.entrants, o.outcome.advance)) {
        return V.fail('changed');
      }
    }
    db.prepare("UPDATE event_stages SET status = 'finished', finished_at = ?, updated_at = ? WHERE id = ?").run(at, at, stage.id);
    const place = db.prepare("UPDATE event_entries SET status = ?, placement = ? WHERE id = ? AND status NOT IN ('dropped', 'disqualified')");
    const ranks = [...o.outcome.ranks].sort((x, y) => x.rank - y.rank);
    if (o.next) {
      const going = new Set(o.outcome.advance);
      let n = o.outcome.advance.length;
      for (const r of ranks) if (!going.has(r.entryId)) place.run('eliminated', ++n, r.entryId);
      openStage(db, ev.id, o.next, at);
    } else {
      for (const r of ranks) place.run('placed', r.rank, r.entryId);
      db.prepare("UPDATE events SET status = 'finished', finished_at = ?, updated_at = ? WHERE id = ?").run(at, at, ev.id);
    }
    E.logEvent(db, ev.id, null, 'stage_finished', at, { stageId: stage.id, advance: o.outcome.advance, eventFinished: !o.next });
    return V.ok({ eventFinished: !o.next });
  })();
}

/** Plan T4 Ruling 2: the stage's schedule, stamped again onto every match
 *  that has not started (pending or waiting). The window and not_before
 *  are the organizer's and always follow the schedule; a time a captain
 *  agreed or staff set (schedule_source agreed or staff) is kept, and a
 *  match whose room is open is not touched. by is null when the engine
 *  calls it. */
export function applySchedule(db: DB, o: { stageId: number; by: string | null; now?: Date }): V.Checked<{ stamped: number }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ stamped: number }> => {
    const stage = E.getStage(db, o.stageId);
    if (!stage) return V.fail('stage_not_found');
    if (E.SCHEDULE_LOCKED.has(E.getEvent(db, stage.event_id)!.status) || stage.status === 'finished') return V.fail('schedule_locked');
    const upd = db.prepare(
      `UPDATE event_matches SET not_before = ?, window_start = ?, window_end = ?,
         scheduled_at = CASE WHEN schedule_source IN ('agreed', 'staff') THEN scheduled_at ELSE ? END,
         schedule_source = CASE WHEN schedule_source IN ('agreed', 'staff') THEN schedule_source ELSE ? END
       WHERE id = ?`,
    );
    let stamped = 0;
    for (const m of matchesOf(db, stage.id)) {
      if (m.status !== 'pending' && m.status !== 'waiting') continue;
      const s = stampOf(db, stage.id, m.round, at);
      upd.run(s.not_before, s.from, s.to, s.scheduled_at, s.source, m.id);
      stamped++;
    }
    E.logEvent(db, stage.event_id, o.by, 'schedule_applied', at, { stageId: stage.id, stamped });
    return V.ok({ stamped });
  })();
}
