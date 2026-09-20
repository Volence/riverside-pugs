/**
 * "A ban changed", published from the three writers of the bans table and
 * consumed by whatever enforces bans somewhere else (today, ServerBanSync).
 *
 * A process-wide bus for the same reason adminFeed.ts is one: the writers are
 * reached from the admin routes, the abandon handler and the 60 second reaper,
 * none of which have any business holding an RCON client, and a missing
 * subscriber must cost nothing. Publishing never throws.
 *
 * This is latency only. Correctness comes from the sweep in serverBans.ts,
 * which reads the table and does not rely on having been told.
 */

export type BanChange =
  | { kind: 'ban'; steamid: string; reason: string }
  | { kind: 'unban'; steamid: string };

type Listener = (e: BanChange) => void;
const listeners = new Set<Listener>();

export function publishBanChange(e: BanChange): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch (err) {
      console.error('[banEvents] listener failed:', err);
    }
  }
}

export function subscribeBanChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
