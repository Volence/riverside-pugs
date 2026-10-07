import type { DB } from '../db.js';
import { getServer, type ServerRow } from '../serverPool.js';
import { NOT_HELD_SQL, holdFor } from '../serverHolds.js';
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
import type { Notifier } from '../notify/notify.js';
import { bookingMessage, reviewAskMessage, type BookingNotifyType } from './messages.js';
import { claimReviewAsk } from '../scrims/reviews.js';
import { DEFAULT_GRACE_MINUTES, bookingLimits, byPriority, isLateCancel } from './rules.js';
import {
  acceptedPeople, actingSides, advancePlaylist, allowInGame, allowList, bookingRules, closeBooking, endBooking, expireUnconfirmed, addCampaign, gameName, getBooking, markActive,
  markReady, markReleased, markSetup, openBookings, recordPresence, resetSetupAttempts, setCloseAt, setNext, setReminded, setWarned, sideName, sidesOf, holdBox,
  beginMove, beginRecovery, bumpBooking, dropBox, finishRecovery, markUpAlerted, noteA2s, noteAlive, noteLost, reholdBox,
  BOOKING_ERRORS, type BookingRow, type Side, type SideRow,
} from './bookings.js';
import { classifyBox } from './recovery.js';
import { prepareRestore, restoreSnapshot, resumeLines, type RestoreSnapshot } from './restore.js';
import type { A2sFn } from '../a2s.js';
import { abortBookingGame, bookingGames, bookingOnServer, gamesPlayed, liveBookingGame } from './games.js';
import { TOURNAMENT_LINES, TOURNAMENT_RULE_CLEAR, boxNeedsGame, tournamentRuleLines } from './tournamentGames.js';
import type { BookingVoice } from './voice.js';
import type { BookingCmd } from '../logParse.js';
import { EVENT_ERRORS } from '../events/validate.js';

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
/** Tries at a chapter replay whose resume got no answer after the abort
 *  (plan T3c Task 8 ruling), before the booking goes to crash recovery. */
export const REPLAY_TRIES = 3;
export type ReplayResult = 'ok' | 'refused' | 'busy' | 'error' | 'dropped';
export const GOODBYE_MS = 3_000;
/** Minutes left on the slot at which the box says so in chat, once, and
 *  only between games (bookings by campaign, Ruling 4). */
export const WARN_MINUTES = 10;
/** The seeded default of booking_close_grace_minutes (plan T5 Ruling 2). */
export const CLOSE_GRACE_MS = 5 * 60_000;
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
  // Server priority Ruling 7: the goodbye on a scrim's box a tournament match takes.
  bumped: 'a tournament match needs it',
};
/** The goodbye for a `done` end once every booked campaign is played. */
const ALL_PLAYED_SAY = 'every booked campaign is played';

/** A tournament booking (aliased t) waiting for a box: scheduled at its
 *  start with none yet, or recovering after its box died (waiting_since is
 *  set by dropBox and beginMove). Either way it has no box and is not ending. */
const WAITING_MATCH_SQL = "t.server_id IS NULL AND t.ending_at IS NULL AND (t.state = 'scheduled' OR t.waiting_since IS NOT NULL)";

/** A tournament booking (aliased t) a scrim may give way to: waiting at its
 *  start, or waiting because its box died (its latest box_dropped is newer
 *  than its latest box_moved_by_staff). A match staff moved (beginMove) waits
 *  without bumping anyone (controller ruling on the final review). */
const OWED_MATCH_SQL = `t.server_id IS NULL AND t.ending_at IS NULL AND (t.state = 'scheduled' OR (t.waiting_since IS NOT NULL
  AND (SELECT e.event FROM booking_events e WHERE e.booking_id = t.id AND e.event IN ('box_dropped', 'box_moved_by_staff')
        ORDER BY e.id DESC LIMIT 1) = 'box_dropped'))`;

const ordinal = (n: number): string => ({ 2: 'second', 3: 'third' } as Record<number, string>)[n] ?? `${n}th`;

/** The refusal of `!nextmap` and `!stay` once the count is reached. */
/** Plan T6: a carry pug-match refused (an older plugin, a box not in
 *  tournament mode, a match id it does not hold) is only logged; the game
 *  plays on with its own score. replies are one per command, as BoxRcon returns them. */
export function warnCarryRefused(server: ServerRow, cmds: readonly string[], replies: readonly string[]): void {
  cmds.forEach((c, i) => {
    const m = /^sm_pug_carry (\d+) /.exec(c);
    const reply = (Array.isArray(replies) ? replies[i] ?? '' : '').trim();
    if (m && !reply.startsWith('PUGOK carry')) {
      console.warn(`[booking] match ${m[1]}: ${server.name} did not take sm_pug_carry (${JSON.stringify(reply.slice(0, 120))}); game 2 plays without game 1's score in its tally`);
    }
  });
}

function allPlayedText(n: number): string {
  return n === 1 ? 'The booked campaign is played. !addcampaign for one more.' : `All ${n} campaigns are played. !addcampaign for one more.`;
}

/** Sent before the release: if the end restart is ever skipped, the box must
 *  not keep the booking's passwords or notice, nor its scrim rules: the pause
 *  limits go back to the PUG template and the auto-track threshold to the
 *  plugin's default (8), so the next PUG on the box plays PUG rules. */
export const CLEAR_LINES: readonly string[] = [
  'l4d_booking_id ""',
  'l4d_booking_password ""', 'l4d_booking_tv_password ""', 'l4d_booking_notice ""',
  `sm_pug_pause_limit ${TEMPLATES.PUG.pause.limit ?? 0}`, `sm_pug_pause_seconds ${TEMPLATES.PUG.pause.seconds ?? 0}`,
  'sm_pug_auto_min_players 8',
  // A tournament box sets it to 0 (TOURNAMENT_LINES); the plugin default is 1.
  'sm_pug_end_kick 1',
  // A tournament box turned on !sub, !admin and the staff freeze (TOURNAMENT_LINES, plan T3c); 0 is the plugin default.
  'sm_pug_tournament 0',
  // Plan T5: a tournament box's match-rule cvars back to pug-match's defaults.
  ...TOURNAMENT_RULE_CLEAR,
];

/** The series engine's hand on a tournament booking (tournaments plan T3b). */
export interface TournamentHooks {
  /** The burst that starts the game due on this campaign (sm_pug_match, the
   *  roster, the ready notice, a chat line), pushed before every changelevel
   *  of a tournament booking. May throw: a setup try then fails, and a
   *  between-game load alerts staff. */
  gameLines(bookingId: number, campaign: string): string[];
  /** The burst of a game already pushed that the box has not reported yet
   *  (no heartbeat), re-sent on the minute watch; [] otherwise. */
  pendingLines(bookingId: number): string[];
  ready(bookingId: number): void;
  presence(bookingId: number, on: ReadonlySet<string>, now: Date): void;
  gameEnded(bookingId: number, matchId: number): void;
  ended(bookingId: number, reason: string | null): void;
  /** Crash recovery aborted this tournament game (server_lost): it could not
   *  be restored, or the booking was given up. Optional. */
  gameLost?(bookingId: number, matchId: number): void;
  /** Plan T3c final review: may an empty tournament booking be ended as
   *  idle now? False while staff gave the teams longer to connect than the
   *  idle end would wait. Optional; absent or throwing, yes. */
  idleEndAllowed?(bookingId: number): boolean;
  /** Plan T3c final review: is the staff freeze on for this booking's match
   *  on the site? A restarted box forgot it, so a resumed game is frozen
   *  again. Optional; absent or throwing, no. */
  frozen?(bookingId: number): boolean;
}

export interface BookingRunnerDeps {
  db: DB;
  rcon: BoxRcon;
  publicUrl: string;
  /** Give the box back with a forced restart; resolves once it is back (true)
   *  or reported offline (false). `gone`: the give-back of a box that went
   *  down under a booking and answers again (the releaser refuses a gone box
   *  to everyone else). */
  release: (serverId: number, opts?: { gone?: boolean }) => Promise<boolean>;
  /** True while the releaser is restarting this box (staff Set idle on a gone
   *  box starts the same forced restart): the gone give-back leaves it alone
   *  rather than restart it a second time. Absent, never. */
  releasing?: (serverId: number) => boolean;
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
  /** A booked scrim's private team voice (plan 4c). Absent, there is none.
   *  Every call is guarded (voiceStep): voice never blocks a booking. */
  voice?: BookingVoice;
  /** A2S_INFO, asked only once rcon has failed for booking_gone_minutes
   *  (plan 5). Absent, it is treated as never answering. */
  a2s?: A2sFn;
  /** Tournaments plan T3b: the series engine's hooks on a tournament booking.
   *  Absent, a tournament booking's box is still set up with auto-track off
   *  and no captain commands, but it starts no game and nothing hears it. */
  tournament?: TournamentHooks;
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

/** The lines that make the box record the booking's games (plan 4b), and
 *  since plan 4b2 the allowlist (allowLines) at the end: the
 *  plugin's auto-track starts a match when both teams go live with enough
 *  humans, the ruleset's pause limits (0 turns a limit off), the captains
 *  list (every manager of a confirmed side, Task 6) so the plugin's own
 *  `!nextmap`/`!stay`/`!end`/`!addcampaign` courtesy check has someone to check
 *  against, and when the site has a log address, logging to it plus (with
 *  `withSecret`, the default) the log secret exactly as pushLogSecret
 *  (src/logAuth.ts) sends it. The secret goes only at setup and after a
 *  campaign load, not in the minute re-push. It is a console line: callers
 *  must redact it from anything they log (redactSecrets). */
export function gameLines(db: DB, b: BookingRow, server: ServerRow, logAddress?: string, withSecret = true): string[] {
  const pause = bookingRules(b)?.pause;
  const captains = [...new Set(sidesOf(db, b.id).filter((s) => s.confirmed_at !== null).flatMap((s) => sideManagers(db, s)))];
  const lines = [
    // A tournament box adopts nothing: the site starts every game (T3b Ruling 3).
    `sm_pug_auto_track ${b.purpose === 'tournament' ? 0 : 1}`,
    `sm_pug_auto_min_players ${settingNumber(db, 'booking_game_min_players', 6, { min: 2, max: 8, integer: true })}`,
    `sm_pug_pause_limit ${Math.max(0, Math.trunc(pause?.limit ?? 0))}`,
    `sm_pug_pause_seconds ${Math.max(0, Math.trunc(pause?.seconds ?? 0))}`,
    `l4d_booking_captains ${quoted(captains.join(','))}`,
    ...(b.purpose === 'tournament' ? [...TOURNAMENT_LINES, ...tournamentRuleLines(bookingRules(b))] : []),
  ];
  if (logAddress && /^[A-Za-z0-9.-]+:\d{1,5}$/.test(logAddress)) {
    lines.push(`logaddress_add ${logAddress}`);
    if (withSecret && server.log_secret && /^[0-9a-f]{32,64}$/.test(server.log_secret)) {
      lines.push('sv_rcon_log 0', `sm_pug_log_secret "${server.log_secret}"`, 'sv_rcon_log 1');
    }
  }
  lines.push(...allowLines(db, b));
  return lines;
}

/** The boot marker (plan 5): written by setup and recovery only, never by the
 *  minute re-push, so an empty one means srcds started since. */
export const markerLine = (id: number): string => `l4d_booking_id "${id}"`;

/** Steamids per `sm_booking_allow_add` line: well under the console's line length. */
export const ALLOW_CHUNK = 10;

/** Who may be on the box (plan 4b2), pushed whole each time so the plugin
 *  never holds a half list: begin, the ids in chunks, commit. Then how long a
 *  captain has to `!allow` someone who is not on it, and how long a kicked
 *  one stays out. The ids must never reach a log line: hideAllowIds. */
export function allowLines(db: DB, b: BookingRow): string[] {
  const ids = allowList(db, b.id).filter((id) => /^\d{17}$/.test(id));
  const lines = ['sm_booking_allow_begin'];
  for (let i = 0; i < ids.length; i += ALLOW_CHUNK) lines.push(`sm_booking_allow_add ${ids.slice(i, i + ALLOW_CHUNK).join(' ')}`);
  lines.push(
    'sm_booking_allow_commit',
    `l4d_booking_grace ${settingNumber(db, 'booking_allow_grace_seconds', 60, { min: 15, max: 300, integer: true })}`,
    `l4d_booking_block ${settingNumber(db, 'booking_allow_block_minutes', 30, { min: 0, max: 240, integer: true })}`,
  );
  return lines;
}

/** An rcon error names the command it was on: an allowlist line (add or
 *  refuse) becomes a count. */
export function hideAllowIds(message: string): string {
  return message.replace(/sm_booking_allow_(add|refuse)((?:\s+\d+)*)/g, (_, what: string, ids: string) => `sm_booking_allow_${what} (${ids.trim() === '' ? 0 : ids.trim().split(/\s+/).length} ids)`);
}

/** The SteamID64 an `!allow` line names (its arg starts with it), or null. */
function allowTarget(arg: string): string | null {
  const first = arg.trim().split(/\s+/)[0] ?? '';
  return /^\d{17}$/.test(first) ? first : null;
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
  /** Bookings whose box has had a campaign start said by loadNext: the
   *  go-active announcement of the first campaign is then moot (a captain
   *  picked a campaign before anyone was on, and it was already announced). */
  private readonly announced = new Set<number>();
  /** Recovery attempts so far, per booking (plan 5); SETUP_TRIES at most. */
  private readonly recoverTries = new Map<number, number>();
  /** Bookings just moved to another box by relocate: recoverOnce restarts
   *  that box first, as setup does a fresh one (plan 5). */
  private readonly freshBox = new Set<number>();
  /** Unanswered A2S queries in a row per booking while rcon fails (plan 5).
   *  In memory: a web restart starts the count again, which only delays a move. */
  private readonly a2sMisses = new Map<number, number>();
  /** rcon answers in a row per gone box (plan 5 ruling 4); two put it back. */
  private readonly goneAnswers = new Map<number, number>();
  /** Gone boxes being given back through the releaser right now, by server id. */
  private readonly returning = new Map<number, Promise<void>>();

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
    while (this.busy.size > 0 || this.returning.size > 0) await Promise.all([...this.busy.values(), ...this.returning.values()]);
  }

