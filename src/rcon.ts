import net from 'node:net';
import {
  decodePackets, encodePacket, type RconPacket,
  SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE, SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from './rconPacket.js';

export interface RconOpts {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

/**
 * Minimal Source RCON (TCP) client. Each `exec` resolves with the body of the
 * RESPONSE_VALUE packet whose id matches the request. Our commands return a
 * single small (<4 KB) packet, so multi-packet fragmentation is intentionally
 * not handled here.
 */
export class RconClient {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (body: string) => void; reject: (e: Error) => void }>();
  private readonly timeoutMs: number;

  constructor(private opts: RconOpts) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      this.sock = sock;
      const authId = this.nextId++;
      const timer = setTimeout(() => reject(new Error('rcon connect timeout')), this.timeoutMs);

      sock.on('error', (err) => { clearTimeout(timer); reject(err); });
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('connect', () => {
        sock.write(encodePacket(authId, SERVERDATA_AUTH, this.opts.password));
      });

      this.onAuth = (p: RconPacket) => {
        clearTimeout(timer);
        if (p.id === -1) reject(new Error('rcon auth failed'));
        else resolve();
        this.onAuth = null;
      };
    });
  }

  private onAuth: ((p: RconPacket) => void) | null = null;

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    const { packets, rest } = decodePackets(this.buf);
    this.buf = rest;
    for (const p of packets) {
      if (p.type === SERVERDATA_AUTH_RESPONSE) {
        this.onAuth?.(p);
        continue;
      }
      if (p.type === SERVERDATA_RESPONSE_VALUE) {
        const waiter = this.pending.get(p.id);
        if (waiter) {
          this.pending.delete(p.id);
          waiter.resolve(p.body);
        }
      }
    }
  }

  exec(cmd: string): Promise<string> {
    if (!this.sock) return Promise.reject(new Error('rcon not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rcon exec timeout: ${cmd}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (body) => { clearTimeout(timer); resolve(body); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock!.write(encodePacket(id, SERVERDATA_EXECCOMMAND, cmd));
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
    for (const [, w] of this.pending) w.reject(new Error('rcon closed'));
    this.pending.clear();
  }
}
