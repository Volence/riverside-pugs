import type { DB } from '../db.js';
import { BracketError, bracketComplete, bracketGroups, bracketMatches, bracketRanks, createBracket, reportResult, type BracketData, type BracketType } from './bracket.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import { repeatedRoundRobin } from './league.js';
import { standings, type StandingRow, type TableResult } from './standings.js';
import { pairSwiss } from './swiss.js';
import * as V from './validate.js';

/**
 * Runs an event once it plays (tournaments plan T2). Every call that changes
 * an event goes through serialize, so one event's starts, results and
 * settles never interleave; different events run side by side. The async
 * steps (brackets-manager, pairing) run here, and src/events/play.ts writes
 * their output in one transaction. settleEvent moves an event as far as it
 * can: forfeits for disqualified teams (Ruling 9), the end of a stage and the
 * start of the next (Rulings 6, 13, 14), the next Swiss round. Each step is
 * one play.ts mutation, and settle stops when a pass changes nothing, so
 * calling it again is harmless.
 */

const chains = new Map<number, Promise<unknown>>();

export function serialize<T>(eventId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(eventId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(eventId, tail);
  void tail.then(() => { if (chains.get(eventId) === tail) chains.delete(eventId); });
  return run;
}

const isBracket = (t: V.StageType): t is BracketType => t === 'single_elim' || t === 'double_elim' || t === 'round_robin';
const OUT: ReadonlySet<string> = new Set(['dropped', 'disqualified']);

function outOf(db: DB, ids: number[]): Set<number> {
  return new Set(ids.filter((id) => OUT.has(N.getEntry(db, id)?.status ?? 'dropped')));
}
const toResult = (m: P.MatchRow): TableResult => ({
  a: m.entry_a!, b: m.status === 'bye' ? null : m.entry_b, winner: m.winner_entry!, scoreA: m.score_a, scoreB: m.score_b,
});

/** The first matches of a stage for these entrants (best seed first). */
export async function planStage(stage: E.StageRow, entrants: number[]): Promise<V.Checked<P.StagePlan>> {
  if (entrants.length < 2) return V.fail('too_few_entries');
  const s = E.stageSettingsOf(stage);
  if (isBracket(s.type)) {
    return V.ok({ stageId: stage.id, entrants, bracket: await createBracket(s.type, s.config as V.StageConfigs[BracketType], entrants), rounds: [] });
  }
  if (s.type === 'league' && (s.config as V.StageConfigs['league']).pairing === 'round_robin') {
    const rounds = repeatedRoundRobin(entrants, (s.config as V.StageConfigs['league']).matches);
    return V.ok({ stageId: stage.id, entrants, bracket: null, rounds: rounds.map((r, i) => ({ round: i + 1, ...r })) });
  }
  const seeds = entrants.map((id, i) => ({ id, seed: i + 1 }));
  return V.ok({ stageId: stage.id, entrants, bracket: null, rounds: [{ round: 1, ...pairSwiss(seeds, [], P.totalRounds(stage) ?? 1) }] });
}

export interface TableRow extends StandingRow { group: number; groupRank: number }

/** A table stage's standings: one table per round robin group, else one.
 *  With groups, the overall order is group place first, then wins, score
 *  difference and stage seed (Ruling 3); rank is that overall place. */
export function stageTable(db: DB, stage: E.StageRow): TableRow[] {
  const entrants = P.stageEntrants(stage);
  const out = outOf(db, entrants);
  const s = E.stageSettingsOf(stage);
  const kind = s.type === 'swiss' ? 'swiss' : s.type === 'league' ? 'league' : 'round_robin';
  const rounds = P.totalRounds(stage) ?? 0;
  const results = P.matchesOf(db, stage.id).filter((m) => P.RESOLVED.has(m.status) && m.winner_entry !== null).map(toResult);
  const seed = new Map(entrants.map((id, i) => [id, i + 1]));
  const bracket = P.stageBracket(stage);
  const groupOf = s.type === 'round_robin' && bracket ? bracketGroups(bracket) : new Map<number, number>();
  const groups = new Map<number, number[]>();
  for (const id of entrants) {
    const g = groupOf.get(id) ?? 1;
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const rows: TableRow[] = [];
  for (const [g, ids] of [...groups].sort((x, y) => x[0] - y[0])) {
    const inGroup = new Set(ids);
    const table = standings(kind, ids.map((id) => ({ id, seed: seed.get(id)!, out: out.has(id) })), results.filter((r) => inGroup.has(r.a)), { rounds });
    for (const r of table) rows.push({ ...r, group: g, groupRank: r.rank });
  }
  if (groups.size <= 1) return rows;
  return rows
    .sort((x, y) => Number(x.out) - Number(y.out) || x.groupRank - y.groupRank || y.wins - x.wins || y.scoreDiff - x.scoreDiff
      || seed.get(x.entryId)! - seed.get(y.entryId)!)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Who placed where in a finished stage and who carries over. Disqualified
 *  entries are left out of both. */
export async function stageOutcome(db: DB, stage: E.StageRow): Promise<P.StageOutcome> {
  const entrants = P.stageEntrants(stage);
  const out = outOf(db, entrants);
  const type = E.stageSettingsOf(stage).type;
  if (type === 'single_elim' || type === 'double_elim') {
    // brackets-manager ranks densely (an SE of 8 is 1,2,3,3,4,4,4,4); places
    // are standard competition ranks (1,2,3,3,5,5,5,5), counted over the
    // teams still in, so a disqualified finalist leaves 1, 2, ... behind.
    const lib = (await bracketRanks(P.stageBracket(stage)!)).filter((r) => !out.has(r.entryId));
    const ranks = lib.map((r) => ({ entryId: r.entryId, rank: 1 + lib.filter((x) => x.rank < r.rank).length }));
    return { ranks, advance: [] };
  }
  const ranked = stageTable(db, stage).filter((r) => !r.out);
  const n = Math.min(stage.advance_count ?? 0, ranked.length);
  return { ranks: ranked.map((r, i) => ({ entryId: r.entryId, rank: i + 1 })), advance: ranked.slice(0, n).map((r) => r.entryId) };
}

function stageComplete(db: DB, stage: E.StageRow): boolean {
  const ms = P.matchesOf(db, stage.id);
  if (ms.length === 0 || ms.some((m) => !P.RESOLVED.has(m.status))) return false;
  const bracket = P.stageBracket(stage);
  if (bracket) return bracketComplete(bracket);
  // A table stage with fewer than 2 entrants still in is done: there is
  // nobody left to pair, whatever the round count says (Ruling 1, fix
  // round 1). Without this, a Swiss or Swiss-paired league with 0 or 1
  // active entrants left either writes nothing (addRound now refuses an
  // empty round) or keeps pairing single-entrant bye rounds until the
  // configured round count, neither of which ends the stage.
  const entrants = P.stageEntrants(stage);
  if (entrants.filter((id) => !outOf(db, entrants).has(id)).length < 2) return true;
  const total = P.totalRounds(stage);
  return total === null || Math.max(...ms.map((m) => m.round)) >= total;
}

/** Inside serialize only. */
async function report(
  db: DB, m: P.MatchRow, by: string | null, result: V.ResultInput, now?: Date, source: 'auto' | 'admin' = 'admin',
): Promise<V.Checked<P.MatchRow>> {
  if (m.bm_match_id === null) return P.recordResult(db, { matchId: m.id, by, result, bracket: null, now, source });
  const stage = E.getStage(db, m.stage_id)!;
  if (stage.status !== 'live') return V.fail('not_live');
  const base = P.stageBracket(stage);
  if (!base) return V.fail('wrong_status');
  let data;
  try {
    data = await reportResult(base, m.bm_match_id, result);
  } catch (err) {
    if (err instanceof BracketError) return V.fail(err.code === 'locked' ? 'result_locked' : 'match_not_open');
    throw err;
  }
  const moved = movedRooms(db, stage, m.id, data);
  const record = () => P.recordResult(db, { matchId: m.id, by, result, bracket: { data, baseRev: stage.bracket_rev }, now, source });
  if (moved.length === 0 || moved.some((row) => R.vetoActions(db, row.id).length > 0 || R.lineupsOf(db, row.id).length > 0)) return record();
  // Every room the new bracket would change is still in its ready check:
  // reset each (the clock reopens it with the corrected teams) and record,
  // all in one transaction so a refused result leaves the rooms as they were
  // (final review ruling, option a).
  const refused = Symbol('refused');
  try {
    return db.transaction((): V.Checked<P.MatchRow> => {
      for (const row of moved) {
        const r = R.resetRoom(db, { matchId: row.id, by, now });
        if (!r.ok) throw Object.assign(new Error(r.error), { [refused]: r });
      }
      const r = record();
      if (!r.ok) throw Object.assign(new Error(r.error), { [refused]: r });
      return r;
    })();
  } catch (err) {
    const r = (err as Record<symbol, unknown> | null)?.[refused];
    if (r) return r as V.Checked<P.MatchRow>;
    throw err;
  }
}

/** The other matches of the stage in a room state whose teams this bracket
 *  data would change (P.recordResult refuses those as room_open_downstream). */
function movedRooms(db: DB, stage: E.StageRow, matchId: number, data: BracketData): P.MatchRow[] {
  const byBm = new Map(bracketMatches(data).map((b) => [b.bmId, b]));
  return P.matchesOf(db, stage.id).filter((row) => {
    if (row.id === matchId || !P.ROOM_OPEN.has(row.status) || row.bm_match_id === null) return false;
    const b = byBm.get(row.bm_match_id);
    return !b || b.a !== row.entry_a || b.b !== row.entry_b;
  });
}

export function startEventFlow(db: DB, o: { eventId: number; by: string | null; now?: Date }): Promise<V.Checked<E.EventRow>> {
  return serialize(o.eventId, async (): Promise<V.Checked<E.EventRow>> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'live')) return V.fail('wrong_status');
    if (ev.locked_at === null) return V.fail('list_not_final');
    const first = E.stagesOf(db, ev.id)[0];
    if (!first) return V.fail('no_stages');
    const plan = await planStage(first, P.activeSeeded(db, ev.id));
    if (!plan.ok) return plan;
    return P.startEvent(db, { eventId: ev.id, by: o.by, plan: plan.value, now: o.now });
  });
}

