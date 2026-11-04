import { useEffect, useRef, useState } from 'preact/hooks';
import type { WidgetPayload } from '../../../src/widgetTypes';
import { useHubEvent } from '../hooks/useHubEvent';

/**
 * The data behind a stream widget: GET /api/widget/<steamid>, fetched when
 * the site's hub says something changed and polled as a fallback. A failed
 * or slow poll keeps what is on screen rather than blanking a widget that is
 * on air; only a 404 (no such player, or banned) takes it down.
 */

export const WIDGET_POLL_MS = 20_000;
const TIMEOUT_MS = 8000;

/** After a 'live' broadcast (a half or a map just ended): fetch once the live
 *  view's delay (DEFAULT_DELAY_MS, src/replayTail.ts) has released the new
 *  score, with a little room for the server's clock. */
export const LIVE_NUDGE_MS = 11_500;
/** After a 'refresh' (a match finished, the queue moved): nothing is held back. */
export const REFRESH_NUDGE_MS = 1_000;
/** Spread so every widget on air does not ask in the same instant. */
export const NUDGE_JITTER_MS = 2_000;

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
  const nudgeRef = useRef<(ms: number) => void>(() => {});
  useHubEvent(['live', 'refresh'], (event) => {
    nudgeRef.current((event === 'live' ? LIVE_NUDGE_MS : REFRESH_NUDGE_MS) + Math.random() * NUDGE_JITTER_MS);
  });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dueAt = 0;
    let inFlight = false;
    let again = false;

    /** Poll in `ms`, unless one is already due sooner. A nudge that lands
     *  during a fetch survives it: the fetch clears the timer when it starts. */
    const schedule = (ms: number) => {
      if (stopped || (timer && dueAt <= Date.now() + ms)) return;
      if (timer) clearTimeout(timer);
      dueAt = Date.now() + ms;
      timer = setTimeout(() => { timer = null; void poll(); }, ms);
    };
    const poll = async () => {
      if (stopped) return;
      // Due while a slow fetch is out: that fetch may predate the change, so
      // ask again as soon as it is back.
      if (inFlight) { again = true; return; }
      inFlight = true;
      again = false;
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
        schedule(again ? 0 : WIDGET_POLL_MS);
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };

    nudgeRef.current = schedule;
    void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      nudgeRef.current = () => {};
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [steamid, since]);
  return state;
}
