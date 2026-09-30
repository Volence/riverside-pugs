import { describe, it, expect } from 'vitest';
import { busiestWindow, localActivity, localDayHour, nowLevel, ROW_DAYS, waitWords } from './activity';
import type { QueueActivity } from './api';

function activity(cells: [number, number, number][]): QueueActivity {
  const pops = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const [dow, h, n] of cells) pops[dow][h] = n;
  return {
    days: 28, pops, totalPops: cells.reduce((s, c) => s + c[2], 0),
    waits: { medianSec: null, byHourSec: new Array(24).fill(null), popped: 0, left: 0, leftMedianSec: null },
  };
}

const row = (day: number) => ROW_DAYS.indexOf(day as typeof ROW_DAYS[number]);
// A Wednesday in daylight saving time in New York (UTC-4).
const NOW = new Date('2026-09-30T12:00:00Z');

describe('localActivity', () => {
  it('moves a Wednesday 01:00 UTC pop to Tuesday 21:00 in New York, as games per week', () => {
    const local = localActivity(activity([[3, 1, 8]]), NOW, 'America/New_York');
    expect(local.grid[row(2)][21]).toBe(2);
    expect(local.byHour[21]).toBe(2);
    expect(local.max).toBe(2);
  });

  it('wraps Saturday late UTC to Sunday in a zone ahead of UTC', () => {
    const local = localActivity(activity([[6, 23, 4]]), NOW, 'Europe/Berlin');
    expect(local.grid[row(0)][1]).toBe(1);
  });

  it('is the identity in UTC', () => {
    const local = localActivity(activity([[5, 20, 4]]), NOW, 'UTC');
    expect(local.grid[row(5)][20]).toBe(1);
  });
});

describe('localDayHour', () => {
  it('reads the weekday and hour in the given zone', () => {
    expect(localDayHour(new Date('2026-09-30T02:30:00Z'), 'America/Chicago')).toEqual({ day: 2, hour: 21 });
  });
});

describe('busiestWindow', () => {
  it('spans the hours at or above half the peak, wrapping past midnight', () => {
    const byHour = new Array(24).fill(0);
    byHour[21] = 3; byHour[22] = 6; byHour[23] = 8; byHour[0] = 10; byHour[1] = 5; byHour[2] = 2;
    expect(busiestWindow(byHour)).toEqual({ start: 22, end: 2 });
  });

  it('is null with no data and when every hour is busy', () => {
    expect(busiestWindow(new Array(24).fill(0))).toBeNull();
    expect(busiestWindow(new Array(24).fill(3))).toBeNull();
  });
});

describe('nowLevel', () => {
  it('grades the current cell against the busiest one', () => {
    const local = localActivity(activity([[2, 1, 12], [2, 2, 4], [2, 3, 1]]), NOW, 'UTC');
    expect(nowLevel(local, 2, 1)).toBe('busy');
    expect(nowLevel(local, 2, 2)).toBe('some');
    expect(nowLevel(local, 2, 3)).toBe('quiet');
    expect(nowLevel(local, 4, 12)).toBe('quiet');
  });
});

describe('waitWords', () => {
  it('rounds to something a person would say', () => {
    expect(waitWords(40)).toBe('about a minute');
    expect(waitWords(7 * 60 + 20)).toBe('about 7 minutes');
    expect(waitWords(3600)).toBe('about 1 hour');
    expect(waitWords(5700)).toBe('about 1.5 hours');
  });
});
