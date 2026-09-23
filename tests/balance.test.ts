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
});