  /** Boot: nothing in memory survived. An end that had started finishes
   *  (no goodbye: the box may be mid-restart); a booking caught in setup is
   *  set up again from the start; ready and active ones carry on. */
  resume(): void {
    for (const b of openBookings(this.db)) {
      if (b.ending_at !== null) this.track(b.id, () => this.windDown(b.id, false));
      else if (b.recovering_at !== null && b.server_id !== null) this.track(b.id, () => this.recover(b.id));
      else if (b.state === 'held' || b.state === 'setup') {
        // A web restart is not a failed try: start the retry count fresh.
        resetSetupAttempts(this.db, b.id);
        this.track(b.id, () => this.setup(b.id));
      }
    }
  }

  /** Take a box for every confirmed booking at its hold time. Run by the
   *  tick and whenever the releaser frees a box. Bookings are walked by
   *  priority (rules.ts byPriority): a tournament match before a scrim. */
  allocate(): void {
    // Waiting bookings first: the only time a booking goes ahead of PUGs.
    this.relocate();
    const nowMs = this.now();
    const lead = bookingLimits(this.db).holdLeadMinutes * 60_000;
    let preempt = false;
    for (const b of this.queue()) {
      if (b.state !== 'scheduled' || b.server_id !== null || b.ending_at !== null) continue;
      if (Date.parse(b.starts_at) - lead > nowMs) continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const server = this.pickBox(b);
      if (!server || !holdBox(this.db, b.id, server.id, new Date(nowMs))) {
        // Preempt practice and side games only when the region has no free
        // box at all; an idle box that cannot load the playlist (dlc4, a
        // custom campaign) would not be helped by emptying another one.
        if (this.freeBoxes(b.region) === 0) {
          preempt = true;
          // Server priority (Rulings 4 and 6): once practice and side games
          // have nothing left to give back in the region, a tournament match
          // bumps the unstarted scrim holding a box it can use, and a scrim
          // past its start is bumped for a match still waiting on a box
          // rather than waiting on itself for the no_server close.
          if (!this.preemptable(b.region)) {
            if (b.purpose === 'tournament') {
              this.bumpFor(b, nowMs);
            } else if (nowMs >= Date.parse(b.starts_at)) {
              // One scrim per waiting match, across passes: a match any scrim
              // was already bumped for is not offered again (waitingTournament).
              // A box on its way back is owed to the match first (Important 1).
              const match = this.tournamentsOwed(b.region) > 0 ? this.waitingTournament(b.region) : null;
              if (match) { this.bump(b, match, nowMs); continue; }
            }
          }
        }
        if (b.purpose !== 'tournament' && nowMs >= Date.parse(b.starts_at) && !this.latePublished.has(b.id)) {
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

  /** Every booking still holding something, in the order boxes go to them
   *  (server priority Ruling 2). */
  private queue(): BookingRow[] {
    return openBookings(this.db).sort(byPriority);
  }

  /** Idle, enabled boxes in the region that nothing holds. */
  private freeBoxes(region: string): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM servers WHERE status = 'idle' AND enabled = 1 AND region = ? AND ${NOT_HELD_SQL}`,
    ).get(region) as { n: number }).n;
  }

  /** Whether this box can load every campaign on the booking's playlist. */
  private fits(b: BookingRow, s: ServerRow): boolean {
    const registry = campaignRegistry(this.db);
    return (JSON.parse(b.playlist_json) as string[]).every((c) => loadsOn(this.db, registry.get(c), s));
  }

  /** An idle box for this booking: enabled, in its region, held by nothing,
   *  and able to load every campaign on the playlist. Highest id first, the
   *  reverse of claimIdle, like a practice lease. */
  pickBox(b: BookingRow): ServerRow | null {
    const rows = this.db.prepare(
      `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND region = ? AND ${NOT_HELD_SQL} ORDER BY id DESC`,
    ).all(b.region) as ServerRow[];
    return rows.find((s) => this.fits(b, s)) ?? null;
  }

  // ---------- server priority (owner, 2026-10-07) ----------

  /** Practice leases and side games on enabled boxes in the region: what
   *  deps.preempt can still give back, which always comes before a scrim
   *  gives way (Ruling 4). */
  private preemptable(region: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM open_server_holds h JOIN servers s ON s.id = h.server_id
        WHERE h.kind IN ('practice', 'side') AND s.region = ? AND s.enabled = 1 LIMIT 1`,
    ).get(region);
  }

  /** Tournament bookings in the region waiting for a box (at their start,
   *  or recovering from a box that died, never a staff move: OWED_MATCH_SQL), less the boxes
   *  already on their way back there (bumped scrims winding down, and boxes
   *  the releaser is restarting): how many more scrims may give way right
   *  now (Rulings 4 and 6, final review Importants 1 and 2). */
  private tournamentsOwed(region: string): number {
    const waiting = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM bookings t WHERE purpose = 'tournament' AND region = ? AND ${OWED_MATCH_SQL}`,
    ).get(region) as { n: number }).n;
    const bumped = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE purpose = 'scrim' AND region = ? AND end_reason = 'bumped' AND server_id IS NOT NULL AND ended_at IS NULL",
    ).get(region) as { n: number }).n;
    return Math.max(0, waiting - bumped - this.restartingBoxes(region));
  }

  /** Boxes in the region the releaser is restarting that come back to the
   *  pool when it is done (final review, Important 1): offline, enabled, not
   *  gone (a gone box is not coming back), held by no practice lease or side
   *  game, and held by no booking that keeps it (a running one, or a bumped
   *  scrim, which tournamentsOwed counts already). A booking winding down for
   *  any other end gives its box back, so that box counts. Without the
   *  releasing dep, none. */
  private restartingBoxes(region: string): number {
    const releasing = this.deps.releasing;
    if (!releasing) return 0;
    const rows = this.db.prepare(
      `SELECT id FROM servers WHERE status = 'offline' AND enabled = 1 AND region = ? AND gone_since IS NULL
         AND id NOT IN (SELECT server_id FROM open_server_holds WHERE kind <> 'booking')
         AND id NOT IN (SELECT server_id FROM bookings WHERE server_id IS NOT NULL AND ended_at IS NULL AND (ending_at IS NULL OR end_reason = 'bumped'))`,
    ).all(region) as { id: number }[];
    return rows.filter((r) => {
      try {
        return releasing(r.id);
      } catch {
        return false;
      }
    }).length;
  }

  /** Whether this booking is a match a scrim may give way to (OWED_MATCH_SQL). */
  private owed(id: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM bookings t WHERE id = ? AND purpose = 'tournament' AND ${OWED_MATCH_SQL}`).get(id);
  }

  /** Whether any tournament booking in the region waits for a box (staff
   *  moved or not: a released box goes to it either way). */
  private tournamentsWaiting(region: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM bookings t WHERE purpose = 'tournament' AND region = ? AND ${WAITING_MATCH_SQL} LIMIT 1`).get(region);
  }

  /** The tournament booking in the region waiting for a box that a scrim
   *  past its start gives way to (Ruling 6): the first in queue order that
   *  no scrim has been bumped for yet. A bump writes a 'bumped' event naming
   *  the match (byBookingId), so one waiting match takes at most one scrim
   *  however many passes it waits through, and a match a held scrim's box is
   *  already winding down for takes no second one. */
  private waitingTournament(region: string): BookingRow | null {
    const rows = this.db.prepare(
      `SELECT * FROM bookings t WHERE purpose = 'tournament' AND region = ? AND ${OWED_MATCH_SQL}
         AND NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.event = 'bumped' AND json_extract(e.detail, '$.byBookingId') = t.id)`,
    ).all(region) as BookingRow[];
    return rows.sort(byPriority)[0] ?? null;
  }

  /** The scrim a tournament match may bump (Ruling 4): open, holding a box
   *  in the match's region, not started (never active, no live game, not in
   *  crash recovery, nobody seen on its box yet: last_human_at is written
   *  only by recordPresence and finishRecovery), on a box that loads the
   *  match's campaign. The latest
   *  start first, then the newest row: the scrim with the most time to
   *  rebook gives way. */
  private bumpable(forB: BookingRow): BookingRow | null {
    const rows = this.db.prepare(
      `SELECT * FROM bookings WHERE purpose = 'scrim' AND region = ? AND server_id IS NOT NULL AND ending_at IS NULL
         AND recovering_at IS NULL AND last_human_at IS NULL AND state IN ('held', 'setup', 'ready') ORDER BY starts_at DESC, id DESC`,
    ).all(forB.region) as BookingRow[];
    for (const v of rows) {
      if (liveBookingGame(this.db, v.id)) continue;
      const s = getServer(this.db, v.server_id!);
      if (s && this.fits(forB, s)) return v;
    }
    return null;
  }

  /** A tournament match with no idle box in its region and nothing left to
   *  preempt: bump one scrim for it, unless a bumped box is already on its
   *  way back (Ruling 4). */
  private bumpFor(forB: BookingRow, nowMs: number): void {
    if (this.tournamentsOwed(forB.region) === 0) return;
    const victim = this.bumpable(forB);
    if (victim) this.bump(victim, forB, nowMs);
  }

  /** Close the scrim as bumped, tell staff and both sides, and start the
   *  wind-down (settle), which gives its box back through the releaser;
   *  the freed hook then runs allocate again for the match (Rulings 5 and 7). */
  private bump(victim: BookingRow, forB: BookingRow, nowMs: number): void {
    // Scrims already bumped for this match: a later one means the box an
    // earlier bump freed never reached it (its restart failed).
    const before = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM booking_events WHERE event = 'bumped' AND json_extract(detail, '$.byBookingId') = ?",
    ).get(forB.id) as { n: number }).n;
    const r = bumpBooking(this.db, { bookingId: victim.id, byBookingId: forB.id, now: new Date(nowMs) });
    if (!r.ok) {
      console.warn(`[booking] bumping booking ${victim.id} for ${forB.id} refused: ${r.error}`);
      return;
    }
    const [a, bs] = sidesOf(this.db, victim.id);
    const names = `${sideName(this.db, a)} vs ${sideName(this.db, bs)}`;
    console.log(`[booking] ${victim.id} (${names}) bumped by tournament booking ${forB.id}`);
    publishAdminEvent({
      kind: 'problem',
      text: `Booking ${victim.id} (${names}, ${victim.starts_at.slice(11, 16)} UTC) was bumped by tournament match booking ${forB.id}: `
        + `${r.value.hadServer ? 'its server is going back to the pool for the match' : 'no server was free and the match is ahead of it'}. `
        + `Both sides are told${r.value.nearestSlot ? ` and offered ${r.value.nearestSlot.slice(11, 16)} UTC` : ''}; it counts against neither side.`
        + (before > 0 ? ` It is the ${ordinal(before + 1)} scrim bumped for match booking ${forB.id}: the server the earlier bump freed did not come back.` : ''),
    });
    this.tell(victim.id, this.everyone(victim.id), 'booking_bumped', { slot: r.value.nearestSlot });
    this.settle(victim.id);
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
        const why = hideAllowIds(redactSecrets(err instanceof Error ? err.message : String(err), [server.log_secret]));
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
    const [hasMarker] = await this.deps.rcon(server, ['l4d_booking_id']);
    if (cvarValue(hasMarker, 'l4d_booking_id') === null) throw new Error('the l4d_booking plugin on this box is older than 1.4.0 (no l4d_booking_id)');
    const lines = [...bookingLines(this.db, b), ...gameLines(this.db, b, server, this.deps.logPublicAddress)];
    const playlist = JSON.parse(b.playlist_json) as string[];
    const firstMap = firstMapOf(this.db, playlist[0]);
    if (!isMapName(firstMap)) throw new Error(`${playlist[0]} starts on ${JSON.stringify(firstMap)}, which is not a valid map name`);
    // T3b Ruling 3: the game burst goes before the first changelevel, as the
    // orchestrator's queue path sends it; a throw here fails this setup try.
    const game = this.gameLinesFor(b, playlist[0]!);
    const setupBurst = [...lines, markerLine(b.id), ...game];
    warnCarryRefused(server, setupBurst, await this.deps.rcon(server, setupBurst));
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
    if (b.purpose === 'tournament') this.hook(id, 'ready', () => this.deps.tournament?.ready(id));
    else this.tell(id, acceptedPeople(this.db, id).map((p) => p.steamid), 'booking_ready');
    await this.voiceStep(id, 'ensure');
  }

  /** One BookingVoice call. BookingVoice already never throws; this is the
   *  belt to its braces, so a voice bug can never stop a setup, a watch or a
   *  wind-down. */
  private async voiceStep(id: number, step: 'ensure' | 'sync' | 'close'): Promise<void> {
    const voice = this.deps.voice;
    if (!voice) return;
    try {
      await voice[step](id);
    } catch (err) {
      console.error(`[booking] ${id}: voice ${step} failed:`, err);
    }
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
    // T3b Ruling 11: the series engine holds a match whose box goes away mid-series.
    if (b.purpose === 'tournament') this.hook(id, 'ended', () => this.deps.tournament?.ended(id, b.end_reason));
    // Whatever the end (time, idle, everyone left, a cancel, staff, !end), a
    // live game of this booking is aborted first. Left 'live', the orphan
    // reaper would later release the box it names, which by then may be
    // running a PUG.
    const tokens: string[] = [];
    for (let live = liveBookingGame(this.db, id); live; live = liveBookingGame(this.db, id)) {
      const token = abortBookingGame(this.db, live.id, new Date(this.now()));
      if (token === null) break;
      this.forgetToken(id, token);
      tokens.push(token);
    }
    if (b.server_id === null) { markReleased(this.db, id, new Date(this.now())); return; }
    const server = getServer(this.db, b.server_id);
    if (server) for (const token of tokens) await this.sendAbort(id, server, token);
    if (server && sayGoodbye) {
      try {
        const why = b.end_reason === 'done' && gamesPlayed(this.db, id) >= b.games_allowed ? ALL_PLAYED_SAY : END_SAY[b.end_reason ?? 'time'] ?? 'the booking is over';
        const tag = b.purpose === 'tournament' ? 'Match' : 'Booking';
        await this.deps.rcon(server, [`say [${tag}] This booked server is closing: ${why}.`]);
        await this.sleep(GOODBYE_MS);
        await this.deps.rcon(server, ['sm_kick @humans "The booking is over. Thanks for playing."']);
      } catch (err) {
        // Best effort: the restart below empties the box either way.
        console.warn(`[booking] ${id}: goodbye on ${server.name} failed:`, err instanceof Error ? err.message : err);
      }
    }
    // Before the release (ruling 3): everyone in the side channels goes to
    // the lobby and the channels go.
    await this.voiceStep(id, 'close');
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
    this.a2sMisses.delete(id);
    this.announced.delete(id);
    // Final review, Important 3: the releaser's own waiters (allocate among
    // them) ran before markReleased, while the hold still hid the box. A box
    // a bumped scrim gave up, or any box while a match in its region waits,
    // goes to the match now, before the freed hook wakes the PUG queue.
    if (b.end_reason === 'bumped' || this.tournamentsWaiting(b.region)) {
      try {
        this.allocate();
      } catch (err) {
        console.error(`[booking] ${id}: allocating after the release failed:`, err);
      }
    }
    try {
      this.deps.freed?.();
    } catch (err) {
      console.error(`[booking] ${id}: the freed hook failed:`, err);
    }
  }

  private forgetToken(id: number, token: string): void {
    try {
      this.deps.unregisterToken?.(token);
    } catch (err) {
      console.error(`[booking] ${id}: unregistering the aborted game's token failed:`, err);
    }
  }

  /** Best effort: the plugin drops its match. At the end of a booking the
   *  restart ends it either way. */
  private async sendAbort(id: number, server: ServerRow, token: string): Promise<void> {
    try {
      await this.deps.rcon(server, [`sm_pug_abort ${token}`]);
    } catch (err) {
      console.warn(`[booking] ${id}: sm_pug_abort on ${server.name} failed:`, redactSecrets(err instanceof Error ? err.message : String(err), [token]));
    }
  }

  /** Staff aborted a booking game (src/admin/matches.ts has already marked
   *  the row aborted): stop listening for its token and tell the plugin to
   *  drop the match. The box stays with the booking, which carries on. */
  async abortGame(matchId: number, token: string): Promise<void> {
    const m = this.db.prepare('SELECT booking_id, server_id FROM matches WHERE id = ?').get(matchId) as
      { booking_id: number | null; server_id: number | null } | undefined;
    if (!m || m.booking_id === null) return;
    this.forgetToken(m.booking_id, token);
    const b = getBooking(this.db, m.booking_id);
    const serverId = b?.server_id ?? m.server_id;
    const server = serverId !== null ? getServer(this.db, serverId) : undefined;
    if (server) await this.sendAbort(m.booking_id, server, token);
  }

  /** Finish any end a route or the tick started. Idempotent. Every end of a
   *  booking (time, idle, done, !end, a captain's or staff End, a no-show)
   *  comes through here, so this is where a scrim's review ask goes out. */
  settle(id: number): void {
    const b = getBooking(this.db, id);
    if (!b) return;
    this.askReview(b);
    if (b.ending_at === null || b.ended_at !== null) return;
    this.track(id, () => this.windDown(id, true));
  }

  /** Plan 2 Ruling 5: once a scrim closes as ended or no_show, each side's
   *  managers are asked for a private review of the other side. Once per
   *  booking: claimReviewAsk writes the review_asked event, so a second
   *  settle sends nothing. Never throws, like tell(). */
  private askReview(b: BookingRow): void {
    if (b.purpose !== 'scrim' || (b.state !== 'ended' && b.state !== 'no_show')) return;
    try {
      if (!claimReviewAsk(this.db, b.id, new Date(this.now()))) return;
      for (const s of sidesOf(this.db, b.id)) {
        const payload = reviewAskMessage(this.db, this.deps.publicUrl, b.id, s.side);
        if (payload) this.deps.notifier.send(sideManagers(this.db, s), 'scrim_review', payload);
      }
    } catch (err) {
      console.warn(`[booking] ${b.id}: scrim_review notice failed:`, err instanceof Error ? err.message : err);
    }
  }

  /** The minute pass. Never runs two at once, and never rejects: a timer
   *  caller only ever does `void runner.tick()`, so a thrown error here would
   *  otherwise surface as an unhandled rejection rather than a logged line. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date(this.now());
      for (const id of expireUnconfirmed(this.db, now)) {
        this.tell(id, this.everyone(id), 'booking_cancelled', { reason: 'it was not confirmed in time' });
      }
      this.remind(now);
      this.relocate();
      this.allocate();
      this.closeServerless(now);
      for (const b of openBookings(this.db)) {
        if (b.ending_at !== null) { this.settle(b.id); continue; }
        if ((b.state === 'ready' || b.state === 'active') && !this.busy.has(b.id)) await this.watch(b, now);
      }
      await this.returnGone();
      try {
        await this.deps.voice?.closeEnded();
      } catch (err) {
        console.error('[booking] voice closeEnded failed:', err);
      }
    } catch (err) {
      console.error('[booking] tick failed:', err);
    } finally {
      this.ticking = false;
    }
  }

  /** A confirmed booking that never got a box (none free in its region, or
   *  none able to load its playlist) closes once the no-show grace after its
   *  start has passed, so it neither waits for ever nor keeps a box back. */
  private closeServerless(now: Date): void {
    for (const b of openBookings(this.db)) {
      // T3b Ruling 8: a tournament booking waits; the series engine alerts.
      if (b.purpose === 'tournament') continue;
      if (b.state !== 'scheduled' || b.server_id !== null || b.ending_at !== null) continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const grace = (bookingRules(b)?.noShowGraceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000;
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

  /** The end a running booking is due without asking its box, or null.
   *  Bookings by campaign: never while a booking game is live (Ruling 4: the
   *  slot's end does not cut a game); `done` once the closing grace after the
   *  last booked campaign has passed with the count still reached (Ruling 3);
   *  `time` at the slot's end, unless a closing grace is still running, which
   *  then decides (Ruling 4: the N of N end still runs). */
  private dueEnd(b: BookingRow, nowMs: number): 'done' | 'time' | null {
    if (liveBookingGame(this.db, b.id)) return null;
    const closeMs = b.close_at !== null ? Date.parse(b.close_at) : null;
    if (closeMs !== null && nowMs >= closeMs && gamesPlayed(this.db, b.id) >= b.games_allowed) return 'done';
    // A tournament booking never ends on time: the series engine closes it (T3b Ruling 11).
    if (b.purpose !== 'tournament' && nowMs >= Date.parse(b.ends_at) && (closeMs === null || nowMs >= closeMs)) return 'time';
    return null;
  }

  /** One look at a running booking's box (minute watch: presence, active,
   *  done/time/idle ends, the slot warning). */
  private async watch(listed: BookingRow, now: Date): Promise<void> {
    // Read the row again: `listed` came from the tick's list, and the watches
    // before this one awaited rcon, so a +1 campaign made meanwhile (which
    // clears the closing grace) must not be undone by a stale close_at.
    const b = this.running(listed.id);
    if (!b) return;
    const server = b.server_id !== null ? getServer(this.db, b.server_id) : undefined;
    if (!server) return;
    // The done and time ends need no answer from the box: a dead box still ends.
    const due = this.dueEnd(b, now.getTime());
    if (due) { this.endNow(b.id, due, now); return; }
    // Voice needs no answer from the box either. Ensure is a no-op once the
    // channels exist; it makes them for a booking that was ready before voice
    // was turned on or the bot connected. Sync keeps the members in step.
    await this.voiceStep(b.id, 'ensure');
    await this.voiceStep(b.id, 'sync');
    let humans: ReturnType<typeof parseStatusPlayers>;
    let marker: string | null = null;
    let rconOk = true;
    try {
      const [st, mk] = await this.deps.rcon(server, ['status', 'l4d_booking_id']);
      humans = parseStatusPlayers(st);
      marker = cvarValue(mk, 'l4d_booking_id');
    } catch (err) {
      // Says nothing about who is on: the empty run starts again.
      rconOk = false;
      humans = [];
      this.emptyWatches.delete(b.id);
      console.warn(`[booking] ${b.id}: status on ${server.name} failed:`, err instanceof Error ? err.message : err);
    }
    // Plan 5: a restarted or gone box is dealt with before the minute re-push.
    if (await this.checkBox(b, server, now, rconOk, marker)) return;
    if (!rconOk) return;
    // The booking and game lines go again each minute, in their own burst
    // (best effort; the status above stands either way): cheap, idempotent,
    // and a map change can reset cvars a cfg sets. The log secret is not
    // among them: setup and every campaign load send it.
    await this.push(b.id, server, () => [...bookingLines(this.db, b), ...gameLines(this.db, b, server, this.deps.logPublicAddress, false)], 're-pushing the booking lines');
    const on = new Set(humans.map((h) => h.steamid64).filter((s): s is string => s !== null));
    const people = acceptedPeople(this.db, b.id);
    const present = {
      a: people.filter((p) => p.side === 'a' && on.has(p.steamid)).length,
      b: people.filter((p) => p.side === 'b' && on.has(p.steamid)).length,
    };
    // present_now (plan T3b, "N of 4") counts only each side's locked four.
    const players = people.filter((p) => p.role === 'player' && on.has(p.steamid));
    const playersNow = { a: players.filter((p) => p.side === 'a').length, b: players.filter((p) => p.side === 'b').length };
    recordPresence(this.db, b.id, present, humans.length > 0, now, playersNow);
    if (b.purpose === 'tournament') {
      this.hook(b.id, 'presence', () => this.deps.tournament?.presence(b.id, on, now));
      // A burst the box never got goes again until the game heartbeats (T3b Ruling 3).
      let pending: string[] = [];
      this.hook(b.id, 'pendingLines', () => { pending = this.deps.tournament?.pendingLines(b.id) ?? []; });
      if (pending.length > 0 && await this.boxLacksGame(b.id, server, pending)) await this.push(b.id, server, () => pending, 'the pending game burst');
    }
    if (b.state === 'ready' && present.a + present.b > 0 && markActive(this.db, b.id, now)) {
      // The first campaign was loaded by setup, before anyone was on: its
      // start lines are said once, when the booking goes active.
      const first = (JSON.parse(b.playlist_json) as string[])[b.playlist_pos];
      if (first && !this.announced.has(b.id)) await this.push(b.id, server, () => this.startLinesFor(b, first), 'the campaign start lines');
    }

    const fresh = getBooking(this.db, b.id)!;
    const nowMs = now.getTime();
    const endsMs = Date.parse(fresh.ends_at);
    const dueNow = this.dueEnd(fresh, nowMs);
    if (dueNow) { this.endNow(b.id, dueNow, now); return; }
    const limits = bookingLimits(this.db);
    const grace = (bookingRules(fresh)?.noShowGraceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000;
    const idleFrom = Math.max(fresh.last_human_at ? Date.parse(fresh.last_human_at) : 0, Date.parse(fresh.starts_at) + grace);
    if (humans.length === 0 && nowMs - idleFrom >= limits.idleEndMinutes * 60_000 && this.idleEndAllowed(fresh)) { this.endNow(b.id, 'idle', now); return; }
    const empties = humans.length === 0 ? (this.emptyWatches.get(b.id) ?? 0) + 1 : 0;
    this.emptyWatches.set(b.id, empties);
    if (b.purpose !== 'tournament' && empties >= EMPTY_WATCHES_TO_END && this.everyoneLeftAfterGame(b.id, nowMs)) { this.endNow(b.id, 'done', now); return; }

    if (fresh.next_campaign !== null && fresh.next_at !== null && Date.parse(fresh.next_at) <= nowMs && !liveBookingGame(this.db, b.id)) {
      this.track(b.id, () => this.loadNext(b.id));
    }

    // Ruling 4: one warning, only between games, and not during a closing
    // grace (the close line has said what happens next). +1 campaign clears
    // warned_minutes, so a moved slot end is warned about again.
    const leftMin = (endsMs - nowMs) / 60_000;
    if (leftMin <= WARN_MINUTES && (fresh.warned_minutes === null || fresh.warned_minutes > WARN_MINUTES)
      && fresh.close_at === null && fresh.purpose !== 'tournament' && !liveBookingGame(this.db, b.id)) {
      setWarned(this.db, b.id, WARN_MINUTES);
      try {
        await this.deps.rcon(server, [`say [Booking] About ${Math.max(1, Math.round(leftMin))} minutes of the booked slot left (until ${fresh.ends_at.slice(11, 16)} UTC).`]);
      } catch {
        // Best effort.
      }
    }
  }

  // ---------- crash recovery (plan 5) ----------

  /** After the watch's status: is the box still this booking's? True when
   *  the watch must stop here (a recovery started, or the box is quiet). */
  private async checkBox(b: BookingRow, server: ServerRow, now: Date, rconOk: boolean, marker: string | null): Promise<boolean> {
    const nowMs = now.getTime();
    if (rconOk) { noteAlive(this.db, b.id); this.a2sMisses.delete(b.id); }
    const lostSince = rconOk ? null : noteLost(this.db, b.id, now);
    const live = liveBookingGame(this.db, b.id);
    const hb = live ? (this.db.prepare('SELECT last_seen FROM match_live WHERE match_id = ?').get(live.id) as { last_seen: string } | undefined) : undefined;
    const limits = bookingLimits(this.db);
    const goneMs = limits.goneMinutes * 60_000;
    let a2sPlayers: number | null = null;
    // Asked on every watch from the first failed one, so an answer anywhere
    // in the outage is seen (between games there is no heartbeat).
    if (!rconOk && this.deps.a2s) {
      try {
        const r = await this.deps.a2s(server.host, server.port);
        if (r) { a2sPlayers = r.players; noteA2s(this.db, b.id, now); }
      } catch {
        // Treated as no answer.
      }
      this.a2sMisses.set(b.id, a2sPlayers !== null ? 0 : (this.a2sMisses.get(b.id) ?? 0) + 1);
    }
    const v = classifyBox({
      rconOk, marker, bookingId: b.id, nowMs,
      lostSinceMs: lostSince !== null ? Date.parse(lostSince) : null,
      heartbeatMs: hb ? sqlMs(hb.last_seen) : null,
      a2sPlayers, a2sMisses: this.a2sMisses.get(b.id) ?? 0, goneMisses: limits.goneMinutes, goneMs,
    });
    switch (v.kind) {
      case 'ok': return false;
      case 'quiet': return true;
      case 'up_no_rcon':
        if (markUpAlerted(this.db, b.id, now)) {
          publishAdminEvent({ kind: 'problem', text: `Booking ${b.id}: ${server.name} has not answered rcon for ${limits.goneMinutes}+ minutes but answers the server browser (${v.players} players). Nothing was moved; check the box.` });
        }
        return true;
      case 'restarted':
        if (beginRecovery(this.db, b.id, 'restart', now)) {
          publishAdminEvent({ kind: 'problem', text: `Booking ${b.id}: ${server.name} restarted; setting it up again` });
          this.track(b.id, () => this.recover(b.id));
        }
        return true;
      case 'gone':
        // With no A2S probe wired there is no proof the server browser is
        // silent too, so the box is never taken as gone (constraint: rcon,
        // heartbeat and A2S all silent).
        if (this.deps.a2s) this.onGone(b, server, now);
        return true;
    }
  }

  /** Plan 5: the box is gone. Let go of it, keep a box back from the PUG
   *  queue, and take the first one that is free. */
  private onGone(b: BookingRow, server: ServerRow, now: Date): void {
    if (!beginRecovery(this.db, b.id, 'gone', now)) return;
    this.a2sMisses.delete(b.id);
    if (dropBox(this.db, b.id, now) === null) return;
    console.warn(`[booking] ${b.id}: ${server.name} is gone; marked offline, moving to another server`);
    publishAdminEvent({
      kind: 'problem',
      text: `Booking ${b.id}: ${server.name} is gone (no rcon, no heartbeat, no server browser answer for ${bookingLimits(this.db).goneMinutes} minutes). It is marked offline; set it idle on the Servers desk once it answers (it also goes back by itself after answering rcon twice in a row). The booking is moving to another server.`,
    });
    this.relocate();
  }

  /** Waiting bookings first: the only time a booking goes ahead of PUGs.
   *  Each takes the first box free for it, or is cancelled after the wait. */
  private relocate(): void {
    const nowMs = this.now();
    const wait = bookingLimits(this.db).recoverWaitMinutes * 60_000;
    let preempt = false;
    for (const b of this.queue()) {
      if (b.waiting_since === null || b.server_id !== null || b.ending_at !== null || this.busy.has(b.id)) continue;
      if (nowMs - Date.parse(b.waiting_since) >= wait) {
        this.giveUp(b.id, `no server came free within ${wait / 60_000} minutes after its server went down`, 'the server went down and no other server was free');
        this.track(b.id, () => this.windDown(b.id, false));
        continue;
      }
      const s = this.pickBox(b);
      if (!s || !reholdBox(this.db, b.id, s.id, new Date(nowMs))) {
        preempt = true;
        // Server priority (final review, Important 2): a tournament match
        // whose box died bumps an unstarted scrim on the same terms as one
        // waiting at its start (allocate): no free box, nothing coming back,
        // nothing left to preempt, and one scrim per match still owed.
        // A match staff moved waits without bumping (OWED_MATCH_SQL).
        if (b.purpose === 'tournament' && this.freeBoxes(b.region) === 0 && !this.preemptable(b.region) && this.owed(b.id)) this.bumpFor(b, nowMs);
        continue;
      }
      console.log(`[booking] ${b.id} moves to ${s.name}`);
      this.freshBox.add(b.id);
      this.track(b.id, () => this.recover(b.id));
    }
    if (preempt) this.deps.preempt();
  }

  /** Plan 5 ruling 4: a gone box gets one `status` per tick (one short rcon
   *  burst, nothing held across ticks); two answers in a row give it back
   *  through the releaser, whose forced restart clears whatever the old
   *  booking left on it (a box cut off rather than crashed may still run its
   *  plugin match, passwords and players). A box staff already set idle only
   *  has gone_since cleared, and one staff Set idle is restarting is skipped. */
  private async returnGone(): Promise<void> {
    const gone = this.db.prepare('SELECT * FROM servers WHERE gone_since IS NOT NULL').all() as ServerRow[];
    const ids = new Set(gone.map((s) => s.id));
    for (const id of this.goneAnswers.keys()) if (!ids.has(id)) this.goneAnswers.delete(id);
    for (const server of gone) {
      if (this.returning.has(server.id) || this.deps.releasing?.(server.id)) continue;
      if (server.status !== 'offline') {
        this.db.prepare('UPDATE servers SET gone_since = NULL WHERE id = ?').run(server.id);
        this.goneAnswers.delete(server.id);
        continue;
      }
      try {
        await this.deps.rcon(server, ['status']);
      } catch (err) {
        this.goneAnswers.set(server.id, 0);
        // An rcon error names the command it was on; `status` carries no secret,
        // but the redaction stays as everywhere else.
        console.warn(`[booking] gone box ${server.name} still does not answer: ${redactSecrets(err instanceof Error ? err.message : String(err), [server.log_secret])}`);
        continue;
      }
      const n = (this.goneAnswers.get(server.id) ?? 0) + 1;
      this.goneAnswers.set(server.id, n);
      if (n < 2) continue;
      this.goneAnswers.delete(server.id);
      const still = this.db.prepare("SELECT 1 FROM servers WHERE id = ? AND status = 'offline' AND gone_since IS NOT NULL").get(server.id);
      if (!still) continue;
      const p = this.giveBack(server).finally(() => { this.returning.delete(server.id); });
      this.returning.set(server.id, p);
    }
  }

  /** The releaser's forced restart, then gone_since clears and staff hear of it.
   *  A restart that never comes back leaves the box offline and gone, so the
   *  next ticks try again. Never rejects. */
  private async giveBack(server: ServerRow): Promise<void> {
    let back = false;
    try {
      back = await this.deps.release(server.id, { gone: true });
    } catch (err) {
      console.error(`[booking] giving back gone box ${server.name} failed:`, err instanceof Error ? redactSecrets(err.message, [server.log_secret]) : err);
    }
    if (!back) {
      console.warn(`[booking] gone box ${server.name} answered but did not come back from its restart; trying again later`);
      return;
    }
    this.db.prepare('UPDATE servers SET gone_since = NULL WHERE id = ?').run(server.id);
    const under = this.db.prepare(
      "SELECT booking_id FROM booking_events WHERE event = 'box_dropped' AND json_extract(detail, '$.serverId') = ? ORDER BY id DESC LIMIT 1",
    ).get(server.id) as { booking_id: number } | undefined;
    console.log(`[booking] gone box ${server.name} answers again; back in the pool`);
    publishAdminEvent({ kind: 'problem', text: `Server ${server.name} answers again after it went down under booking ${under?.booking_id ?? '?'}; it is back in the pool.` });
    try {
      this.deps.freed?.();
    } catch (err) {
      console.error(`[booking] the freed hook failed after ${server.name} came back:`, err);
    }
  }

  /** Set a restarted box up again, and put its live game back. Tracked work. */
  private async recover(id: number): Promise<void> {
    for (;;) {
      const b = getBooking(this.db, id);
      if (!b || b.recovering_at === null || b.ending_at !== null || b.server_id === null) break;
      const server = getServer(this.db, b.server_id);
      if (!server) break;
      const attempt = (this.recoverTries.get(id) ?? 0) + 1;
      this.recoverTries.set(id, attempt);
      // Read before the try: a game the try aborts is no longer live, but its
      // token may still be in the error.
      const token = liveBookingGame(this.db, id)?.token ?? null;
      try {
        await this.recoverOnce(b, server);
        break;
      } catch (err) {
        // An rcon error names the command it was on (src/rcon.ts): the bursts
        // carry the log secret, the booking passwords, the game's token
        // (sm_pug_resume) and the allowlist ids, all hidden here.
        const why = hideAllowIds(redactSecrets(err instanceof Error ? err.message : String(err), [server.log_secret, b.password, b.tv_password, token]));
        console.warn(`[booking] ${id}: recovery try ${attempt} on ${server.name} failed: ${why}`);
        if (attempt < SETUP_TRIES) continue;
        this.recoverTries.delete(id);
        this.giveUp(id, `it could not be set up again on ${server.name} (${why})`, 'the server went down and could not be set up again');
        // Already tracked (this is the recovery's own work): wind down inline,
        // with no goodbye: the box is broken.
        await this.windDown(id, false);
        return;
      }
    }
    this.recoverTries.delete(id);
    // An end that came in during the recovery (staff, a captain's End) is
    // ours to finish, as in setup: settle skipped it while this was busy.
    const after = getBooking(this.db, id);
    if (after && after.ending_at !== null && after.ended_at === null) await this.windDown(id, true);
  }

  private async recoverOnce(b: BookingRow, server: ServerRow): Promise<void> {
    // A box just taken by a move gets the forced restart setup gives a fresh box.
    if (this.freshBox.delete(b.id) && !(await this.deps.restart(server))) throw new Error('the new box did not come back from its restart');
    await waitForStartup(this.deps.rcon, server, this.sleep);
    await this.execVerified(server, b);
    const [version, mk] = await this.deps.rcon(server, ['l4d_booking_version', 'l4d_booking_id']);
    if (cvarValue(version, 'l4d_booking_version') === null) throw new Error('the l4d_booking plugin is not loaded on this box');
    if (cvarValue(mk, 'l4d_booking_id') === null) throw new Error('the l4d_booking plugin on this box is older than 1.4.0 (no l4d_booking_id)');
    // The resume goes only now, after the config exec has settled: a map start
    // between sm_pug_resume and the changelevel below would use up the
    // plugin's one-shot side seed.
    const live = liveBookingGame(this.db, b.id);
    const snap = live ? restoreSnapshot(this.db, live.id) : null;
    const resume = snap ? resumeLines(snap) : [];
    const lines = [...bookingLines(this.db, b), ...gameLines(this.db, b, server, this.deps.logPublicAddress), markerLine(b.id)];
    // No sm_pug_auto_track 0 ahead of the resume: gameLines sets it to 1 (0 on a tournament box) in
    // this same burst, so it never kept auto-track from adopting anything.
    // What does is the plugin's state (sm_pug_resume leaves it Pending with a
    // match, which auto-track never adopts over) and the site guards
    // (selfStarted.ts leaves a recovering booking's game alone).
    const burst = [...resume, ...lines];
    const replies = await this.deps.rcon(server, burst);
    warnCarryRefused(server, burst, replies);
    // The sm_pug_resume_commit reply is the last of the resume lines.
    const resumed = snap !== null && (replies[resume.length - 1] ?? '').trim().startsWith('PUGOK resumed');
    if (live && !resumed) {
      // Ruling 5: the game cannot come back; the booking carries on without it.
      const token = abortBookingGame(this.db, live.id, new Date(this.now()), 'server_lost');
      if (token) this.forgetToken(b.id, token);
      if (token && b.purpose === 'tournament') this.hook(b.id, 'gameLost', () => this.deps.tournament?.gameLost?.(b.id, live.id));
      publishAdminEvent({
        kind: 'problem', matchId: live.id,
        text: `Booking ${b.id}: game #${live.id} could not be restored on ${server.name} (${snap ? 'pug-match did not take sm_pug_resume; is 0.3.19 staged?' : 'it was on the finale, or the site has no record of where it was'}). It is aborted; the booking carries on.`,
      });
    }
    if (resumed) prepareRestore(this.db, snap!);
    const fresh = getBooking(this.db, b.id)!;
    const playlist = JSON.parse(fresh.playlist_json) as string[];
    const campaign = fresh.next_campaign ?? playlist[fresh.playlist_pos];
    const map = resumed ? snap!.map : fresh.next_map ?? firstMapOf(this.db, campaign);
    if (!isMapName(map)) throw new Error(`${campaign} starts on ${JSON.stringify(map)}, which is not a valid map name`);
    // The campaign a captain had picked is loaded here, so it is moved on as
    // loadNext does (next cleared, position advanced, campaign_loaded logged):
    // left due, the next watch would changelevel the box to it a second time.
    const loadedNext = !resumed && fresh.next_campaign !== null;
    // T3b: the game burst for a game the crash caught before its load goes
    // before the playlist moves on (as loadNext), so a throw here leaves the
    // due load (next_campaign, next_map) for the retry.
    const game = loadedNext ? this.gameLinesFor(fresh, campaign) : [];
    if (game.length > 0) warnCarryRefused(server, game, await this.deps.rcon(server, game));
    if (loadedNext) {
      const at = playlist.indexOf(campaign);
      advancePlaylist(this.db, b.id, at >= 0 ? at : fresh.playlist_pos, new Date(this.now()));
    }
    try {
      await this.deps.rcon(server, [`changelevel ${map}`]);
    } catch {
      // A changelevel can drop the connection it came in on; the map check decides.
    }
    await this.sleep(MAP_SETTLE_MS);
    const [st] = await this.deps.rcon(server, ['status', ...lines]);
    if (parseStatusMap(st) !== map) throw new Error(`${map} did not load (the box is on ${parseStatusMap(st) ?? 'no map'})`);
    if (!finishRecovery(this.db, b.id, new Date(this.now()))) return;
    this.emptyWatches.delete(b.id);
    this.a2sMisses.delete(b.id);
    this.announced.delete(b.id);
    if (loadedNext) {
      this.announced.add(b.id);
      await this.push(b.id, server, () => this.startLinesFor(fresh, campaign), 'the campaign start lines');
    }
    let restored: string | null = null;
    let adminTail = '';
    if (resumed) {
      const s = snap!;
      const [sa, sb] = sidesOf(this.db, b.id);
      const sideA = (this.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(s.matchId) as { booking_side_a: Side | null } | undefined)?.booking_side_a ?? 'a';
      const teamName = (t: 'a' | 'b') => sideName(this.db, (t === 'a') === (sideA === 'a') ? sa : sb);
      const totA = s.maps.reduce((n, x) => n + x.a, 0);
      const totB = s.maps.reduce((n, x) => n + x.b, 0);
      const cname = campaignRegistry(this.db).get(s.campaign)?.name ?? s.campaign;
      const score = `${cname} map ${s.maps.length + 1}, ${teamName('a')} ${totA} - ${teamName('b')} ${totB}`;
      restored = `your game is back on ${score}`;
      adminTail = ` (game #${s.matchId} back on ${s.map}, ${teamName('a')} ${totA} - ${teamName('b')} ${totB})`;
      await this.push(b.id, server, () => [`say [Booking] ${consoleText(
        `Restored after a server restart: ${score}. ${teamName(s.firstSurv)} survive first. Ready up when everyone is back.`, 220)}`], 'the restore line');
      if (b.purpose === 'tournament') await this.refreeze(b.id, server, s);
    }
    console.log(`[booking] ${b.id} restored on ${server.name}`);
    // The notice carries the password: accepted people only, as booking_ready.
    this.tell(b.id, acceptedPeople(this.db, b.id).map((p) => p.steamid), 'booking_recovered', { moved: fresh.recover_reason === 'gone', restored });
    publishAdminEvent({ kind: 'problem', text: `Booking ${b.id}: restored on ${server.name}${adminTail}` });
  }

  /** Plan 5 rulings 3 and 5: the booking cannot go on. The caller winds down
   *  (inline from recover, which is already tracked). */
  private giveUp(id: number, staffWhy: string, playerWhy: string): void {
    const live = liveBookingGame(this.db, id);
    if (live) {
      const token = abortBookingGame(this.db, live.id, new Date(this.now()), 'server_lost');
      if (token) this.forgetToken(id, token);
      if (token && getBooking(this.db, id)?.purpose === 'tournament') this.hook(id, 'gameLost', () => this.deps.tournament?.gameLost?.(id, live.id));
    }
    publishAdminEvent({ kind: 'problem', text: `Booking ${id} is cancelled: ${staffWhy}.` });
    if (closeBooking(this.db, id, 'cancelled', 'server_lost', new Date(this.now()))) {
      this.tell(id, this.everyone(id), 'booking_cancelled', { reason: playerWhy });
    }
  }

  /** Ruling 4: a finished game, none live, and the last game's end, the last
   *  campaign load and the last recovery all long enough ago that a map
   *  change between campaigns, or everyone reconnecting after a restart
   *  between games, is not mistaken for it. */
  private everyoneLeftAfterGame(id: number, nowMs: number): boolean {
    const games = bookingGames(this.db, id);
    if (!games.some((g) => g.state === 'completed') || games.some((g) => g.state === 'live')) return false;
    const last = games.at(-1)!;
    if (last.endedAt === null) return false;
    const recovered = this.db.prepare("SELECT at FROM booking_events WHERE booking_id = ? AND event = 'recovered' ORDER BY id DESC LIMIT 1")
      .get(id) as { at: string } | undefined;
    const since = Math.max(sqlMs(last.endedAt), this.lastLoadMs(id), recovered ? sqlMs(recovered.at) : 0);
    return nowMs - since >= LEFT_AFTER_GAME_MS;
  }

  /** When the runner last loaded a campaign on the box, in ms, or 0. */
  private lastLoadMs(id: number): number {
    const loaded = this.db.prepare("SELECT at FROM booking_events WHERE booking_id = ? AND event = 'campaign_loaded' ORDER BY id DESC LIMIT 1")
      .get(id) as { at: string } | undefined;
    return loaded ? sqlMs(loaded.at) : 0;
  }

  /** The box sits on a finished campaign: the last game completed, none is
   *  live, and nothing has been loaded since. */
  private sittingOnFinished(id: number): boolean {
    const last = bookingGames(this.db, id).at(-1);
    return !!last && last.state === 'completed' && last.endedAt !== null && sqlMs(last.endedAt) >= this.lastLoadMs(id);
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
    // A tiebreak chapter loads straight (T3b Ruling 5).
    const map = b.next_map ?? firstMapOf(this.db, campaign);
    if (!isMapName(map)) {
      console.warn(`[booking] ${id}: ${campaign} starts on ${JSON.stringify(map)}, which is not a valid map name; not loading it`);
      setNext(this.db, id, null, null, new Date(this.now()));
      return;
    }
    const playlist = JSON.parse(b.playlist_json) as string[];
    const at = playlist.indexOf(campaign);
    let game: string[];
    try {
      game = this.gameLinesFor(b, campaign);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[booking] ${id}: the game for ${campaign} could not be started: ${why}`);
      publishAdminEvent({ kind: 'problem', text: `Booking ${id}: the tournament game on ${campaign} could not be started (${why}). Nothing was loaded; look at the match room.` });
      setNext(this.db, id, null, null, new Date(this.now()));
      return;
    }
    if (game.length > 0) await this.push(id, server, () => game, 'the game burst');
    // Moved on first: a box that does not take the changelevel is not sent it
    // again every minute; a captain can pick the campaign again.
    advancePlaylist(this.db, id, at >= 0 ? at : b.playlist_pos, new Date(this.now()));
    // A campaign load empties the box for a moment: the everyone-left count starts again.
    this.emptyWatches.delete(id);
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
            ...bookingLines(this.db, after), ...gameLines(this.db, after, server, this.deps.logPublicAddress), ...this.startLinesFor(after, campaign),
          ], 'the campaign start lines');
        }
      }
    }
    // An end that came in while this ran is ours to finish (settle skipped it).
    const end = getBooking(this.db, id);
    if (end && end.ending_at !== null && end.ended_at === null) await this.windDown(id, true);
  }

  /** Said at the start of every campaign: the captains' commands. There is
   *  no hint to extend any more: the slot's end never cuts a live game
   *  (bookings by campaign, Ruling 4). */
  private campaignStartLines(campaign: string): string[] {
    const name = consoleText(campaignRegistry(this.db).get(campaign)?.name ?? campaign, 60);
    return [`say [Booking] ${name}: !nextmap, !stay, !end and !addcampaign are yours, captains.`];
  }

  /** T3b final review: the pending burst goes again only to a box whose
   *  pug-match does not hold that game (sm_pug_status). A game the box holds
   *  (pending, live or ended) is never reset by a re-push, which is what a
   *  lost MATCH_START datagram would otherwise cause; another match live on
   *  it is left alone too. No answer, or one that cannot be read: nothing is
   *  sent (the next minute asks again). */
  private async boxLacksGame(id: number, server: ServerRow, pending: string[]): Promise<boolean> {
    const matchId = Number(/^sm_pug_match (\d+) /.exec(pending.find((l) => l.startsWith('sm_pug_match ')) ?? '')?.[1] ?? NaN);
    if (!Number.isInteger(matchId)) return false;
    let body: string;
    try {
      [body = ''] = await this.deps.rcon(server, ['sm_pug_status']);
    } catch (err) {
      console.warn(`[booking] ${id}: sm_pug_status on ${server.name} failed; the pending game burst waits:`, err instanceof Error ? err.message : err);
      return false;
    }
    return boxNeedsGame(body, matchId);
  }

  /** The series engine's burst for the game due on a tournament booking; nothing for a scrim. May throw (TournamentHooks). */
  private gameLinesFor(b: BookingRow, campaign: string): string[] {
    if (b.purpose !== 'tournament' || !this.deps.tournament) return [];
    return this.deps.tournament.gameLines(b.id, campaign);
  }

  /** A guarded hook call: the engine's failure is logged and never stops the runner. */
  /** Plan T3c final review: the site still has the match frozen but the
   *  restarted box forgot it, so the resumed game is frozen again (the
   *  plugin's sm_pug_adminpause, Cmd_AdminPause). Staff are told when the box
   *  does not take it. */
  private async refreeze(id: number, server: ServerRow, s: RestoreSnapshot): Promise<void> {
    let frozen = false;
    this.hook(id, 'frozen', () => { frozen = this.deps.tournament?.frozen?.(id) ?? false; });
    if (!frozen) return;
    let reply = '';
    try {
      [reply = ''] = await this.deps.rcon(server, [`sm_pug_adminpause ${s.token} on "Staff"`]);
    } catch (err) {
      console.warn(`[booking] ${id}: the staff freeze on ${server.name} failed:`, err instanceof Error ? err.message : err);
    }
    if (/PUGOK adminpause=on frozen=1/.test(reply)) return;
    publishAdminEvent({
      kind: 'problem', matchId: s.matchId,
      text: `Booking ${id}: game #${s.matchId} was restored on ${server.name} but the staff freeze could not be put back. Freeze it again from the Events desk.`,
    });
  }

  /** A tournament booking asks the series engine first (an extended connect grace). */
  private idleEndAllowed(b: BookingRow): boolean {
    if (b.purpose !== 'tournament') return true;
    let allowed = true;
    this.hook(b.id, 'idleEndAllowed', () => { allowed = this.deps.tournament?.idleEndAllowed?.(b.id) ?? true; });
    return allowed;
  }

  private hook(id: number, what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[booking] ${id}: tournament ${what} hook failed:`, err instanceof Error ? err.message : err);
    }
  }

  /** The chat lines said once a campaign is up: the captains' commands on a
   *  scrim; nothing on a tournament box, whose burst says its own. */
  private startLinesFor(b: BookingRow, campaign: string): string[] {
    return b.purpose === 'tournament' ? [] : this.campaignStartLines(campaign);
  }

  /** One best-effort line on a tournament box (the series engine's). */
  announce(bookingId: number, text: string): void {
    this.say(bookingId, `say [Match] ${consoleText(text, 200)}`, 'the series line');
  }

  /** One burst from the series engine or the desk to a running tournament
   *  box, with the replies (plan T3c: the freeze, a sub, a chat line). Null
   *  when the booking has no running box or the burst failed; the failure is
   *  logged with the secrets redacted, never thrown. */
  async send(bookingId: number, lines: string[], what: string): Promise<string[] | null> {
    const b = this.running(bookingId);
    const server = b ? getServer(this.db, b.server_id!) : undefined;
    if (!b || !server) return null;
    try {
      return await this.deps.rcon(server, lines);
    } catch (err) {
      const secrets = [server.log_secret, b.password, b.tv_password];
      console.warn(`[booking] ${bookingId}: ${what} on ${server.name} failed:`, hideAllowIds(redactSecrets(err instanceof Error ? err.message : String(err), secrets)));
      return null;
    }
  }

  /** The allow list to a running box now, not at the next minute re-push
   *  (drafts plan D2c: a player staff took off a draft team leaves the
   *  booking, and must not stay on the box until then). */
  async pushAllowList(bookingId: number): Promise<void> {
    const b = this.running(bookingId);
    const server = b ? getServer(this.db, b.server_id!) : undefined;
    if (!b || !server) return;
    await this.push(b.id, server, () => allowLines(this.db, b), 'the allowlist after a staff replace');
  }

  /** Staff replay a chapter of a live tournament game (plan T3c Ruling 12),
   *  on the same box, through the plugin's restore: the match is dropped and
   *  rebuilt from the snapshot, then the chapter loads from its start. The
   *  site's rows for the dropped chapters go only once the plugin took the
   *  resume. A resume the box answered and refused aborts the game as
   *  server_lost (the engine holds the match through gameLost), as a failed
   *  recovery does, and the dropped chapters' rows stay. 'error' is a box
   *  that did not answer the abort (or the replay threw): the box still runs
   *  the game. 'dropped' is a resume burst that failed in rcon after the
   *  abort was answered: the box has dropped its match (and any freeze with
   *  it). Either way nothing is aborted or dropped on the site and the game
   *  stays live, for staff to try again (once a drop is restored) or move the match (plan T3c Task 4
   *  ruling, split in Task 8). A drop is tried again REPLAY_TRIES - 1 more
   *  times inside the same work (each try re-sends the abort, then the
   *  resume); still dropped, the booking goes to crash recovery as a restarted
   *  box does, which restores the game at its current chapter (plan T3c Task 8
   *  ruling), so a drop never decays into an aborted game through the orphan
   *  reaper. 'busy' touches nothing: the booking is busy, not running, or not
   *  running this game. */
  async replayGame(bookingId: number, gameMatchId: number, snap: RestoreSnapshot): Promise<ReplayResult> {
    const live = liveBookingGame(this.db, bookingId);
    if (this.busy.has(bookingId) || !this.running(bookingId) || !live || live.id !== gameMatchId || live.token !== snap.token) return 'busy';
    let result: ReplayResult = 'error';
    this.track(bookingId, async () => {
      for (let attempt = 1; attempt <= REPLAY_TRIES; attempt++) {
        const retry = attempt > 1;
        if (retry) await this.sleep(MAP_SETTLE_MS);
        let r: ReplayResult;
        try {
          r = await this.replayOnce(bookingId, gameMatchId, snap, retry);
        } catch (err) {
          console.error(`[booking] ${bookingId}: the replay of game #${gameMatchId} failed:`, redactSecrets(err instanceof Error ? err.message : String(err), [snap.token]));
          r = 'error';
        }
        // After a drop the box has already let go of its match: a retry whose
        // abort got no answer is still a dropped game, not a running one.
        result = retry && r === 'error' ? 'dropped' : r;
        if (result !== 'dropped') break;
      }
    });
    await this.busy.get(bookingId);
    // Set inside the tracked work, which TS's narrowing cannot see.
    const final = result as ReplayResult;
    if (final === 'dropped') {
      const b = this.running(bookingId);
      const server = b ? getServer(this.db, b.server_id!) : undefined;
      const now = new Date(this.now());
      publishAdminEvent({ kind: 'problem', matchId: gameMatchId, text: `Booking ${bookingId}: ${server?.name ?? 'its server'} dropped game #${gameMatchId} while replaying (the resume got no answer after the abort, ${REPLAY_TRIES} tries). ${EVENT_ERRORS.replay_dropped.text}` });
      if (b && beginRecovery(this.db, bookingId, 'restart', now)) this.track(bookingId, () => this.recover(bookingId));
    }
    return final;
  }

  /** 'ok' once the plugin took the resume (the replay is on its way);
   *  'refused' when it answered and refused, in which case the game has been
   *  aborted; 'error' when the box did not answer the abort, 'dropped' when
   *  it answered the abort but not the resume. */
  private async replayOnce(id: number, gameMatchId: number, snap: RestoreSnapshot, retry = false): Promise<ReplayResult> {
    const b = this.running(id);
    const server = b ? getServer(this.db, b.server_id!) : undefined;
    if (!b || !server) return 'busy';
    const live = liveBookingGame(this.db, id);
    if (!live || live.id !== gameMatchId || live.token !== snap.token) return 'busy';
    const resume = resumeLines(snap);
    let replies: string[];
    let step = 'abort';
    try {
      await this.deps.rcon(server, [`sm_pug_abort ${snap.token}`]);
      step = 'resume';
      replies = await this.deps.rcon(server, resume);
      warnCarryRefused(server, resume, replies);
    } catch (err) {
      const why = redactSecrets(err instanceof Error ? err.message : String(err), [server.log_secret, snap.token]);
      console.warn(`[booking] ${id}: the replay's ${step} on ${server.name} failed:`, why);
      if (step === 'abort') {
        // A retry's abort follows a drop: replayGame reports that, not this.
        if (!retry) publishAdminEvent({ kind: 'problem', matchId: live.id, text: `Booking ${id}: ${server.name} did not answer the abort of a chapter replay of game #${live.id}. Nothing was aborted on the site; replay again or move the match.` });
        return 'error';
      }
      // replayGame tries again, then reports a drop that stuck.
      return 'dropped';
    }
    if (!(replies[resume.length - 1] ?? '').trim().startsWith('PUGOK resumed')) {
      const token = abortBookingGame(this.db, live.id, new Date(this.now()), 'server_lost');
      if (token) this.forgetToken(id, token);
      if (token && b.purpose === 'tournament') this.hook(id, 'gameLost', () => this.deps.tournament?.gameLost?.(id, live.id));
      publishAdminEvent({ kind: 'problem', matchId: live.id, text: `Booking ${id}: game #${live.id} could not be rebuilt on ${server.name} for a chapter replay (pug-match did not take sm_pug_resume). It is aborted.` });
      return 'refused';
    }
    prepareRestore(this.db, snap);
    try {
      await this.deps.rcon(server, [`changelevel ${snap.map}`]);
    } catch {
      // A changelevel can drop the connection it came in on; the map check decides.
    }
    await this.sleep(MAP_SETTLE_MS);
    let onMap: string | null = null;
    try {
      const [st] = await this.deps.rcon(server, ['status']);
      onMap = parseStatusMap(st);
    } catch {
      // No answer: reported below; the next minute watch re-pushes the lines.
    }
    if (onMap !== snap.map) {
      publishAdminEvent({ kind: 'problem', matchId: live.id, text: `Booking ${id}: ${server.name} was sent ${snap.map} for a chapter replay but is on ${onMap ?? 'no map'}. The game is rebuilt on the box; load the map by hand or replay again.` });
      return 'ok';
    }
    const fresh = this.running(id);
    if (fresh) {
      const name = campaignRegistry(this.db).get(snap.campaign)?.name ?? snap.campaign;
      await this.push(id, server, () => [
        ...bookingLines(this.db, fresh), ...gameLines(this.db, fresh, server, this.deps.logPublicAddress),
        `say [Match] ${consoleText(`Staff replayed chapter ${snap.maps.length + 1} of ${name} from its start. Ready up when everyone is back.`, 200)}`,
      ], 'the replay lines');
    }
    console.log(`[booking] ${id}: game #${live.id} replays ${snap.map} on ${server.name}`);
    return 'ok';
  }

  /** Staff move a running booking to another box (plan T3c Ruling 13): the
   *  booking lets go of its box, the box goes back through the releaser's
   *  forced restart (not awaited: the move must not wait on it), and the
   *  relocate pass takes the first idle box, after which recover() restarts
   *  it, replays setup and restores the live game. The old box, or null when
   *  the booking is not running, is busy, or is already recovering.
   *
   *  Deliberately no await anywhere in here. A booked box is idle in
   *  servers.status and held only through the bookings view, so the moment
   *  beginMove clears server_id the old box is a free idle box. The
   *  releaser's release() (src/serverRelease.ts, called inside the deps
   *  wrapper's Promise executor) marks it offline synchronously before its
   *  first await, so it is out of the pool in this same tick: no pickBox,
   *  practice lease, side game or PUG claimIdle can take it in between, and
   *  the relocate below cannot hand the booking back the box it is leaving.
   *  It comes back idle only once its restart answers. */
  async moveBooking(bookingId: number): Promise<number | null> {
    if (!this.running(bookingId) || this.busy.has(bookingId)) return null;
    const old = beginMove(this.db, bookingId, new Date(this.now()));
    if (old === null) return null;
    this.deps.release(old).catch((err) => {
      console.error(`[booking] ${bookingId}: giving back server ${old} after a move failed:`, err);
    });
    console.log(`[booking] ${bookingId}: staff moved it off ${getServer(this.db, old)?.name ?? old}`);
    this.relocate();
    return old;
  }

  /** A best-effort burst. A failure is logged with the log secret and the
   *  booking passwords redacted (an rcon error names the command it was on,
   *  and the minute re-push carries sv_password and tv_password) and never thrown. */
  private async push(id: number, server: ServerRow, lines: () => string[], what: string): Promise<void> {
    try {
      const cmds = lines();
      warnCarryRefused(server, cmds, await this.deps.rcon(server, cmds));
    } catch (err) {
      const b = getBooking(this.db, id);
      const secrets = [server.log_secret, b?.password ?? null, b?.tv_password ?? null];
      console.warn(`[booking] ${id}: ${what} on ${server.name} failed:`, hideAllowIds(redactSecrets(err instanceof Error ? err.message : String(err), secrets)));
    }
  }

  /** A booking game finished (finishMatch has marked it completed, keeps the
   *  box with the booking and calls this). Bookings by campaign: the finished
   *  games are counted (gamesPlayed: an aborted game does not count, a replay
   *  or an off-playlist campaign does). Below games_allowed, the next
   *  campaign is announced and loaded on the first minute watch at least 60 s
   *  later (so 60 to 120 s: "in about a minute"). At the count, the booking
   *  closes in 5 minutes unless a campaign is added (Ruling 3). A game that
   *  finished past the slot's end announces nothing: the next watch ends the
   *  booking on time (Ruling 4). A booking already ending is left alone, so
   *  a game finishing after the close cannot reopen anything. */
  onGameEnded(matchId: number): void {
    const m = this.db.prepare('SELECT booking_id FROM matches WHERE id = ?').get(matchId) as { booking_id: number | null } | undefined;
    if (!m || m.booking_id === null) return;
    const b = this.running(m.booking_id);
    if (!b) return;
    if (b.purpose === 'tournament') {
      // The series engine records the game and schedules what follows (T3b).
      this.hook(b.id, 'gameEnded', () => this.deps.tournament?.gameEnded(b.id, matchId));
      return;
    }
    const played = gamesPlayed(this.db, b.id);
    const nowMs = this.now();
    let line: string;
    if (played >= b.games_allowed) {
      // Nothing loads during the grace: a campaign added in it is announced by onExtended.
      if (b.next_campaign !== null) setNext(this.db, b.id, null, null, new Date(nowMs));
      const graceMin = bookingLimits(this.db).closeGraceMinutes;
      if (!setCloseAt(this.db, b.id, played, new Date(nowMs + graceMin * 60_000).toISOString(), new Date(nowMs))) return;
      const closes = `or the server closes in ${graceMin} minute${graceMin === 1 ? '' : 's'}.`;
      // A game started inside an earlier grace can take played past the count.
      line = played > b.games_allowed
        ? `say [Booking] That was past the last booked campaign. Type !addcampaign to play one more, ${closes}`
        : `say [Booking] That was campaign ${b.games_allowed} of ${b.games_allowed}. Type !addcampaign to play one more, ${closes}`;
    } else if (nowMs >= Date.parse(b.ends_at)) {
      return;
    } else {
      line = this.scheduleNext(b, played, nowMs);
    }
    this.say(b.id, line, 'next campaign line');
  }

  /** The next campaign by the count (playlist[played], or the last one again
   *  once the playlist is shorter than the count), due in about a minute.
   *  Returns the line that says so. */
  private scheduleNext(b: BookingRow, played: number, nowMs: number): string {
    const playlist = JSON.parse(b.playlist_json) as string[];
    const next = playlist[played] ?? playlist[playlist.length - 1];
    setNext(this.db, b.id, next, new Date(nowMs + NEXT_DELAY_MS).toISOString(), new Date(nowMs));
    const name = consoleText(campaignRegistry(this.db).get(next)?.name ?? next, 60);
    return `say [Booking] Next: ${name} in about a minute. !nextmap to pick another, !stay to replay this one, !end to finish.`;
  }

  /** One best-effort line on the booking's box, not awaited. */
  private say(id: number, line: string, what: string): void {
    const b = getBooking(this.db, id);
    const server = b && b.server_id !== null ? getServer(this.db, b.server_id) : undefined;
    if (!server) return;
    this.deps.rcon(server, [line]).catch((err) => {
      console.warn(`[booking] ${id}: ${what} on ${server.name} failed:`, err instanceof Error ? err.message : err);
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
    // Bookings by campaign: every played game uses one of the N, so once all
    // are played only +1 campaign opens another.
    if (gamesPlayed(this.db, id) >= b.games_allowed) return { ok: false, error: allPlayedText(b.games_allowed) };
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

  /** `!end` (ruling 3): the booking ends and winds down; the wind-down
   *  aborts a live game (booking_ended) and tells the plugin to drop it, as
   *  it does for every end. A refused end aborts nothing. */
  endFromGame(id: number, by: string, staff = false): { ok: true } | { ok: false; error: string } {
    const r = endBooking(this.db, { bookingId: id, by, staff, now: new Date(this.now()) });
    if (!r.ok) return { ok: false, error: BOOKING_ERRORS[r.error].text };
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
   *  calls (the campaign-start lines, the goodbye, the +1 campaign notice, or
   *  allowFromGame's who-is-in line). */
  onCommand(serverId: number, steamid: string, cmd: BookingCmd, arg: string): void {
    // An allow line is about who may be on the box: its log lines carry no steamid.
    const who = cmd === 'allow' ? 'the sender' : steamid;
    const b = bookingOnServer(this.db, serverId);
    if (!b) {
      console.log(`[booking] onCommand: no open booking on server ${serverId} (${cmd === 'allow' ? 'no steamid logged' : `steamid ${steamid}`}, cmd ${cmd})`);
      // A booking winding down still holds the box and its plugin still
      // enforces: what that plugin let in on its own is taken back.
      const hold = holdFor(this.db, serverId);
      if (cmd === 'allow' && hold?.kind === 'booking') this.refuseAllow(hold.rowId, serverId, arg, BOOKING_ERRORS.wrong_state.text);
      return;
    }
    if (actingSides(this.db, b.id, steamid).length === 0) {
      console.log(`[booking] ${b.id}: onCommand: ${who} does not manage a confirmed side (server ${serverId}, cmd ${cmd})`);
      if (cmd === 'allow') this.refuseAllow(b.id, serverId, arg, BOOKING_ERRORS.not_manager.text);
      return;
    }
    if (b.purpose === 'tournament' && cmd !== 'allow') {
      // T3b Ruling 10: the series engine picks the campaigns and closes the box.
      this.say(b.id, 'say [Match] The site runs this tournament match: it picks the campaigns and closes the server.', 'the tournament refusal');
      return;
    }
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
      case 'extend':
      case 'addcampaign': {
        error = this.addCampaignFromGame(b, steamid, cmd === 'addcampaign' ? arg : '');
        break;
      }
      case 'allow': {
        error = this.allowFromGame(b.id, serverId, steamid, arg);
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

  /** `!addcampaign [campaign]` and its older alias `!extend` (no campaign):
   *  +1 campaign (bookings by campaign, Ruling 5). A name is matched as
   *  `!nextmap` matches one, and must load on this box. The refusal text, or
   *  null when onExtended has said the new count. */
  private addCampaignFromGame(b: BookingRow, by: string, arg: string): string | null {
    let campaign: string | null = null;
    if (arg.trim() !== '') {
      const r = this.resolveCampaign(arg);
      if (!r.ok) return r.error;
      const entry = campaignRegistry(this.db).get(r.campaign);
      const server = getServer(this.db, b.server_id!);
      if (!server || !loadsOn(this.db, entry, server)) return `This server cannot load ${entry?.name ?? r.campaign}.`;
      campaign = r.campaign;
    }
    const r = addCampaign(this.db, { bookingId: b.id, by, campaign, now: new Date(this.now()) });
    if (!r.ok) return BOOKING_ERRORS[r.error].text;
    this.onExtended(b.id);
    return null;
  }

  /** `!allow` (plan 4b2): `arg` is `<steamid64> <name...>` from the plugin,
   *  the name as the game shows it (untrusted). On success the whole list goes
   *  to the box at once, with the line saying who is in; a refusal is said
   *  and taken back on the box (refuseAllow). Always null: it says its own. */
  private allowFromGame(id: number, serverId: number, by: string, arg: string): string | null {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(arg.trim());
    const steamid = m?.[1] ?? '';
    const r = allowInGame(this.db, { bookingId: id, by, steamid, name: m?.[2] ?? '', now: new Date(this.now()) });
    if (!r.ok) {
      console.log(`[booking] ${id}: !allow refused (${r.error})`);
      this.refuseAllow(id, serverId, arg, BOOKING_ERRORS[r.error].text);
      return null;
    }
    const b = getBooking(this.db, id);
    const server = getServer(this.db, serverId);
    const side = sidesOf(this.db, id).find((s) => s.side === r.value.side);
    if (!b || !server || !side) return null;
    const who = consoleText(gameName(steamid, m?.[2]), 40);
    const role = (this.db.prepare('SELECT role FROM booking_people WHERE booking_id = ? AND steamid = ?').get(id, steamid) as { role: string } | undefined)?.role ?? 'ringer';
    const said = r.value.added
      ? `say [Booking] ${who} is in, as a ${role} for ${consoleText(sideName(this.db, side), 60)}.`
      : `say [Booking] ${who} is already in this booking.`;
    console.log(`[booking] ${id}: !allow ${r.value.added ? 'added' : 'already in'}; the list has ${allowList(this.db, id).length} ids`);
    void this.push(id, server, () => [...allowLines(this.db, b), said], 'the allowlist');
    return null;
  }

  /** A refused `!allow`. The plugin put the player on its active list the
   *  moment the captain typed it (l4d_booking 1.2.0), so beside the reason
   *  the box is told `sm_booking_allow_refuse <id>` (1.2.1): it takes them
   *  back off and restarts their grace. Through push, so a failure logs the
   *  line as a count (hideAllowIds), never the id. A malformed target gets
   *  the reason alone. */
  private refuseAllow(id: number, serverId: number, arg: string, reason: string): void {
    const server = getServer(this.db, serverId);
    if (!server) return;
    const target = allowTarget(arg);
    const lines = [`say [Booking] ${consoleText(reason, 150)}`];
    if (target) lines.push(`sm_booking_allow_refuse ${target}`);
    void this.push(id, server, () => lines, 'the !allow refusal');
  }

  // ---------- notices ----------

  /** Never throws: a notice runs after a committed state change, and a
   *  failure to word or send it must not undo the caller's work (a route's
   *  answer, a release). */
  private tell(id: number, steamids: Iterable<string>, type: BookingNotifyType, extra: { minutes?: number; reason?: string | null; addedBy?: string; lateCancel?: boolean; moved?: boolean; restored?: string | null; slot?: string | null } = {}): void {
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

  /** A late cancel (plan 2) asks the other side's managers, and only them,
   *  to excuse it, since only they have the button; everyone else, the other
   *  side's plain players too, gets the plain notice. */
  onCancelled(id: number, by: string | null, reason: string | null): void {
    const to = this.everyone(id).filter((s) => s !== by);
    const b = getBooking(this.db, id);
    const other = b && isLateCancel(this.db, b) ? sidesOf(this.db, id).find((s) => s.side !== b.cancel_side) : undefined;
    if (other) {
      const theirs = new Set(sideManagers(this.db, other));
      this.tell(id, to.filter((s) => theirs.has(s)), 'booking_cancelled', { reason, lateCancel: true });
      const rest = to.filter((s) => !theirs.has(s));
      if (rest.length > 0) this.tell(id, rest, 'booking_cancelled', { reason });
    } else {
      this.tell(id, to, 'booking_cancelled', { reason });
    }
    this.settle(id);
  }

  /** After +1 campaign (the site, staff, or in game): a running box shows the
   *  new end in its notice and says the new count in chat. Best effort; the
   *  minute watch already uses the new end. When the box sits on a finished
   *  campaign with nothing due (a campaign added in the closing grace, or
   *  after a game that ran past the slot), the next one is scheduled as after
   *  a game: by the count, so a named campaign is the one played. */
  onExtended(id: number): void {
    const b = getBooking(this.db, id);
    if (!b || b.server_id === null || b.ending_at !== null || (b.state !== 'ready' && b.state !== 'active')) return;
    const server = getServer(this.db, b.server_id);
    if (!server) return;
    let lines: string[];
    try {
      lines = bookingLines(this.db, b);
    } catch (err) {
      console.warn(`[booking] ${id}: +1 campaign notice not sent:`, err instanceof Error ? err.message : err);
      return;
    }
    const played = gamesPlayed(this.db, id);
    const left = b.games_allowed - played;
    lines.push(`say [Booking] +1 campaign: ${left} left to play, ${b.games_allowed} booked in all (until about ${b.ends_at.slice(11, 16)} UTC).`);
    if (played < b.games_allowed && b.next_campaign === null && !liveBookingGame(this.db, id) && this.sittingOnFinished(id)) {
      lines.push(this.scheduleNext(b, played, this.now()));
    }
    this.deps.rcon(server, lines).catch((err) => {
      console.warn(`[booking] ${id}: +1 campaign notice on ${server.name} failed:`, err instanceof Error ? err.message : err);
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
