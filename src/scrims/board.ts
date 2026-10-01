import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import { expire, getAccept } from './scrims.js';
import { scrimMessage } from './messages.js';

/**
 * The scrim board's minute tick (plan 1, Task 3): expires posts and stale
 * acceptances (src/scrims/scrims.ts's expire, which also withdraws posts
 * whose team was disbanded) and tells every accepter who lost a pending
 * acceptance that way. Nothing here writes to scrim_posts or scrim_accepts;
 * expire() already did, inside its own transaction.
 */

export const TICK_MS = 60_000;

/** The scrim board's Discord poster (plan 1, Task 4): refreshes the
 *  `#scrims` cards. Not built yet; ScrimBoard calls it only when one is
 *  wired, so this task's tick works with or without it. */
export interface ScrimPoster {
  tickNow(): void;
}

export interface ScrimBoardDeps {
  db: DB;
  notifier: Notifier;
  publicUrl: string;
  /** Absent until plan 1 Task 4 wires the Discord poster. Read per tick,
   *  like the booking runner reads its voice and bot transport, since the
   *  poster may start existing only after this board is built. */
  poster?: () => ScrimPoster | null;
  now?: () => number;
}

export class ScrimBoard {
  private readonly db: DB;
  private readonly now: () => number;
  private ticking = false;

  constructor(private readonly deps: ScrimBoardDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  /** The minute pass. Never runs two at once. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = expire(this.db, new Date(this.now()));
      const lost = [...result.accepts, ...result.withdrawn.accepts];
      for (const acceptId of lost) {
        const a = getAccept(this.db, acceptId);
        if (!a) continue;
        try {
          const payload = scrimMessage(this.db, this.deps.publicUrl, a.post_id, 'scrim_declined', { reason: 'it expired' });
          if (payload) this.deps.notifier.send([a.captain_steamid], 'scrim_declined', payload);
        } catch (err) {
          console.warn(`[scrims] expiry notice for accept ${acceptId} failed:`, err instanceof Error ? err.message : err);
        }
      }
      this.deps.poster?.()?.tickNow();
    } finally {
      this.ticking = false;
    }
  }
}
