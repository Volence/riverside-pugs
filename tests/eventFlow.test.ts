import { describe, it, expect, vi } from 'vitest';
import * as F from '../src/events/flow.js';
import * as P from '../src/events/play.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { ADMIN, NOW } from './eventFixture.js';
import { DE, LEAGUE, RR, SE, SWISS, playFixture, type PlayFixture } from './playFixture.js';
import * as R from '../src/events/room.js';
import { TIMERS, roomFixture } from './roomFixture.js';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const live = (f: PlayFixture) => E.stagesOf(f.db, f.eventId).find((s) => s.status === 'live');
const open = (f: PlayFixture) => { const s = live(f); return s ? P.matchesOf(f.db, s.id).filter((m) => m.status === 'waiting') : []; };
/** Reports every open match (the lower entry id wins unless `pick` says
 *  otherwise) until nothing is open or the event is over. */
async function playOut(f: PlayFixture, pick: (m: P.MatchRow) => 'a' | 'b' = (m) => (m.entry_a! < m.entry_b! ? 'a' : 'b')) {
  for (let i = 0; i < 200 && open(f).length > 0; i++) {
    const m = open(f)[0]!;
    const w = pick(m);
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW,
      result: { winner: w, scoreA: w === 'a' ? 10 : 5, scoreB: w === 'a' ? 5 : 10 } }));
  }
}

