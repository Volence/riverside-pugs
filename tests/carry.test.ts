import { describe, it, expect, afterEach, vi } from 'vitest';
import * as R from '../src/events/room.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { carryEntries, carryFor } from '../src/events/carry.js';
import { POOL7, TIMERS } from './roomFixture.js';
import { A, B as BATS } from './entryFixture.js';
import { HA, MIN, driveHomeAway, driveLoserPicks, seriesFixture, type SeriesFixture } from './seriesFixture.js';

/** Plan T6: the stage's rules (and the booking's copy, once one exists) carry the score. */
const carryOn = (f: SeriesFixture, on = true) => {
  f.db.prepare("UPDATE event_stages SET rules_json = json_set(rules_json, '$.series.carryScore', json(?))").run(on ? 'true' : 'false');
  f.db.prepare("UPDATE bookings SET rules_json = json_set(rules_json, '$.series.carryScore', json(?)) WHERE rules_json IS NOT NULL").run(on ? 'true' : 'false');
};
const sideAOf = (f: SeriesFixture, matchId: number) => f.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').pluck().get(matchId) as string | null;

/** Game 1 played (Rats, entry a, 500; Bats 400), then game 2 pushed. */
async function toGame2(f: SeriesFixture): Promise<{ g1: number; g2: number }> {
  await f.tick();
  const g1 = f.gameOf(1).match_id!;
  // Rats survive first in game 1, so they are its pug team a.
  expect(sideAOf(f, g1)).toBe('a');
  f.goLive(g1);
  f.endGame(g1, [{ map: 'l4d_vs_smalltown01_caves', a: 500, b: 400 }]);
  expect(f.gameOf(1)).toMatchObject({ score_a: 500, score_b: 400 });
  f.sent.length = 0;
  f.t.t += MIN;
  await f.tick();
  const g2 = f.gameOf(2).match_id;
  expect(g2).not.toBeNull();
  return { g1, g2: g2! };
}

