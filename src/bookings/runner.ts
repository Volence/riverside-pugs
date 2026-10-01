import type { DB } from '../db.js';
import { getServer, type ServerRow } from '../serverPool.js';
import { NOT_HELD_SQL } from '../serverHolds.js';
import { campaignRegistry, firstMapOf, type CampaignEntry } from '../campaignRegistry.js';
import { isInstalledEverywhere } from '../campaignInstall.js';
import { isMapName } from '../campaigns.js';
import { parseStatusMap } from '../practiceLeases.js';
import { parseStatusPlayers } from '../practicePlayers.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getCampaignPool, settingNumber } from '../settings.js';
import { redactSecrets } from '../redact.js';
import { TEMPLATES } from '../rulesets.js';
import { consoleText, cvarValue, quoted, waitForStartup, type BoxRcon } from '../serverSetup.js';
import { activeMembers } from '../teams/teams.js';
import type { Notifier, NotifyType } from '../notify/notify.js';
import { bookingMessage } from './messages.js';
import { bookingLimits, typicalCampaignMinutes } from './rules.js';
import {
  acceptedPeople, actingSides, advancePlaylist, bookingRules, closeBooking, endBooking, expireUnconfirmed, extendBooking, getBooking, markActive,
  markReady, markReleased, markSetup, openBookings, recordPresence, resetSetupAttempts, setNext, setReminded, setWarned, sideName, sidesOf, holdBox,
  BOOKING_ERRORS, type BookingRow, type Side, type SideRow,
} from './bookings.js';
import { abortBookingGame, bookingGames, bookingOnServer, liveBookingGame } from './games.js';

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
/** After a game, how long the box waits before loading the next campaign. */
export const NEXT_DELAY_MS = 60_000;
/** Empty minute watches in a row before "everyone left" may end a booking. */
export const EMPTY_WATCHES_TO_END = 2;
/** The last game must have ended at least this long ago for "everyone left":
 *  players reloading into the next campaign are briefly not on the box. */
export const LEFT_AFTER_GAME_MS = 2 * 60_000;

const END_SAY: Record<string, string> = {
  time: 'its time is up',
  idle: 'nobody was on it',
  captain: 'a captain ended it',
  staff: 'staff ended it',
  cancelled: 'it was cancelled',
  no_show: 'the other side did not show',
  setup_failed: 'it could not be set up',
  done: 'everyone left',
};

/** Sent before the release: if the end restart is ever skipped, the box must
 *  not keep the booking's passwords or notice, nor its scrim rules: the pause
 *  limits go back to the PUG template and the auto-track threshold to the
 *  plugin's default (8), so the next PUG on the box plays PUG rules. */
export const CLEAR_LINES: readonly string[] = [
  'l4d_booking_password ""', 'l4d_booking_tv_password ""', 'l4d_booking_notice ""',
  `sm_pug_pause_limit ${TEMPLATES.PUG.pause.limit ?? 0}`, `sm_pug_pause_seconds ${TEMPLATES.PUG.pause.seconds ?? 0}`,
  'sm_pug_auto_min_players 8',
];

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
  /** A box this runner held is back in the pool and the booking's hold is
   *  gone (ended_at written). The releaser's own waiters run before that, while
   *  the hold still hides the box, so a PUG waiting on a box is woken here
   *  (server.ts wires the same drain side games use). */
  freed?: () => void;
  /** The ip:port the site's log listener receives on. Set, the box is told to
   *  send its logs there (and gets its log secret); absent, both are skipped. */
  logPublicAddress?: string;
  /** Stop listening for a match token (an aborted booking game). */
  unregisterToken?: (token: string) => void;
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

/** The lines that make the box record the booking's games (plan 4b): the
 *  plugin's auto-track starts a match when both teams go live with enough
 *  humans, the ruleset's pause limits (0 turns a limit off), the captains
 *  list (every manager of a confirmed side, Task 6) so the plugin's own
 *  `!nextmap`/`!stay`/`!end`/`!extend` courtesy check has someone to check
 *  against, and when the site has a log address, logging to it plus the log
 *  secret exactly as pushLogSecret (src/logAuth.ts) sends it. The secret is a
 *  console line: callers must redact it from anything they log (redactSecrets). */
