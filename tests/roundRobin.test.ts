import { describe, it, expect } from 'vitest';
import { circleRounds } from '../src/events/roundRobin.js';

const everyPairOnce = (ids: number[], rounds: { pairs: [number, number][] }[]) => {
  const seen = new Map<string, number>();
  for (const r of rounds) for (const [a, b] of r.pairs) {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  expect(seen.size).toBe((ids.length * (ids.length - 1)) / 2);
  expect([...seen.values()].every((n) => n === 1)).toBe(true);
};

describe('circleRounds', () => {
  it('even count: n - 1 rounds, no byes, everyone once per round', () => {
    const ids = [11, 12, 13, 14, 15, 16];
    const rounds = circleRounds(ids);
    expect(rounds).toHaveLength(5);
    for (const r of rounds) {
      expect(r.bye).toBeNull();
      expect(new Set(r.pairs.flat()).size).toBe(6);
    }
    everyPairOnce(ids, rounds);
  });

  it('odd count: n rounds, one bye each, every team sits out once', () => {
    const ids = [1, 2, 3, 4, 5];
    const rounds = circleRounds(ids);
    expect(rounds).toHaveLength(5);
    expect(new Set(rounds.map((r) => r.bye))).toEqual(new Set(ids));
    everyPairOnce(ids, rounds);
  });

  it('two teams play once; one team only sits out', () => {
    expect(circleRounds([1, 2])).toEqual([{ pairs: [[1, 2]], bye: null }]);
    expect(circleRounds([7])).toEqual([{ pairs: [], bye: 7 }]);
  });
});
