interface SocketLike {
  readyState: number;
  send(data: string): void;
}

const OPEN = 1;

export class Hub {
  private sockets = new Set<SocketLike>();

  add(socket: SocketLike): void {
    this.sockets.add(socket);
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
    for (const s of this.sockets) {
      if (s.readyState === OPEN) s.send(msg);
    }
  }
}
