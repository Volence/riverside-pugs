import { useEffect, useRef } from 'preact/hooks';

/** What the one websocket (useLiveState) raises on `window` when the server
 *  says a ticket this viewer may see has changed. */
export const TICKETS_EVENT = 'pug:tickets';

/** The event name inside a websocket frame, or null for anything unreadable. */
export function eventName(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  try {
    const v = JSON.parse(data) as { event?: unknown };
    return typeof v.event === 'string' ? v.event : null;
  } catch {
    return null;
  }
}

/** Call `fn` whenever that happens. The server only sends the event to staff
 *  who can see the ticket, so there is nothing to filter here. */
export function useTicketNudge(fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    window.addEventListener(TICKETS_EVENT, h);
    return () => window.removeEventListener(TICKETS_EVENT, h);
  }, []);
}
