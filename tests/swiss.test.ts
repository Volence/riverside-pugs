import { describe, it, expect } from 'vitest';
import { pairSwiss } from '../src/events/swiss.js';
import type { TableResult } from '../src/events/standings.js';

const seeds = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, seed: i + 1 }));
const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
/** Plays a round: the higher seed (lower id) always wins. */
const play = (pairs: [number, number][], bye: number | null): TableResult[] => [
  ...pairs.map(([a, b]) => ({ a, b, winner: Math.min(a, b), scoreA: 10, scoreB: 5 })),
  ...(bye !== null ? [{ a: bye, b: null, winner: bye, scoreA: null, scoreB: null }] : []),
];

describe('pairSwiss', () => {
  it('round 1 pairs the top half against the bottom half', () => {
    expect(pairSwiss(seeds(8), [], 4)).toEqual({ pairs: [[1, 5], [2, 6], [3, 7], [4, 8]], bye: null });
  });

  it('round 1 with an odd count gives the bye to the lowest seed', () => {
    expect(pairSwiss(seeds(5), [], 3)).toEqual({ pairs: [[1, 3], [2, 4]], bye: 5 });
  });

  it('never repeats an opponent while a repeat-free pairing exists, and pairs within score groups', () => {
    let results: TableResult[] = [];
    const met = new Set<string>();
    for (let round = 1; round <= 5; round++) {
      const p = pairSwiss(seeds(8), results, 5);
      expect(p.bye).toBeNull();
      expect(new Set(p.pairs.flat()).size).toBe(8);
      for (const [a, b] of p.pairs) {
        expect(met.has(key(a, b)), `round ${round} repeats ${a}-${b}`).toBe(false);
        met.add(key(a, b));
      }
      results = [...results, ...play(p.pairs, p.bye)];
    }
    // After round 1 (1, 2, 3, 4 won), round 2 pairs winners with winners.
    const r2 = pairSwiss(seeds(8), play([[1, 5], [2, 6], [3, 7], [4, 8]], null), 5);
    for (const [a, b] of r2.pairs) expect(a <= 4).toBe(b <= 4);
  });

  it('rotates the bye: nobody gets a second bye while someone has none', () => {
    let results: TableResult[] = [];
    const byes: number[] = [];
    for (let round = 1; round <= 5; round++) {
      const p = pairSwiss(seeds(5), results, 5);
      expect(p.bye).not.toBeNull();
      byes.push(p.bye!);
      results = [...results, ...play(p.pairs, p.bye)];
    }
    expect(new Set(byes).size).toBe(5);
  });

  it('allows a rematch only when no repeat-free pairing is left', () => {
    let results: TableResult[] = [];
    for (let round = 1; round <= 3; round++) results = [...results, ...play(pairSwiss(seeds(4), results, 5).pairs, null)];
    // 4 teams have each met all 3 others; round 4 must still pair everyone.
    const p = pairSwiss(seeds(4), results, 5);
    expect(new Set(p.pairs.flat()).size).toBe(4);
  });

  it('pairs only the entries it is given (a disqualified team is left out by the caller)', () => {
    const results = play([[1, 3], [2, 4]], null);
    const p = pairSwiss(seeds(4).filter((e) => e.id !== 1), results, 3);
    expect(p.pairs.flat().includes(1)).toBe(false);
    expect(p.bye).not.toBeNull();
  });

  it('handles 0, 1 and 2 entries', () => {
    expect(pairSwiss([], [], 3)).toEqual({ pairs: [], bye: null });
    expect(pairSwiss(seeds(1), [], 3)).toEqual({ pairs: [], bye: 1 });
    expect(pairSwiss(seeds(2), [], 3)).toEqual({ pairs: [[1, 2]], bye: null });
  });
});
