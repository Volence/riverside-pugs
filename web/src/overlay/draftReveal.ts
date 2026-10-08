import type { CastDraftPick, CastDraftView } from '../../../src/cast/types';

/**
 * The pick reveal (drafts plan D2b2 Ruling 5): each overlay's own queue,
 * like auto callouts (callouts.ts), so every OBS source agrees. Pure: the
 * overlay steps it on every render with the feed's draft and its
 * skew-corrected clock.
 */

export const DRAFT_REVEAL_MS = 7000;
/** A queued pick this old (by its server time) is skipped, not replayed. */
export const REVEAL_STALE_MS = 20_000;

export interface DraftReveal { pick: CastDraftPick; key: string; until: number }
export interface RevealQueue {
  /** The draft this queue follows; another draft starts a fresh queue. */
  eventId: number | null;
  /** Keys of the live picks already taken in. */
  seen: ReadonlySet<string>;
  pending: CastDraftPick[];
  showing: DraftReveal | null;
}

export const emptyReveal = (): RevealQueue => ({ eventId: null, seen: new Set(), pending: [], showing: null });

/** The same slot picked again after an undo is a new pick. */
export const revealKey = (p: CastDraftPick): string => `${p.pickNo}:${p.at}:${p.steamid}`;

export function stepReveal(q: RevealQueue, draft: CastDraftView | null, now: number): RevealQueue {
  const eventId = draft?.eventId ?? null;
  const picks = draft?.picks ?? [];
  const live = new Set(picks.map(revealKey));
  // The first feed of a draft (or another draft): what is there is history.
  if (eventId !== q.eventId) return { eventId, seen: live, pending: [], showing: null };
  const fresh = picks.filter((p) => !q.seen.has(revealKey(p)));
  // An undone pick leaves the queue and the screen at once (Review Focus 3).
  let pending = [...q.pending, ...fresh].filter((p) => live.has(revealKey(p)) && now - Date.parse(p.at) <= REVEAL_STALE_MS);
  let showing = q.showing && live.has(q.showing.key) && now < q.showing.until ? q.showing : null;
  if (!showing && pending.length > 0) {
    const [next, ...rest] = pending;
    showing = { pick: next!, key: revealKey(next!), until: now + DRAFT_REVEAL_MS };
    pending = rest;
  }
  return { eventId, seen: live, pending, showing };
}