export function gameLines(db: DB, b: BookingRow, server: ServerRow, logAddress?: string): string[] {
  const pause = bookingRules(b)?.pause;
  const captains = [...new Set(sidesOf(db, b.id).filter((s) => s.confirmed_at !== null).flatMap((s) => sideManagers(db, s)))];
  const lines = [
    'sm_pug_auto_track 1',
    `sm_pug_auto_min_players ${settingNumber(db, 'booking_game_min_players', 6, { min: 2, max: 8, integer: true })}`,
    `sm_pug_pause_limit ${Math.max(0, Math.trunc(pause?.limit ?? 0))}`,
    `sm_pug_pause_seconds ${Math.max(0, Math.trunc(pause?.seconds ?? 0))}`,
    `l4d_booking_captains ${quoted(captains.join(','))}`,
  ];
  if (logAddress && /^[A-Za-z0-9.-]+:\d{1,5}$/.test(logAddress)) {
    lines.push(`logaddress_add ${logAddress}`);
    if (server.log_secret && /^[0-9a-f]{32,64}$/.test(server.log_secret)) {
      lines.push('sv_rcon_log 0', `sm_pug_log_secret "${server.log_secret}"`, 'sv_rcon_log 1');
    }
  }
  return lines;
}

/** Folded for name matching: lower case, `_`, `-` and spaces as one space. */
const fold = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** A `YYYY-MM-DD HH:MM:SS` (datetime('now'), UTC) or ISO time, in ms. */
function sqlMs(t: string): number {
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(t) ? `${t.replace(' ', 'T')}Z` : t);
}

/** Whether this box can load the campaign: known, installed if custom, and
 *  the dlc4 mappack for an L4D2 campaign. */
function loadsOn(db: DB, e: CampaignEntry | undefined, s: ServerRow): boolean {
  return !!e && (!e.custom || isInstalledEverywhere(db, e.slug, [s.id])) && (!e.requiresDlc4 || s.has_dlc4 === 1);
}

