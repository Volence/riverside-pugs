import type { DB } from '../db.js';
import { BracketError, bracketComplete, bracketGroups, bracketRanks, createBracket, reportResult, type BracketType } from './bracket.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
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
    const ranks = (await bracketRanks(P.stageBracket(stage)!)).filter((r) => !out.has(r.entryId));
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
  const total = P.totalRounds(stage);
  return total === null || Math.max(...ms.map((m) => m.round)) >= total;
}

/** Inside serialize only. */
async function report(db: DB, m: P.MatchRow, by: string | null, result: V.ResultInput, now?: Date): Promise<V.Checked<P.MatchRow>> {
  if (m.bm_match_id === null) return P.recordResult(db, { matchId: m.id, by, result, bracket: null, now });
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
  return P.recordResult(db, { matchId: m.id, by, result, bracket: { data, baseRev: stage.bracket_rev }, now });
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
  if (r.ok) await settleEvent(db, { eventId: o.eventId, now: o.now });
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

  for (const m of P.matchesOf(db, stage.id)) {
    if (m.status !== 'waiting' || m.entry_a === null || m.entry_b === null) continue;
    const aOut = out.has(m.entry_a);
    if (aOut === out.has(m.entry_b)) continue;
    const r = await report(db, m, null, { winner: aOut ? 'b' : 'a', scoreA: null, scoreB: null, forfeit: true }, now);
    if (r.ok) return true;
  }

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
