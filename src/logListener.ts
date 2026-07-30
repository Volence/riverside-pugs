import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { parseLogDatagram, type LogEvent } from './logParse.js';

/**
 * Binds a UDP socket for srcds `logaddress` traffic. Datagrams are parsed and,
 * if their token is registered, handed to the callback. Everything else (bad
 * parse, unknown token) is dropped — the stream is untrusted and lossy by design.
 */
export class LogListener {
  private sock: dgram.Socket | null = null;
  private tokens = new Set<string>();

  constructor(private onEvent: (ev: LogEvent) => void) {}

  listen(port: number, address = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      this.sock = sock;
      sock.on('error', reject);
      sock.on('message', (msg) => {
        const ev = parseLogDatagram(msg);
        if (ev && this.tokens.has(ev.token)) this.onEvent(ev);
      });
      sock.bind(port, address, () => {
        resolve((sock.address() as AddressInfo).port);
      });
    });
  }

  register(token: string): void { this.tokens.add(token); }
  unregister(token: string): void { this.tokens.delete(token); }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sock) return resolve();
      this.sock.close(() => resolve());
      this.sock = null;
    });
  }
}
