import { describe, it, expect } from 'vitest';
import { byeSpread, leagueWeeks, perWeekFor, repeatedRoundRobin, weekDates, weekOfRound } from '../src/events/league.js';

describe('league season', () => {
  it('repeats the round robin, swapping sides, until the rounds are used', () => {
    const ids = [1, 2, 3, 4];
    const rounds = repeatedRoundRobin(ids, 7);
    expect(rounds).toHaveLength(7);
    const meetings = new Map<string, number>();
    for (const r of rounds) for (const [a, b] of r.pairs) {
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      meetings.set(k, (meetings.get(k) ?? 0) + 1);
    }
    // 7 rounds of 4 teams = two full cycles (6 rounds) plus one: every pair twice, two pairs three times.
    expect([...meetings.values()].sort()).toEqual([2, 2, 2, 2, 3, 3]);
    // Cycle 2 plays cycle 1's first round with sides swapped.
    expect(rounds[3]!.pairs).toEqual(rounds[0]!.pairs.map(([a, b]) => [b, a]));
  });

  it('gives each team of an odd field one bye per cycle', () => {
    const rounds = repeatedRoundRobin([1, 2, 3, 4, 5], 10);
    const byes = new Map<number, number>();
    for (const r of rounds) byes.set(r.bye!, (byes.get(r.bye!) ?? 0) + 1);
    expect([...byes.values()]).toEqual([2, 2, 2, 2, 2]);
  });

  it('weeks, the week of a round and its dates', () => {
    expect(leagueWeeks(16, 2)).toBe(8);
    expect(leagueWeeks(16, 3)).toBe(6);
    expect([1, 2, 3, 4, 5].map((r) => weekOfRound(r, 2))).toEqual([1, 1, 2, 2, 3]);
    expect(weekDates('2026-10-12', 1)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(weekDates('2026-10-12', 8)).toEqual({ from: '2026-11-30', to: '2026-12-06' });
  });

  it('works out matches a week from two dates', () => {
    // Oct 12 to Nov 29 inclusive is exactly 7 weeks: 16 matches need 3 a week.
    expect(perWeekFor(16, '2026-10-12', '2026-11-29')).toBe(3);
    expect(perWeekFor(16, '2026-10-12', '2026-12-06')).toBe(2);
    expect(perWeekFor(16, '2026-10-12', '2026-10-25')).toBeNull();
    expect(perWeekFor(16, '2026-10-12', '2026-10-01')).toBeNull();
  });

  it('says how byes fall for an odd field and which counts split them evenly', () => {
    expect(byeSpread(16, 8)).toBeNull();
    expect(byeSpread(16, 7)).toEqual({ min: 2, max: 3, even: [14, 21] });
    expect(byeSpread(14, 7)).toEqual({ min: 2, max: 2, even: [14] });
    expect(byeSpread(3, 5)).toEqual({ min: 0, max: 1, even: [5] });
  });
});
