/**
 * Practice server leases: lending an idle pool server out for practice.
 *
 * Two kinds, both decided by the owner on 2026-09-28:
 *
 *   park   The shared Practice Park. Anyone logged in may join, eight humans
 *          at most, and it is listed publicly on the Play page. Starting one
 *          when a park with room already exists hands back that park instead
 *          of leasing a second box.
 *   drill  A private server for replay drills. Only its owner may drive the
 *          drill commands in game; the invite link /practice/<id> gives any
 *          logged-in player the connect line and password.
 *
 * A lease is a row of practice_leases and never a servers.status value: the
 * box stays 'idle' in servers, and claimIdle (with the two between-matches
 * writers that hold idle boxes) reads this table to keep away from it. See
 * NOT_LEASED_SQL in src/serverPool.ts and the table comment in src/db.ts for
 * why a status was the wrong tool.
 *
 * Ranked always wins. A server is only lent while `practice_reserve_idle`
 * other enabled servers stay idle, never while a PUG is waiting for a box,
 * and when a PUG finds none the newest lease is warned in game and taken back
 * 60 seconds later (`needServer`, hooked into the orchestrator's no-server
 * path, with the minute tick as the fallback).
 *
 * Ending a lease always restarts srcds, through the releaser's own restart
 * machinery (src/serverRelease.ts, forceRestart), whatever the box's
 * restart_after_match toggle says, so nothing a practice config set can
 * reach the next PUG. That is not paranoia: the 2026-09-25 config audit
 * found the existing practice mode already leaking z_ghost_delay_minspawn
 * into ranked play. Any enabled box may be lent (owner, 2026-09-28); one
 * whose supervisor does not bring it back after `quit` stays offline and is
 * reported, as for a match release.
 *
 * The lease row holds its box until that restart has finished: end_reason is
 * set when the wind-down starts and ended_at only once the box is back. A
 * web restart in between therefore finds an open lease on boot and runs the
 * wind-down again (`resume`), instead of leaving the box offline for good the
 * way pug-offline-strand-on-web-restart describes for match releases.
 *
 * Everything that talks to a game server goes through the injected `rcon`,
 * one short connection per burst, so tests use a fake and no connection is
 * held across the setup's waits (srcds drops every other rcon connection
 * when one closes, and the per-server turn in src/rcon.ts serialises them).
 */
import { randomInt } from 'node:crypto';
import type { DB } from './db.js';
import { getServer, NOT_LEASED_SQL, type ServerRow } from './serverPool.js';
import { settingNumber } from './settings.js';
import { parseHumans } from './serverRestart.js';
import { getPlayer } from './players.js';
import { publishAdminEvent } from './adminFeed.js';

export type LeaseKind = 'park' | 'drill';

/** Why a lease ended. Stored as text in end_reason. */
export type EndReason =
  | 'owner' | 'admin' | 'idle' | 'expired' | 'preempted'
  | 'setup_failed' | 'players_on_server' | 'interrupted';

export interface LeaseRow {
  id: number;
  server_id: number;
  kind: LeaseKind;
  owner_player_id: string;
  password: string;
  drill_code: string | null;
  created_at: string;
  ready_at: string | null;
  last_human_at: string;
  ends_at: string;
  humans: number;
  map: string | null;
  warned_at: string | null;
  ending_at: string | null;
  ended_at: string | null;
  end_reason: EndReason | null;
}

/** Humans the park takes. The owner's number; the box itself allows more. */
export const PARK_CAPACITY = 8;
/** A lease with nobody on it for this long ends. Also the grace to join.
 *  Shorter for the park (owner, 2026-09-28): it is a shared box that exists
 *  for whoever turns up, and an empty one is a box the queue could have. A
 *  drill server is one person's, set up for a planned session, and gets the
 *  longer wait for friends to connect. */
export const IDLE_END_MS: Record<LeaseKind, number> = { park: 5 * 60_000, drill: 10 * 60_000 };
/** How long a lease runs before it ends unless people are still on it. */
export const LEASE_MS = 90 * 60_000;
/** Each extension past LEASE_MS while humans are connected. */
export const EXTEND_MS = 15 * 60_000;
/** The warning a lease gets before a PUG takes its box back. */
export const PREEMPT_WARN_MS = 60_000;
/** After `exec practice_<kind>.cfg`: the cfg changes map or restarts the
 *  round, so the password and owner lines wait for that to settle. */
