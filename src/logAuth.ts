import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.js';
import type { LogAuthTrailer, LogEvent } from './logParse.js';
import { resolveServerBySource, serverIdsAtAddress } from './serverPool.js';
import { publishAdminEvent } from './adminFeed.js';

/**
 * Signed log lines (audit 2026-09-21 item 15).
 *
 * Everything the game servers report arrives as srcds log lines over UDP. The
 * token-less kinds (SIGNON_DROP, LilAC flags, input bursts, PUGNET) were
 * admitted on the sender's address alone, which is the one thing a spoofer
 * forges, so anyone could plant a LilAC "banned" flag or a shared-address
 * sighting on any SteamID. The token on a PUG line is little better against
 * someone who can read the stream, since it crosses it in the clear. This
 * engine has no sv_logsecret.
 *
 * So each server gets a secret, generated here and pushed over rcon
 * (pushLogSecret), and plugin/pug-logauth.inc appends to every line
 *
 *     lseq=<boot>.<n> mac=<8 hex>
 *
 * where mac is the first four bytes of HMAC-SHA1(secret, the line up to
 * " mac="), n counts lines for the whole server and boot is when that srcds
 * process started signing. A line is good when the MAC verifies AND it is not
 * a replay: same boot and a counter not seen before (a small window allows
 * for UDP reordering), or a later boot, which is a restarted server starting
 * its counter again. The boot stamp rides on every line, not in a start-up
 * marker, because a marker is one datagram and losing it would leave a
 * restarted server refused for good.
 *
 * Thirty-two bits of MAC is a guess in four billion per datagram, each one
 * counted here and reported, and that is enough for a feed whose worst forgery
 * is a flag an admin then looks at. It keeps the longest lines inside one log
 * line.
 *
 * MODES, per server, because plugins roll out a box at a time:
 *   off      today's behaviour. A valid signature is still used to say which
 *            server a line came from; nothing is counted or refused.
 *   log      verify and count, accept anyway. Watch `missing` fall to zero as
 *            the new plugins are staged, then enforce.
 *   enforce  a line that is unsigned, badly signed or replayed is dropped.
 *
 * The engine's own `"name<uid><steamid><>" entered the game` line cannot be
 * signed: no plugin emits it. It is honoured in every mode, from the pinned
 * source address only (LogListener's gate, unchanged), and all it can ever do
 * is clear a signon drop, which PLAYER event=connect also does, signed.
 *
 * Until EVERY server sharing an address enforces, an unsigned line from that
 * address that cannot be pinned on one of them is accepted: a server still on
 * old plugins legitimately sends exactly that.
 */

export const LOG_AUTH_MODES = ['off', 'log', 'enforce'] as const;
export type LogAuthMode = typeof LOG_AUTH_MODES[number];

/** How far behind the newest counter a line may arrive and still be taken,
 *  once. UDP reorders within a burst, not across seconds. */
export const REORDER_WINDOW = 64;

/** A boot stamp further ahead of our clock than this is refused: accepted, it
 *  would make every real line from that server a replay until the clock caught
 *  up. A day is far more than any honest clock is out by. */
const MAX_BOOT_AHEAD_S = 86_400;

/** How often the replay position is written back, per server. A restart of the
 *  backend can reopen at most this much of the stream to replay. */
const PERSIST_EVERY_MS = 5_000;

const REPORT_EVERY_MS = 30 * 60_000;

export function newLogSecret(): string {
  return randomBytes(16).toString('hex');
}

/** The MAC as the plugin computes it. The key is the secret's own characters,
 *  not the bytes its hex spells: both sides agree, and SourcePawn is spared a
 *  decoder. Pinned against the SourcePawn side by tests/logAuthVectors.test.ts. */
export function macOf(secret: string, signed: Buffer): string {
  return createHmac('sha1', secret).update(signed).digest('hex').slice(0, 8);
}

/** The replay position is left alone: it belongs to the srcds process, which
 *  carries on counting under the new secret, not to the secret. */
export function setLogSecret(db: DB, serverId: number, secret: string | null): void {
  db.prepare('UPDATE servers SET log_secret = ? WHERE id = ?').run(secret, serverId);
}

export function setLogAuthMode(db: DB, serverId: number, mode: LogAuthMode): void {
  db.prepare('UPDATE servers SET log_auth = ? WHERE id = ?').run(mode, serverId);
}

