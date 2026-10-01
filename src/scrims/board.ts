import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import { expire, getAccept } from './scrims.js';
import { scrimMessage, scrimSideManagers } from './messages.js';

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

  /** The minute pass. Never runs two at once, and never rejects: a caller
   *  only ever does `void board.tick()` from a timer, so a thrown error here
   *  would otherwise surface as an unhandled rejection rather than a logged
   *  line. expire() and poster.tickNow() are caught separately, so a poster
   *  refresh still happens even if expiring posts failed, and vice versa. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      try {
        const result = expire(this.db, new Date(this.now()));
        this.notifyLost(result.accepts, 'it expired');
        this.notifyLost(result.withdrawn.accepts, 'the team was disbanded');
      } catch (err) {
        console.error('[scrims] expire() failed:', err instanceof Error ? err.message : err);
      }
      try {
        this.deps.poster?.()?.tickNow();
      } catch (err) {
        console.error('[scrims] poster.tickNow() failed:', err instanceof Error ? err.message : err);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Tells every current manager of each lost accepter's side (not just the
   *  acceptance's stored captain_steamid, which can be stale: a team accept
   *  may since have grown a co-captain). A failure to word or send one
   *  notice must not stop the rest. */
  private notifyLost(acceptIds: number[], reason: string): void {
    for (const acceptId of acceptIds) {
      const a = getAccept(this.db, acceptId);
      if (!a) continue;
      try {
        const payload = scrimMessage(this.db, this.deps.publicUrl, a.post_id, 'scrim_declined', { reason });
        if (payload) this.deps.notifier.send(scrimSideManagers(this.db, a), 'scrim_declined', payload);
      } catch (err) {
        console.warn(`[scrims] expiry notice for accept ${acceptId} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
}
