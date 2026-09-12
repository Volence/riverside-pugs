import { describe, it, expect } from 'vitest';
import { advance, SPEEDS } from './playback';

describe('SPEEDS', () => {
  it('offers the four rates the toolbar shows', () => {
    expect([...SPEEDS]).toEqual([0.5, 1, 2, 4]);
  });
});

describe('advance', () => {
  it('moves forward by elapsed time at 1x', () => {
    expect(advance(1000, 16, 1, 10_000, false)).toBe(1016);
  });

  it('scales by speed', () => {
    expect(advance(1000, 100, 4, 10_000, false)).toBe(1400);
  });

  it('stops at the end when not following', () => {
    expect(advance(9950, 100, 1, 10_000, false)).toBe(10_000);
  });

  // Following is the live case. The end keeps moving as frames arrive, and
  // the viewer should ride it rather than repeatedly hitting a wall that
  // moves a moment later.
  it('snaps to the end when following', () => {
    expect(advance(1000, 16, 1, 10_000, true)).toBe(10_000);
  });

  it('never goes backwards past zero', () => {
    expect(advance(0, 16, 1, 0, false)).toBe(0);
  });
});
