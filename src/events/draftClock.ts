// src/events/draftClock.ts
import type { DB } from '../db.js';
import { autoPickDue, type Present } from './draftRoom.js';

export const DRAFT_TICK_MS = 1_000;
/** Ruling 8: a heartbeat every 10 s, so 25 s is two missed beats. */
export const HEARTBEAT_FRESH_MS = 25_000;

/**
 * The live draft room's clock (drafts plan D2b1 Rulings 7 and 8). Presence
 * is the only state it holds, in memory: who sent a room heartbeat in the
 * last 25 s, per event. A restart forgets it, so for the first 25 s after
 * the clock is made (the startup grace, one freshness window) everyone reads
 * as present: a picker whose page has not beaten yet is not handed a 5 s
 * clock by an overdue auto-pick. The stored deadline of the running pick is
 * never touched by any of it. tick() runs every second from src/server.ts and
 * auto-picks for each running room whose deadline has passed; a fault in
 * one room is logged and never stops the rest. push tells the pages
 * (hub event draft:<eventId>) and never throws.
 */
export class DraftClock {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(private readonly deps: { db: DB; push?: (eventId: number) => void; now?: () => number }) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** The one clock the room routes use, so tests can move it. */
  nowDate(): Date {
    return new Date(this.now());
  }

  heartbeat(eventId: number, steamid: string): void {
    this.seen.set(`${eventId}:${steamid}`, this.now());
  }

  present(eventId: number): Present {
    const t = this.now();
    if (t - this.startedAt <= HEARTBEAT_FRESH_MS) return () => true;
    return (steamid) => {
      const last = this.seen.get(`${eventId}:${steamid}`);
      return last !== undefined && t - last <= HEARTBEAT_FRESH_MS;
    };
  }

  push(eventId: number): void {
    try { this.deps.push?.(eventId); } catch (err) { console.warn('[draft] push failed:', err instanceof Error ? err.message : err); }
  }

  tick(): void {
    const t = this.now();
    for (const [k, last] of this.seen) if (t - last > HEARTBEAT_FRESH_MS) this.seen.delete(k);
    const now = new Date(t);
    const due = this.deps.db.prepare(
      "SELECT event_id FROM draft_rooms WHERE status = 'running' AND deadline_at IS NOT NULL AND deadline_at <= ?",
    ).all(now.toISOString()) as { event_id: number }[];
    for (const { event_id: eventId } of due) {
      try {
        const r = autoPickDue(this.deps.db, { eventId, now, present: this.present(eventId) });
        if (r.ok) this.push(eventId);
      } catch (err) {
        console.error(`[draft] auto-pick for event ${eventId} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
}
