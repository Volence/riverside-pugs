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

/** Whether the match page asks for the endorse panel at all: a completed PUG
 *  only, since a scrim or tournament match never takes endorsements (the
 *  server's gate refuses them too). An older server sends no kind: a PUG. */
export const endorsable = (m: { state: string; kind?: string }): boolean => m.state === 'completed' && (m.kind ?? 'pug') === 'pug';