describe('event flow', () => {
  it('Swiss to single elimination: rounds pair themselves, the top 4 carry over, and the event finishes with places', async () => {
    const f = playFixture({ stages: [SWISS(3, 4), SE(true)], entries: 8 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    expect(open(f)).toHaveLength(4);
    await playOut(f);
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(ev.status).toBe('finished');
    const [s1, s2] = E.stagesOf(f.db, f.eventId);
    expect(Math.max(...P.matchesOf(f.db, s1!.id).map((m) => m.round))).toBe(3);
    expect(P.stageEntrants(s2!)).toHaveLength(4);
    const placed = N.entriesOf(f.db, f.eventId).map((e) => [e.status, e.placement]);
    expect(placed.filter(([s]) => s === 'placed').map(([, p]) => p).sort()).toEqual([1, 2, 3, 4]);
    expect(placed.filter(([s]) => s === 'eliminated').map(([, p]) => p).sort()).toEqual([5, 6, 7, 8]);
    // Seed 1 (lowest id) wins every match it plays.
    expect(N.getEntry(f.db, f.entries[0]!)!.placement).toBe(1);
  });

  it('double elimination where the lower side wins the first grand final plays the reset', async () => {
    const f = playFixture({ stages: [DE(true)], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    await playOut(f, (m) => (m.grp === 3 ? 'b' : m.entry_a! < m.entry_b! ? 'a' : 'b'));
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    expect(P.matchesOf(f.db, s.id).filter((m) => m.grp === 3).map((m) => m.round)).toEqual([1, 2]);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
  });

  it('round robin groups advance the top of each group, group winners seeded first', async () => {
    const f = playFixture({ stages: [RR(2, 4), SE()], entries: 8 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const s1 = E.stagesOf(f.db, f.eventId)[0]!;
    while (open(f).length > 0 && live(f)!.id === s1.id) {
      const m = open(f)[0]!;
      ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: m.entry_a! < m.entry_b! ? 'a' : 'b', forfeit: true } }));
    }
    const table = F.stageTable(f.db, E.getStage(f.db, s1.id)!);
    const s2 = E.stagesOf(f.db, f.eventId)[1]!;
    const carried = P.stageEntrants(s2);
    expect(carried).toHaveLength(4);
    const groupOf = new Map(table.map((r) => [r.entryId, r]));
    expect(carried.slice(0, 2).every((id) => groupOf.get(id)!.groupRank === 1)).toBe(true);
    expect(new Set(carried.slice(0, 2).map((id) => groupOf.get(id)!.group)).size).toBe(2);
  });

  it('a round robin league of 5 teams plays its full match count: every round written at the start, byes as wins, every team on 7 results', async () => {
    const f = playFixture({ stages: [LEAGUE(7, 2, 'round_robin', null)], entries: 5 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    expect(new Set(P.matchesOf(f.db, s.id).map((m) => m.round)).size).toBe(7);
    await playOut(f);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
    const table = F.stageTable(f.db, E.getStage(f.db, s.id)!);
    expect(table.every((r) => r.played + r.byes === 7)).toBe(true);
    expect(table.map((r) => r.byes).sort()).toEqual([1, 1, 1, 2, 2]);
  });

  it('a 4-team round robin league of 7 matches meets every pair twice and two pairs a third time', async () => {
    const f = playFixture({ stages: [LEAGUE(7, 1, 'round_robin', null)], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const ms = P.matchesOf(f.db, E.stagesOf(f.db, f.eventId)[0]!.id);
    expect(ms).toHaveLength(14);
    expect(ms.every((m) => m.status === 'waiting')).toBe(true);
  });

  it('a Swiss-paired league plays its match count in rounds', async () => {
    const f = playFixture({ stages: [LEAGUE(4, 2, 'swiss', null)], entries: 6 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    await playOut(f);
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    expect(Math.max(...P.matchesOf(f.db, s.id).map((m) => m.round))).toBe(4);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
  });

  it('a team disqualified mid-Swiss forfeits its open match, is never paired again, and gets no place', async () => {
    const f = playFixture({ stages: [SWISS(3, null)], entries: 6 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const out = f.entries[5]!;
    ok(N.disqualifyEntry(f.db, { entryId: out, by: ADMIN, reason: 'left', now: NOW }));
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    const theirs = P.matchesOf(f.db, s.id).find((m) => m.entry_a === out || m.entry_b === out)!;
    expect(theirs).toMatchObject({ status: 'forfeit', result_source: 'forfeit' });
    expect(theirs.winner_entry).not.toBe(out);
    expect(E.eventLog(f.db, f.eventId).find((l) => l.action === 'result_recorded')!.actor).toBeNull();
    await playOut(f);
    const later = P.matchesOf(f.db, s.id).filter((m) => m.round > 1);
    expect(later.some((m) => m.entry_a === out || m.entry_b === out)).toBe(false);
    expect(N.getEntry(f.db, out)).toMatchObject({ status: 'disqualified', placement: null });
    expect(F.stageTable(f.db, E.getStage(f.db, s.id)!).at(-1)!.entryId).toBe(out);
  });

  it('a correction after the next bracket match is played is refused and changes nothing', async () => {
    const g = playFixture({ stages: [SE()], entries: 8 });
    ok(await F.startEventFlow(g.db, { eventId: g.eventId, by: ADMIN, now: NOW }));
    const r1 = open(g);
    for (const m of r1.slice(0, 2)) ok(await F.recordResultFlow(g.db, { eventId: g.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }));
    const semi = open(g).find((m) => m.round === 2)!;
    ok(await F.recordResultFlow(g.db, { eventId: g.eventId, matchId: semi.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }));
    const snap = JSON.stringify([g.db.prepare('SELECT * FROM event_matches ORDER BY id').all(), g.db.prepare('SELECT bracket_json, bracket_rev FROM event_stages').all()]);
    expect(await F.recordResultFlow(g.db, { eventId: g.eventId, matchId: r1[0]!.id, by: ADMIN, now: NOW, result: { winner: 'b', scoreA: 1, scoreB: 2 } }))
      .toEqual({ ok: false, error: 'result_locked' });
    expect(JSON.stringify([g.db.prepare('SELECT * FROM event_matches ORDER BY id').all(), g.db.prepare('SELECT bracket_json, bracket_rev FROM event_stages').all()])).toBe(snap);
  });

  it('two results for one match at once: one lands, the other is a correction, the bracket takes exactly one revision each', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const m = open(f)[0]!;
    const rev = () => E.stagesOf(f.db, f.eventId)[0]!.bracket_rev;
    const before = rev();
    const [x, y] = await Promise.all([
      F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }),
      F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'b', scoreA: 1, scoreB: 2 } }),
    ]);
    expect(x.ok && y.ok).toBe(true);
    expect(rev()).toBe(before + 2);
    expect(P.getMatch(f.db, m.id)!.winner_entry).toBe(m.entry_b);
    const logs = E.eventLog(f.db, f.eventId).filter((l) => l.action === 'result_recorded').map((l) => JSON.parse(l.detail).correction);
    expect(logs).toEqual([false, true]);
  });

  it('a refused result writes nothing: bad body, unknown match, another event, a pending match', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const pending = P.matchesOf(f.db, E.stagesOf(f.db, f.eventId)[0]!.id).find((m) => m.status === 'pending')!;
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: open(f)[0]!.id, by: ADMIN, result: { winner: 'a', scoreA: 1, scoreB: 1 } }))
      .toEqual({ ok: false, error: 'bad_result' });
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: 99999, by: ADMIN, result: { winner: 'a', forfeit: true } }))
      .toEqual({ ok: false, error: 'match_not_found' });
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId + 1, matchId: open(f)[0]!.id, by: ADMIN, result: { winner: 'a', forfeit: true } }))
      .toEqual({ ok: false, error: 'match_not_found' });
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: pending.id, by: ADMIN, result: { winner: 'a', forfeit: true } }))
      .toEqual({ ok: false, error: 'match_not_open' });
  });

  it('settle is idempotent: a second call changes nothing', async () => {
    const f = playFixture({ stages: [SWISS(2, null)], entries: 5 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    // Seed 1 (entries[0]) is in round 1's first real match (seed 5 gets the
    // opening bye with 5 entrants), so disqualifying it gives settle a real
    // forfeit to make before the idempotence check below.
    ok(N.disqualifyEntry(f.db, { entryId: f.entries[0]!, by: ADMIN, reason: 'left', now: NOW }));
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    // The disqualification actually did work: it forfeited the entry's
    // open match before the snapshot below, so the second call below is a
    // real no-op, not a settle that never had anything to do.
    expect(E.eventLog(f.db, f.eventId).some((l) => l.action === 'result_recorded' && l.actor === null)).toBe(true);
    const snap = JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all());
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all())).toBe(snap);
  });

  it('a Swiss stage finishes once staff forfeit both round-1 matches of an all-disqualified field, instead of looping empty round-pairing', async () => {
    // The repro: with both sides of a match disqualified, settle's own
    // forfeit step never touches it (it only resolves a match with exactly
    // one side out), so it is staff who forfeit each match by hand.
    const f = playFixture({ stages: [SWISS(2, null)], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    for (const id of f.entries) ok(N.disqualifyEntry(f.db, { entryId: id, by: ADMIN, reason: 'left', now: NOW }));
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    const r1 = P.matchesOf(f.db, s.id).filter((m) => m.status === 'waiting');
    expect(r1).toHaveLength(2);
    for (const m of r1) ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'a', forfeit: true } }));
    const log = E.eventLog(f.db, f.eventId);
    expect(log.filter((l) => l.action === 'result_recorded')).toHaveLength(2);
    expect(log.filter((l) => l.action === 'round_paired')).toHaveLength(0);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
    const snap = JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all());
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all())).toBe(snap);
  });

  it('a Swiss of 3 finishes once disqualification leaves one entrant, instead of pairing more bye-only rounds', async () => {
    const f = playFixture({ stages: [SWISS(3, null)], entries: 3 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    // Round 1 has one real match (the third entrant gets the opening bye);
    // playing it out also pairs round 2, since all three are still active.
    const r1 = open(f)[0]!;
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: r1.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 10, scoreB: 5 } }));
    const r2 = P.matchesOf(f.db, s.id).find((m) => m.round === 2 && m.status === 'waiting')!;
    const r2Bye = P.matchesOf(f.db, s.id).find((m) => m.round === 2 && m.status === 'bye')!.entry_a!;
    // Disqualify round 2's bye recipient and one side of round 2's real
    // match, leaving exactly one entrant (the other side of that match) in.
    ok(N.disqualifyEntry(f.db, { entryId: r2Bye, by: ADMIN, reason: 'left', now: NOW }));
    ok(N.disqualifyEntry(f.db, { entryId: r2.entry_b!, by: ADMIN, reason: 'left', now: NOW }));
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    // round 2 was paired once (before the disqualifications); round 3 (and
    // any further bye-only round) is never paired once one entrant is left.
    expect(E.eventLog(f.db, f.eventId).filter((l) => l.action === 'round_paired')).toHaveLength(1);
    expect(P.matchesOf(f.db, s.id).some((m) => m.round > 2)).toBe(false);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
  });

  it('a single settle forfeits every eligible disqualification match in one pass, not one per call', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = playFixture({ stages: [LEAGUE(40, 3, 'round_robin', null)], entries: 20 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    const disqualified = new Set(f.entries.slice(0, 10));
    for (const id of disqualified) ok(N.disqualifyEntry(f.db, { entryId: id, by: ADMIN, reason: 'left', now: NOW }));
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    const stillOneSidedOut = P.matchesOf(f.db, s.id).filter((m) =>
      m.status === 'waiting' && m.entry_a !== null && m.entry_b !== null && (disqualified.has(m.entry_a) !== disqualified.has(m.entry_b)));
    expect(stillOneSidedOut).toHaveLength(0);
    expect(errSpy.mock.calls.some((args) => typeof args[0] === 'string' && args[0].includes('did not come to rest'))).toBe(false);
    errSpy.mockRestore();
  });

  it('a throw inside settle after a result is caught, logged, and leaves the already-saved result in place', async () => {
    const f = playFixture({ stages: [SWISS(1, 2), SE()], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const s1 = E.stagesOf(f.db, f.eventId)[0]!;
    const s2 = E.stagesOf(f.db, f.eventId)[1]!;
    const ms = P.matchesOf(f.db, s1.id).filter((m) => m.status === 'waiting');
    expect(ms).toHaveLength(2);
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: ms[0]!.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 10, scoreB: 5 } }));
    // Corrupt stage 2's settings so planStage's read of them throws once
    // stage 1 finishes and settle tries to start it: a genuine throw from
    // inside settle, not a mock, is what recordResultFlow must survive.
    f.db.prepare("UPDATE event_stages SET config_json = 'not json' WHERE id = ?").run(s2.id);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const last = ms[1]!;
    const r = await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: last.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 10, scoreB: 5 } });
    expect(r.ok).toBe(true);
    expect(P.getMatch(f.db, last.id)).toMatchObject({ status: 'done', winner_entry: last.entry_a });
    expect(errSpy.mock.calls.some((args) => typeof args[0] === 'string' && args[0].includes('settle after a result'))).toBe(true);
    errSpy.mockRestore();
  });

  it('serialize runs one event in call order and lets other events through', async () => {
    const seen: string[] = [];
    const slow = (tag: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => { seen.push(tag); r(); }, ms));
    await Promise.all([F.serialize(1, slow('1a', 20)), F.serialize(1, slow('1b', 0)), F.serialize(2, slow('2a', 5))]);
    expect(seen).toEqual(['2a', '1a', '1b']);
    await expect(F.serialize(3, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await F.serialize(3, async () => 'after')).toBe('after');
  });
});

