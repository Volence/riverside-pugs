import { describe, it, expect } from 'vitest';
import * as P from '../src/events/play.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { createBracket, bracketMatches } from '../src/events/bracket.js';
import { repeatedRoundRobin } from '../src/events/league.js';
import { ADMIN, NOW } from './eventFixture.js';
import { LEAGUE, SE, SWISS, playFixture } from './playFixture.js';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const swissPlan = (stageId: number, entrants: number[]): P.StagePlan => ({
  stageId, entrants, bracket: null,
  rounds: [{ round: 1, pairs: [[entrants[0]!, entrants[2]!], [entrants[1]!, entrants[3]!]], bye: null }],
});
const aWins = { winner: 'a' as const, scoreA: 10, scoreB: 5, forfeit: false };

describe('play writer', () => {
  it('startEvent: live, stage 1 live with its entrants and round, one event_started row', () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    const ev = ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    expect(ev).toMatchObject({ status: 'live', live_at: NOW.toISOString() });
    const s = E.getStage(f.db, f.stages[0]!)!;
    expect(s).toMatchObject({ status: 'live', started_at: NOW.toISOString(), bracket_json: null });
    expect(P.stageEntrants(s)).toEqual(f.entries);
    expect(P.matchesOf(f.db, s.id).map((m) => [m.round, m.slot, m.entry_a, m.entry_b, m.status]))
      .toEqual([[1, 1, f.entries[0], f.entries[2], 'waiting'], [1, 2, f.entries[1], f.entries[3], 'waiting']]);
    expect(E.eventLog(f.db, f.eventId).at(-1)).toMatchObject({ action: 'event_started', actor: ADMIN });
  });

  it('startEvent refuses a list that is not final, fewer than 2 entries, or a plan for other entrants', () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    expect(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, [...f.entries].reverse()), now: NOW }))
      .toEqual({ ok: false, error: 'changed' });
    f.db.prepare('UPDATE events SET locked_at = NULL WHERE id = ?').run(f.eventId);
    expect(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }))
      .toEqual({ ok: false, error: 'list_not_final' });
    const g = playFixture({ stages: [SE()], entries: 1 });
    expect(P.startEvent(g.db, { eventId: g.eventId, by: ADMIN, plan: { stageId: g.stages[0]!, entrants: g.entries, bracket: null, rounds: [] }, now: NOW }))
      .toEqual({ ok: false, error: 'too_few_entries' });
  });

  it('startEvent with a bracket mirrors every non-bye bracket match as a row', async () => {
    const f = playFixture({ stages: [SE()], entries: 5 });
    const bracket = await createBracket('single_elim', { thirdPlace: false }, f.entries);
    ok(P.startEvent(f.db, { eventId: f.eventId, by: null, plan: { stageId: f.stages[0]!, entrants: f.entries, bracket, rounds: [] }, now: NOW }));
    const rows = P.matchesOf(f.db, f.stages[0]!);
    expect(rows).toHaveLength(bracketMatches(bracket).length);
    // Two matches are ready at creation: the real round-1 match (seed 4 v 5),
    // and the round-2 match pairing the two round-1 bye winners (seed 2 v 3),
    // whose entrants are already known even though round 1 is still open
    // (Task 4's documented bracketMatches behavior). Order follows matchesOf's
    // ORDER BY grp, round, slot.
    expect(rows.filter((m) => m.status === 'waiting').map((m) => [m.entry_a, m.entry_b]))
      .toEqual([[f.entries[3], f.entries[4]], [f.entries[1], f.entries[2]]]);
    expect(E.getStage(f.db, f.stages[0]!)!.bracket_rev).toBe(1);
  });

  it('recordResult on a table match: result, source admin, then a correction while no later round exists', () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    const [m1] = P.matchesOf(f.db, f.stages[0]!);
    expect(ok(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: aWins, bracket: null, now: NOW })))
      .toMatchObject({ status: 'done', winner_entry: m1!.entry_a, score_a: 10, score_b: 5, result_source: 'admin' });
    const fixed = ok(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: { winner: 'b', scoreA: null, scoreB: null, forfeit: true }, bracket: null, now: NOW }));
    expect(fixed).toMatchObject({ status: 'forfeit', winner_entry: m1!.entry_b, score_a: null, result_source: 'forfeit' });
    expect(JSON.parse(E.eventLog(f.db, f.eventId).at(-1)!.detail)).toMatchObject({ matchId: m1!.id, correction: true, forfeit: true });
  });

  it('recordResult refuses a correction once the next round exists, and a write on an older bracket', async () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    const [m1, m2] = P.matchesOf(f.db, f.stages[0]!);
    for (const m of [m1!, m2!]) ok(P.recordResult(f.db, { matchId: m.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    ok(P.addRound(f.db, { stageId: f.stages[0]!, round: { round: 2, pairs: [[m1!.entry_a!, m2!.entry_a!], [m1!.entry_b!, m2!.entry_b!]], bye: null }, now: NOW }));
    expect(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: aWins, bracket: null, now: NOW })).toEqual({ ok: false, error: 'result_locked' });

    const g = playFixture({ stages: [SE()], entries: 2 });
    const bracket = await createBracket('single_elim', { thirdPlace: false }, g.entries);
    ok(P.startEvent(g.db, { eventId: g.eventId, by: null, plan: { stageId: g.stages[0]!, entrants: g.entries, bracket, rounds: [] }, now: NOW }));
    const [only] = P.matchesOf(g.db, g.stages[0]!);
    expect(P.recordResult(g.db, { matchId: only!.id, by: ADMIN, result: aWins, bracket: { data: bracket, baseRev: 0 }, now: NOW }))
      .toEqual({ ok: false, error: 'changed' });
  });

  it('recordResult allows a round 1 correction in a round robin league even once later rounds exist (every round is written at the start)', () => {
    const f = playFixture({ stages: [LEAGUE(4, 1, 'round_robin', null)], entries: 4 });
    const pairings = repeatedRoundRobin(f.entries, 4);
    const rounds: P.NewRound[] = pairings.map((p, i) => ({ round: i + 1, pairs: p.pairs, bye: p.bye }));
    const plan: P.StagePlan = { stageId: f.stages[0]!, entrants: f.entries, bracket: null, rounds };
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan, now: NOW }));
    const [m1] = P.matchesOf(f.db, f.stages[0]!).filter((m) => m.round === 1);
    ok(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    const fixed = ok(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    expect(fixed.status).toBe('done');
    expect(JSON.parse(E.eventLog(f.db, f.eventId).at(-1)!.detail)).toMatchObject({ matchId: m1!.id, correction: true });
  });

  it('addRound refuses a round while one is open, a skipped number, or one past the last', () => {
    const f = playFixture({ stages: [SWISS(1, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    const round2 = { round: 2, pairs: [[f.entries[0]!, f.entries[1]!]] as [number, number][], bye: null };
    expect(P.addRound(f.db, { stageId: f.stages[0]!, round: round2, now: NOW })).toEqual({ ok: false, error: 'changed' });
    for (const m of P.matchesOf(f.db, f.stages[0]!)) ok(P.recordResult(f.db, { matchId: m.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    expect(P.addRound(f.db, { stageId: f.stages[0]!, round: { ...round2, round: 3 }, now: NOW })).toEqual({ ok: false, error: 'changed' });
    expect(P.addRound(f.db, { stageId: f.stages[0]!, round: round2, now: NOW })).toEqual({ ok: false, error: 'wrong_status' });
  });

  it('finishStage: losers eliminated with places below the advancers, next stage live; last stage places everyone and finishes the event', async () => {
    const f = playFixture({ stages: [SWISS(1, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    for (const m of P.matchesOf(f.db, f.stages[0]!)) ok(P.recordResult(f.db, { matchId: m.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    const [e1, e2, e3, e4] = f.entries as [number, number, number, number];
    const ranks = [e1, e2, e3, e4].map((entryId, i) => ({ entryId, rank: i + 1 }));
    const bracket = await createBracket('single_elim', { thirdPlace: false }, [e1, e2]);
    const next: P.StagePlan = { stageId: f.stages[1]!, entrants: [e1, e2], bracket, rounds: [] };
    expect(ok(P.finishStage(f.db, { stageId: f.stages[0]!, outcome: { ranks, advance: [e1, e2] }, next, now: NOW }))).toEqual({ eventFinished: false });
    expect(N.getEntry(f.db, e3)).toMatchObject({ status: 'eliminated', placement: 3 });
    expect(N.getEntry(f.db, e4)).toMatchObject({ status: 'eliminated', placement: 4 });
    expect(E.getStage(f.db, f.stages[0]!)!.status).toBe('finished');
    expect(E.getStage(f.db, f.stages[1]!)!.status).toBe('live');

    const [final] = P.matchesOf(f.db, f.stages[1]!);
    expect(P.finishStage(f.db, { stageId: f.stages[1]!, outcome: { ranks: [], advance: [] }, next: null, now: NOW })).toEqual({ ok: false, error: 'changed' });
    f.db.prepare("UPDATE event_matches SET status = 'done', winner_entry = ? WHERE id = ?").run(e1, final!.id);
    expect(ok(P.finishStage(f.db, { stageId: f.stages[1]!, outcome: { ranks: [{ entryId: e1, rank: 1 }, { entryId: e2, rank: 2 }], advance: [] }, next: null, now: NOW })))
      .toEqual({ eventFinished: true });
    expect(N.getEntry(f.db, e1)).toMatchObject({ status: 'placed', placement: 1 });
    expect(E.getEvent(f.db, f.eventId)).toMatchObject({ status: 'finished', finished_at: NOW.toISOString() });
  });

  it('activeSeeded lists active seeded entries in seed order, without disqualified ones', () => {
    const f = playFixture({ stages: [SE()], entries: 3 });
    f.db.prepare("UPDATE event_entries SET status = 'disqualified', seed = NULL WHERE id = ?").run(f.entries[1]);
    expect(P.activeSeeded(f.db, f.eventId)).toEqual([f.entries[0], f.entries[2]]);
  });

  it('startEvent re-checks the stage chain: elimination moved ahead of Swiss after registration is refused, and nothing is written', async () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    ok(E.reorderStages(f.db, { eventId: f.eventId, by: ADMIN, order: [f.stages[1], f.stages[0]], now: NOW }));
    const [first] = E.stagesOf(f.db, f.eventId);
    expect(E.stageSettingsOf(first!).type).toBe('single_elim');
    const snap = () => JSON.stringify(['events', 'event_stages', 'event_matches', 'event_log'].map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
    const before = snap();
    const bracket = await createBracket('single_elim', { thirdPlace: false }, f.entries);
    expect(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: { stageId: first!.id, entrants: f.entries, bracket, rounds: [] }, now: NOW }))
      .toEqual({ ok: false, error: 'elim_not_last' });
    expect(snap()).toBe(before);
  });

  it('startEvent refuses a draft-entry event', () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    f.db.prepare("UPDATE events SET entry_kind = 'draft' WHERE id = ?").run(f.eventId);
    expect(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }))
      .toEqual({ ok: false, error: 'wrong_status' });
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('checkin');
  });

  it('recordResult refuses a winner who is out while the other side is in, and lets staff pick either side when both are out', () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    ok(P.startEvent(f.db, { eventId: f.eventId, by: ADMIN, plan: swissPlan(f.stages[0]!, f.entries), now: NOW }));
    const [m1] = P.matchesOf(f.db, f.stages[0]!);
    ok(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: aWins, bracket: null, now: NOW }));
    ok(N.disqualifyEntry(f.db, { entryId: m1!.entry_b!, by: ADMIN, reason: 'left', now: NOW }));
    const logs = E.eventLog(f.db, f.eventId).length;
    const bWins = { winner: 'b' as const, scoreA: 5, scoreB: 10, forfeit: false };
    expect(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: bWins, bracket: null, now: NOW })).toEqual({ ok: false, error: 'winner_out' });
    expect(P.getMatch(f.db, m1!.id)!.winner_entry).toBe(m1!.entry_a);
    expect(E.eventLog(f.db, f.eventId)).toHaveLength(logs);
    ok(N.disqualifyEntry(f.db, { entryId: m1!.entry_a!, by: ADMIN, reason: 'left', now: NOW }));
    expect(ok(P.recordResult(f.db, { matchId: m1!.id, by: ADMIN, result: bWins, bracket: null, now: NOW })).winner_entry).toBe(m1!.entry_b);
  });
});
