import { describe, it, expect } from 'vitest';
import { healthColor, statusFlags, portraitFor, barSegments } from './hud';
import { STATE, VERSION } from '../../../src/replayFormat';

describe('healthColor', () => {
  it('ramps green to red', () => {
    expect(healthColor(100, true)).not.toBe(healthColor(40, true));
    expect(healthColor(40, true)).not.toBe(healthColor(10, true));
  });

  it('greys out a dead player', () => {
    expect(healthColor(0, false)).toBe(healthColor(100, false));
  });
});

describe('statusFlags', () => {
  it('names each state bit that is set', () => {
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.INCAP)).toContain('Incapped');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.PINNED)).toContain('Pinned');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.BILED)).toContain('Biled');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.BURNING)).toContain('Burning');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.LEDGED)).toContain('Hanging');
  });

  it('names nothing for a healthy player', () => {
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE)).toEqual([]);
  });

  it('names a dead player as dead rather than listing bits', () => {
    expect(statusFlags(STATE.PRESENT)).toEqual(['Dead']);
  });
});

describe('portraitFor', () => {
  // The whole reason the version check exists. A version 1 file wrote 0 for
  // every survivor, so believing `cls` there would label all four of them
  // Bill.
  it('is the silhouette for a version 1 survivor', () => {
    expect(portraitFor(0, 1, true)).toBe('/portraits/unknown.png');
    expect(portraitFor(2, 1, true)).toBe('/portraits/unknown.png');
  });

  it('is the real character for a version 2 survivor', () => {
    expect(portraitFor(2, 2, true)).toBe('/portraits/francis.png');
  });

  it('is the silhouette for an out of range character index', () => {
    expect(portraitFor(99, 2, true)).toBe('/portraits/unknown.png');
  });

  it('is never a survivor portrait for an infected player', () => {
    expect(portraitFor(1, 2, false)).toBe('/portraits/unknown.png');
  });

  it('handles the current version without special casing', () => {
    expect(portraitFor(0, VERSION, true)).toBe(
      VERSION >= 2 ? '/portraits/bill.png' : '/portraits/unknown.png',
    );
  });
});

describe('barSegments', () => {
  it('splits permanent and temporary health as fractions', () => {
    expect(barSegments(50, 25)).toEqual({ perm: 0.5, temp: 0.25 });
  });

  it('clamps the total to the bar', () => {
    const got = barSegments(90, 90);
    expect(got.perm + got.temp).toBeLessThanOrEqual(1);
  });

  it('is empty for a dead player', () => {
    expect(barSegments(0, 0)).toEqual({ perm: 0, temp: 0 });
  });

  // A tank records 8000 health, which is why health is a uint16 in the
  // format. Passing its own max keeps the bar meaningful instead of pinned.
  it('accepts a different maximum', () => {
    expect(barSegments(4000, 0, 8000).perm).toBe(0.5);
  });
});
