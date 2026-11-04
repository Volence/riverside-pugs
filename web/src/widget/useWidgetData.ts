import { useEffect, useState } from 'preact/hooks';
import type { WidgetPayload } from '../../../src/widgetTypes';

/**
 * The data behind a stream widget: GET /api/widget/<steamid>, polled. A
 * failed or slow poll keeps what is on screen rather than blanking a widget
 * that is on air; only a 404 (no such player, or banned) takes it down.
 */

export const WIDGET_POLL_MS = 20_000;
const TIMEOUT_MS = 8000;

export type WidgetState = { kind: 'loading' } | { kind: 'ok'; data: WidgetPayload } | { kind: 'gone' };

/** The one place the endpoint URL is built (the profile preview uses it too).
 *  tz is minutes east of UTC, for the server's "today". */
export function widgetApiPath(steamid: string, since: number | null, tzOffsetMin: number = -new Date().getTimezoneOffset()): string {
  return `/api/widget/${encodeURIComponent(steamid)}?tz=${tzOffsetMin}&since=${since ?? ''}`;
}

/** A session older than this is from an earlier stream. */
const SESSION_MAX_MS = 12 * 3_600_000;

/**
 * When "this stream" started, kept per player in this browser source's
 * storage so an OBS reload mid-stream keeps counting. Missing, unreadable or
 * older than 12 h starts a new session now; so does `reset`.
 */
export function sessionSince(steamid: string, now = Date.now(), reset = false): number {
  const key = `widget-session-${steamid}`;
  if (!reset) {
    let stored: number = Number.NaN;
    try { stored = Number(localStorage.getItem(key) ?? Number.NaN); } catch { /* no storage */ }
    if (Number.isFinite(stored) && stored <= now && now - stored <= SESSION_MAX_MS) return stored;
  }
  try { localStorage.setItem(key, String(now)); } catch { /* no storage: a session per load */ }
  return now;
}

export function useWidgetData(steamid: string, opts: { since: number | null }): WidgetState {
  const { since } = opts;
  const [state, setState] = useState<WidgetState>({ kind: 'loading' });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = stopped ? null : setTimeout(() => void poll(), WIDGET_POLL_MS);
    };
    const poll = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try {
        const res = await fetch(widgetApiPath(steamid, since), { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (stopped) return;
        if (res.status === 404) setState({ kind: 'gone' });
        else if (res.ok) {
          const data = await res.json() as WidgetPayload;
          if (!stopped) setState({ kind: 'ok', data });
        }
        // Any other status: keep the last good state.
      } catch { /* network or timeout: keep the last good state */ }
      finally {
        inFlight = false;
        schedule();
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };

    void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [steamid, since]);
  return state;
}