export type ChooseResult = { ok: true; campaign: string } | { ok: false; error: string };

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
  /** Bookings already alerted as started-with-no-server; once per process. */
  private readonly latePublished = new Set<number>();
  /** Empty minute watches in a row, per booking (everyone-left end). */
  private readonly emptyWatches = new Map<number, number>();
  /** Booking game tokens to send sm_pug_abort for at the start of the wind-down. */
  private readonly abortTokens = new Map<number, string>();
  /** Bookings whose box has had a campaign start said by loadNext: the
   *  go-active announcement of the first campaign is then moot (a captain
   *  picked a campaign before anyone was on, and it was already announced). */
  private readonly announced = new Set<number>();

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
      else if (b.state === 'held' || b.state === 'setup') {
        // A web restart is not a failed try: start the retry count fresh.
        resetSetupAttempts(this.db, b.id);
        this.track(b.id, () => this.setup(b.id));
      }
    }
  }

  /** Take a box for every confirmed booking at its hold time. Run by the
   *  tick and whenever the releaser frees a box. */
  allocate(): void {
    const nowMs = this.now();
    const lead = bookingLimits(this.db).holdLeadMinutes * 60_000;
    let preempt = false;
    for (const b of openBookings(this.db)) {
      if (b.state !== 'scheduled' || b.server_id !== null || b.ending_at !== null) continue;
      if (Date.parse(b.starts_at) - lead > nowMs) continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const server = this.pickBox(b);
      if (!server || !holdBox(this.db, b.id, server.id, new Date(nowMs))) {
        // Preempt practice and side games only when the region has no free
        // box at all; an idle box that cannot load the playlist (dlc4, a
        // custom campaign) would not be helped by emptying another one.
        if (this.freeBoxes(b.region) === 0) preempt = true;
        if (nowMs >= Date.parse(b.starts_at) && !this.latePublished.has(b.id)) {
          this.latePublished.add(b.id);
          publishAdminEvent({
            kind: 'problem',
            text: `Booking ${b.id} started at ${b.starts_at.slice(11, 16)} UTC and still has no server: no idle box in its region can load its playlist, or every box is busy.`,
          });
        }
        continue;
      }
      console.log(`[booking] ${b.id} holds ${server.name}`);
      this.track(b.id, () => this.setup(b.id));
    }
    if (preempt) this.deps.preempt();
  }

  /** Idle, enabled boxes in the region that nothing holds. */
  private freeBoxes(region: string): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM servers WHERE status = 'idle' AND enabled = 1 AND region = ? AND ${NOT_HELD_SQL}`,
    ).get(region) as { n: number }).n;
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
    return rows.find((s) => playlist.every((c) => loadsOn(this.db, registry.get(c), s))) ?? null;
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
        // An rcon error names the command it was on, and one of them carries the log secret.
        const why = redactSecrets(err instanceof Error ? err.message : String(err), [server.log_secret]);
        console.warn(`[booking] ${id}: setup try ${attempt} on ${server.name} failed: ${why}`);
        if (!this.stillSettingUp(id)) break;
        if (attempt < SETUP_TRIES) continue;
        publishAdminEvent({ kind: 'problem', text: `Booking ${id} could not be set up on ${server.name} (${why}). It is cancelled and the box is going back to the pool.` });
        // tell() never throws: a notice that fails must not block the box going back below.
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
    const lines = [...bookingLines(this.db, b), ...gameLines(this.db, b, server, this.deps.logPublicAddress)];
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
    const token = this.abortTokens.get(id);
    this.abortTokens.delete(id);
    if (server && token) {
      try {
        await this.deps.rcon(server, [`sm_pug_abort ${token}`]);
      } catch (err) {
        // Best effort: the restart below ends the plugin's match either way.
        console.warn(`[booking] ${id}: sm_pug_abort on ${server.name} failed:`, redactSecrets(err instanceof Error ? err.message : String(err), [token]));
      }
    }
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
    if (server) {
      try {
        await this.deps.rcon(server, [...CLEAR_LINES]);
      } catch (err) {
        // Best effort: the restart below clears them too.
        console.warn(`[booking] ${id}: clearing the booking cvars on ${server.name} failed:`, err instanceof Error ? err.message : err);
      }
    }
    try {
      await this.deps.release(b.server_id);
    } catch (err) {
      console.error(`[booking] ${id}: releasing server ${b.server_id} failed:`, err);
    }
    markReleased(this.db, id, new Date(this.now()));
    this.emptyWatches.delete(id);
    this.announced.delete(id);
    try {
      this.deps.freed?.();
    } catch (err) {
      console.error(`[booking] ${id}: the freed hook failed:`, err);
    }
  }

  /** Finish any end a route or the tick started. Idempotent. */
  settle(id: number): void {
    const b = getBooking(this.db, id);
    if (!b || b.ending_at === null || b.ended_at !== null) return;
    this.track(id, () => this.windDown(id, true));
  }

  /** The minute pass. Never runs two at once. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date(this.now());
      for (const id of expireUnconfirmed(this.db, now)) {
        this.tell(id, this.everyone(id), 'booking_cancelled', { reason: 'it was not confirmed in time' });
      }
      this.remind(now);
      this.allocate();
      this.closeServerless(now);
      for (const b of openBookings(this.db)) {
        if (b.ending_at !== null) { this.settle(b.id); continue; }
        if ((b.state === 'ready' || b.state === 'active') && !this.busy.has(b.id)) await this.watch(b, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** A confirmed booking that never got a box (none free in its region, or
   *  none able to load its playlist) closes once the no-show grace after its
   *  start has passed, so it neither waits for ever nor keeps a box back. */
  private closeServerless(now: Date): void {
    for (const b of openBookings(this.db)) {
      if (b.state !== 'scheduled' || b.server_id !== null || b.ending_at !== null) continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const grace = (bookingRules(b)?.noShowGraceMinutes ?? 15) * 60_000;
      if (now.getTime() < Date.parse(b.starts_at) + grace) continue;
      if (!closeBooking(this.db, b.id, 'cancelled', 'no_server', now)) continue;
      console.warn(`[booking] ${b.id}: no server was free by ${b.starts_at}; cancelled`);
      publishAdminEvent({ kind: 'problem', text: `Booking ${b.id} never got a server and is cancelled (no_server). Both sides are told.` });
      this.tell(b.id, this.everyone(b.id), 'booking_cancelled', { reason: 'no server was free' });
    }
  }

  /** 60 and 15 minutes before the start, once each, to everyone accepted. A
   *  booking made 40 minutes ahead gets the first one at once ("in 40"). */
  private remind(now: Date): void {
    for (const b of openBookings(this.db)) {
      if (b.ending_at !== null || b.state === 'active') continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const left = Date.parse(b.starts_at) - now.getTime();
      if (left <= 0) continue;
      const minutes = Math.round(left / 60_000);
      const to = acceptedPeople(this.db, b.id).map((p) => p.steamid);
      if (left <= 15 * 60_000 && b.reminded_15_at === null) {
        setReminded(this.db, b.id, 15, now);
        setReminded(this.db, b.id, 60, now);
        this.tell(b.id, to, 'booking_starting', { minutes });
      } else if (left <= 60 * 60_000 && left > 15 * 60_000 && b.reminded_60_at === null) {
        setReminded(this.db, b.id, 60, now);
        this.tell(b.id, to, 'booking_starting', { minutes });
      }
    }
  }

  /** One look at a running booking's box (minute watch: presence, active,
   *  time/idle ends, minutes-left warnings). */
  private async watch(b: BookingRow, now: Date): Promise<void> {
    const server = b.server_id !== null ? getServer(this.db, b.server_id) : undefined;
    if (!server) return;
    // The time end needs no answer from the box: a dead box still ends on time.
    if (now.getTime() >= Date.parse(b.ends_at)) { this.endNow(b.id, 'time', now); return; }
    let humans: ReturnType<typeof parseStatusPlayers>;
    try {
      const [st] = await this.deps.rcon(server, ['status']);
      humans = parseStatusPlayers(st);
    } catch (err) {
      // Says nothing about who is on: the empty run starts again.
      this.emptyWatches.delete(b.id);
      console.warn(`[booking] ${b.id}: status on ${server.name} failed:`, err instanceof Error ? err.message : err);
      return;
    }
    // The booking and game lines go again each minute, in their own burst
    // (best effort; the status above stands either way): cheap, idempotent,
    // and a map change can reset cvars a cfg sets.
    await this.push(b.id, server, () => [...bookingLines(this.db, b), ...gameLines(this.db, b, server, this.deps.logPublicAddress)], 're-pushing the booking lines');
    const on = new Set(humans.map((h) => h.steamid64).filter((s): s is string => s !== null));
    const people = acceptedPeople(this.db, b.id);
    const present = {
      a: people.filter((p) => p.side === 'a' && on.has(p.steamid)).length,
      b: people.filter((p) => p.side === 'b' && on.has(p.steamid)).length,
    };
    recordPresence(this.db, b.id, present, humans.length > 0, now);
    if (b.state === 'ready' && present.a + present.b > 0 && markActive(this.db, b.id, now)) {
      // The first campaign was loaded by setup, before anyone was on: its
      // start lines are said once, when the booking goes active.
      const first = (JSON.parse(b.playlist_json) as string[])[b.playlist_pos];
      if (first && !this.announced.has(b.id)) await this.push(b.id, server, () => this.campaignStartLines(getBooking(this.db, b.id)!, first), 'the campaign start lines');
    }

    const fresh = getBooking(this.db, b.id)!;
    const nowMs = now.getTime();
    const endsMs = Date.parse(fresh.ends_at);
    if (nowMs >= endsMs) { this.endNow(b.id, 'time', now); return; }
    const limits = bookingLimits(this.db);
    const grace = (bookingRules(fresh)?.noShowGraceMinutes ?? 15) * 60_000;
    const idleFrom = Math.max(fresh.last_human_at ? Date.parse(fresh.last_human_at) : 0, Date.parse(fresh.starts_at) + grace);
    if (humans.length === 0 && nowMs - idleFrom >= limits.idleEndMinutes * 60_000) { this.endNow(b.id, 'idle', now); return; }
    const empties = humans.length === 0 ? (this.emptyWatches.get(b.id) ?? 0) + 1 : 0;
    this.emptyWatches.set(b.id, empties);
    if (empties >= EMPTY_WATCHES_TO_END && this.everyoneLeftAfterGame(b.id, nowMs)) { this.endNow(b.id, 'done', now); return; }

    if (fresh.next_campaign !== null && fresh.next_at !== null && Date.parse(fresh.next_at) <= nowMs && !liveBookingGame(this.db, b.id)) {
      this.track(b.id, () => this.loadNext(b.id));
    }

    const leftMin = (endsMs - nowMs) / 60_000;
    const crossed = WARN_AT_MINUTES.filter((m) => leftMin <= m && (fresh.warned_minutes === null || fresh.warned_minutes > m));
    if (crossed.length > 0) {
      const m = Math.min(...crossed);
      setWarned(this.db, b.id, m);
      try {
        await this.deps.rcon(server, [`say [Booking] About ${m} minutes left on this booking (until ${fresh.ends_at.slice(11, 16)} UTC).`]);
      } catch {
        // Best effort.
      }
    }
  }

  /** Ruling 4: a finished game, none live, and the last one ended long
   *  enough ago that a map change between campaigns is not mistaken for it. */
  private everyoneLeftAfterGame(id: number, nowMs: number): boolean {
    const games = bookingGames(this.db, id);
    if (!games.some((g) => g.state === 'completed') || games.some((g) => g.state === 'live')) return false;
    const last = games.at(-1)!;
    return last.endedAt !== null && nowMs - sqlMs(last.endedAt) >= LEFT_AFTER_GAME_MS;
  }

  private endNow(id: number, reason: 'time' | 'idle' | 'done', now: Date): void {
    this.emptyWatches.delete(id);
    if (closeBooking(this.db, id, 'ended', reason, now)) this.settle(id);
  }

  // ---------- the playlist ----------

  /** A running booking (ready or active, no end started, a box), or null. */
  private running(id: number): BookingRow | null {
    const b = getBooking(this.db, id);
    return b && b.ending_at === null && b.server_id !== null && (b.state === 'ready' || b.state === 'active') ? b : null;
  }

  /** Load the due next campaign: one changelevel, the playlist moves on, and
   *  once the map is up the campaign-start lines. Runs as tracked work, so the
   *  watch and a captain's pick cannot both load it. */
  private async loadNext(id: number): Promise<void> {
    const b = this.running(id);
    if (!b || b.next_campaign === null || b.next_at === null || Date.parse(b.next_at) > this.now()) return;
    if (liveBookingGame(this.db, id)) return;
    const server = getServer(this.db, b.server_id!);
    if (!server) return;
    const campaign = b.next_campaign;
    const map = firstMapOf(this.db, campaign);
    if (!isMapName(map)) {
      console.warn(`[booking] ${id}: ${campaign} starts on ${JSON.stringify(map)}, which is not a valid map name; not loading it`);
      setNext(this.db, id, null, null, new Date(this.now()));
      return;
    }
    const playlist = JSON.parse(b.playlist_json) as string[];
    const at = playlist.indexOf(campaign);
    // Moved on first: a box that does not take the changelevel is not sent it
    // again every minute; a captain can pick the campaign again.
    advancePlaylist(this.db, id, at >= 0 ? at : b.playlist_pos, new Date(this.now()));
    try {
      await this.deps.rcon(server, [`changelevel ${map}`]);
    } catch {
      // A changelevel can drop the connection it came in on.
    }
    await this.sleep(MAP_SETTLE_MS);
    if (this.running(id)) {
      let onMap: string | null = null;
      try {
        const [st] = await this.deps.rcon(server, ['status']);
        onMap = parseStatusMap(st);
      } catch {
        // No answer: treated as not loaded below.
      }
      if (onMap !== map) {
        // Nothing is said about a campaign the box is not on.
        console.warn(`[booking] ${id}: ${map} did not load on ${server.name} (it is on ${onMap ?? 'no map'})`);
        publishAdminEvent({
          kind: 'problem',
          text: `Booking ${id}: ${server.name} was sent ${map} for the next campaign but is on ${onMap ?? 'no map'}. A captain can pick the campaign again.`,
        });
      } else {
        const after = this.running(id);
        if (after) {
          this.announced.add(id);
          await this.push(id, server, () => [
            ...bookingLines(this.db, after), ...gameLines(this.db, after, server, this.deps.logPublicAddress), ...this.campaignStartLines(after, campaign),
          ], 'the campaign start lines');
        }
      }
    }
    // An end that came in while this ran is ours to finish (settle skipped it).
    const end = getBooking(this.db, id);
    if (end && end.ending_at !== null && end.ended_at === null) await this.windDown(id, true);
  }

  /** Said at the start of every campaign: the captains' commands, and the
   *  extend hint when the campaign usually takes longer than the time left. */
  private campaignStartLines(b: BookingRow, campaign: string): string[] {
    const name = consoleText(campaignRegistry(this.db).get(campaign)?.name ?? campaign, 60);
    const say = [`say [Booking] ${name}: !nextmap, !stay, !end and !extend are yours, captains.`];
    const left = Math.floor((Date.parse(b.ends_at) - this.now()) / 60_000);
    const typical = typicalCampaignMinutes(this.db, campaign);
    if (typical > left) say.push(`say [Booking] About ${left} min left, this campaign usually takes ${typical}. !extend now while the slot after is free.`);
    return say;
  }

  /** A best-effort burst. A failure is logged with the log secret redacted
   *  (an rcon error names the command it was on) and never thrown. */
  private async push(id: number, server: ServerRow, lines: () => string[], what: string): Promise<void> {
    try {
      await this.deps.rcon(server, lines());
    } catch (err) {
      console.warn(`[booking] ${id}: ${what} on ${server.name} failed:`, redactSecrets(err instanceof Error ? err.message : String(err), [server.log_secret]));
    }
  }

  /** A booking game finished (finishMatch keeps the box with the booking and
   *  calls this): announce the next playlist campaign and load it 60 s later,
   *  or say the playlist is used up. */
  onGameEnded(matchId: number): void {
    const m = this.db.prepare('SELECT booking_id FROM matches WHERE id = ?').get(matchId) as { booking_id: number | null } | undefined;
    if (!m || m.booking_id === null) return;
    const b = this.running(m.booking_id);
    if (!b) return;
    const server = getServer(this.db, b.server_id!);
    const playlist = JSON.parse(b.playlist_json) as string[];
    const next = playlist[b.playlist_pos + 1] ?? null;
    const nowMs = this.now();
    let line: string;
    if (next !== null) {
      setNext(this.db, b.id, next, new Date(nowMs + NEXT_DELAY_MS).toISOString(), new Date(nowMs));
      const name = consoleText(campaignRegistry(this.db).get(next)?.name ?? next, 60);
      line = `say [Booking] Next: ${name} in 60 s. !nextmap to pick another, !stay to replay this one, !end to finish.`;
    } else {
      line = 'say [Booking] That was the last campaign on the playlist. !nextmap <campaign> to play another, or !end to finish.';
    }
    if (!server) return;
    this.deps.rcon(server, [line]).catch((err) => {
      console.warn(`[booking] ${b.id}: next campaign line on ${server.name} failed:`, err instanceof Error ? err.message : err);
    });
  }

  /** A captain (or staff) picks the next campaign; it loads at once. Ruling 5:
   *  `wanted` matches a pool campaign by slug or name, case-insensitive, a
   *  unique prefix allowed; null means the next playlist campaign. */
  chooseNext(id: number, by: string, wanted: string | null, staff = false): ChooseResult {
    return this.choose(id, by, staff, (b) => {
      const playlist = JSON.parse(b.playlist_json) as string[];
      if (wanted === null || wanted.trim() === '') {
        const next = playlist[b.playlist_pos + 1];
        return next !== undefined ? { ok: true, campaign: next } : { ok: false, error: 'That was the last campaign on the playlist. Name one: !nextmap <campaign>.' };
      }
      return this.resolveCampaign(wanted);
    });
  }

  /** Replay the campaign of the last game, or the current playlist one when
   *  no game has been played yet. */
  stay(id: number, by: string, staff = false): ChooseResult {
    return this.choose(id, by, staff, (b) => {
      const last = bookingGames(this.db, id).at(-1);
      const campaign = last?.campaign ?? (JSON.parse(b.playlist_json) as string[])[b.playlist_pos];
      return campaign ? { ok: true, campaign } : { ok: false, error: 'There is no campaign to replay.' };
    });
  }

  private choose(id: number, by: string, staff: boolean, resolve: (b: BookingRow) => ChooseResult): ChooseResult {
    const b = getBooking(this.db, id);
    if (!b) return { ok: false, error: BOOKING_ERRORS.not_found.text };
    if (!staff && actingSides(this.db, id, by).length === 0) return { ok: false, error: BOOKING_ERRORS.not_manager.text };
    if (!this.running(id)) return { ok: false, error: 'The booking is not running.' };
    if (liveBookingGame(this.db, id)) return { ok: false, error: 'Finish this game or use !end first.' };
    const r = resolve(b);
    if (!r.ok) return r;
    const server = getServer(this.db, b.server_id!);
    const entry = campaignRegistry(this.db).get(r.campaign);
    if (!server || !loadsOn(this.db, entry, server)) return { ok: false, error: `This server cannot load ${entry?.name ?? r.campaign}.` };
    const nowMs = this.now();
    if (!setNext(this.db, id, r.campaign, new Date(nowMs).toISOString(), new Date(nowMs), by)) return { ok: false, error: 'The booking is not running.' };
    // Loaded now; were a load already running, the next watch picks this up.
    this.track(id, () => this.loadNext(id));
    return r;
  }

  private resolveCampaign(wanted: string): ChooseResult {
    const registry = campaignRegistry(this.db);
    const pool = getCampaignPool(this.db).flatMap((slug) => { const e = registry.get(slug); return e ? [e] : []; });
    const w = fold(wanted);
    const exact = pool.filter((e) => fold(e.slug) === w || fold(e.name) === w);
    const found = exact.length > 0 ? exact : pool.filter((e) => fold(e.slug).startsWith(w) || fold(e.name).startsWith(w));
    const shown = consoleText(wanted, 40);
    if (found.length === 1) return { ok: true, campaign: found[0].slug };
    if (found.length === 0) return { ok: false, error: `No campaign in the map pool matches "${shown}".` };
    return { ok: false, error: `"${shown}" matches more than one campaign: ${found.map((e) => e.name).join(', ')}.` };
  }

  /** `!end` (ruling 3): a live game is aborted (booking_ended) and the
   *  plugin told to drop it, then the booking ends and winds down. */
  endFromGame(id: number, by: string, staff = false): { ok: true } | { ok: false; error: string } {
    const nowDate = new Date(this.now());
    const r = endBooking(this.db, { bookingId: id, by, staff, now: nowDate });
    if (!r.ok) return { ok: false, error: BOOKING_ERRORS[r.error].text };
    const live = liveBookingGame(this.db, id);
    const token = live ? abortBookingGame(this.db, live.id, nowDate) : null;
    if (token) {
      try {
        this.deps.unregisterToken?.(token);
      } catch (err) {
        console.error(`[booking] ${id}: unregistering the aborted game's token failed:`, err);
      }
      this.abortTokens.set(id, token);
    }
    this.settle(id);
    return { ok: true };
  }

  /** A captain's in-game command (plugin l4d_booking 1.1.0's signed PUGBOOK
   *  line, Task 6). The plugin's own captains cvar (gameLines) is only a
   *  courtesy: this re-checks the sender against the booking actually
   *  holding this box right now. Nothing happens for a box with no running
   *  booking (bookingOnServer already excludes an ending one) or a sender who
   *  does not manage one of its confirmed sides. A refusal is said on the box
   *  as `[Booking] <reason>`; a success is already said by the method it
   *  calls (the campaign-start lines, the goodbye, or the extend notice). */
  onCommand(serverId: number, steamid: string, cmd: 'nextmap' | 'stay' | 'end' | 'extend', arg: string): void {
    const b = bookingOnServer(this.db, serverId);
    if (!b || actingSides(this.db, b.id, steamid).length === 0) return;
    let error: string | null = null;
    switch (cmd) {
      case 'nextmap': {
        const r = this.chooseNext(b.id, steamid, arg || null);
        if (!r.ok) error = r.error;
        break;
      }
      case 'stay': {
        const r = this.stay(b.id, steamid);
        if (!r.ok) error = r.error;
        break;
      }
      case 'end': {
        const r = this.endFromGame(b.id, steamid);
        if (!r.ok) error = r.error;
        break;
      }
      case 'extend': {
        const r = extendBooking(this.db, { bookingId: b.id, by: steamid, now: new Date(this.now()) });
        if (r.ok) this.onExtended(b.id);
        else error = BOOKING_ERRORS[r.error].text;
        break;
      }
    }
    if (error === null) return;
    const server = getServer(this.db, serverId);
    if (!server) return;
    this.deps.rcon(server, [`say [Booking] ${consoleText(error, 150)}`]).catch((err) => {
      console.warn(`[booking] ${b.id}: command refusal on ${server.name} failed:`, err instanceof Error ? err.message : err);
    });
  }

  // ---------- notices ----------

  /** Never throws: a notice runs after a committed state change, and a
   *  failure to word or send it must not undo the caller's work (a route's
   *  answer, a release). */
  private tell(id: number, steamids: Iterable<string>, type: NotifyType, extra: { minutes?: number; reason?: string | null; addedBy?: string } = {}): void {
    try {
      const payload = bookingMessage(this.db, this.deps.publicUrl, id, type, extra);
      if (payload) this.deps.notifier.send(steamids, type, payload);
    } catch (err) {
      console.warn(`[booking] ${id}: ${type} notice failed:`, err instanceof Error ? err.message : err);
    }
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

  /** After an extend: a running box shows the new end in its notice and says
   *  so in chat. Best effort; the minute watch already uses the new end. */
  onExtended(id: number): void {
    const b = getBooking(this.db, id);
    if (!b || b.server_id === null || b.ending_at !== null || (b.state !== 'ready' && b.state !== 'active')) return;
    const server = getServer(this.db, b.server_id);
    if (!server) return;
    let lines: string[];
    try {
      lines = bookingLines(this.db, b);
    } catch (err) {
      console.warn(`[booking] ${id}: extend notice not sent:`, err instanceof Error ? err.message : err);
      return;
    }
    this.deps.rcon(server, [...lines, `say [Booking] Extended: this booking now runs until ${b.ends_at.slice(11, 16)} UTC.`]).catch((err) => {
      console.warn(`[booking] ${id}: extend notice on ${server.name} failed:`, err instanceof Error ? err.message : err);
    });
  }

  onNoShow(id: number, absent: Side): void {
    const s = sidesOf(this.db, id).find((x) => x.side === absent);
    if (!s) return;
    const people = acceptedPeople(this.db, id).filter((p) => p.side === absent).map((p) => p.steamid);
    this.tell(id, [...sideManagers(this.db, s), ...people], 'booking_no_show');
    this.settle(id);
  }

}