export async function recordResultFlow(
  db: DB, o: { eventId: number; matchId: number; by: string; result: unknown; now?: Date },
): Promise<V.Checked<P.MatchRow>> {
  const parsed = V.parseResult(o.result);
  if (!parsed.ok) return parsed;
  const r = await serialize(o.eventId, async (): Promise<V.Checked<P.MatchRow>> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || m.event_id !== o.eventId) return V.fail('match_not_found');
    return report(db, m, o.by, parsed.value, o.now);
  });
  if (r.ok) {
    try {
      await settleEvent(db, { eventId: o.eventId, now: o.now });
    } catch (err) {
      // The result is already committed; a settle failure after it (bad
      // stage data, a library throw) must not turn a saved result into a
      // rejected call, which a route would answer with a 500 and a retry
      // would then read as a correction (Ruling 3, fix round 1).
      console.error(`[events] settle after a result of event ${o.eventId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return r;
}

/** A forfeit the room's clock decides (plan T3a Ruling 2). expect re-checks
 *  the match inside the event's chain, so an admin result or a reset that
 *  landed first is never overwritten (Ruling 12). Settles after, as a
 *  result does. */
export async function forfeitMatch(
  db: DB, o: { eventId: number; matchId: number; winner: 'a' | 'b'; expect: (m: P.MatchRow) => boolean; now?: Date },
): Promise<V.Checked<P.MatchRow>> {
  const r = await serialize(o.eventId, async (): Promise<V.Checked<P.MatchRow>> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || m.event_id !== o.eventId) return V.fail('match_not_found');
    if (!o.expect(m)) return V.fail('changed');
    return report(db, m, null, { winner: o.winner, scoreA: null, scoreB: null, forfeit: true }, o.now);
  });
  if (r.ok) {
    try {
      await settleEvent(db, { eventId: o.eventId, now: o.now });
    } catch (err) {
      console.error(`[events] settle after a forfeit in event ${o.eventId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return r;
}

/** The series engine's result (plan T3b Ruling 9): the clock recorded it, so
 *  by is null and result_source is 'auto' (or 'forfeit' for a Bo2 ended by
 *  a !gg). expect re-checks the match inside the event's chain (a dispute or
 *  an admin result that landed first wins), then the event settles as after
 *  any result. */
export async function autoResultFlow(
  db: DB, o: { eventId: number; matchId: number; result: V.ResultInput; expect: (m: P.MatchRow) => boolean; now?: Date },
): Promise<V.Checked<P.MatchRow>> {
  const r = await serialize(o.eventId, async (): Promise<V.Checked<P.MatchRow>> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || m.event_id !== o.eventId) return V.fail('match_not_found');
    if (!o.expect(m)) return V.fail('changed');
    return report(db, m, null, o.result, o.now, 'auto');
  });
  if (r.ok) {
    try {
      await settleEvent(db, { eventId: o.eventId, now: o.now });
    } catch (err) {
      console.error(`[events] settle after an automatic result in event ${o.eventId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return r;
}

export function settleEvent(db: DB, o: { eventId: number; now?: Date }): Promise<void> {
  return serialize(o.eventId, async () => {
    for (let i = 0; i < 100; i++) if (!(await settleOnce(db, o.eventId, o.now))) return;
    console.error(`[events] settle of event ${o.eventId} did not come to rest`);
  });
}

/** One step; true when it changed something. */
async function settleOnce(db: DB, eventId: number, now?: Date): Promise<boolean> {
  const ev = E.getEvent(db, eventId);
  if (!ev || ev.status !== 'live') return false;
  const stage = E.stagesOf(db, ev.id).find((s) => s.status === 'live');
  if (!stage) return false;
  const entrants = P.stageEntrants(stage);
  const out = outOf(db, entrants);

  // Forfeit every eligible waiting or room-open match in this pass (an open
  // room counts since plan T3a Ruling 15), not just the first
  // (Ruling 2, fix round 1): a round robin league of any size can have many
  // one-side-disqualified matches waiting at once, and settleEvent's own
  // retry cap is for the stage/round steps below, not a budget for how many
  // forfeits one call may make. Each match is re-read right before it is
  // reported, since an earlier forfeit in this same pass can have changed a
  // later one's row (a bracket forfeit can resolve or drop a row further
  // down the bracket).
  let forfeited = false;
  for (const snap of P.matchesOf(db, stage.id)) {
    if (!(snap.status === 'waiting' || P.ROOM_OPEN.has(snap.status)) || snap.entry_a === null || snap.entry_b === null) continue;
    const m = P.getMatch(db, snap.id);
    if (!m || !(m.status === 'waiting' || P.ROOM_OPEN.has(m.status)) || m.entry_a === null || m.entry_b === null) continue;
    const aOut = out.has(m.entry_a);
    if (aOut === out.has(m.entry_b)) continue;
    const r = await report(db, m, null, { winner: aOut ? 'b' : 'a', scoreA: null, scoreB: null, forfeit: true }, now);
    if (r.ok) forfeited = true;
    else console.error(`[events] disqualification forfeit of match ${m.id} refused: ${r.error}`);
  }
  if (forfeited) return true;

  if (stageComplete(db, stage)) {
    const outcome = await stageOutcome(db, stage);
    const nextStage = E.stagesOf(db, ev.id).find((s) => s.ordinal === stage.ordinal + 1);
    let next: P.StagePlan | null = null;
    if (nextStage && outcome.advance.length >= 2) {
      const plan = await planStage(nextStage, outcome.advance);
      if (!plan.ok) {
        console.error(`[events] event ${ev.id}: stage ${nextStage.ordinal} cannot start: ${plan.error}`);
        return false;
      }
      next = plan.value;
    }
    return P.finishStage(db, { stageId: stage.id, outcome, next, now }).ok;
  }

  const total = P.totalRounds(stage);
  const ms = P.matchesOf(db, stage.id);
  if (P.stageBracket(stage) === null && total !== null && ms.every((m) => P.RESOLVED.has(m.status))) {
    const last = Math.max(0, ...ms.map((m) => m.round));
    if (last < total) {
      const still = entrants.filter((id) => !out.has(id)).map((id) => ({ id, seed: entrants.indexOf(id) + 1 }));
      const results = ms.filter((m) => m.winner_entry !== null).map(toResult);
      return P.addRound(db, { stageId: stage.id, round: { round: last + 1, ...pairSwiss(still, results, total) }, now }).ok;
    }
  }
  return false;
}
