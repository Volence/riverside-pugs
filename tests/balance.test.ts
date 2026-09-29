import { describe, it, expect } from 'vitest';
import { balanceTeams, type RatedPlayer } from '../src/balance.js';

function p(steamid: string, mu: number, sigma = 25 / 3): RatedPlayer {
  return { steamid, mu, sigma };
}

describe('balanceTeams', () => {
  it('splits 8 into 4v4 with near-even odds for equal players', () => {
    const players = Array.from({ length: 8 }, (_, i) => p(`p${i}`, 25));
    const { teamA, teamB, pWinA } = balanceTeams(players);
    expect(teamA).toHaveLength(4);
    expect(teamB).toHaveLength(4);
    expect([...teamA, ...teamB].sort()).toEqual(players.map((x) => x.steamid).sort());
    expect(pWinA).toBeCloseTo(0.5, 1);
  });

  it('separates the two strongest players', () => {
    const players = [p('star1', 40), p('star2', 40), ...Array.from({ length: 6 }, (_, i) => p(`p${i}`, 25))];
    const { teamA, teamB } = balanceTeams(players);
    const aHasStar1 = teamA.includes('star1');
    expect(aHasStar1 ? teamB : teamA).toContain('star2');
  });

  it('produces odds closer to even than a naive first-4/last-4 split', () => {
    const players = [p('a', 35), p('b', 33), p('c', 31), p('d', 29), p('e', 24), p('f', 22), p('g', 20), p('h', 18)];
    const { pWinA } = balanceTeams(players);
    expect(Math.abs(pWinA - 0.5)).toBeLessThan(0.1);
  });

  it('splits 4 into 2v2 and 6 into 3v3', () => {
    for (const n of [4, 6]) {
      const players = Array.from({ length: n }, (_, i) => p(`p${i}`, 20 + i));
      const { teamA, teamB } = balanceTeams(players);
      expect(teamA).toHaveLength(n / 2);
      expect(teamB).toHaveLength(n / 2);
      expect([...teamA, ...teamB].sort()).toEqual(players.map((x) => x.steamid).sort());
    }
  });

  it('separates the two strongest in a 2v2', () => {
    const { teamA, teamB } = balanceTeams([p('s1', 40), p('s2', 40), p('a', 20), p('b', 20)]);
    expect(teamA.includes('s1')).not.toBe(teamA.includes('s2'));
    expect(teamB).toHaveLength(2);
  });

  it('refuses sizes other than 4, 6 and 8', () => {
    expect(() => balanceTeams([p('a', 25), p('b', 25), p('c', 25)])).toThrow(/4, 6 or 8/);
    expect(() => balanceTeams(Array.from({ length: 10 }, (_, i) => p(`p${i}`, 25)))).toThrow(/4, 6 or 8/);
  });
});
