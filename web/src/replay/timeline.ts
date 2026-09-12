export interface TimelineEntry {
  seq: number;
  tMs: number;
  kind: 'event' | 'chat';
  text: string;
  actor: string;
  team: string | null;
}

/** How much history the rail shows by default. Long enough to read what just
 *  happened, short enough that it is not a wall of text during a horde. */
export const DEFAULT_WINDOW_MS = 20_000;

/**
 * Entries the viewer may show at this moment.
 *
 * Nothing in the future is ever returned. On a saved replay that is a
 * convenience, because seeing a death announced before it happens spoils the
 * clip. On a live one it also matters that it never widens what the server
 * chose to release.
 */
export function activeEntries(
  entries: TimelineEntry[], tMs: number, windowMs = DEFAULT_WINDOW_MS,
): TimelineEntry[] {
  const from = tMs - windowMs;
  return entries.filter((e) => e.tMs <= tMs && e.tMs >= from);
}