export const SETUP_SETTLE_MS = 20_000;
/** The same lines again this much later: the per-map cfg that l4dready
 *  re-execs on the new map can reset cvars set in between. */
export const SETUP_RESEND_MS = 5_000;
/** Between the goodbye in chat and the kick, so the line can be read. */
export const GOODBYE_MS = 3_000;
/** New leases one player may start in an hour. Joining a park is free. */
export const LEASES_PER_HOUR = 6;
/** How often the manager polls each leased box. */
export const TICK_MS = 60_000;

/** No 0/o, 1/l/i: a password is read off a screen and typed in a console. */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PASSWORD_LEN = 8;

/** A fresh per-lease sv_password. Random, and never derived from anything
 *  public (unlike a match password, which follows from its token). */
export function newLeasePassword(pick: (n: number) => number = randomInt): string {
  let out = '';
  for (let i = 0; i < PASSWORD_LEN; i++) out += PASSWORD_ALPHABET[pick(PASSWORD_ALPHABET.length)];
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function getLease(db: DB, id: number): LeaseRow | undefined {
  return db.prepare('SELECT * FROM practice_leases WHERE id = ?').get(id) as LeaseRow | undefined;
}

/** Every lease still holding its box, winding down included, oldest first. */
export function openLeases(db: DB): LeaseRow[] {
  return db.prepare('SELECT * FROM practice_leases WHERE ended_at IS NULL ORDER BY id').all() as LeaseRow[];
}

/** Open and not winding down: a lease people can still join. */
const isActive = (l: LeaseRow) => l.ended_at === null && l.end_reason === null;

/** The player's open lease, if any. One at a time per player. */
export function openLeaseOf(db: DB, steamid: string): LeaseRow | undefined {
  return db.prepare(
    'SELECT * FROM practice_leases WHERE owner_player_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
  ).get(steamid) as LeaseRow | undefined;
}

/** Parks people can join right now: active, with room, fullest first so
 *  players gather in one place rather than spreading over two half-empty
 *  parks, then oldest. The humans figure is the last minute's reading. */
export function joinableParks(db: DB): LeaseRow[] {
  return (db.prepare(
    "SELECT * FROM practice_leases WHERE kind = 'park' AND ended_at IS NULL AND end_reason IS NULL ORDER BY humans DESC, id",
  ).all() as LeaseRow[]).filter((l) => l.humans < PARK_CAPACITY);
}

/** Leases this player started since `sinceIso`, for the hourly limit. */
export function leasesStartedSince(db: DB, steamid: string, sinceIso: string): number {
  return (db.prepare(
    'SELECT COUNT(*) AS n FROM practice_leases WHERE owner_player_id = ? AND created_at > ?',
  ).get(steamid, sinceIso) as { n: number }).n;
}

/** PUGs waiting for a server: configuring with no box yet. The same test
 *  the admin live board uses for "waiting for a server". */
export function matchesWaiting(db: DB): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM matches WHERE state = 'configuring' AND server_id IS NULL",
  ).get() as { n: number }).n;
}

/** Enabled idle boxes that no lease holds: what the queue could claim now. */
function claimableServers(db: DB): ServerRow[] {
  return db.prepare(
    `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_LEASED_SQL} ORDER BY id`,
  ).all() as ServerRow[];
}

export type PickResult =
  | { ok: true; server: ServerRow }
  | { ok: false; reason: 'off' | 'max_leases' | 'queue_waiting' | 'no_server' };

/**
 * Which server a new lease may take, or why none.
 *
 * The highest id that qualifies, the reverse of the order matches claim
 * boxes in (claimIdle takes the lowest id), so the box lent out is the one a
 * PUG would reach for last. Any enabled, idle, unleased box qualifies, as
 * long as taking it still leaves `practice_reserve_idle` other claimable
 * boxes for the queue. Whether the box restarts after matches does not
 * matter here: ending a lease restarts srcds regardless (owner, 2026-09-28).
 */