/** Push a server its secret, on a connection the caller owns.
 *
 *  srcds logs every rcon command it is sent, and that log is the very stream
 *  this protects, so the secret would cross it in the clear the moment it was
 *  set. sv_rcon_log is turned off around the one command and back on after.
 *  The command is logged BEFORE it runs, hence three execs and not one line.
 *
 *  False when no plugin on the box knows the cvar yet (old plugins): nothing
 *  was set, and the caller should say so rather than claim a push. An empty
 *  secret turns signing off on the box. */
export async function pushLogSecret(rcon: { exec(cmd: string): Promise<string> }, secret: string): Promise<boolean> {
  if (secret !== '' && !/^[0-9a-f]{32,64}$/.test(secret)) throw new Error('log secret must be 32 to 64 hex digits');
  await rcon.exec('sv_rcon_log 0');
  try {
    const res = await rcon.exec(`sm_pug_log_secret "${secret}"`);
    return !/unknown command/i.test(res);
  } finally {
    await rcon.exec('sv_rcon_log 1');
  }
}

export interface LogAuthCounters {
  ok: number;
  /** No trailer at all: an old plugin, a box that lost its secret, or a forgery. */
  missing: number;
  badMac: number;
  replay: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastFail: 'missing' | 'badMac' | 'replay' | null;
}

export interface LogAuthInput {
  ev: LogEvent;
  trailer: LogAuthTrailer | null;
  address: string;
  port: number;
}

export interface LogAuthResult {
  accept: boolean;
  /** The MAC verified and the line was not a replay. */
  verified: boolean;
  /** Set only when verified: the server whose secret signed the line, which is
   *  a better answer than its address and port. */
  serverId: number | null;
}

interface ServerAuthRow { id: number; name: string; secret: string | null; mode: LogAuthMode }

interface ReplayState { boot: number; highest: number; seen: Set<number>; persistedAt: number; dirty: boolean }

export class LogAuth {
  private counts = new Map<number, LogAuthCounters>();
  private replay = new Map<number, ReplayState>();
  private reportedAt = new Map<number, number>();

  constructor(private db: DB, private feedHost: string, private now: () => number = () => Date.now()) {}

  counters(serverId: number): LogAuthCounters {
    let c = this.counts.get(serverId);
    if (!c) {
      c = { ok: 0, missing: 0, badMac: 0, replay: 0, lastOkAt: null, lastFailAt: null, lastFail: null };
      this.counts.set(serverId, c);
    }
    return c;
  }

  check(input: LogAuthInput): LogAuthResult {
    const { ev, trailer, address, port } = input;
    // Not signable: the engine writes it, no plugin does. See the header.
    if (ev.kind === 'entered') return { accept: true, verified: false, serverId: null };

    const servers = this.servers();
    // A line that carries a match token answers to the server that match is
    // ON, whatever address it claims to be from: that is the server whose
    // secret must have signed it, and whose mode decides what a failure costs.
    const pinned = 'token' in ev ? this.serverOfToken(ev.token, servers) : null;

    if (trailer) {
      const atAddress = new Set(serverIdsAtAddress(this.db, address, this.feedHost));
      const candidates = pinned
        ? [pinned]
        : [...servers].sort((a, b) => Number(atAddress.has(b.id)) - Number(atAddress.has(a.id)));
      const signer = candidates.find((s) => s.secret !== null && macEquals(macOf(s.secret, trailer.signed), trailer.mac));
      if (signer) {
        if (this.fresh(signer.id, trailer)) {
          const c = this.counters(signer.id);
          c.ok++;
          c.lastOkAt = this.now();
          return { accept: true, verified: true, serverId: signer.id };
        }
        return this.failed([signer], 'replay');
      }
    }

    // Nobody is checking anything (every install, until an admin turns this
    // on): stop here, so that `off` costs nothing and says nothing, exactly as
    // before. Attributing the line below can raise an admin problem of its own.
    if (!servers.some((s) => s.secret !== null && s.mode !== 'off')) {
      return { accept: true, verified: false, serverId: null };
    }

    const kind = trailer ? 'badMac' : 'missing';
    if (pinned) return this.failed([pinned], kind);
    const byPort = resolveServerBySource(this.db, address, this.feedHost, port);
    const held = byPort !== null
      ? servers.filter((s) => s.id === byPort)
      : servers.filter((s) => serverIdsAtAddress(this.db, address, this.feedHost).includes(s.id));
    return this.failed(held, kind);
  }

  /** Write every server's replay position back now. For shutdown and tests;
   *  check() does it on its own every few seconds. */
  flush(): void {
    for (const [id, st] of this.replay) this.persist(id, st, true);
  }

