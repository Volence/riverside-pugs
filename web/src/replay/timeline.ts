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
 * Nothing in the future is ever returned, and nothing older than the window.
 * That is presentation, not protection: the server only serves a timeline for
 * a completed match, so there is nothing here to hold back. A live timeline
 * would need its own server-side cutoff, the way the frames have one, rather
 * than relying on this filter.
 */
export function activeEntries(
  entries: TimelineEntry[], tMs: number, windowMs = DEFAULT_WINDOW_MS,
): TimelineEntry[] {
  const from = tMs - windowMs;
  return entries.filter((e) => e.tMs <= tMs && e.tMs >= from);
}
