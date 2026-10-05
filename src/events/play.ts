import type { DB } from '../db.js';
import { bracketMatches, type BracketData } from './bracket.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as V from './validate.js';

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
}
export interface NewRound { round: number; pairs: [number, number][]; bye: number | null }
export interface StagePlan { stageId: number; entrants: number[]; bracket: BracketData | null; rounds: NewRound[] }
export interface StageOutcome { ranks: { entryId: number; rank: number }[]; advance: number[] }

export const RESOLVED: ReadonlySet<MatchStatus> = new Set<MatchStatus>(['done', 'forfeit', 'bye']);

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

function insertRound(db: DB, eventId: number, stageId: number, r: NewRound, at: string): void {
  const ins = db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, winner_entry, created_at, finished_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  r.pairs.forEach(([a, b], i) => ins.run(eventId, stageId, r.round, i + 1, a, b, 'waiting', null, at, null));
  if (r.bye !== null) ins.run(eventId, stageId, r.round, r.pairs.length + 1, r.bye, null, 'bye', r.bye, at, at);
}

/** Brings the stage's rows in line with its bracket: inserts new matches,
 *  updates teams, states and results, and deletes rows of matches that are no
 *  longer played and have no result (a grand final reset that turned out not
 *  to be needed after a correction). result_source is set by recordResult for
 *  the match it reports; a row whose result the bracket dropped loses it. */
function syncBracket(db: DB, eventId: number, stageId: number, data: BracketData, at: string): void {
  const rows = new Map(matchesOf(db, stageId).filter((m) => m.bm_match_id !== null).map((m) => [m.bm_match_id!, m]));
  const ins = db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, bm_match_id, entry_a, entry_b, status, winner_entry, score_a, score_b, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ins.run(eventId, stageId, b.group, b.round, b.number, b.bmId, b.a, b.b, status, b.winner, b.scoreA, b.scoreB, at, resolved ? at : null);
      continue;
    }
    upd.run(b.a, b.b, status, b.winner, b.scoreA, b.scoreB, resolved ? row.result_source : null, resolved ? row.finished_at ?? at : null, row.id);
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
    if (!V.nextStatusAllowed(ev.status, 'live')) return V.fail('wrong_status');
    if (ev.locked_at === null) return V.fail('list_not_final');
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
  db: DB, o: { matchId: number; by: string | null; result: V.ResultInput; bracket: { data: BracketData; baseRev: number } | null; now?: Date },
): V.Checked<MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<MatchRow> => {
    const m = getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    const stage = E.getStage(db, m.stage_id)!;
    const ev = E.getEvent(db, m.event_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    if (m.entry_a === null || m.entry_b === null || !(m.status === 'waiting' || m.status === 'done' || m.status === 'forfeit')) {
      return V.fail('match_not_open');
    }
    if ((m.bm_match_id === null) !== (o.bracket === null)) return V.fail('bad_request');
    const correction = m.status !== 'waiting';
    if (correction && m.bm_match_id === null && totalRounds(stage) !== null && laterRound(db, stage.id, m.round)) return V.fail('result_locked');
    const winner = o.result.winner === 'a' ? m.entry_a : m.entry_b;
    if (o.bracket) {
      if (stage.bracket_rev !== o.bracket.baseRev) return V.fail('changed');
      db.prepare('UPDATE event_stages SET bracket_json = ?, bracket_rev = bracket_rev + 1, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(o.bracket.data), at, stage.id);
      syncBracket(db, ev.id, stage.id, o.bracket.data, at);
      if (getMatch(db, m.id)?.winner_entry !== winner) throw new Error(`bracket disagrees with the result of event match ${m.id}`);
    }
    db.prepare(
      'UPDATE event_matches SET status = ?, winner_entry = ?, score_a = ?, score_b = ?, result_source = ?, finished_at = ? WHERE id = ?',
    ).run(o.result.forfeit ? 'forfeit' : 'done', winner, o.result.scoreA, o.result.scoreB, o.result.forfeit ? 'forfeit' : 'admin', at, m.id);
    E.logEvent(db, ev.id, o.by, 'result_recorded', at, {
      matchId: m.id, winner, scoreA: o.result.scoreA, scoreB: o.result.scoreB, forfeit: o.result.forfeit, correction,
    });
    return V.ok(getMatch(db, m.id)!);
  })();
}

/** The next Swiss or Swiss-paired league round (Ruling 6), once every match
 *  of the stage has a result. Always the engine. */
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
