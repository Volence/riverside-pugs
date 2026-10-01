import type { DB } from '../db.js';
import { getSetting, settingNumber } from '../settings.js';

/**
 * The weekly scrim night window (scrim spec section 5; plan 2 Ruling 7): a
 * pure function of three settings and the clock, never counted in place.
 * scrim_night_day off, or scrim_night_start_utc failing to parse, turns the
 * whole feature off: nightWindow and inNight both read that as "no window".
 */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

export interface NightWindow { startsAt: string; endsAt: string }

const DAY_MS = 86_400_000;

/** "HH:MM" (24 hour) to minutes since midnight, or null when it does not parse. */
function parseHHMM(raw: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The occurrence of the configured weekday and time whose date is on or
 *  before `atMs`'s own UTC date, within the same week (so at most 6 days
 *  earlier). Null when the day is off or the start time does not parse. */
function occurrenceAtOrBefore(db: DB, atMs: number): { startMs: number; durationMs: number } | null {
  const day = getSetting(db, 'scrim_night_day') ?? 'off';
  const dayIndex = DAYS.indexOf(day as (typeof DAYS)[number]);
  if (dayIndex === -1) return null;
  const startMinutes = parseHHMM(getSetting(db, 'scrim_night_start_utc') ?? '');
  if (startMinutes === null) return null;
  const hours = settingNumber(db, 'scrim_night_hours', 4, { integer: true, min: 1, max: 12 });

  const at = new Date(atMs);
  const atDay = at.getUTCDay();
  const atMidnightMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const offsetDays = (atDay - dayIndex + 7) % 7;
  const startMs = atMidnightMs - offsetDays * DAY_MS + startMinutes * 60_000;
  return { startMs, durationMs: hours * 3_600_000 };
}

/** The next or current weekly window: the configured weekday and time in
 *  UTC, lasting the configured hours, possibly crossing midnight. If `nowMs`
 *  is inside a window, that one comes back; otherwise the next one does.
 *  Null when the day is off or the time setting does not parse. */
export function nightWindow(db: DB, nowMs: number = Date.now()): NightWindow | null {
  const occ = occurrenceAtOrBefore(db, nowMs);
  if (!occ) return null;
  // The most recent occurrence within the last week either still holds now
  // (inside it) or already ended; once it has ended the next one is exactly
  // a week later (the window never spans more than a day, let alone a week).
  const startMs = nowMs >= occ.startMs + occ.durationMs ? occ.startMs + 7 * DAY_MS : occ.startMs;
  return { startsAt: new Date(startMs).toISOString(), endsAt: new Date(startMs + occ.durationMs).toISOString() };
}

/** Whether a post's start falls inside any weekly occurrence of the window. */
export function inNight(db: DB, startsAtIso: string): boolean {
  const ms = Date.parse(startsAtIso);
  if (!Number.isFinite(ms)) return false;
  const occ = occurrenceAtOrBefore(db, ms);
  if (!occ) return false;
  return ms >= occ.startMs && ms < occ.startMs + occ.durationMs;
}
