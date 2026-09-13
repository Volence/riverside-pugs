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
 * Minimal Source RCON (TCP) client.
 *
 * A response longer than about 4 KB arrives as several RESPONSE_VALUE packets
 * sharing the request id, and nothing in the protocol marks the last one. The
 * standard trick is to follow the command with an empty RESPONSE_VALUE packet
 * carrying its own id: the server answers requests in order, so its (empty)
 * answer to that marker means every fragment of the real response is already
 * in. `exec` collects fragments until the marker's answer lands.
 *
 * This was a real bug, not a theoretical one: sm_pug_dump grew past 4 KB once
 * skill_detect stats were included (eight SKILL lines), the first packet had
 * no END line, and match 14 on 2026-09-13 sat "live" with its result stuck in
 * the plugin until the dump was pulled by hand.
 */
export class RconClient {
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (body: string) => void; reject: (e: Error) => void }>();
  /** Fragments received so far for an in-flight command, by command id. */
  private parts = new Map<number, string[]>();
  /** Marker id -> command id it terminates. */
  private markers = new Map<number, number>();
  private readonly timeoutMs: number;

  constructor(private opts: RconOpts) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      this.sock = sock;
      const authId = this.nextId++;
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('rcon connect timeout')); }, this.timeoutMs);

      sock.on('error', (err) => { clearTimeout(timer); reject(err); });
      sock.on('data', (chunk) => this.onData(chunk as Buffer));
      sock.on('connect', () => {
        sock.write(encodePacket(authId, SERVERDATA_AUTH, this.opts.password));
      });

      this.onAuth = (p: RconPacket) => {
        clearTimeout(timer);
        if (p.id === -1) { sock.destroy(); reject(new Error('rcon auth failed')); }
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
        const cmdId = this.markers.get(p.id);
        if (cmdId !== undefined) {
          // The marker's answer: the command's response is complete. Source
          // sends a second, junk-bodied packet for the same marker id right
          // after; the marker is forgotten here so that one is dropped below.
          this.markers.delete(p.id);
          const waiter = this.pending.get(cmdId);
          const body = (this.parts.get(cmdId) ?? []).join('');
          this.parts.delete(cmdId);
          if (waiter) {
            this.pending.delete(cmdId);
            waiter.resolve(body);
          }
          continue;
        }
        if (this.pending.has(p.id)) {
          const list = this.parts.get(p.id);
          if (list) list.push(p.body); else this.parts.set(p.id, [p.body]);
        }
      }
    }
  }

  exec(cmd: string): Promise<string> {
    if (!this.sock) return Promise.reject(new Error('rcon not connected'));
    const id = this.nextId++;
    const markerId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.parts.delete(id);
        this.markers.delete(markerId);
        reject(new Error(`rcon exec timeout: ${cmd}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (body) => { clearTimeout(timer); resolve(body); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.markers.set(markerId, id);
      this.sock!.write(encodePacket(id, SERVERDATA_EXECCOMMAND, cmd));
      this.sock!.write(encodePacket(markerId, SERVERDATA_RESPONSE_VALUE, ''));
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
    for (const [, w] of this.pending) w.reject(new Error('rcon closed'));
    this.pending.clear();
    this.parts.clear();
    this.markers.clear();
  }
}
