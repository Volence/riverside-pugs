/**
 * "Look at this again", from the site to whatever keeps Discord in step with
 * it (TicketSync, when the bot is running).
 *
 * A process-wide bus for the reason adminFeed.ts and banEvents.ts are: the
 * publishers are ticket actions and admin routes that know nothing about
 * Discord, and a missing subscriber must cost nothing. Publishing never
 * throws, and is always done AFTER the transaction that made the change has
 * committed: the subscriber dials Discord.
 *
 * This is latency only. TicketSync also runs on a timer and works everything
 * out from the database, so a lost signal delays a thread by a few minutes
 * and loses nothing.
 *
 * A signal carries an id and nothing else, and never leaves the process, so
 * it is safe to publish for a restricted ticket.
 */
export type TicketSignal =
  // Something about this ticket changed: a report, a claim, a close, access.
  | { kind: 'ticket'; ticketId: number }
  // Who is staff, or who has Discord linked, changed: a flag, a merge, a link.
  | { kind: 'staff' };

type Listener = (s: TicketSignal) => void;
const listeners = new Set<Listener>();

export function publishTicketSignal(s: TicketSignal): void {
  for (const fn of listeners) {
    try {
      fn(s);
    } catch (err) {
      console.error('[tickets] signal listener failed:', err);
    }
  }
}

export function subscribeTicketSignals(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
