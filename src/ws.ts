interface SocketLike {
  readyState: number;
  send(data: string): void;
}

const OPEN = 1;

export class Hub {
  /** socket -> the steamid its session cookie named when it connected, or
   *  null for a browser that was not signed in. */
  private sockets = new Map<SocketLike, string | null>();

  add(socket: SocketLike, steamid: string | null = null): void {
    this.sockets.set(socket, steamid);
  }

  remove(socket: SocketLike): void {
    this.sockets.delete(socket);
  }

  private subscribers = new Set<(event: string) => void>();

  /** In-process listeners (the Discord bot) that hear exactly what browsers
   *  hear. Returns an unsubscribe function. */
  subscribe(fn: (event: string) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  broadcast(event: string): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        console.error('[hub] subscriber failed:', err);
      }
    }
    const msg = JSON.stringify({ event });
    for (const s of this.sockets.keys()) {
      if (s.readyState === OPEN) s.send(msg);
    }
  }

  /**
   * An event for some browsers only. `allow` is asked per signed-in user at
   * the moment of sending, once per user however many tabs they have, so it
   * can read the database and a demotion takes effect on the next event. A
   * socket that was not signed in when it connected never receives one.
   *
   * In-process subscribers do NOT hear it: they hear what everyone hears,
   * and this is by definition not that.
   *
   * The steamid is the one the cookie named at connect time. Someone who
   * signs out keeps their socket until the page reloads, which is why
   * `allow` must check the account as it is now, not trust that it was
   * staff when it connected.
   */
  sendTo(event: string, allow: (steamid: string) => boolean): void {
    const msg = JSON.stringify({ event });
    const verdict = new Map<string, boolean>();
    for (const [s, steamid] of this.sockets) {
      if (steamid === null || s.readyState !== OPEN) continue;
      let ok = verdict.get(steamid);
      if (ok === undefined) {
        ok = allow(steamid);
        verdict.set(steamid, ok);
      }
      if (ok) s.send(msg);
    }
  }
}
