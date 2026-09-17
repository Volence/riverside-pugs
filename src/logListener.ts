import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { parseLogDatagram, type LogEvent } from './logParse.js';

/**
 * Binds a UDP socket for srcds `logaddress` traffic. Datagrams are parsed and,
 * if their token is registered, handed to the callback. Everything else (bad
 * parse, unknown token) is dropped, because the stream is untrusted and lossy by design.
 */
/** The only line kinds a not-yet-registered token may carry. These are the
 *  in-game `!load_4v4p` burst, whose token the plugin generates and we
 *  therefore cannot have registered in advance. Everything else stays
 *  token-gated: a spoofed MATCH_END or MAP_RESULT must never be able to invent
 *  a score. */
const SELF_START_KINDS = new Set(['match_create', 'match_roster', 'match_create_end']);

export class LogListener {
  private sock: dgram.Socket | null = null;
  private tokens = new Set<string>();
  private matchCreateSources = new Set<string>();
  private matchCreateCheck: ((address: string) => boolean) | null = null;

  /** `source` is the datagram's sender address, which self-started matches use
   *  to tell which game server they are on. */
  constructor(private onEvent: (ev: LogEvent, source: string) => void) {}

  listen(port: number, address = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      this.sock = sock;
      sock.on('error', reject);
      sock.on('message', (msg, rinfo) => {
        const ev = parseLogDatagram(msg);
        if (!ev) return;
        if (this.tokens.has(ev.token)) return this.onEvent(ev, rinfo.address);
        // MATCH_CREATE is the first line that can cause database writes, and
        // UDP source addresses are trivially spoofable off-path but not from
        // the open internet against a localhost-only feed. Admission is
        // therefore pinned to the configured game server's address.
        if (SELF_START_KINDS.has(ev.kind)
          && (this.matchCreateSources.has(rinfo.address) || this.matchCreateCheck?.(rinfo.address))) {
          return this.onEvent(ev, rinfo.address);
        }
      });
      sock.bind(port, address, () => {
        resolve((sock.address() as AddressInfo).port);
      });
    });
  }

  register(token: string): void { this.tokens.add(token); }
  unregister(token: string): void { this.tokens.delete(token); }

  /** Permit the in-game match-create burst from this source address. Call once
   *  per known game server. Without it, self-started matches are ignored. */
  allowMatchCreateFrom(address: string): void { this.matchCreateSources.add(address); }

  /** Also admit sources this predicate accepts, checked per datagram, so a game
   *  server added to the database later is admitted without a restart. */
  allowMatchCreateWhen(check: (address: string) => boolean): void { this.matchCreateCheck = check; }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sock) return resolve();
      this.sock.close(() => resolve());
      this.sock = null;
    });
  }
}
