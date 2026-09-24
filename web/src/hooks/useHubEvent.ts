import { useEffect, useRef } from 'preact/hooks';

/**
 * Call `fn` when the server's hub broadcasts one of `names`.
 *
 * The app's own socket lives in useLiveState at the root and re-fetches the
 * player state on EVERY message, whatever it is called. The admin board cannot
 * ride that: the spectator feed broadcasts 'live' several times a second
 * during a match, and the board wants 'refresh' only. So it listens for
 * itself, by name. One extra socket per open admin board is nothing.
 *
 * Same reconnect as useLiveState. Does nothing where there is no WebSocket.
 */
export function useHubEvent(names: string[], fn: () => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  const key = names.join(',');

  useEffect(() => {
    if (typeof WebSocket === 'undefined') return undefined;
    const wanted = new Set(key.split(','));
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (m) => {
        try {
          const { event } = JSON.parse(String(m.data)) as { event?: string };
          if (event && wanted.has(event)) latest.current();
        } catch {
          /* not one of ours */
        }
      };
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
  }, [key]);
}
