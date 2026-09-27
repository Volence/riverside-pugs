import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { addWeeks, computeWeek, weekBounds, weekStartOf } from '../src/weeklyAwards.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let P: string[];
beforeEach(() => { db = openDb(':memory:'); P = seedPlayers(db, 8); });

const W = '2026-09-21';
const at = (day: number, hms = '20:00:00') => `2026-09-${String(21 + day).padStart(2, '0')} ${hms}`;
/** n matches for player p with the given stats each, teammates filler. */
function play(p: string, n: number, stats: Record<string, number>, day = 0) {
  for (let i = 0; i < n; i++) seedMatch(db, { endedAt: at(day, `1${i}:00:00`), lines: [{ id: p, team: 'a', stats }] });
}
const find = (r: ReturnType<typeof computeWeek>, key: string, kind: string) => r.find((x) => x.key === key && x.kind === kind);

describe('week math', () => {
  it('Monday is the start, whatever day is given', () => {
    expect(weekStartOf(new Date('2026-09-21T00:00:00Z'))).toBe(W);
    expect(weekStartOf(new Date('2026-09-27T23:59:59Z'))).toBe(W);
    expect(weekStartOf(new Date('2026-09-28T00:00:00Z'))).toBe('2026-09-28');
    expect(addWeeks(W, -1)).toBe('2026-09-14');
    expect(weekBounds(W)).toEqual({ from: '2026-09-21 00:00:00', to: '2026-09-28 00:00:00' });
  });

  it('a match ending exactly at Monday 00:00:00 belongs to the new week', () => {
    seedMatch(db, { endedAt: '2026-09-28 00:00:00', lines: [{ id: P[0], team: 'a', stats: { skeets: 9 } }] });
    expect(find(computeWeek(db, W), 'skeets', 'total')).toBeUndefined();
    expect(find(computeWeek(db, '2026-09-28'), 'skeets', 'total')?.winners[0].steamid).toBe(P[0]);
  });
});

describe('stat awards', () => {
  it('average needs the minimum games, total does not', () => {
    play(P[0], 4, { skeets: 5 });   // 20 total, 5.0 avg, only 4 games
    play(P[1], 5, { skeets: 3 });   // 15 total, 3.0 avg
    const r = computeWeek(db, W);
    expect(find(r, 'skeets', 'avg')!.winners.map((w) => [w.steamid, w.value, w.games])).toEqual([[P[1], 3, 5]]);
    expect(find(r, 'skeets', 'total')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 20]]);
  });

  it('the minimum comes from the setting', () => {
    setSetting(db, 'weekly_min_games', '4');
    play(P[0], 4, { skeets: 5 });
    play(P[1], 5, { skeets: 3 });
    expect(find(computeWeek(db, W), 'skeets', 'avg')!.winners[0].steamid).toBe(P[0]);
  });

  it('an out-of-range or blank minimum falls back to the default of 5', () => {
    play(P[0], 4, { skeets: 5 });
    play(P[1], 5, { skeets: 3 });
    setSetting(db, 'weekly_min_games', '0');
    expect(find(computeWeek(db, W), 'skeets', 'avg')!.winners[0].steamid).toBe(P[1]);
    setSetting(db, 'weekly_min_games', '');
    expect(find(computeWeek(db, W), 'skeets', 'avg')!.winners[0].steamid).toBe(P[1]);
    setSetting(db, 'weekly_min_games', '3.5');
    expect(find(computeWeek(db, W), 'skeets', 'avg')!.winners[0].steamid).toBe(P[1]);
  });

  it('ties share, zeros never win, voided and aborted matches do not count', () => {
    play(P[0], 5, { boomer_pops: 2 });
    play(P[1], 5, { boomer_pops: 2 });
    play(P[2], 5, { rock_skeets: 0 });
    seedMatch(db, { endedAt: at(1), voided: true, lines: [{ id: P[3], team: 'a', stats: { boomer_pops: 99 } }] });
    seedMatch(db, { endedAt: at(1), state: 'aborted', lines: [{ id: P[3], team: 'a', stats: { boomer_pops: 99 } }] });
    const r = computeWeek(db, W);
    expect(find(r, 'boomer_pops', 'total')!.winners.map((w) => w.steamid).sort()).toEqual([P[0], P[1]]);
    expect(find(r, 'rock_skeets', 'total')).toBeUndefined();
  });

  it('witch crowns adds crowns and draw crowns; fixed columns work', () => {
    play(P[0], 5, { crowns: 1, draw_crowns: 2 });
    seedMatch(db, { endedAt: at(2), lines: [{ id: P[1], team: 'a', fixed: { common_kills: 400 } }] });
    const r = computeWeek(db, W);
    expect(find(r, 'crowns', 'total')!.winners[0].value).toBe(15);
    expect(find(r, 'common_kills', 'total')!.winners[0].value).toBe(400);
  });

  it('a game with no stat row still counts as a game for the average', () => {
    play(P[0], 4, { skeets: 5 });
    seedMatch(db, { endedAt: at(3), lines: [{ id: P[0], team: 'a' }] });   // fifth match, no stats
    expect(find(computeWeek(db, W), 'skeets', 'avg')!.winners[0]).toMatchObject({ value: 4, games: 5 });
  });
});
