import { describe, it, expect } from 'vitest';
import { FLICK_MIN_KILLS, flickNote, flickReturns, isFlickReturn, type KillRow } from '../src/aimRules.js';

const row = (pre: number, back: number, i = 0): KillRow => ({
  id: i + 1, weapon: 'smg', headshot: 1, pre, back, victimClass: i % 2 ? 'smoker' : 'hunter',
  at: `2026-10-17T21:0${i}:13.000Z`,
});

describe('isFlickReturn', () => {
  it('counts 90 out and 45 back, inclusive', () => {
    expect(isFlickReturn(row(90, 45))).toBe(true);
    expect(isFlickReturn(row(143.5, 12))).toBe(true);
    expect(isFlickReturn(row(89.9, 0))).toBe(false);
    expect(isFlickReturn(row(180, 45.1))).toBe(false);
  });

  it('never counts an unknown look back', () => {
    expect(isFlickReturn(row(180, -1))).toBe(false);
  });
});

describe('flickReturns', () => {
  it('needs two in the match', () => {
    expect(FLICK_MIN_KILLS).toBe(2);
    expect(flickReturns([row(143.5, 12, 0), row(10, 3, 1), row(5, 2, 2)])).toBeNull();
    const r = flickReturns([row(143.5, 12, 0), row(10, 3, 1), row(101.5, 30.1, 2)]);
    expect(r?.kills).toBe(3);
    expect(r?.flicks.map((k) => k.id)).toEqual([1, 3]);
  });

  it('does not let back=-1 make up the second', () => {
    expect(flickReturns([row(143.5, 12, 0), row(180, -1, 1)])).toBeNull();
  });

  it('gives the numbers and the times', () => {
    const r = flickReturns([row(143.5, 12, 0), row(10, 3, 1), row(101.5, 30.1, 2)])!;
    expect(flickNote(r)).toBe(
      '2 of 3 SI kills were a 90+ degree flick and back within 45: 21:00:13 hunter (pre 143.5, back 12.0), 21:02:13 hunter (pre 101.5, back 30.1) UTC',
    );
  });
});
