import { eventPhrase } from './eventText';

interface TimelineBase {
  /** Per-match monotonic sequence shared by events and chat, so the two
   *  interleave in the order they really happened. */
  seq: number;
  tMs: number;
}

/** One thing that happened, as the plugin reported it. `event` is the kind
 *  slug (dp, boom, death...); see EVENT_KINDS for how each reads. */
export interface TimelineEvent extends TimelineBase {
  kind: 'event';
  event: string;
  actor: string;
  target: string | null;
  value: number;
}

export interface TimelineChat extends TimelineBase {
  kind: 'chat';
  actor: string;
  team: string | null;
  text: string;
}

export type TimelineEntry = TimelineEvent | TimelineChat;

/** What the rail prints after the speaker or actor: the message, or the
 *  event phrase with every id resolved. */
export function entryText(e: TimelineEntry, nameOf: (id: string) => string): string {
  return e.kind === 'chat' ? e.text : eventPhrase(e, nameOf);
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

/** How far before a bookmark's own moment a seek to it lands (owner
 *  feedback: landing exactly on the tag's timestamp shows the moment right
 *  after it resolved, e.g. a death already lying on the ground, rather than
 *  the setup for it, e.g. the pounce that led there). */
export const BOOKMARK_LEAD_MS = 3000;

/** Where a seek triggered by clicking a bookmark should land: `BOOKMARK_LEAD_MS`
 *  before the event, clamped to the start of the round. Used at every seek
 *  site that jumps to a timeline entry, so a click from the rail, the scrub
 *  ticks or a marker tag on the map all show the same lead-in. */
export function bookmarkSeekMs(tMs: number): number {
  return Math.max(0, tMs - BOOKMARK_LEAD_MS);
}