describe('event flow, final review fixes', () => {
  const places = (f: PlayFixture) => N.entriesOf(f.db, f.eventId).filter((e) => e.status === 'placed')
    .sort((x, y) => x.id - y.id).map((e) => e.placement);

  it('a double elimination stage of 2 is played as one final, finishes, and places 1 and 2', async () => {
    for (const reset of [true, false]) {
      const f = playFixture({ stages: [DE(reset)], entries: 2 });
      ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
      expect(open(f)).toHaveLength(1);
      await playOut(f, () => 'b');
      expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
      expect(places(f)).toEqual([2, 1]);
    }
  });

  it('Swiss and a league advancing 2 into double elimination both finish', async () => {
    for (const first of [SWISS(2, 2), LEAGUE(3, 1, 'swiss', 2), LEAGUE(3, 1, 'round_robin', 2)]) {
      const f = playFixture({ stages: [first, DE(true)], entries: 4 });
      ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
      await playOut(f);
      expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
      expect(N.entriesOf(f.db, f.eventId).map((e) => e.placement).sort()).toEqual([1, 2, 3, 4]);
    }
  });

  it('elimination places are standard competition ranks: SE of 8 is 1,2,3,3,5,5,5,5 and DE of 8 is 1,2,3,4,5,5,7,7', async () => {
    const se = playFixture({ stages: [SE(false)], entries: 8 });
    ok(await F.startEventFlow(se.db, { eventId: se.eventId, by: ADMIN, now: NOW }));
    await playOut(se);
    expect(places(se)).toEqual([1, 2, 3, 3, 5, 5, 5, 5]);
    const de = playFixture({ stages: [DE(true)], entries: 8 });
    ok(await F.startEventFlow(de.db, { eventId: de.eventId, by: ADMIN, now: NOW }));
    await playOut(de);
    expect(places(de)).toEqual([1, 2, 3, 4, 5, 5, 7, 7]);
  });

  it('a finalist disqualified before the final leaves places 1, 2, 2', async () => {
    const f = playFixture({ stages: [SE(false)], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    for (const m of open(f)) {
      ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }));
    }
    const final = open(f)[0]!;
    ok(N.disqualifyEntry(f.db, { entryId: final.entry_b!, by: ADMIN, reason: 'left', now: NOW }));
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('finished');
    expect(N.getEntry(f.db, final.entry_a!)!.placement).toBe(1);
    expect(N.getEntry(f.db, final.entry_b!)).toMatchObject({ status: 'disqualified', placement: null });
    expect(N.entriesOf(f.db, f.eventId).filter((e) => e.status === 'placed').map((e) => e.placement).sort()).toEqual([1, 2, 2]);
  });

  it('a disqualification after a stage placed the entry clears its placement', async () => {
    const f = playFixture({ stages: [SWISS(1, 2), SE()], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    for (const m of open(f)) ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }));
    const gone = N.entriesOf(f.db, f.eventId).find((e) => e.status === 'eliminated')!;
    expect(gone.placement).not.toBeNull();
    expect(ok(N.disqualifyEntry(f.db, { entryId: gone.id, by: ADMIN, reason: 'abuse', now: NOW }))).toMatchObject({ status: 'disqualified', placement: null });
  });

  it('a correction that would make a disqualified team beat one still in is refused and writes nothing; with both out it is allowed', async () => {
    const f = playFixture({ stages: [SWISS(2, null)], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const [m1, m2] = open(f) as [P.MatchRow, P.MatchRow];
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m1.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 2, scoreB: 1 } }));
    ok(N.disqualifyEntry(f.db, { entryId: m1.entry_b!, by: ADMIN, reason: 'left', now: NOW }));
    const snap = JSON.stringify([f.db.prepare('SELECT * FROM event_matches ORDER BY id').all(), f.db.prepare('SELECT * FROM event_log ORDER BY id').all()]);
    expect(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m1.id, by: ADMIN, now: NOW, result: { winner: 'b', forfeit: true } }))
      .toEqual({ ok: false, error: 'winner_out' });
    expect(JSON.stringify([f.db.prepare('SELECT * FROM event_matches ORDER BY id').all(), f.db.prepare('SELECT * FROM event_log ORDER BY id').all()])).toBe(snap);
    // Same winner, new score: still fine.
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m1.id, by: ADMIN, now: NOW, result: { winner: 'a', scoreA: 3, scoreB: 1 } }));
    // Both sides out: staff may resolve it either way (Ruling 9).
    ok(N.disqualifyEntry(f.db, { entryId: m2.entry_a!, by: ADMIN, reason: 'left', now: NOW }));
    ok(N.disqualifyEntry(f.db, { entryId: m2.entry_b!, by: ADMIN, reason: 'left', now: NOW }));
    expect(P.getMatch(f.db, m2.id)!.status).toBe('waiting');
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: m2.id, by: ADMIN, now: NOW, result: { winner: 'b', forfeit: true } }));
  });

  it('keeps a bracket match\'s room status through another match\'s result, and refuses a correction that would change its teams (plan T3a)', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    ok(await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const semis = P.matchesOf(f.db, f.stages[0]!).filter((m) => m.status === 'waiting');
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: semis[0]!.id, by: ADMIN, result: { winner: 'a', scoreA: 10, scoreB: 5 }, now: NOW }));
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: semis[1]!.id, by: ADMIN, result: { winner: 'a', scoreA: 10, scoreB: 5 }, now: NOW }));
    const ready = P.matchesOf(f.db, f.stages[0]!).find((m) => m.round === 2 && m.status === 'waiting')!;
    ok(R.openRoom(f.db, { matchId: ready.id, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    const fix = await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: semis[0]!.id, by: ADMIN, result: { winner: 'b', scoreA: 5, scoreB: 10 }, now: NOW });
    expect(fix).toEqual({ ok: false, error: 'room_open_downstream' });
    expect(P.getMatch(f.db, ready.id)!.status).toBe('veto');
    const same = await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: semis[0]!.id, by: ADMIN, result: { winner: 'a', scoreA: 12, scoreB: 5 }, now: NOW });
    expect(same.ok).toBe(true);
    expect(P.getMatch(f.db, ready.id)!.status).toBe('veto');
  });
  it('forfeitMatch refuses when the match moved on before its turn in the chain (plan T3a Ruling 12)', async () => {
    const f = await roomFixture();
    ok(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    ok(await F.recordResultFlow(f.db, { eventId: f.eventId, matchId: f.matchId, by: ADMIN, result: { winner: 'a', scoreA: 9, scoreB: 1 }, now: NOW }));
    const r = await F.forfeitMatch(f.db, { eventId: f.eventId, matchId: f.matchId, winner: 'b', expect: (m) => m.status === 'veto', now: NOW });
    expect(r).toEqual({ ok: false, error: 'changed' });
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'done', winner_entry: f.entryA });
  });

  it('forfeits a disqualified team\'s open room on settle (plan T3a Ruling 15)', async () => {
    const f = await roomFixture();
    ok(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    ok(N.disqualifyEntry(f.db, { entryId: f.entryB, by: ADMIN, reason: 'left', now: NOW }));
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'forfeit', winner_entry: f.entryA });
  });
});
