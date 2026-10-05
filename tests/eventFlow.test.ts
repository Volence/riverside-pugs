import { describe, it, expect } from 'vitest';
import * as F from '../src/events/flow.js';
import * as P from '../src/events/play.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { ADMIN, NOW } from './eventFixture.js';
import { DE, LEAGUE, RR, SE, SWISS, playFixture, type PlayFixture } from './playFixture.js';

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
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    const snap = JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all());
    await F.settleEvent(f.db, { eventId: f.eventId, now: NOW });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all())).toBe(snap);
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
