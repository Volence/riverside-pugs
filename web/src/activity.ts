import type { QueueActivity } from './api';

/**
 * The "When people play" panel's arithmetic, kept out of the component so it
 * can be tested without a DOM.
 *
 * The server buckets pops by UTC weekday and hour; everything here moves them
 * into the viewer's own time zone. The shift is worked out on real dates in
 * the current week rather than from a fixed offset, so daylight saving and
 * half-hour zones come out the way the viewer's clock reads.
 */

/** Rows of the grid, Monday first, as JavaScript's getDay numbers. */
export const ROW_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

const HOUR_MS = 3_600_000;

export interface LocalActivity {
  /** grid[row][localHour]: pops per week, rows in ROW_DAYS order. */
  grid: number[][];
  /** The largest cell, for scaling. */
  max: number;
  /** Pops per week by local hour, all days together. */
  byHour: number[];
}

/**
 * Shift the UTC grid into local time. `now` anchors the week the shift is
 * computed in; `tz` is only for tests, which pin a zone rather than depend on
 * the machine's. Counts become pops per week over the window.
 */
export function localActivity(a: QueueActivity, now: Date = new Date(), tz?: string): LocalActivity {
  const weeks = Math.max(1, a.days / 7);
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const byHour = new Array<number>(24).fill(0);
  // Sunday 00:00 UTC of the current week.
  const sunday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay());
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      const n = a.pops[dow]?.[h] ?? 0;
      if (!n) continue;
      const { day, hour } = localDayHour(new Date(sunday + (dow * 24 + h) * HOUR_MS), tz);
      const rate = n / weeks;
      grid[ROW_DAYS.indexOf(day as typeof ROW_DAYS[number])][hour] += rate;
      byHour[hour] += rate;
    }
  }
  let max = 0;
  for (const row of grid) for (const v of row) max = Math.max(max, v);
  return { grid, max, byHour };
}

const WEEKDAY_NUM: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local weekday (getDay numbering) and hour of an instant. */
export function localDayHour(d: Date, tz?: string): { day: number; hour: number } {
  if (!tz) return { day: d.getDay(), hour: d.getHours() };
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(d);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hr = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return { day: WEEKDAY_NUM[wd] ?? 0, hour: hr % 24 };
}

/**
 * The busiest stretch of the day: the run of consecutive hours (wrapping past
 * midnight) around the peak hour where activity stays at or above half the
 * peak. Null when there is nothing to go on.
 */
export function busiestWindow(byHour: number[]): { start: number; end: number } | null {
  const peak = Math.max(...byHour);
  if (!(peak > 0)) return null;
  const at = byHour.indexOf(peak);
  const hot = (h: number) => byHour[(h + 24) % 24] >= peak / 2;
  let start = at;
  let end = at;
  for (let i = 0; i < 23 && hot(start - 1) && (start - 1 + 24) % 24 !== end; i++) start = (start - 1 + 24) % 24;
  for (let i = 0; i < 23 && hot(end + 1) && (end + 1) % 24 !== start; i++) end = (end + 1) % 24;
  // `end` is the last busy hour; the window closes at the top of the next.
  // Busy around the clock is no window at all.
  if ((end + 1) % 24 === start) return null;
  return { start, end: (end + 1) % 24 };
}

export type NowLevel = 'busy' | 'some' | 'quiet';

/** How the viewer's current hour compares with the busiest cell. */
export function nowLevel(local: LocalActivity, day: number, hour: number): NowLevel {
  if (local.max <= 0) return 'quiet';
  const v = local.grid[ROW_DAYS.indexOf(day as typeof ROW_DAYS[number])]?.[hour] ?? 0;
  if (v >= local.max / 2) return 'busy';
  if (v >= local.max / 6) return 'some';
  return 'quiet';
}

/** "9 PM" or "21:00", whichever the viewer's locale uses. */
export function hourLabel(hour: number, locale?: string): string {
  const d = new Date(2026, 0, 4, hour, 0, 0);
  return d.toLocaleTimeString(locale, { hour: 'numeric' });
}

/** A wait in words, rounded to what anyone would say out loud. */
export function waitWords(sec: number): string {
  if (sec < 90) return 'about a minute';
  const min = Math.round(sec / 60);
  if (min < 60) return `about ${min} minutes`;
  const h = Math.round((sec / 3600) * 2) / 2;
  return `about ${h} hour${h === 1 ? '' : 's'}`;
}