describe('carryFor: what a tournament game starts with (plan T6)', () => {
  let f: SeriesFixture;
  afterEach(() => { vi.restoreAllMocks(); f?.close(); });

  it('game 2 of a best of 2 that carries starts with game 1 in pug-team order, pushes sm_pug_carry after sm_pug_match and says so', async () => {
    f = await seriesFixture({ pool: HA, veto: presetConfig('home_away', 4), drive: driveHomeAway });
    carryOn(f);
    const { g1, g2 } = await toGame2(f);
    expect(JSON.parse(f.db.prepare('SELECT rules_json FROM matches WHERE id = ?').pluck().get(g2) as string).series.carryScore).toBe(true);
    // Rats survive first in game 2 too: Rats are its team a.
    const sideA = sideAOf(f, g2);
    expect(sideA).toBe('a');
    const want = sideA === 'a' ? { a: 500, b: 400 } : { a: 400, b: 500 };
    expect(carryFor(f.db, g2)).toEqual(want);
    expect(carryFor(f.db, g2)).toEqual({ a: 500, b: 400 });
    expect(carryEntries(f.db, g2)).toEqual({ entryA: 500, entryB: 400 });
    const at = f.sent.findIndex((c) => c.startsWith(`sm_pug_match ${g2} `));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(f.sent[at + 1]).toBe(`sm_pug_carry ${g2} 500 400`);
    expect(f.sent.some((c) => c.startsWith('say [Match] ') && c.includes("Game 1's score carries over: Rats 500, Bats 400."))).toBe(true);
    // Game 1 never carries.
    expect(carryFor(f.db, g1)).toBeNull();
    expect(carryEntries(f.db, g1)).toBeNull();
  });

  it('orients by game 2\'s booking_side_a: Bats surviving first are pug team a', async () => {
    f = await seriesFixture({ pool: HA, veto: presetConfig('home_away', 4), drive: (r) => driveHomeAway(r, 'survivors') });
    carryOn(f);
    const { g2 } = await toGame2(f);
    expect(sideAOf(f, g2)).toBe('b');
    expect(carryFor(f.db, g2)).toEqual({ a: 400, b: 500 });
    expect(carryEntries(f.db, g2)).toEqual({ entryA: 500, entryB: 400 });
    const at = f.sent.findIndex((c) => c.startsWith(`sm_pug_match ${g2} `));
    expect(f.sent[at + 1]).toBe(`sm_pug_carry ${g2} 400 500`);
    // The start line stays in entry order.
    expect(f.sent.some((c) => c.includes("Game 1's score carries over: Rats 500, Bats 400."))).toBe(true);
  });

  it('carries nothing when the ruleset does not carry the score', async () => {
    f = await seriesFixture({ pool: HA, veto: presetConfig('home_away', 4), drive: driveHomeAway });
    const { g2 } = await toGame2(f);
    expect(carryFor(f.db, g2)).toBeNull();
    expect(carryEntries(f.db, g2)).toBeNull();
    expect(f.sent.some((c) => c.startsWith('sm_pug_carry'))).toBe(false);
    expect(f.sent.some((c) => c.includes('carries over'))).toBe(false);
  });

  it('a tiebreak never carries', async () => {
    f = await seriesFixture({ pool: HA, veto: presetConfig('home_away', 4), drive: driveHomeAway });
    carryOn(f);
    const { g2 } = await toGame2(f);
    f.goLive(g2);
    // Rats 300, Bats 400: 800 to 800 on total.
    f.endGame(g2, [{ map: 'l4d_vs_hospital01_apartment', a: 100, b: 100, half1Surv: 'a' }, { map: 'l4d_vs_hospital02_subway', a: 200, b: 300, half1Surv: 'b' }]);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const tb = f.gameOf(21).match_id;
    expect(tb).not.toBeNull();
    expect(carryFor(f.db, tb!)).toBeNull();
    expect(f.sent.some((c) => c.startsWith('sm_pug_carry'))).toBe(false);
  });

  it('a best of 3 never carries', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    carryOn(f);
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1);
    f.endGame(g1, [{ map: 'm1', a: 300, b: 200 }, { map: 'm2', a: 100, b: 400 }]);
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true);
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: BATS[0]!, step: 7, action: 'pick', campaign: POOL7[4]!, timers: TIMERS, now: new Date(f.t.t) }));
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 8, action: 'survivors', campaign: null, timers: TIMERS, now: new Date(f.t.t) }));
    f.series.afterPick(f.matchId);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const g2 = f.gameOf(2).match_id;
    expect(g2).not.toBeNull();
    expect(carryFor(f.db, g2!)).toBeNull();
    expect(f.sent.some((c) => c.startsWith('sm_pug_carry'))).toBe(false);
  });

  it('carries nothing when game 1 has no scores', async () => {
    f = await seriesFixture({ pool: HA, veto: presetConfig('home_away', 4), drive: driveHomeAway });
    carryOn(f);
    const { g2 } = await toGame2(f);
    f.db.prepare('UPDATE event_games SET score_a = NULL, score_b = NULL WHERE event_match_id = ? AND ordinal = 1').run(f.matchId);
    expect(carryFor(f.db, g2)).toBeNull();
    expect(carryEntries(f.db, g2)).toBeNull();
  });

  it('a PUG match or an unknown id carries nothing and does not throw', async () => {
    f = await seriesFixture({ pool: HA, veto: presetConfig('home_away', 4), drive: driveHomeAway });
    const pug = Number(f.db.prepare("INSERT INTO matches (season_id, state, campaign, origin) VALUES ((SELECT id FROM seasons LIMIT 1), 'live', 'no_mercy', 'queue')").run().lastInsertRowid);
    expect(carryFor(f.db, pug)).toBeNull();
    expect(carryFor(f.db, 999999)).toBeNull();
  });
});
