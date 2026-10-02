import { useEffect, useState } from 'preact/hooks';
import type { OverlayFeed } from '../../../src/cast/types';

export type FeedState =
  | { kind: 'loading' }
  | { kind: 'ok'; feed: OverlayFeed; skewMs: number }
  | { kind: 'refused'; status: number; error: string };

const POLL_MS = 1000;

/** Feed messages as the worker and the fallback poll both deliver them. */
type Msg = { ok: true; feed: OverlayFeed; at: number } | { ok: false; status: number; error: string };

/**
 * The overlay feed for one key: through the shared worker when the browser
 * has one, else a poll of its own. A network blip keeps the last good feed
 * on screen rather than blanking a live broadcast; only a refusal (a dead or
 * revoked key) replaces it.
 */
export function useFeed(key: string): FeedState {
  const [state, setState] = useState<FeedState>({ kind: 'loading' });
  useEffect(() => {
    let stopped = false;
    const onMsg = (m: Msg) => {
      if (stopped) return;
      if (m.ok) setState({ kind: 'ok', feed: m.feed, skewMs: m.feed.serverNow - m.at });
      else if (m.status === 401 || m.status === 403) setState({ kind: 'refused', status: m.status, error: m.error });
    };
    if (!key) {
      setState({ kind: 'refused', status: 401, error: 'This overlay link has no key. Copy it from the caster studio.' });
      return;
    }
    let cleanup = () => {};
    try {
      if (typeof SharedWorker === 'undefined') throw new Error('no SharedWorker');
      const w = new SharedWorker(new URL('./feedWorker.ts', import.meta.url), { type: 'module', name: 'riverside-overlay-feed' });
      w.port.onmessage = (e: MessageEvent<Msg>) => onMsg(e.data);
      w.port.start();
      w.port.postMessage({ type: 'watch', key });
      const alive = setInterval(() => w.port.postMessage({ type: 'alive', key }), 5000);
      cleanup = () => { clearInterval(alive); w.port.close(); };
    } catch {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const poll = async () => {
        try {
          const res = await fetch(`/api/overlay/feed?k=${encodeURIComponent(key)}`, { cache: 'no-store' });
          if (res.ok) onMsg({ ok: true, feed: await res.json() as OverlayFeed, at: Date.now() });
          else onMsg({ ok: false, status: res.status, error: (await res.json().catch(() => ({})) as { error?: string }).error ?? '' });
        } catch { /* keep the last good feed */ }
        if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
      };
      void poll();
      cleanup = () => { if (timer) clearTimeout(timer); };
    }
    return () => { stopped = true; cleanup(); };
  }, [key]);
  return state;
}
