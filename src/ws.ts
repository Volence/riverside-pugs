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

  broadcast(event: string): void {
    const msg = JSON.stringify({ event });
    for (const s of this.sockets) {
      if (s.readyState === OPEN) s.send(msg);
    }
  }
}
