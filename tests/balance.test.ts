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

describe('balanceTeams with duo groups', () => {
  it('never splits a group', () => {
    const players = [p('s1', 40), p('s2', 40), ...Array.from({ length: 6 }, (_, i) => p(`p${i}`, 25))];
    const { teamA, teamB } = balanceTeams(players, { groups: [['s1', 's2']] });
    const together = (t: string[]) => t.includes('s1') && t.includes('s2');
    expect(together(teamA) || together(teamB)).toBe(true);
  });

  it('puts a strong duo and a weak duo on the same side when that is the even split (owner example)', () => {
    const players = [p('s1', 35), p('s2', 35), p('w1', 15), p('w2', 15), p('m1', 25), p('m2', 25), p('m3', 25), p('m4', 25)];
    const { teamA, teamB, pWinA } = balanceTeams(players, { groups: [['s1', 's2'], ['w1', 'w2']] });
    const side = teamA.includes('s1') ? teamA : teamB;
    expect([...side].sort()).toEqual(['s1', 's2', 'w1', 'w2']);
    expect(pWinA).toBeCloseTo(0.5, 2);
  });

  it('with no groups gives exactly the old answer', () => {
    const players = [p('a', 35), p('b', 33), p('c', 31), p('d', 29), p('e', 24), p('f', 22), p('g', 20), p('h', 18)];
    expect(balanceTeams(players, { groups: [] })).toEqual(balanceTeams(players));
  });

  it('ignores a group naming someone not in the lobby', () => {
    const players = Array.from({ length: 8 }, (_, i) => p(`p${i}`, 25));
    expect(() => balanceTeams(players, { groups: [['p0', 'ghost']] })).not.toThrow();
  });

  it('throws when no split keeps every group together', () => {
    const players = Array.from({ length: 6 }, (_, i) => p(`p${i}`, 25));
    const groups: [string, string][] = [['p0', 'p1'], ['p2', 'p3'], ['p4', 'p5']];
    expect(() => balanceTeams(players, { groups })).toThrow('balanceTeams: no split keeps every group together');
  });
});
