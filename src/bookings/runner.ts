import type { DB } from '../db.js';
import { getServer, type ServerRow } from '../serverPool.js';
import { NOT_HELD_SQL } from '../serverHolds.js';
import { campaignRegistry, firstMapOf } from '../campaignRegistry.js';
import { isInstalledEverywhere } from '../campaignInstall.js';
import { isMapName } from '../campaigns.js';
import { parseStatusMap } from '../practiceLeases.js';
import { parseStatusPlayers } from '../practicePlayers.js';
import { publishAdminEvent } from '../adminFeed.js';
import { consoleText, cvarValue, quoted, waitForStartup, type BoxRcon } from '../serverSetup.js';
import { activeMembers } from '../teams/teams.js';
import type { Notifier, NotifyType } from '../notify/notify.js';
import { bookingMessage } from './messages.js';
import { bookingLimits } from './rules.js';
import {
  acceptedPeople, bookingRules, closeBooking, expireUnconfirmed, getBooking, markActive, markReady, markReleased, markSetup,
  openBookings, recordPresence, setReminded, setWarned, sideName, sidesOf, holdBox, type BookingRow, type Side, type SideRow,
} from './bookings.js';

/**
 * The part of bookings that talks to game servers (spec part 1 section 3;
 * plan 4a), modelled on PracticeLeases: a minute tick, setup in the
 * background, a guarded end, a wind-down that holds the box until its
 * restart has finished, and resume() after a web restart.
 *
 * Every state change goes through src/bookings/bookings.ts. This class only
 * decides when, and does the rcon work in between. One short rcon connection
 * per burst (BoxRcon), never one held across a wait.
 */

export const TICK_MS = 60_000;
/** Setup attempts before a booking is cancelled as setup_failed (spec). */
export const SETUP_TRIES = 2;
/** Tries at exec'ing the game config and seeing it take, per attempt. */
export const CFG_TRIES = 3;
/** After `exec <cfg>`: it changes map or restarts the round. */
export const SETUP_SETTLE_MS = 15_000;
/** After `changelevel`: the map loads and its configs run. */
export const MAP_SETTLE_MS = 20_000;
export const GOODBYE_MS = 3_000;
/** Minutes left at which the box says so in chat, once each. */
export const WARN_AT_MINUTES = [30, 10, 5] as const;

const END_SAY: Record<string, string> = {
  time: 'its time is up',
  idle: 'nobody was on it',
  captain: 'a captain ended it',
  staff: 'staff ended it',
  cancelled: 'it was cancelled',
  no_show: 'the other side did not show',
  setup_failed: 'it could not be set up',
};

export interface BookingRunnerDeps {
  db: DB;
  rcon: BoxRcon;
  publicUrl: string;
  /** Give the box back with a forced restart; resolves once it is back (true)
   *  or reported offline (false). */
  release: (serverId: number) => Promise<boolean>;
  /** The quit-and-wait before setup, without a release (the booking still holds the box). */
  restart: (server: ServerRow) => Promise<boolean>;
  notifier: Notifier;
  /** No box for a booking at its hold time: ask practice leases and side
   *  games to give one back (server.ts wires both needServer calls). */
  preempt: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The lines that make a box the booking's: the plugin's cvars (which put
 *  the values back after every map load) and the engine cvars themselves. */
export function bookingLines(db: DB, b: BookingRow): string[] {
  if (!/^[a-z0-9]+$/.test(b.password) || !/^[a-z0-9]+$/.test(b.tv_password)) throw new Error('booking password has unexpected characters');
  const [a, bs] = sidesOf(db, b.id);
  const notice = consoleText(`Booked: ${sideName(db, a)} vs ${sideName(db, bs)} until ${b.ends_at.slice(11, 16)} UTC`, 120);
  return [
    `l4d_booking_tv_password ${quoted(b.tv_password)}`,
    `l4d_booking_notice ${quoted(notice)}`,
    `l4d_booking_password ${quoted(b.password)}`,
    `sm_cvar sv_password ${quoted(b.password)}`,
    `sm_cvar tv_password ${quoted(b.tv_password)}`,
  ];
}

/** Who runs a side: a team's captain and co-captains, or the pickup captain. */
function sideManagers(db: DB, s: SideRow): string[] {
  if (s.team_id === null) return [s.captain_steamid];
  return activeMembers(db, s.team_id).filter((m) => m.role !== 'member').map((m) => m.steamid);
}

export class BookingRunner {
  private readonly db: DB;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Bookings with a setup or wind-down running; nothing else starts on them. */
  private readonly busy = new Map<number, Promise<void>>();
  private ticking = false;

  constructor(private readonly deps: BookingRunnerDeps) {
    this.db = deps.db;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.now = deps.now ?? Date.now;
  }

  private track(id: number, work: () => Promise<void>): void {
    if (this.busy.has(id)) return;
    const p = work().catch((err) => { console.error(`[booking] ${id}:`, err); }).finally(() => { this.busy.delete(id); });
    this.busy.set(id, p);
  }

