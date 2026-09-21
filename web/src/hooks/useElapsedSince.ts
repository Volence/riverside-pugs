import { useEffect, useState } from 'preact/hooks';

/**
 * Seconds since `at` (an epoch millisecond from Date.now()), re-rendered as
 * it grows.
 *
 * THE ticker for the live board: called once, at the top, and the number is
 * handed down. Every countdown on the page is the server's figure minus this,
 * so they all flip on the same frame and a board with two matches and three
 * dropped players still runs one interval, not one per row. 250 ms for the
 * same reason Countdown.tsx polls at that rate: the displayed second flips
 * close to when it really changes.
 *
 * Only ever compares Date.now() with an earlier Date.now() from the same
 * browser, so a wrong clock on the admin's machine cancels out.
 */
export function useElapsedSince(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return at === null ? 0 : Math.max(0, (now - at) / 1000);
}