  private servers(): ServerAuthRow[] {
    return this.db.prepare('SELECT id, name, log_secret AS secret, log_auth AS mode FROM servers ORDER BY id')
      .all() as ServerAuthRow[];
  }

  private serverOfToken(token: string, servers: ServerAuthRow[]): ServerAuthRow | null {
    const row = this.db.prepare('SELECT server_id FROM matches WHERE token = ?').get(token) as
      { server_id: number | null } | undefined;
    if (!row || row.server_id === null) return null;
    return servers.find((s) => s.id === row.server_id) ?? null;
  }

  /** Count a failure against every server the line could have been from, and
   *  decide. Dropped only when all of them enforce: a server with no secret or
   *  with auth off legitimately sends unsigned lines. No server at all means
   *  an address we cannot place, which the listener's own gates deal with. */
  private failed(held: ServerAuthRow[], kind: 'missing' | 'badMac' | 'replay'): LogAuthResult {
    const active = held.filter((s) => s.secret !== null && s.mode !== 'off');
    for (const s of active) {
      const c = this.counters(s.id);
      c[kind]++;
      c.lastFailAt = this.now();
      c.lastFail = kind;
      this.report(s, kind);
    }
    const drop = held.length > 0 && held.every((s) => s.secret !== null && s.mode === 'enforce');
    return { accept: !drop, verified: false, serverId: null };
  }

  /** Unsigned lines in log mode are what a roll-out looks like (old plugins),
   *  so they are counted and not announced. Everything else is, once per
   *  server per half hour; the counters carry the detail. */
  private report(s: ServerAuthRow, kind: 'missing' | 'badMac' | 'replay'): void {
    if (s.mode === 'log' && kind === 'missing') return;
    const now = this.now();
    if (now - (this.reportedAt.get(s.id) ?? -Infinity) < REPORT_EVERY_MS) return;
    this.reportedAt.set(s.id, now);
    const what = kind === 'missing' ? 'with no signature' : kind === 'badMac' ? 'with a signature that does not verify' : 'that replay a line already seen';
    publishAdminEvent({
      kind: 'problem',
      text: `Log lines ${what} are arriving for ${s.name}. They are being ${s.mode === 'enforce' ? 'DROPPED' : 'accepted (log mode)'}. If ${s.name} was just restarted or had plugins staged, push its log secret again from the server panel; otherwise someone is forging lines. Counts are on the server panel.`,
    });
  }

  private fresh(serverId: number, t: LogAuthTrailer): boolean {
    let st = this.replay.get(serverId);
    if (!st) {
      const row = this.db.prepare('SELECT log_auth_boot AS boot, log_auth_seq AS seq FROM servers WHERE id = ?')
        .get(serverId) as { boot: number; seq: number } | undefined;
      // Everything at or below a persisted position counts as seen: which of
      // them really were is not known after a restart, and refusing a few
      // stragglers is the safe side of that.
      st = { boot: row?.boot ?? 0, highest: row?.seq ?? 0, seen: new Set(), persistedAt: this.now(), dirty: false };
      if (st.highest > 0) st.seen = new Set(Array.from({ length: REORDER_WINDOW }, (_, i) => st!.highest - i));
      this.replay.set(serverId, st);
    }
    if (t.boot < st.boot) return false;
    if (t.boot > st.boot) {
      if (t.boot > this.now() / 1000 + MAX_BOOT_AHEAD_S) return false;
      st.boot = t.boot;
      st.highest = t.seq;
      st.seen = new Set([t.seq]);
      this.persist(serverId, st, true);
      return true;
    }
    if (t.seq <= st.highest - REORDER_WINDOW || st.seen.has(t.seq)) return false;
    st.seen.add(t.seq);
    if (t.seq > st.highest) {
      st.highest = t.seq;
      for (const n of st.seen) if (n <= st.highest - REORDER_WINDOW) st.seen.delete(n);
    }
    st.dirty = true;
    this.persist(serverId, st, false);
    return true;
  }

  private persist(serverId: number, st: ReplayState, force: boolean): void {
    const now = this.now();
    if (!force && (!st.dirty || now - st.persistedAt < PERSIST_EVERY_MS)) return;
    this.db.prepare('UPDATE servers SET log_auth_boot = ?, log_auth_seq = ? WHERE id = ?').run(st.boot, st.highest, serverId);
    st.persistedAt = now;
    st.dirty = false;
  }
}

function macEquals(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