export function pickLeaseServer(db: DB): PickResult {
  const max = settingNumber(db, 'practice_max_leases', 2, { integer: true, min: 0 });
  if (max === 0) return { ok: false, reason: 'off' };
  if (openLeases(db).length >= max) return { ok: false, reason: 'max_leases' };
  if (matchesWaiting(db) > 0) return { ok: false, reason: 'queue_waiting' };
  const reserve = settingNumber(db, 'practice_reserve_idle', 1, { integer: true, min: 0 });
  const free = claimableServers(db);
  if (free.length === 0 || free.length - 1 < reserve) return { ok: false, reason: 'no_server' };
  return { ok: true, server: free[free.length - 1] };
}

/** What a player is told when no lease could be made. */
export const PICK_ERRORS: Record<Exclude<PickResult, { ok: true }>['reason'], string> = {
  off: 'Practice servers are turned off right now.',
  max_leases: 'Every practice server slot is in use. Try again when one closes, or join the Practice Park.',
  queue_waiting: 'A PUG is waiting for a server, so none can be spared right now.',
  no_server: 'All servers are busy with PUGs right now. Try again in a few minutes.',
};

/**
 * What a poll of a leased box means for its lease. Pure, for the tests.
 *
 * `humans` is null when the poll failed. A failed poll never counts as
 * someone being there, so a box that stops answering drifts to the idle end
 * rather than being held for ever.
 */
export function judgeLease(
  lease: Pick<LeaseRow, 'kind' | 'last_human_at' | 'ends_at'>, humans: number | null, nowMs: number,
): { end: 'idle' | 'expired' } | { end: null; lastHumanAt: string; endsAt: string } {
  const present = humans !== null && humans > 0;
  const lastHumanAt = present ? iso(nowMs) : lease.last_human_at;
  let endsAt = lease.ends_at;
  if (nowMs >= Date.parse(lease.ends_at)) {
    if (!present) return { end: 'expired' };
    endsAt = iso(nowMs + EXTEND_MS);
  }
  if (!present && nowMs - Date.parse(lease.last_human_at) >= IDLE_END_MS[lease.kind]) return { end: 'idle' };
  return { end: null, lastHumanAt, endsAt };
}

/** The map from an engine `status` reply, or null. */
export function parseStatusMap(status: string): string | null {
  const m = /^map\s*:\s*(\S+)/m.exec(status);
  return m ? m[1] : null;
}

/** Quoted for the console: a URL carries `//`, which starts a comment
 *  unquoted. Quotes and line breaks are refused rather than escaped, since
 *  the Source console has no escape for either. */
