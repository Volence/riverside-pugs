import { describe, it, expect } from 'vitest';
import {
  campaignName, winnerLabel, fmtDate, fmtDelta, deltaClass, fmtClock,
  secondsLeft, sparklinePoints,
} from './format';

describe('campaignName', () => {
  it('maps known slugs and passes unknown ones through', () => {
    expect(campaignName('no_mercy')).toBe('No Mercy');
    expect(campaignName('blood_harvest')).toBe('Blood Harvest');
    expect(campaignName('crash_course')).toBe('crash_course');
  });
});

describe('winnerLabel', () => {
  it('names the team, or says Draw', () => {
    expect(winnerLabel('a')).toBe('Team A');
    expect(winnerLabel('b')).toBe('Team B');
    expect(winnerLabel('draw')).toBe('Draw');
  });
});

describe('fmtDate', () => {
  it('trims an ISO timestamp to minutes', () => {
    expect(fmtDate('2026-09-06T04:12:33.000Z')).toBe('2026-09-06 04:12');
  });
  it('returns empty for null/undefined rather than "Invalid Date"', () => {
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
  });
});

describe('fmtDelta', () => {
  it('always prints a sign, with a real minus for negatives', () => {
    expect(fmtDelta(12)).toBe('+12');
    expect(fmtDelta(-9)).toBe('−9');
    expect(fmtDelta(0)).toBe('±0');
  });

  it('uses U+2212, not a hyphen, so delta columns align', () => {
    expect(fmtDelta(-9).charCodeAt(0)).toBe(0x2212);
    expect(fmtDelta(-9)).not.toContain('-');
  });

  it('classes a delta by direction', () => {
    expect(deltaClass(1)).toContain('delta--up');
    expect(deltaClass(-1)).toContain('delta--down');
    expect(deltaClass(0)).toBe('delta');
  });
});

describe('fmtClock', () => {
  it('formats mm:ss with a padded seconds field', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(9)).toBe('0:09');
    expect(fmtClock(75)).toBe('1:15');
  });
  it('floors fractions and never goes negative', () => {
    expect(fmtClock(9.9)).toBe('0:09');
    expect(fmtClock(-5)).toBe('0:00');
  });
});

describe('secondsLeft', () => {
  it('counts down to a deadline and clamps at zero', () => {
    const now = 1_000_000;
    expect(secondsLeft(now + 30_000, now)).toBe(30);
    expect(secondsLeft(now - 5_000, now)).toBe(0);
  });
});

describe('sparklinePoints', () => {
  it('returns null below two points, because a dot implies a trend it cannot support', () => {
    expect(sparklinePoints([], 100, 50)).toBeNull();
    expect(sparklinePoints([1200], 100, 50)).toBeNull();
  });

  it('spans the full width and inverts y so higher SR sits higher', () => {
    const pts = sparklinePoints([0, 100], 100, 50, 5)!.split(' ');
    expect(pts).toHaveLength(2);
    const [x0, y0] = pts[0].split(',').map(Number);
    const [x1, y1] = pts[1].split(',').map(Number);
    expect(x0).toBe(0);
    expect(x1).toBe(100);
    expect(y0).toBe(45); // the low value sits at the bottom, inside the pad
    expect(y1).toBe(5);  // the high value at the top
    expect(y1).toBeLessThan(y0);
  });

  it('draws a flat series as a centered line instead of dividing by zero', () => {
    const pts = sparklinePoints([1200, 1200, 1200], 100, 50)!;
    expect(pts).not.toContain('NaN');
    for (const p of pts.split(' ')) expect(Number(p.split(',')[1])).toBe(25);
  });
});