  /** Resolves once no setup or wind-down is running. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.busy.size > 0) await Promise.all([...this.busy.values()]);
  }

  /** Boot: nothing in memory survived. An end that had started finishes
   *  (no goodbye: the box may be mid-restart); a booking caught in setup is
   *  set up again from the start; ready and active ones carry on. */
  resume(): void {
    for (const b of openBookings(this.db)) {
      if (b.ending_at !== null) this.track(b.id, () => this.windDown(b.id, false));
      else if (b.state === 'held' || b.state === 'setup') this.track(b.id, () => this.setup(b.id));
    }
  }

  /** Take a box for every confirmed booking at its hold time. Run by the
   *  tick and whenever the releaser frees a box. */
  allocate(): void {
    const nowMs = this.now();
    const lead = bookingLimits(this.db).holdLeadMinutes * 60_000;
    let waiting = false;
    for (const b of openBookings(this.db)) {
      if (b.state !== 'scheduled' || b.server_id !== null || b.ending_at !== null) continue;
      if (Date.parse(b.starts_at) - lead > nowMs) continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const server = this.pickBox(b);
      if (!server || !holdBox(this.db, b.id, server.id, new Date(nowMs))) { waiting = true; continue; }
      console.log(`[booking] ${b.id} holds ${server.name}`);
      this.track(b.id, () => this.setup(b.id));
    }
    if (waiting) this.deps.preempt();
  }

  /** An idle box for this booking: enabled, in its region, held by nothing,
   *  and able to load every campaign on the playlist. Highest id first, the
   *  reverse of claimIdle, like a practice lease. */
  pickBox(b: BookingRow): ServerRow | null {
    const rows = this.db.prepare(
      `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND region = ? AND ${NOT_HELD_SQL} ORDER BY id DESC`,
    ).all(b.region) as ServerRow[];
    const registry = campaignRegistry(this.db);
    const playlist = JSON.parse(b.playlist_json) as string[];
    return rows.find((s) => playlist.every((c) => {
      const e = registry.get(c);
      return !!e && (!e.custom || isInstalledEverywhere(this.db, c, [s.id])) && (!e.requiresDlc4 || s.has_dlc4 === 1);
    })) ?? null;
  }

  private stillSettingUp(id: number): BookingRow | null {
    const b = getBooking(this.db, id);
    return b && b.state === 'setup' && b.ending_at === null ? b : null;
  }

  private async setup(id: number): Promise<void> {
    for (;;) {
      const attempt = markSetup(this.db, id, new Date(this.now()));
      if (attempt === null) break;
      const b = getBooking(this.db, id)!;
      const server = getServer(this.db, b.server_id!)!;
      try {
        await this.setupOnce(id, server);
        break;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.warn(`[booking] ${id}: setup try ${attempt} on ${server.name} failed: ${why}`);
        if (!this.stillSettingUp(id)) break;
        if (attempt < SETUP_TRIES) continue;
        publishAdminEvent({ kind: 'problem', text: `Booking ${id} could not be set up on ${server.name} (${why}). It is cancelled and the box is going back to the pool.` });
        if (closeBooking(this.db, id, 'cancelled', 'setup_failed', new Date(this.now()))) {
          this.tell(id, this.everyone(id), 'booking_cancelled', { reason: 'the server could not be set up' });
        }
        break;
      }
    }
    // An end that came in during setup (a cancel, setup_failed) is ours to finish.
    const after = getBooking(this.db, id);
    if (after && after.ending_at !== null && after.ended_at === null) await this.windDown(id, true);
  }

  private async setupOnce(id: number, server: ServerRow): Promise<void> {
    if (!(await this.deps.restart(server))) throw new Error('the box did not come back from its restart');
    if (!this.stillSettingUp(id)) return;
    await waitForStartup(this.deps.rcon, server, this.sleep);
    const b = this.stillSettingUp(id);
    if (!b) return;
    await this.execVerified(server, b);
    const [version] = await this.deps.rcon(server, ['l4d_booking_version']);
    if (cvarValue(version, 'l4d_booking_version') === null) throw new Error('the l4d_booking plugin is not loaded on this box');
    const lines = bookingLines(this.db, b);
    const playlist = JSON.parse(b.playlist_json) as string[];
    const firstMap = firstMapOf(this.db, playlist[0]);
    if (!isMapName(firstMap)) throw new Error(`${playlist[0]} starts on ${JSON.stringify(firstMap)}, which is not a valid map name`);
    await this.deps.rcon(server, lines);
    try {
      await this.deps.rcon(server, [`changelevel ${firstMap}`]);
    } catch {
      // A changelevel can drop the connection it came in on; the map check decides.
    }
    await this.sleep(MAP_SETTLE_MS);
    if (!this.stillSettingUp(id)) return;
    const [st] = await this.deps.rcon(server, ['status', ...lines]);
    if (parseStatusMap(st) !== firstMap) throw new Error(`${firstMap} did not load (the box is on ${parseStatusMap(st) ?? 'no map'})`);
    if (!markReady(this.db, id, new Date(this.now()))) return;
    console.log(`[booking] ${id} ready on ${server.name}`);
    this.tell(id, acceptedPeople(this.db, id).map((p) => p.steamid), 'booking_ready');
  }

