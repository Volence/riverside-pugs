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
  /** How many whole duos the last takeBatch passed over (reached but did not
   *  fit, and not swapped in), for the duo trial review. */
  lastSkippedDuos = 0;

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
   *  is the wait until a ready check started.
   *
   *  With `partnerOf`, a duo whose two members are both queued is taken whole
   *  or not at all (src/duos.ts). A duo that does not fit keeps its place and
   *  the next solo behind it fills the slot.
   *
   *  When nobody behind can fill the last slot (a duo joining behind 7 solos
   *  makes 9), nothing is taken and this returns []: the pop waits for one
   *  more player. Owner 2026-10-21: bumping a solo who had waited the whole
   *  queue to make room for a duo that just joined is the worse wait. */
  takeBatch(n: number, partnerOf?: (id: string) => string | null): string[] {
    const taken: string[] = [];
    const skipped: [string, string][] = [];
    const done = new Set<string>();
    for (const id of this.order) {
      if (taken.length >= n) break;
      if (done.has(id)) continue;
      const p = partnerOf?.(id) ?? null;
      if (p && p !== id && this.order.includes(p)) {
        done.add(id);
        done.add(p);
        if (taken.length + 2 <= n) taken.push(id, p);
        else skipped.push([id, p]);
        continue;
      }
      done.add(id);
      taken.push(id);
    }
    if (taken.length < n) {
      this.lastSkippedDuos = 0;
      return [];
    }
    this.lastSkippedDuos = skipped.length;
    const out = new Set(taken);
    this.order = this.order.filter((id) => !out.has(id));
    for (const id of taken) this.end(id, 'popped');
    return taken;
  }

  /** A held pop forced through after duo_hold_max_minutes (src/matchmaker.ts):
   *  the same walk in queue order as takeBatch, but the first duo that does
   *  not fit takes the place of the latest queued solo(s) already taken.
   *  Those solos stay queued, move to the FRONT so they are first in the next
   *  pop, and keep their wait. Takes nothing (taken []) when even that cannot
   *  make `n`. */
  takeBatchBumping(n: number, partnerOf: (id: string) => string | null): { taken: string[]; bumped: string[] } {
    const units: string[][] = [];
    let size = 0;
    let bumped: string[] = [];
    let skipped = 0;
    const done = new Set<string>();
    for (const id of this.order) {
      if (size >= n) break;
      if (done.has(id)) continue;
      done.add(id);
      const p = partnerOf(id);
      if (!p || p === id || !this.order.includes(p)) {
        units.push([id]);
        size += 1;
        continue;
      }
      done.add(p);
      if (size + 2 <= n) {
        units.push([id, p]);
        size += 2;
        continue;
      }
      // Bump only once: the first duo that does not fit is the one held.
      const need = size + 2 - n;
      const solos = units.filter((u) => u.length === 1);
      if (bumped.length > 0 || solos.length < need) {
        skipped++;
        continue;
      }
      const out = new Set(solos.slice(-need).map((u) => u[0]));
      bumped = this.order.filter((x) => out.has(x));
      for (let i = units.length - 1; i >= 0; i--) if (units[i].length === 1 && out.has(units[i][0])) units.splice(i, 1);
      units.push([id, p]);
      size = size - need + 2;
    }
    const taken = units.flat();
    if (taken.length < n) {
      this.lastSkippedDuos = 0;
      return { taken: [], bumped: [] };
    }
    this.lastSkippedDuos = skipped;
    const gone = new Set([...taken, ...bumped]);
    this.order = [...bumped, ...this.order.filter((id) => !gone.has(id))];
    for (const id of taken) this.end(id, 'popped');
    return { taken, bumped };
  }

  requeueFront(steamids: string[]): void {
    const back = steamids.filter((id) => !this.order.includes(id));
    this.order = [...back, ...this.order];
    const at = this.now();
    for (const id of back) this.since.set(id, { at, requeued: true });
  }

  /** Seat a new duo together at the later of the two spots, so forming a duo
   *  never jumps the line. One not queued counts as the back: it joins, and
   *  the queued one moves back beside it. */
  placePair(a: string, b: string): void {
    const ia = this.order.indexOf(a);
    const ib = this.order.indexOf(b);
    if (ia < 0 && ib < 0) return;
    if (ia >= 0 && ib >= 0) {
      const [first, second] = ia < ib ? [a, b] : [b, a];
      this.order.splice(this.order.indexOf(first), 1);
      this.order.splice(this.order.indexOf(second) + 1, 0, first);
      return;
    }
    const queued = ia >= 0 ? a : b;
    const other = ia >= 0 ? b : a;
    this.order.splice(this.order.indexOf(queued), 1);
    this.order.push(queued, other);
    this.since.set(other, { at: this.now(), requeued: false });
  }
}
