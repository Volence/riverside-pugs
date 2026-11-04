import { useEffect, useRef } from 'preact/hooks';

/**
 * Call `fn` with the name when the server's hub broadcasts one of `names`.
 *
 * The app's own socket lives in useLiveState at the root and re-fetches the
 * player state on 'refresh' only (see wakesLiveState). A page that wants any
 * other name ('live', a draft room, the staff chat) listens for itself, by
 * name. One extra socket per open page that needs it is nothing.
 *
 * Same reconnect as useLiveState. Does nothing where there is no WebSocket.
 */
export function useHubEvent(names: string[], fn: (event: string) => void): void {
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
          if (event && wanted.has(event)) latest.current(event);
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