  /** Exec the booking's game config and see it take (the box's game type no
   *  longer says Pub); up to CFG_TRIES times. */
  private async execVerified(server: ServerRow, b: BookingRow): Promise<void> {
    const row = this.db.prepare('SELECT cfg FROM game_configs WHERE key = ?').get(b.game_config) as { cfg: string } | undefined;
    if (!row || !/^[a-z0-9_]+$/.test(row.cfg)) throw new Error(`game config ${b.game_config} has no usable cfg`);
    let seen = '';
    for (let i = 1; i <= CFG_TRIES; i++) {
      try {
        await this.deps.rcon(server, [`exec ${row.cfg}`]);
        await this.sleep(SETUP_SETTLE_MS);
        const [reply] = await this.deps.rcon(server, ['l4d_game_type_name']);
        const type = cvarValue(reply, 'l4d_game_type_name') ?? '';
        if (type !== '' && !type.includes('Pub')) return;
        seen = `game type "${type}"`;
      } catch (err) {
        seen = `no answer (${err instanceof Error ? err.message : String(err)})`;
      }
    }
    throw new Error(`${row.cfg}.cfg did not take after ${CFG_TRIES} tries; last seen ${seen}`);
  }

  /** Finish an end that has started: goodbye, kick, release with a restart,
   *  then the booking holds nothing. A booking that never had a box has
   *  nothing to give back. */
  private async windDown(id: number, sayGoodbye: boolean): Promise<void> {
    const b = getBooking(this.db, id);
    if (!b || b.ended_at !== null) return;
    if (b.server_id === null) { markReleased(this.db, id, new Date(this.now())); return; }
    const server = getServer(this.db, b.server_id);
    if (server && sayGoodbye) {
      try {
        await this.deps.rcon(server, [`say [Booking] This booked server is closing: ${END_SAY[b.end_reason ?? 'time'] ?? 'the booking is over'}.`]);
        await this.sleep(GOODBYE_MS);
        await this.deps.rcon(server, ['sm_kick @humans "The booking is over. Thanks for playing."']);
      } catch (err) {
        // Best effort: the restart below empties the box either way.
        console.warn(`[booking] ${id}: goodbye on ${server.name} failed:`, err instanceof Error ? err.message : err);
      }
    }
    try {
      await this.deps.release(b.server_id);
    } catch (err) {
      console.error(`[booking] ${id}: releasing server ${b.server_id} failed:`, err);
    }
    markReleased(this.db, id, new Date(this.now()));
  }

  /** Finish any end a route or the tick started. Idempotent. */
  settle(id: number): void {
    const b = getBooking(this.db, id);
    if (!b || b.ending_at === null || b.ended_at !== null) return;
    this.track(id, () => this.windDown(id, true));
  }

  /** The minute pass. Task 8 adds expiry, reminders and the watch. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.allocate();
      for (const b of openBookings(this.db)) if (b.ending_at !== null) this.settle(b.id);
    } finally {
      this.ticking = false;
    }
  }

  // ---------- notices ----------

  private tell(id: number, steamids: Iterable<string>, type: NotifyType, extra: { minutes?: number; reason?: string | null; addedBy?: string } = {}): void {
    const payload = bookingMessage(this.db, this.deps.publicUrl, id, type, extra);
    if (payload) this.deps.notifier.send(steamids, type, payload);
  }

  /** Everyone with a stake: accepted people and the managers of both sides. */
  private everyone(id: number): string[] {
    return [...acceptedPeople(this.db, id).map((p) => p.steamid), ...sidesOf(this.db, id).flatMap((s) => sideManagers(this.db, s))];
  }

  onCreated(id: number): void {
    const b = sidesOf(this.db, id).find((s) => s.side === 'b');
    if (b) this.tell(id, sideManagers(this.db, b), 'booking_invite');
  }

  onConfirmed(id: number): void {
    const a = sidesOf(this.db, id).find((s) => s.side === 'a');
    if (a) this.tell(id, sideManagers(this.db, a), 'booking_confirmed');
  }

  onPersonAdded(id: number, steamid: string, by: string): void {
    const row = this.db.prepare("SELECT 1 FROM booking_people WHERE booking_id = ? AND steamid = ? AND status = 'invited'").get(id, steamid);
    if (row) this.tell(id, [steamid], 'booking_invite', { addedBy: by });
  }

  onCancelled(id: number, by: string | null, reason: string | null): void {
    this.tell(id, this.everyone(id).filter((s) => s !== by), 'booking_cancelled', { reason });
    this.settle(id);
  }

  onNoShow(id: number, absent: Side): void {
    const s = sidesOf(this.db, id).find((x) => x.side === absent);
    if (!s) return;
    const people = acceptedPeople(this.db, id).filter((p) => p.side === absent).map((p) => p.steamid);
    this.tell(id, [...sideManagers(this.db, s), ...people], 'booking_no_show');
    this.settle(id);
  }
}
