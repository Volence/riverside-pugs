/**
 * One poll for every overlay page (plan: "one connection for many sources").
 * OBS runs each browser source as its own page; a dozen of them polling the
 * feed once a second each is a dozen requests a second for the same answer.
 * Pages on the same origin share this worker, which polls once per overlay
 * key and posts each answer to every page that asked for that key.
 *
 * A page says it is alive every few seconds; one that goes quiet (its source
 * was removed or hidden with "shutdown when not visible") is dropped, and a
 * key nobody listens to stops polling.
 */

/** The shared worker global, typed by hand: the web project builds against
 *  the DOM lib, which has no SharedWorkerGlobalScope. */
const scope = self as unknown as { onconnect: ((e: MessageEvent) => void) | null };

const POLL_MS = 1000;
const QUIET_MS = 15000;
const FETCH_TIMEOUT_MS = 8000;

interface Listener { port: MessagePort; seenAt: number }
interface Poll { listeners: Set<Listener>; timer: ReturnType<typeof setTimeout> | null; busy: boolean }

const polls = new Map<string, Poll>();

async function tick(key: string): Promise<void> {
  const poll = polls.get(key);
  if (!poll) return;
  const now = Date.now();
  for (const l of poll.listeners) if (now - l.seenAt > QUIET_MS) poll.listeners.delete(l);
  if (poll.listeners.size === 0) { polls.delete(key); return; }
  if (!poll.busy) {
    poll.busy = true;
    let msg: unknown;
    try {
      // A request that never settles would hold `busy` for ever and stop the
      // poll; give up on it and try again next tick.
      const res = await fetch(`/api/overlay/feed?k=${encodeURIComponent(key)}`, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      msg = res.ok ? { ok: true, feed: await res.json(), at: Date.now() } : { ok: false, status: res.status, error: (await res.json().catch(() => ({}))).error ?? '' };
    } catch {
      msg = { ok: false, status: 0, error: '' };
    }
    poll.busy = false;
    for (const l of poll.listeners) l.port.postMessage(msg);
  }
  poll.timer = setTimeout(() => void tick(key), POLL_MS);
}

/** Put a page on a key's poll, starting the poll if nobody else listens. */
function attach(key: string, listener: Listener): void {
  let poll = polls.get(key);
  if (!poll) {
    poll = { listeners: new Set(), timer: null, busy: false };
    polls.set(key, poll);
    poll.listeners.add(listener);
    void tick(key);
  } else {
    poll.listeners.add(listener);
  }
}

scope.onconnect = (e: MessageEvent) => {
  const port = e.ports[0]!;
  let listener: Listener | null = null;
  port.onmessage = (m: MessageEvent<{ type: 'watch' | 'alive'; key: string }>) => {
    if (m.data.type === 'watch' || !listener) {
      listener = { port, seenAt: Date.now() };
      attach(m.data.key, listener);
      return;
    }
    listener.seenAt = Date.now();
    // OBS throttles the timers of a source that is not on screen, so its
    // alive pings can lapse past QUIET_MS and the page gets dropped. The
    // page itself keeps running, still showing the last feed it had; put it
    // back on the poll the moment it speaks again, or it freezes on a match
    // that is long over.
    if (!polls.get(m.data.key)?.listeners.has(listener)) attach(m.data.key, listener);
  };
  port.start();
};