function quoted(v: string): string {
  if (/["\r\n;]/.test(v)) throw new Error(`refusing to send ${JSON.stringify(v)} to a game server console`);
  return `"${v}"`;
}

/** The lines that tell the box who it is for. Sent twice; see SETUP_RESEND_MS. */
export function identityLines(lease: Pick<LeaseRow, 'password' | 'owner_player_id'>, publicUrl: string): string[] {
  if (!/^[a-z0-9]+$/.test(lease.password)) throw new Error('lease password has unexpected characters');
  if (!/^\d{17}$/.test(lease.owner_player_id)) throw new Error('lease owner is not a SteamID64');
  return [
    `sm_cvar sv_password ${quoted(lease.password)}`,
    `l4d_practice_owner ${lease.owner_player_id}`,
    `l4d_practice_site ${quoted(publicUrl)}`,
  ];
}

const END_SAY: Record<EndReason, string> = {
  owner: 'the owner closed it',
  admin: 'an admin closed it',
  idle: 'nobody was on it for a while',
  expired: 'its time ran out',
  preempted: 'a PUG needs this server',
  setup_failed: 'it could not be set up',
  players_on_server: 'it was not free',
  interrupted: 'the site restarted while it was being set up',
};

/** Runs these commands on one short connection and returns each reply. */
export type LeaseRcon = (server: ServerRow, commands: string[]) => Promise<string[]>;

export interface PracticeLeaseDeps {
  db: DB;
  rcon: LeaseRcon;
  /** The site's PUBLIC_URL, pushed as l4d_practice_site so the plugin can
   *  fetch drills and link back. */
  publicUrl: string;
  /**
   * Give the box back: restore its standing password, restart srcds, and
   * put it in the pool once it answers. Resolves with whether it is back in
   * the pool. Production wires this to the releaser with forceRestart, which
   * marks the row offline for the restart and fires the pending-match drain
   * afterwards, so a PUG that preempted this lease gets the box at once.
   */
  release: (serverId: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type CreateResult =
  | { ok: true; lease: LeaseRow; joined: boolean }
  | { ok: false; status: number; error: string; leaseId?: number };

export class PracticeLeases {
  private readonly db: DB;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Owners with a create in flight: the checks and the insert are split by
   *  an rcon round trip, and a double click must not make two leases. */
  private creating = new Set<string>();
  private ticking = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: PracticeLeaseDeps) {
    this.db = deps.db;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Start a lease for `owner`, or hand back the park they should join.
   *
   * Answers once the box has been checked for people and the lease is
   * recorded; the setup itself (cfg, password, owner, drill) carries on in
   * the background for about 25 seconds, and the lease's ready_at says when
   * it is done. The invite page polls for that.
   */
  async create(owner: string, kind: LeaseKind, drillCode: string | null = null): Promise<CreateResult> {
    if (kind === 'park') {
      const park = joinableParks(this.db)[0];
      if (park) return { ok: true, lease: park, joined: true };
    }
    const mine = openLeaseOf(this.db, owner);
    if (mine) {
      return {
        ok: false, status: 409, leaseId: mine.id,
        error: 'You already have a practice server open. Close it before starting another.',
      };
    }
    if (leasesStartedSince(this.db, owner, iso(this.now() - 3_600_000)) >= LEASES_PER_HOUR) {
      return { ok: false, status: 429, error: `You can start ${LEASES_PER_HOUR} practice servers an hour. Try again later.` };
    }
    if (this.creating.has(owner)) {
      return { ok: false, status: 429, error: 'Your practice server is already being started.' };
    }
    this.creating.add(owner);
    try {
      const made = this.db.transaction((): CreateResult => {
        // Again inside the transaction: a park someone else started while
        // this request waited its turn is the one to join.
        if (kind === 'park') {
          const park = joinableParks(this.db)[0];
          if (park) return { ok: true, lease: park, joined: true };
        }
        const pick = pickLeaseServer(this.db);
        if (!pick.ok) return { ok: false, status: 503, error: PICK_ERRORS[pick.reason] };
        const now = this.now();
        const id = Number(this.db.prepare(
          `INSERT INTO practice_leases
             (server_id, kind, owner_player_id, password, drill_code, created_at, last_human_at, ends_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(pick.server.id, kind, owner, newLeasePassword(), drillCode, iso(now), iso(now), iso(now + LEASE_MS)).lastInsertRowid);
        return { ok: true, lease: getLease(this.db, id)!, joined: false };
      })();
      if (!made.ok || made.joined) return made;

      // The box is ours on paper; now make sure nobody is on it. The pool
      // has casual players on idle boxes (the standing password is shared),
      // and A2S cannot be trusted for this (Chicago never answers it).
      const lease = made.lease;
      const server = getServer(this.db, lease.server_id)!;
      let humans: number;
      try {
        const [status] = await this.deps.rcon(server, ['status']);
        humans = parseHumans(status);
      } catch (err) {
        // Nothing was changed on the box, so there is nothing to restart.
        this.close(lease.id, 'setup_failed');
        console.error(`[practice] lease ${lease.id}: ${server.name} did not answer rcon:`, err);
        return { ok: false, status: 503, error: 'The server picked for you did not answer. Try again in a minute.' };
      }
      if (humans > 0) {
        this.close(lease.id, 'players_on_server');
        return { ok: false, status: 503, error: 'The free server has people on it right now. Try again in a few minutes.' };
      }
      this.track(this.setup(lease.id));
      return { ok: true, lease: getLease(this.db, lease.id)!, joined: false };
    } finally {
      this.creating.delete(owner);
    }
  }

  /** Close a lease that never touched its box: no wind-down, no restart. */
  private close(id: number, reason: EndReason): void {
    const at = iso(this.now());
    this.db.prepare(
      'UPDATE practice_leases SET end_reason = ?, ending_at = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL',
    ).run(reason, at, at, id);
  }

  private track(p: Promise<void>): void {
    p.catch((err) => console.error('[practice] background step failed:', err));
  }

  /** Still worth continuing: open and not winding down. */
  private stillActive(id: number): LeaseRow | null {
    const l = getLease(this.db, id);
    return l && isActive(l) ? l : null;
  }

  private async setup(id: number): Promise<void> {
    const first = this.stillActive(id);
    if (!first) return;
    const server = getServer(this.db, first.server_id);
    if (!server) { this.close(id, 'setup_failed'); return; }
    try {
      await this.deps.rcon(server, [`exec practice_${first.kind}.cfg`]);
      await this.sleep(SETUP_SETTLE_MS);
      let lease = this.stillActive(id);
      if (!lease) return;
      const lines = identityLines(lease, this.deps.publicUrl);
      await this.deps.rcon(server, lines);
      await this.sleep(SETUP_RESEND_MS);
      lease = this.stillActive(id);
      if (!lease) return;
      const again = [...lines];
      // Checked where it is stored too; this is the last word before a
      // console line, so it is checked again rather than trusted.
      if (lease.kind === 'drill' && lease.drill_code && /^[A-Z0-9]{4,5}$/.test(lease.drill_code)) {
        again.push(`sm_drill_load ${lease.drill_code}`);
      }
      await this.deps.rcon(server, again);
      this.db.prepare('UPDATE practice_leases SET ready_at = ? WHERE id = ? AND ended_at IS NULL')
        .run(iso(this.now()), id);
      console.log(`[practice] lease ${id} (${lease.kind}) is ready on ${server.name}`);
    } catch (err) {
      console.error(`[practice] lease ${id}: setup on ${server.name} failed:`, err);
      publishAdminEvent({
        kind: 'problem',
        text: `A practice server could not be set up on ${server.name} (${err instanceof Error ? err.message : String(err)}). `
          + 'It is being restarted and put back in the pool.',
      });
      this.end(id, 'setup_failed');
    }
  }

  /**
   * Start winding a lease down. False when it is already ended or ending.
   *
   * Synchronous up to the guarded write that claims the wind-down, so two
   * callers (the owner's End and the idle tick, say) cannot both run it; the
   * goodbye, the kick and the restart follow in the background.
   */
  end(id: number, reason: EndReason): boolean {
    const claimed = this.db.prepare(
      'UPDATE practice_leases SET end_reason = ?, ending_at = ? WHERE id = ? AND ended_at IS NULL AND end_reason IS NULL',
    ).run(reason, iso(this.now()), id).changes === 1;
    if (!claimed) return false;
    console.log(`[practice] ending lease ${id}: ${reason}`);
    this.track(this.windDown(id, true));
    return true;
  }

  private async windDown(id: number, sayGoodbye: boolean): Promise<void> {
    const lease = getLease(this.db, id);
    if (!lease || lease.ended_at !== null) return;
    const server = getServer(this.db, lease.server_id);
    if (server && sayGoodbye) {
      try {
        const why = END_SAY[lease.end_reason ?? 'owner'];
        await this.deps.rcon(server, [`say [Practice] This practice server is closing: ${why}.`]);
        await this.sleep(GOODBYE_MS);
        await this.deps.rcon(server, ['sm_kick @humans "Practice server closed. Thanks for practising."']);
      } catch (err) {
        // Best effort. The restart below empties the box either way.
        console.warn(`[practice] lease ${id}: goodbye on ${server.name} failed:`, err instanceof Error ? err.message : err);
      }
    }
    let back = false;
    try {
      back = await this.deps.release(lease.server_id);
    } catch (err) {
      console.error(`[practice] lease ${id}: releasing server ${lease.server_id} failed:`, err);
    }
    this.db.prepare('UPDATE practice_leases SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(iso(this.now()), id);
    console.log(`[practice] lease ${id} ended; server ${lease.server_id} ${back ? 'is back in the pool' : 'did not come back and stays offline'}`);
  }

  /**
   * A PUG needs a server and found none. The newest active lease is warned
   * in game and ended PREEMPT_WARN_MS later, unless the PUG found a box
   * some other way by then. One lease at a time: a second call while a
   * warning is running does nothing, so one waiting match cannot empty
   * every practice server at once.
   */
  needServer(): void {
    const leases = openLeases(this.db);
    if (leases.length === 0) return;
    if (leases.some((l) => l.warned_at !== null && l.ended_at === null)) return;
    if (claimableServers(this.db).length > 0) return;
    const victim = [...leases].reverse().find(isActive);
    if (!victim) return;
    this.db.prepare('UPDATE practice_leases SET warned_at = ? WHERE id = ?').run(iso(this.now()), victim.id);
    console.log(`[practice] a PUG needs a server; lease ${victim.id} has ${PREEMPT_WARN_MS / 1000}s`);
    const server = getServer(this.db, victim.server_id);
    if (server) {
      this.track(this.deps.rcon(server, [
        `say [Practice] A PUG needs this server in ${PREEMPT_WARN_MS / 1000} seconds. Ranked matches always come first.`,
      ]).then(() => {}, (err) => {
        console.warn(`[practice] preemption warning on ${server.name} failed:`, err instanceof Error ? err.message : err);
      }));
    }
    const t = setTimeout(() => { this.timers.delete(t); this.finishPreempt(victim.id); }, PREEMPT_WARN_MS);
    t.unref?.();
    this.timers.add(t);
  }

  /** The end of a preemption warning: end the lease, or stand down when no
   *  PUG is waiting any more. Also run by the tick, which covers a warning
   *  whose timer was lost to a web restart. */
  finishPreempt(id: number): void {
    const lease = this.stillActive(id);
    if (!lease || lease.warned_at === null) return;
    if (matchesWaiting(this.db) === 0) {
      this.db.prepare('UPDATE practice_leases SET warned_at = NULL WHERE id = ?').run(id);
      const server = getServer(this.db, lease.server_id);
      if (server) {
        this.track(this.deps.rcon(server, ['say [Practice] Never mind: the PUG found another server. Carry on.'])
          .then(() => {}, () => {}));
      }
      return;
    }
    this.end(id, 'preempted');
  }

  /**
   * The minute pass. For each lease: a warning that has run out, the box's
   * humans and map, then the idle and time rules. Then the fallback for a
   * PUG waiting on a box with no preemption running (a no-server call that
   * came before this process, say). Never runs two at once.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const lease of openLeases(this.db)) {
        if (!isActive(lease)) continue;
        if (lease.warned_at !== null && this.now() - Date.parse(lease.warned_at) >= PREEMPT_WARN_MS) {
          this.finishPreempt(lease.id);
          continue;
        }
        const server = getServer(this.db, lease.server_id);
        let humans: number | null = null;
        let map: string | null = null;
        if (server) {
          try {
            const [status] = await this.deps.rcon(server, ['status']);
            humans = parseHumans(status);
            map = parseStatusMap(status);
          } catch (err) {
            console.warn(`[practice] lease ${lease.id}: status on ${server.name} failed:`, err instanceof Error ? err.message : err);
          }
        }
        // Re-read: the owner may have ended it during the rcon round trip.
        const fresh = this.stillActive(lease.id);
        if (!fresh) continue;
        const verdict = judgeLease(fresh, humans, this.now());
        if (verdict.end) { this.end(fresh.id, verdict.end); continue; }
        this.db.prepare(
          'UPDATE practice_leases SET last_human_at = ?, ends_at = ?, humans = ?, map = COALESCE(?, map) WHERE id = ?',
        ).run(verdict.lastHumanAt, verdict.endsAt, humans ?? 0, map, fresh.id);
      }
      if (matchesWaiting(this.db) > 0) this.needServer();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Boot. A lease that was winding down when the process stopped is wound
   * down again (its box is probably offline mid-restart, and nothing else
   * would ever bring it back); one that never finished setting up is ended,
   * since its box is in an unknown half-configured state. Active, set-up
   * leases simply carry on; the tick picks them up.
   */
  resume(): void {
    for (const lease of openLeases(this.db)) {
      if (lease.end_reason !== null) {
        console.log(`[practice] resuming the wind-down of lease ${lease.id}`);
        this.track(this.windDown(lease.id, false));
      } else if (lease.ready_at === null) {
        this.end(lease.id, 'interrupted');
      }
    }
  }

  /** Tests and shutdown: drop pending preemption timers. */
  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** What a logged-in viewer of /practice/<id> is shown. The password and
 *  connect line only while the lease is open. */
export interface LeaseView {
  id: number;
  kind: LeaseKind;
  server: string;
  owner: { steamid: string; name: string };
  isOwner: boolean;
  canEnd: boolean;
  drillCode: string | null;
  createdAt: string;
  readyAt: string | null;
  endsAt: string;
  humans: number;
  capacity: number | null;
  map: string | null;
  warnedAt: string | null;
  state: 'setting_up' | 'ready' | 'ending' | 'ended';
  endReason: EndReason | null;
  endedAt: string | null;
  connect: { host: string; port: number; password: string } | null;
}

export function leaseState(l: LeaseRow): LeaseView['state'] {
  if (l.ended_at !== null) return 'ended';
  if (l.end_reason !== null) return 'ending';
  return l.ready_at === null ? 'setting_up' : 'ready';
}

export function leaseView(db: DB, l: LeaseRow, viewer: string, viewerIsAdmin: boolean): LeaseView {
  const server = getServer(db, l.server_id);
  const owner = getPlayer(db, l.owner_player_id);
  const state = leaseState(l);
  const isOwner = viewer === l.owner_player_id;
  return {
    id: l.id,
    kind: l.kind,
    server: server?.name ?? `server ${l.server_id}`,
    owner: { steamid: l.owner_player_id, name: owner?.name ?? l.owner_player_id },
    isOwner,
    canEnd: (isOwner || viewerIsAdmin) && (state === 'setting_up' || state === 'ready'),
    drillCode: l.drill_code,
    createdAt: l.created_at,
    readyAt: l.ready_at,
    endsAt: l.ends_at,
    humans: l.humans,
    capacity: l.kind === 'park' ? PARK_CAPACITY : null,
    map: l.map,
    warnedAt: l.warned_at,
    state,
    endReason: l.end_reason,
    endedAt: l.ended_at,
    connect: server && (state === 'setting_up' || state === 'ready')
      ? { host: server.host, port: server.port, password: l.password }
      : null,
  };
}

/** One park on the public list. No password, no host: joining goes through
 *  the logged-in invite page. */
export interface ParkListing {
  id: number;
  server: string;
  humans: number;
  capacity: number;
  map: string | null;
  ready: boolean;
  endsAt: string;
}

export function parkListings(db: DB): ParkListing[] {
  return (db.prepare(
    "SELECT * FROM practice_leases WHERE kind = 'park' AND ended_at IS NULL AND end_reason IS NULL ORDER BY id",
  ).all() as LeaseRow[]).map((l) => ({
    id: l.id,
    server: getServer(db, l.server_id)?.name ?? `server ${l.server_id}`,
    humans: l.humans,
    capacity: PARK_CAPACITY,
    map: l.map,
    ready: l.ready_at !== null,
    endsAt: l.ends_at,
  }));
}

/** Every open lease, for the admin live board. */
export interface AdminLeaseRow {
  id: number;
  kind: LeaseKind;
  server: string;
  owner: { steamid: string; name: string };
  state: LeaseView['state'];
  humans: number;
  map: string | null;
  createdAt: string;
  endsAt: string;
  warnedAt: string | null;
  endReason: EndReason | null;
}

export function adminLeaseRows(db: DB): AdminLeaseRow[] {
  return openLeases(db).map((l) => ({
    id: l.id,
    kind: l.kind,
    server: getServer(db, l.server_id)?.name ?? `server ${l.server_id}`,
    owner: { steamid: l.owner_player_id, name: getPlayer(db, l.owner_player_id)?.name ?? l.owner_player_id },
    state: leaseState(l),
    humans: l.humans,
    map: l.map,
    createdAt: l.created_at,
    endsAt: l.ends_at,
    warnedAt: l.warned_at,
    endReason: l.end_reason,
  }));
}
