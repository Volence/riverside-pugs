import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type Me, type StateSnapshot } from '../api';

export type Session =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'pending'; me: Me }
  | { kind: 'active'; me: Me };

/** Live queue/lobby/match state, refreshed on every websocket nudge.
 *
 *  The wire protocol is unchanged from the vanilla frontend and unchanged by 4a:
 *  the server broadcasts an event *name* with no payload (see src/ws.ts) and the
 *  client re-fetches. That keeps the server free of per-client state diffing, and
 *  at eight players the extra round-trip is not worth engineering away. */
export function useLiveState(): {
  session: Session;
  state: StateSnapshot | null;
  refresh: () => void;
} {
  const [session, setSession] = useState<Session>({ kind: 'loading' });
  const [state, setState] = useState<StateSnapshot | null>(null);
  // Held in a ref so the websocket effect can call the latest refresh without
  // being torn down and reconnected every time the callback identity changes.
  const refreshRef = useRef<() => void>(() => {});

  const refresh = useCallback(async () => {
    let me: Me;
    try {
      me = await api.me();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession({ kind: 'anonymous' });
        setState(null);
        return;
      }
      return; // transient failure: keep showing what we have
    }

    if (me.status !== 'active') {
      setSession({ kind: 'pending', me });
      setState(null);
      return;
    }
    setSession({ kind: 'active', me });

    try {
      setState(await api.state());
    } catch {
      /* leave the previous snapshot up rather than blanking the page */
    }
  }, []);

  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = () => refreshRef.current();
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { session, state, refresh: () => void refresh() };
}
