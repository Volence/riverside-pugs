import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { addWeeks, computeWeek, weekBounds, weekStartOf } from '../src/weeklyAwards.js';
import { seedMatch, seedPlayers, seedRating, seedReadyup } from './weeklyFixtures.js';

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

describe('overall awards', () => {
  /** p on team a in each match; results as a string like 'WWLW' (D = draw). */
  function results(p: string, s: string) {
    [...s].forEach((c, i) => seedMatch(db, {
      endedAt: at(0, `${String(10 + i).padStart(2, '0')}:00:00`),
      winner: c === 'W' ? 'a' : c === 'L' ? 'b' : 'draw',
      lines: [{ id: p, team: 'a' }],
    }));
  }
  const single = (key: string) => find(computeWeek(db, W), key, 'single');

  it('most wins, iron man, best win rate with its W-L record', () => {
    results(P[0], 'WWWWL');       // 4-1, 5 games
    results(P[1], 'WWWWWWLLLL');  // 6-4, 10 games
    results(P[2], 'WWWW');        // 4-0 but only 4 games
    expect(single('wins')!.winners.map((w) => w.steamid)).toEqual([P[1]]);
    expect(single('matches')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[1], 10]]);
    expect(single('win_rate')!.winners.map((w) => [w.steamid, w.value, w.detail])).toEqual([[P[0], 0.8, '4-1']]);
  });

  it('a draw breaks a win streak and does not count as decided', () => {
    results(P[0], 'WWDWWWL');
    results(P[1], 'WWLWW');
    // If a draw counted as decided, P0 would be 5/7 and lose to P1's 4/5.
    expect(single('win_streak')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 3]]);
    expect(single('win_rate')!.winners[0]).toMatchObject({ steamid: P[0], detail: '5-1' });
  });

  it('SR climb is displayed SR after the last match minus before the first', () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedMatch(db, { endedAt: at(i), lines: [{ id: P[0], team: 'a' }, { id: P[1], team: 'b' }] }));
    // P0: 25/8.333 (833) up to 30/7 (1600): +767. P1 falls: never a winner.
    ids.forEach((m, i) => {
      seedRating(db, m, P[0], i === 0 ? [25, 8.333] : [26, 8], i === 4 ? [30, 7] : [26, 8]);
      seedRating(db, m, P[1], [25, 8.333], [20, 8]);
    });
    expect(single('sr_climb')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 767]]);
  });
});

describe('shame awards', () => {
  it('slowest ready-up is the average per ready-up, gated on matches', () => {
    for (let i = 0; i < 5; i++) {
      const m = seedMatch(db, { endedAt: at(i), lines: [{ id: P[0], team: 'a' }, { id: P[1], team: 'b' }] });
      seedReadyup(db, m, { [P[0]]: 40, [P[1]]: 10 });
      seedReadyup(db, m, { [P[0]]: 20, [P[1]]: 10 });
    }
    const m = seedMatch(db, { endedAt: at(5), lines: [{ id: P[2], team: 'a' }] });
    seedReadyup(db, m, { [P[2]]: 500 });   // one match: below the gate
    const s = find(computeWeek(db, W), 'slow_ready', 'single')!;
    expect(s.group).toBe('shame');
    expect(s.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 30]]);
  });

  it('friendly fire and group hug are per-match averages', () => {
    for (let i = 0; i < 5; i++) {
      seedMatch(db, {
        endedAt: at(i),
        lines: [
          { id: P[0], team: 'a', fixed: { ff_dealt: 30 }, stats: { times_quadded: 1 } },
          { id: P[1], team: 'b', fixed: { ff_dealt: 10 }, stats: { times_quadded: 2 } },
        ],
      });
    }
    // Four matches only: below the min-games gate, so a huge ff_dealt does not win.
    for (let i = 0; i < 4; i++) {
      seedMatch(db, { endedAt: at(i, '09:00:00'), lines: [{ id: P[2], team: 'a', fixed: { ff_dealt: 500 } }] });
    }
    const r = computeWeek(db, W);
    expect(find(r, 'friendly_fire', 'single')!.winners.map((w) => [w.steamid, w.value])).toEqual([[P[0], 30]]);
    expect(find(r, 'group_hug', 'single')!.winners[0]).toMatchObject({ steamid: P[1], value: 2 });
    expect(find(r, 'incap_damage', 'single')).toBeUndefined();
  });
});
