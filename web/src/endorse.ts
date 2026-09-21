import type { EndorseKind } from './api';

/** Mirrors src/endorsements.ts. There is no negative kind, by design. */
export const ENDORSE_KINDS: EndorseKind[] = ['caller', 'clutch', 'vibes'];

export const ENDORSE_LABEL: Record<EndorseKind, string> = {
  caller: 'Caller',
  clutch: 'Clutch',
  vibes: 'Good vibes',
};

/** Whole hours until a server timestamp (UTC, `YYYY-MM-DD HH:MM:SS`), never
 *  below zero. Null when the timestamp is missing or unreadable. */
export function hoursLeft(closesAt: string | null, nowMs: number = Date.now()): number | null {
  if (!closesAt) return null;
  const t = Date.parse(`${closesAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 3_600_000));
}
