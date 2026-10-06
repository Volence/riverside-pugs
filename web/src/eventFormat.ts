import type { EventStatus } from './api';

/** Event statuses as people read them. */
export const STATUS_LABEL: Record<EventStatus, string> = {
  draft: 'Draft', announced: 'Announced', registration: 'Registration open', checkin: 'Check-in',
  live: 'Live', finished: 'Finished', cancelled: 'Cancelled',
};

/** "in 2 days 3 h", "in 5 h 10 min", "in 42 min", or "starting now". A part
 *  minute rounds up, so it never says "in 0 min" before the start. */
export function untilText(iso: string, nowMs: number = Date.now()): string {
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return 'starting now';
  const mins = Math.ceil(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days >= 2) return `in ${days} days ${hours} h`;
  if (mins >= 60) return `in ${days * 24 + hours} h ${mins % 60} min`;
  return `in ${mins} min`;
}

/** A stored UTC time in the viewer's own zone (Ruling 11). */
export function whenText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** ISO UTC to the value a datetime-local input shows: the viewer's zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A datetime-local value, read in the viewer's zone, as ISO UTC; null if it
 *  is not one. A value without a zone is local time to Date, which is the
 *  point. At the hour a clock goes back, the earlier of the two is taken. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "Oct 26 to Nov 1" for a league week. The days are calendar days, so they
 *  are read and shown in UTC and never shift with the viewer's time zone. */
export function weekRangeText(from: string, to: string): string {
  const f = (d: string) => new Date(`${d}T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(from)} to ${f(to)}`;
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
export function placementText(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}
