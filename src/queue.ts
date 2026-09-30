export const QUEUE_SIZE = 8;

/** How a stint in the queue ended: the player was taken into a pop, or they
 *  left the queue some other way (Leave, a ban, a staff removal). */
export type StintOutcome = 'popped' | 'left';

/** One continuous stretch a player spent in the queue, from joining to
 *  leaving it. Times are epoch ms. `requeued` marks a stint that began because
 *  a pop failed or was cancelled and the player was put back at the front, so
 *  its wait is not a fresh one and the wait figures leave it out. */
export interface QueueStint {
  steamid: string;
  joinedAt: number;
  endedAt: number;
  outcome: StintOutcome;
  requeued: boolean;
}

export interface QueueHooks {
  now?: () => number;
  /** Called once per stint as it ends. Must not throw into the queue: the
   *  caller wraps it. */
  onStintEnd?: (stint: QueueStint) => void;
}

export class Queue {
  private order: string[] = [];
  /** When each queued player's current stint began. */
  private since = new Map<string, { at: number; requeued: boolean }>();

  constructor(private hooks: QueueHooks = {}) {}

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }

  private end(steamid: string, outcome: StintOutcome): void {
    const s = this.since.get(steamid);
    this.since.delete(steamid);
    if (!s || !this.hooks.onStintEnd) return;
    try {
      this.hooks.onStintEnd({ steamid, joinedAt: s.at, endedAt: this.now(), outcome, requeued: s.requeued });
    } catch (err) {
      console.error('[queue] stint hook failed:', err);
    }
  }

  /** `joinedAt` is for restoring a queue saved by a previous process, so a
   *  deploy does not reset everyone's wait to zero. */
  join(steamid: string, joinedAt?: number, requeued = false): void {
    if (this.order.includes(steamid)) return;
    this.order.push(steamid);
    this.since.set(steamid, { at: joinedAt ?? this.now(), requeued });
  }

  leave(steamid: string): void {
    if (!this.order.includes(steamid)) return;
    this.order = this.order.filter((id) => id !== steamid);
    this.end(steamid, 'left');
  }

  has(steamid: string): boolean {
    return this.order.includes(steamid);
  }

  count(): number {
    return this.order.length;
  }

  list(): string[] {
    return [...this.order];
  }

  /** When each queued player's current stint began, for saving. */
  joinTimes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this.order) {
      const s = this.since.get(id);
      if (s) out[id] = s.at;
    }
    return out;
  }

  /** Queued players whose current stint is a requeue, for saving. */
  requeuedIds(): string[] {
    return this.order.filter((id) => this.since.get(id)?.requeued);
  }

  /** A pop ends the stint even if its ready check later fails: a wait here
   *  is the wait until a ready check started. */
  takeBatch(n: number): string[] {
    const taken = this.order.splice(0, n);
    for (const id of taken) this.end(id, 'popped');
    return taken;
  }

  requeueFront(steamids: string[]): void {
    const back = steamids.filter((id) => !this.order.includes(id));
    this.order = [...back, ...this.order];
    const at = this.now();
    for (const id of back) this.since.set(id, { at, requeued: true });
  }
}
