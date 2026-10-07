import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { campaignDisplayName, campaignRegistry } from '../campaignRegistry.js';
import type { Notifier } from '../notify/notify.js';
import { parseRules, rulesForKind, type MatchRules } from '../rulesets.js';
import { stopAfterMap } from '../stopPoint.js';
import { getTeam } from '../teams/teams.js';
import { getPlayer } from '../players.js';
import * as B from '../bookings/bookings.js';
import { gamesPlayed } from '../bookings/games.js';
import { DEFAULT_GRACE_MINUTES, SHOWN_MIN, bookingLimits } from '../bookings/rules.js';
import type { TournamentHooks } from '../bookings/runner.js';
import { settingNumber } from '../settings.js';
import { addTournamentSub, createTournamentGame, gameLinesOf, isPendingGame, isUnstartedGame } from '../bookings/tournamentGames.js';
import { replayableChapters, restoreSnapshot, type RestoreSnapshot } from '../bookings/restore.js';
import type { AdminPauseCause, LogEvent } from '../logParse.js';
import type { ForfeitWhy } from '../dumpParse.js';
import { getServer } from '../serverPool.js';
import { consoleText, quoted } from '../serverSetup.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import * as V from './validate.js';
import { carryEntries } from './carry.js';
import { autoResultFlow, forfeitMatch } from './flow.js';
import { tellConnect, tellReadyForfeit, tellSeriesResult, tellStaffAction } from './notices.js';
import { gameNumberOf, playOrder, seriesResult, seriesVerdict, tiebreakFirstSurvivors, winsLine } from './seriesRules.js';
import { isHumanStep, other, type Side } from './veto.js';

/**
 * The series engine (tournaments plan T3b): everything between "both
 * lineups are locked" and "the result is recorded". It books the server
 * (Ruling 2), gives the booking runner the burst that starts each game
 * (Ruling 3), opens the connect phase and decides the no-show (Ruling 7),
 * records each game from our capture, adds tiebreaks, opens the loser's
 * pick, runs the confirm window and files disputes (Rulings 5, 9). It never
 * writes an event table itself (room.ts does, one event_log row each) and
 * never touches rcon (the runner does). Every entry point is safe to call
 * twice: the state in the database decides what is left to do.
 */

/** The seeded default of event_server_alert_minutes (plan T5 Ruling 2). */
export const SERVER_ALERT_MS = 10 * 60_000;
/** The seeded default of event_presence_fallback_minutes (plan T5 Ruling 2). */
export const PRESENCE_FALLBACK_MS = 3 * 60_000;

/** The engine's operational waits, from the Competitive settings (plan T5 Ruling 2). */
export function seriesTimings(db: DB): { serverAlertMs: number; presenceFallbackMs: number; closeGraceMs: number } {
  return {
    serverAlertMs: settingNumber(db, 'event_server_alert_minutes', SERVER_ALERT_MS / 60_000, { integer: true, min: 2, max: 60 }) * 60_000,
    presenceFallbackMs: settingNumber(db, 'event_presence_fallback_minutes', PRESENCE_FALLBACK_MS / 60_000, { integer: true, min: 1, max: 15 }) * 60_000,
    closeGraceMs: bookingLimits(db).closeGraceMinutes * 60_000,
  };
}

/** "about a minute" or "about N minutes" (plan T5 Ruling 16): the runner
 *  loads a scheduled game on its minute pass, so a wait up to a minute reads
 *  as a minute. */
export function soonText(seconds: number): string {
  return seconds <= 60 ? 'about a minute' : `about ${Math.ceil(seconds / 60)} minutes`;
}

export interface SeriesRunner {
  announce(bookingId: number, text: string): void;
  settle(bookingId: number): void;
  onCancelled(bookingId: number, by: string | null, reason: string | null): void;
  /** Plan T3c: one burst with the replies, a chapter replay, a move. */
  send(bookingId: number, lines: string[], what: string): Promise<string[] | null>;
  /** Drafts plan D2c: the allow list to a running box at once. */
  pushAllowList(bookingId: number): Promise<void>;
  replayGame(bookingId: number, gameMatchId: number, snap: RestoreSnapshot): Promise<'ok' | 'refused' | 'busy' | 'error' | 'dropped'>;
  moveBooking(bookingId: number): Promise<number | null>;
}
export interface SeriesDeps {
  db: DB; runner: SeriesRunner; notifier?: Notifier; publicUrl?: string;
  push?: (matchId: number) => void; registerToken?: (token: string) => void; now?: () => number;
}

/** The runner is built before the engine (server.ts): each hook finds it when called. */
export function lateHooks(get: () => SeriesEngine | null): TournamentHooks {
  return {
    gameLines: (id, campaign) => get()?.gameLines(id, campaign) ?? [],
    pendingLines: (id) => get()?.pendingLines(id) ?? [],
    ready: (id) => get()?.ready(id),
    presence: (id, on, now) => get()?.presence(id, on, now),
    gameEnded: (id, matchId) => get()?.gameEnded(id, matchId),
    ended: (id, reason) => get()?.ended(id, reason),
    gameLost: (id, matchId) => get()?.gameLost(id, matchId),
    idleEndAllowed: (id) => get()?.idleEndAllowed(id) ?? true,
    frozen: (id) => get()?.frozen(id) ?? false,
  };
}

/** The rules a stage plays by: its snapshot, else its ruleset's tournament reading. */
function stageRules(db: DB, stage: E.StageRow): MatchRules {
  if (stage.rules_json) return parseRules(stage.rules_json);
  const row = db.prepare('SELECT rules_json FROM rulesets WHERE id = ?').get(stage.ruleset_id) as { rules_json: string } | undefined;
  if (!row) throw new Error(`stage ${stage.id}: ruleset ${stage.ruleset_id} is gone`);
  return rulesForKind('tournament', parseRules(row.rules_json));
}

/** pug-match's answer to `sm_pug_sub <token> <out> <in>` (plugin/pug-tourney.inc
 *  Cmd_PugSub, 0.3.25): `PUGOK sub out=<out> in=<in> slot=<n>`, `PUGOK sub
 *  already` for a sub that already stands, or `PUGERR <why>` (among them
 *  `not between chapters`). Null when the reply says none of these (no
 *  answer, or a box without the command). Read line by line, so console
 *  noise around the answer does not hide it. */
export type SubReply = { ok: true; already: boolean } | { ok: false; error: string };
export function parseSubReply(reply: string | null | undefined, outId: string, inId: string): SubReply | null {
  for (const raw of (reply ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'PUGOK sub already') return { ok: true, already: true };
    const m = /^PUGOK sub out=(\d+) in=(\d+) slot=\d+$/.exec(line);
    if (m) return m[1] === outId && m[2] === inId ? { ok: true, already: false } : { ok: false, error: 'other players' };
    const e = /^PUGERR (.+)$/.exec(line);
    if (e) return { ok: false, error: e[1]! };
  }
  return null;
}
/** True when pug-match answered `sm_pug_adminpause <token> on|off` with
 *  `PUGOK adminpause=<state> frozen=<1|0>` (Cmd_AdminPause, 0.3.25) and the
 *  freeze stands as asked. */
export function adminPauseTook(reply: string | null | undefined, on: boolean): boolean {
  for (const raw of (reply ?? '').split(/\r?\n/)) {
    const m = /^PUGOK adminpause=(on|off) frozen=([01])$/.exec(raw.trim());
    if (m) return m[1] === (on ? 'on' : 'off') && m[2] === (on ? '1' : '0');
  }
  return false;
}
/** A TECH line from a tournament box (pug-match 0.3.26, plan T5). */
export type TechLine = Extract<LogEvent, { kind: 'tech' }>;

/** True when pug-match answered `sm_pug_forfeit <token> <team>` with `PUGOK
 *  forfeit team=<team>` (or `... already`, a re-send): Cmd_PugForfeit, 0.3.26. */
export function forfeitTook(reply: string | null | undefined, team: 'a' | 'b'): boolean {
  for (const raw of (reply ?? '').split(/\r?\n/)) {
    const m = /^PUGOK forfeit team=(a|b)( already)?$/.exec(raw.trim());
    if (m) return m[1] === team;
  }
  return false;
}
/** Why a game was forfeited, as the series line says it (plan T5 Ruling 9). */
export function forfeitHow(why: ForfeitWhy): string {
  return why === 'disconnect' ? 'ran out of reconnect time' : why === 'staff' ? 'forfeited by staff ruling' : 'typed !gg';
}
const clock = (s: number): string => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
/** The sm_pug_sub refusal that means "not now": a chapter is being played. */
export const SUB_NOT_BETWEEN = 'not between chapters';
/** How long after a replay or a move the box's reset line for it is still
 *  expected (UDP log lines arrive within moments or never). */
export const RESET_EXPECT_MS = 2 * 60_000;
/** The grace to connect when a booking's rules carry none (Ruling 7); the runner's fallback too. */
export { DEFAULT_GRACE_MINUTES };

interface ExpectedReset { gameMatchId: number; frozenId: number; until: number | null }

const LIVE_OR_BEFORE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['booking', 'connect', 'live']);

export class SeriesEngine {
  private readonly db: DB;
  private readonly now: () => number;
  /** When each tournament booking's box was last watched (the presence hook), for the fallback. */
  private readonly watched = new Map<number, number>();
  private readonly bootMs: number;
  /** Matches whose booking was refused, told to staff once per process (the tick retries every 5 seconds). */
  private readonly bookAlerted = new Set<number>();
  /** Matches that could not be booked for want of teams or lineups, logged once per process (same retry). */
  private readonly bookLogged = new Set<number>();
  /** Desk freezes and unfreezes in flight, by match: the box's own `by=site
   *  cause=staff` line for one can land before the rcon reply, and is then
   *  recorded under the staff member who asked (Task 6 ledger). */
  private readonly deskFreezes = new Map<number, { on: boolean; by: string }>();
  /** A replay or a move of a frozen game (Task 7 ledger): the box lifts the
   *  freeze as it drops its match (sm_pug_abort) and says so with a reset
   *  line under the game's own token, which staleReset cannot tell from a
   *  later reset of the same game. The first such line is this one: it lifts
   *  the freeze only while the freeze it was sent for still stands (the same
   *  match_frozen row, `frozenId`), never one set after. Until `until`; null
   *  while the work runs. */
  private readonly expectedResets = new Map<number, ExpectedReset>();

  constructor(private readonly deps: SeriesDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.bootMs = this.now();
  }

  hooks(): TournamentHooks {
    return lateHooks(() => this);
  }

  private push(matchId: number): void {
    try { this.deps.push?.(matchId); } catch (err) { console.warn('[series] push failed:', err instanceof Error ? err.message : err); }
  }
  private name(m: P.MatchRow, side: Side): string {
    return N.getEntry(this.db, R.entryOn(m, side))?.name ?? (side === 'a' ? 'Team A' : 'Team B');
  }
  private sideOfEntry(m: P.MatchRow, entryId: number | null): Side | null {
    return entryId === null ? null : entryId === m.entry_a ? 'a' : entryId === m.entry_b ? 'b' : null;
  }
  private title(m: P.MatchRow): string {
    const ev = E.getEvent(this.db, m.event_id);
    return `${this.name(m, 'a')} vs ${this.name(m, 'b')} (${ev?.name ?? 'event'})`;
  }
  private roomLink(m: P.MatchRow): { label: string; path: string } {
    const ev = E.getEvent(this.db, m.event_id)!;
    return { label: 'Open the match room', path: `/event/${ev.slug}/match/${m.id}` };
  }
  private alert(m: P.MatchRow, text: string): void {
    publishAdminEvent({ kind: 'problem', text: `Tournament match ${this.title(m)}: ${text}`, link: this.roomLink(m) });
  }
  /** The match's booking while it runs on a box (not recovering, not ending), or null. */
  private runningBooking(m: P.MatchRow): B.BookingRow | null {
    if (m.booking_id === null) return null;
    const b = B.getBooking(this.db, m.booking_id);
    return b && b.ending_at === null && b.server_id !== null && b.recovering_at === null && (b.state === 'ready' || b.state === 'active') ? b : null;
  }

  // ---------- the clock's duties ----------

  /** Every 5 seconds from the room clock: book, alert on a long wait, hold a connect deadline nobody could watch. */
  tick(now: Date): void {
    const timing = seriesTimings(this.db);
    const unbooked = this.db.prepare(`SELECT m.* FROM event_matches m WHERE ${R.ROOM_LIVE_SQL} AND m.status = 'booking' AND m.booking_id IS NULL ORDER BY m.id`)
      .all() as P.MatchRow[];
    for (const m of unbooked) {
      try { this.book(m, now); } catch (err) { console.error(`[series] booking match ${m.id} failed:`, err instanceof Error ? err.message : err); }
    }
    const waiting = this.db.prepare(
      `SELECT m.* FROM event_matches m JOIN bookings b ON b.id = m.booking_id
       WHERE m.status = 'booking' AND m.server_alerted_at IS NULL AND m.booked_at <= ?
         AND b.server_id IS NULL AND b.state = 'scheduled' AND b.ending_at IS NULL`,
    ).all(new Date(now.getTime() - timing.serverAlertMs).toISOString()) as P.MatchRow[];
    for (const m of waiting) {
      try {
        if (!R.noteServerAlert(this.db, { matchId: m.id, now }).ok) continue;
        this.alert(m, `has waited ${Math.round(timing.serverAlertMs / 60_000)} minutes for a server (no idle box in its region can take it). It keeps waiting; free a box, or reset the room or enter the result on the Events desk.`);
        this.push(m.id);
      } catch (err) {
        console.error(`[series] server alert for match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    this.sweepAborted(now);
    // Only rooms of a live event and stage, like every other clock query (a cancelled event's rooms never tick).
    const stale = this.db.prepare(`SELECT m.* FROM event_matches m WHERE ${R.ROOM_LIVE_SQL} AND m.status = 'connect' AND m.deadline IS NOT NULL AND m.deadline <= ?`)
      .all(new Date(now.getTime() - timing.presenceFallbackMs).toISOString()) as P.MatchRow[];
    for (const m of stale) {
      const last = m.booking_id !== null ? this.watched.get(m.booking_id) ?? this.bootMs : this.bootMs;
      if (now.getTime() - last < timing.presenceFallbackMs) continue;
      try {
        const r = R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'no_presence', now });
        if (!r.ok) continue;
        this.alert(m, 'the grace to connect ended but the server could not be watched (rcon not answering), so nobody was forfeited. It is on hold.');
        this.push(m.id);
      } catch (err) {
        console.error(`[series] presence fallback for match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** T3b final review: a game aborted by anything but crash recovery (the
   *  staff Abort on the match page, the orphan reaper, an abandon) never
   *  reaches the engine, so the series would wait on it for ever. A connect
   *  or live match whose running game's row is aborted is held for staff
   *  once, as gameLost does (a held match is not swept again). */
  private sweepAborted(now: Date): void {
    const rows = this.db.prepare(
      `SELECT m.id AS matchId, g.id AS gameId, g.match_id AS gameMatchId, x.abort_cause AS cause FROM event_matches m
       JOIN event_games g ON g.event_match_id = m.id AND g.match_id IS NOT NULL AND g.ended_at IS NULL
       JOIN matches x ON x.id = g.match_id AND x.state = 'aborted'
       WHERE ${R.ROOM_LIVE_SQL} AND m.status IN ('connect', 'live') ORDER BY m.id`,
    ).all() as { matchId: number; gameId: number; gameMatchId: number; cause: string | null }[];
    for (const r of rows) {
      try {
        const m = P.getMatch(this.db, r.matchId)!;
        const g = R.gamesOf(this.db, m.id).find((x) => x.id === r.gameId)!;
        if (!R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'game_aborted', now }).ok) continue;
        this.alert(m, `${this.gameLabel(m, g)} (match ${r.gameMatchId}) was aborted${r.cause ? ` (${r.cause})` : ''} before it finished. It is on hold; replay it or enter the result on the Events desk.`);
        this.push(m.id);
      } catch (err) {
        console.error(`[series] holding match ${r.matchId} after its game was aborted failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** Ruling 2. */
  private book(m: P.MatchRow, now: Date): void {
    const ev = E.getEvent(this.db, m.event_id)!;
    const stage = E.getStage(this.db, m.stage_id)!;
    const s = E.stageSettingsOf(stage);
    const game1 = R.gamesOf(this.db, m.id).find((g) => g.ordinal === 1);
    if (!game1) return;
    // attachBooking would refuse a team that is out (settle forfeits it): book nothing meanwhile.
    if (![m.entry_a, m.entry_b].every((id) => id !== null && N.isActive(N.getEntry(this.db, id)!))) return;
    const side = (k: Side): B.TournamentSide | null => {
      const entryId = R.entryOn(m, k);
      const entry = N.getEntry(this.db, entryId);
      const four = R.lineupFour(this.db, m.id, entryId);
      if (!entry || !four) return null;
      // A team entry books as its site team and that team's captain; a draft
      // entry (drafts plan D2a) has no site team and books as its captain.
      const team = entry.team_id !== null ? getTeam(this.db, entry.team_id) : undefined;
      const captain = entry.team_id !== null ? team?.captain_steamid : entry.captain_steamid;
      if (!captain) return null;
      const r = N.rosterOf(this.db, entryId);
      const rest = [...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])].filter((x) => !four.includes(x));
      return { teamId: team ? team.id : null, captain, players: four, spectators: rest, ...(team ? {} : { name: entry.name, tag: entry.tag, logoKey: entry.logo_key }) };
    };
    const a = side('a');
    const b = side('b');
    if (!a || !b) {
      if (!this.bookLogged.has(m.id)) {
        this.bookLogged.add(m.id);
        console.error(`[series] match ${m.id}: cannot book without both teams and their lineups`);
      }
      return;
    }
    const r = B.createTournamentBooking(this.db, {
      region: ev.region, campaign: game1.campaign, rulesJson: JSON.stringify(stageRules(this.db, stage)), rulesetId: stage.ruleset_id,
      gameConfig: s.gameConfig, createdBy: ev.organizer_steamid, sides: [a, b], now,
    });
    if (!r.ok) {
      if (!this.bookAlerted.has(m.id)) {
        this.bookAlerted.add(m.id);
        this.alert(m, `could not book a server (${r.error}). It keeps trying; fix the stage's game config or campaign, or reset the room on the Events desk.`);
      }
      return;
    }
    const attached = R.attachBooking(this.db, { matchId: m.id, bookingId: r.value.id, now });
    if (!attached.ok) {
      B.cancelBooking(this.db, { bookingId: r.value.id, by: ev.organizer_steamid, staff: true, reason: 'The match moved on', now });
      this.deps.runner.settle(r.value.id);
      return;
    }
    console.log(`[series] match ${m.id} booked server booking ${r.value.id}`);
    this.push(m.id);
  }

  // ---------- the runner's hooks ----------

  private stopMapFor(stage: E.StageRow, campaign: string): string | null {
    const s = E.stageSettingsOf(stage);
    if (s.chapters === null) return stopAfterMap(this.db, campaign);
    const maps = campaignRegistry(this.db).get(campaign)?.maps ?? [];
    return maps[Math.min(s.chapters, maps.length) - 1] ?? null;
  }
  private gameLabel(m: P.MatchRow, g: R.GameRow): string {
    const games = R.seriesGames(this.db, m);
    const n = gameNumberOf(games.find((x) => x.id === g.id)!, games);
    return g.tiebreak_of !== null ? `tiebreak of game ${n}` : `game ${n}`;
  }
  private linesFor(m: P.MatchRow, g: R.GameRow, gameMatchId: number): string[] {
    const stage = E.getStage(this.db, m.stage_id)!;
    const ev = E.getEvent(this.db, m.event_id)!;
    const stop = g.tiebreak_of !== null ? g.map : this.stopMapFor(stage, g.campaign);
    return gameLinesOf(this.db, { matchId: gameMatchId, stopAfterMap: stop, notice: `${ev.name}: ${this.name(m, 'a')} vs ${this.name(m, 'b')}, ${this.gameLabel(m, g)}` });
  }
  /** gameMatchId is passed in: the caller's row was read before linkGame set its match_id. */
  private startText(m: P.MatchRow, g: R.GameRow, gameMatchId: number): string {
    const first = this.sideOfEntry(m, g.first_survivors);
    const label = this.gameLabel(m, g);
    const what = `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${campaignDisplayName(this.db, g.campaign)}${g.tiebreak_of !== null ? ', one chapter' : ''}.`;
    // Plan T6: in entry order (event scores are entry_a/entry_b).
    const e = carryEntries(this.db, gameMatchId);
    const carried = e ? `Game 1's score carries over: ${this.name(m, 'a')} ${e.entryA}, ${this.name(m, 'b')} ${e.entryB}. ` : '';
    return `${what} ${carried}${first ? `${this.name(m, first)} start as survivors. ` : ''}Ready up when both teams are in.`;
  }

  /** Ruling 3: the burst for the game due on this campaign, creating its
   *  rows. Throws when nothing fits, so a setup try fails rather than load a
   *  map with no game behind it. */
  gameLines(bookingId: number, campaign: string): string[] {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || !LIVE_OR_BEFORE.has(m.status)) return [];
    const b = B.getBooking(this.db, bookingId);
    if (!b || b.server_id === null) return [];
    // A game already linked that never started (no MATCH_START: current_map
    // is still null, a heartbeat does not set it) is the one this load is
    // for: a setup retry or a recovery restarted the box under it, so its
    // burst goes again (T3b final review). The minute re-push keeps the
    // narrower rule (pendingLines: no heartbeat yet).
    const unstarted = R.gamesOf(this.db, m.id).find((g) => g.match_id !== null && g.ended_at === null && isUnstartedGame(this.db, g.match_id));
    if (unstarted) {
      if (unstarted.campaign !== campaign) throw new Error(`match ${m.id}: the box is loading ${campaign} but game ${unstarted.ordinal} (not started yet) is on ${unstarted.campaign}`);
      return this.linesFor(m, unstarted, unstarted.match_id!);
    }
    const rows = R.gamesOf(this.db, m.id);
    const due = playOrder(R.seriesGames(this.db, m)).map((s) => rows.find((g) => g.id === s.id)!).find((g) => g.match_id === null);
    if (!due || due.first_survivors === null) throw new Error(`match ${m.id}: no game is ready to start`);
    if (due.campaign !== campaign) throw new Error(`match ${m.id}: the box is loading ${campaign} but the next game is on ${due.campaign}`);
    const first = this.sideOfEntry(m, due.first_survivors)!;
    const four = (k: Side) => R.lineupFour(this.db, m.id, R.entryOn(m, k)) ?? [];
    const now = new Date(this.now());
    const g = createTournamentGame(this.db, { bookingId, serverId: b.server_id, campaign, teams: { a: four(first), b: four(other(first)) }, bookingSideA: first, now });
    const linked = R.linkGame(this.db, { matchId: m.id, gameId: due.id, gameMatchId: g.matchId, now });
    if (!linked.ok) throw new Error(`match ${m.id}: game ${due.ordinal} could not be linked (${linked.error})`);
    try { this.deps.registerToken?.(g.token); } catch (err) { console.error(`[series] registering the token of game ${g.matchId} failed:`, err); }
    console.log(`[series] match ${m.id}: game ${due.ordinal} is match ${g.matchId} on ${campaign}`);
    this.push(m.id);
    return [...this.linesFor(m, due, g.matchId), `say [Match] ${this.startText(m, due, g.matchId)}`];
  }

  /** A game pushed but not heard from yet: its burst again (no chat line). */
  pendingLines(bookingId: number): string[] {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m) return [];
    const pending = R.gamesOf(this.db, m.id).find((g) => g.match_id !== null && isPendingGame(this.db, g.match_id));
    return pending ? this.linesFor(m, pending, pending.match_id!) : [];
  }

  /** The box is set up: the grace to connect starts and the connect line goes out (Ruling 7, Ruling 16). */
  ready(bookingId: number): void {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || m.status !== 'booking') return;
    const b = B.getBooking(this.db, bookingId);
    if (!b) return;
    const grace = B.bookingRules(b)?.noShowGraceMinutes ?? DEFAULT_GRACE_MINUTES;
    const r = R.startConnect(this.db, { matchId: m.id, graceMinutes: grace, now: new Date(this.now()) });
    if (!r.ok) return;
    tellConnect(this.deps, m.event_id, m.id, B.acceptedPeople(this.db, bookingId).map((p) => p.steamid));
    this.push(m.id);
  }

  /** Who is on the box, each minute (Ruling 7). */
  presence(bookingId: number, on: ReadonlySet<string>, now: Date): void {
    this.watched.set(bookingId, now.getTime());
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || m.status !== 'connect' || m.deadline === null || now.toISOString() < m.deadline) return;
    const count = (k: Side) => (R.lineupFour(this.db, m.id, R.entryOn(m, k)) ?? []).filter((s) => on.has(s)).length;
    const shownA = count('a') >= SHOWN_MIN;
    const shownB = count('b') >= SHOWN_MIN;
    if (shownA && shownB) return;
    if (!shownA && !shownB) {
      const r = R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'no_show_both', now });
      if (!r.ok) return;
      this.alert(m, `neither team had ${SHOWN_MIN} players on the server when the grace ended (${count('a')} and ${count('b')}). It is on hold; the server stays up.`);
      this.push(m.id);
      return;
    }
    void this.forfeitNoShow(m, shownA ? 'a' : 'b', now);
  }

  private async forfeitNoShow(m: P.MatchRow, winner: Side, now: Date): Promise<void> {
    const r = await forfeitMatch(this.db, {
      eventId: m.event_id, matchId: m.id, winner, now,
      expect: (x) => x.status === 'connect' && x.booking_id === m.booking_id,
    });
    if (!r.ok) return;
    if (m.booking_id !== null && B.closeBooking(this.db, m.booking_id, 'ended', 'no_show', now)) this.deps.runner.settle(m.booking_id);
    tellReadyForfeit(this.deps, m.event_id, m.id, 'server');
    this.alert(m, `${this.name(m, other(winner))} did not have ${SHOWN_MIN} players on the server when the grace ended: forfeit win for ${this.name(m, winner)}.`);
    this.push(m.id);
  }

  /** MATCH_START of a tournament game (server.ts): the first one makes the match live. */
  gameStarted(gameMatchId: number): void {
    const row = this.db.prepare("SELECT booking_id FROM matches WHERE id = ? AND kind = 'tournament'").get(gameMatchId) as { booking_id: number | null } | undefined;
    if (!row || row.booking_id === null) return;
    const m = R.matchOfBooking(this.db, row.booking_id);
    if (!m || m.status !== 'connect') return;
    if (R.startLive(this.db, { matchId: m.id, now: new Date(this.now()) }).ok) this.push(m.id);
  }

  /** Plan T3c final review: the runner's idle end waits while the room's
   *  connect deadline is ahead (staff may have extended the grace past it).
   *  At the deadline the no-show rule decides, then the idle end may run. */
  idleEndAllowed(bookingId: number): boolean {
    const m = R.matchOfBooking(this.db, bookingId);
    return !(m && m.status === 'connect' && m.deadline !== null && Date.parse(m.deadline) > this.now());
  }

  /** Plan T3c final review: the site's staff freeze, for a crash recovery to put back. */
  frozen(bookingId: number): boolean {
    const m = R.matchOfBooking(this.db, bookingId);
    return !!m && m.admin_pause_at !== null;
  }

  /** The booking is winding down (Ruling 11). */
  ended(bookingId: number, reason: string | null): void {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || !LIVE_OR_BEFORE.has(m.status)) return;
    const r = R.holdMatch(this.db, { matchId: m.id, by: null, reason: `booking_${reason ?? 'ended'}`, now: new Date(this.now()) });
    if (!r.ok) return;
    this.alert(m, `its server booking ended (${reason ?? 'ended'}) before the series finished. It is on hold; enter the result or reset the room on the Events desk.`);
    this.push(m.id);
  }

  /** Crash recovery aborted a game of this booking (the runner's gameLost,
   *  T3b Task 4 ruling): it cannot be finished, so the match is held for
   *  staff, who replay it or decide. Once: a held match is not held again. */
  gameLost(bookingId: number, gameMatchId: number): void {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || !LIVE_OR_BEFORE.has(m.status)) return;
    const g = R.gamesOf(this.db, m.id).find((x) => x.match_id === gameMatchId);
    if (!g || g.ended_at !== null) return;
    const r = R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'game_lost', now: new Date(this.now()) });
    if (!r.ok) return;
    this.alert(m, `the server went down during ${this.gameLabel(m, g)} (match ${gameMatchId}) and the game could not be restored, so it was aborted. It is on hold; replay it or enter the result on the Events desk.`);
    this.push(m.id);
  }

  // ---------- results, tiebreaks, picks, the confirm window ----------

  /** The runner's hook: a tournament game finished (completeMatch wrote the
   *  row). The game is recorded from our capture, oriented by the row's
   *  booking_side_a, with a !gg (matches.forfeit_team) as that side's
   *  forfeit; seriesRules derives the winner. Then the series moves on, and
   *  a finished one leaves 'live' (the confirm window) before anything sets
   *  the booking's close, so the runner's ended hook never holds it (T3b
   *  ledger). Safe twice: a recorded game is not recorded again. */
  gameEnded(bookingId: number, gameMatchId: number): void {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m) return;
    const now = new Date(this.now());
    // A lost MATCH_START: the result proves the game was played.
    if (m.status === 'connect') R.startLive(this.db, { matchId: m.id, now });
    const fresh = P.getMatch(this.db, m.id)!;
    // A match staff held while this game ran still gets the game's result
    // (T3b final review); the series then waits for staff.
    const held = fresh.status === 'admin_hold';
    if (fresh.status !== 'live' && !held) return;
    const game = R.gamesOf(this.db, m.id).find((g) => g.match_id === gameMatchId);
    if (!game) return;
    if (game.ended_at === null) {
      const row = this.db.prepare('SELECT state, team_a_score, team_b_score, forfeit_team, forfeit_why, booking_side_a FROM matches WHERE id = ?').get(gameMatchId) as
        { state: string; team_a_score: number | null; team_b_score: number | null; forfeit_team: string | null; forfeit_why: ForfeitWhy | null; booking_side_a: Side | null } | undefined;
      if (!row || row.state !== 'completed') return;
      // Booking side a is entry_a; match team a is booking side booking_side_a.
      const flip = row.booking_side_a === 'b';
      const toSide = (team: 'a' | 'b'): Side => ((team === 'a') !== flip ? 'a' : 'b');
      const scoreA = flip ? row.team_b_score : row.team_a_score;
      const scoreB = flip ? row.team_a_score : row.team_b_score;
      const forfeit = row.forfeit_team === 'a' || row.forfeit_team === 'b' ? toSide(row.forfeit_team) : null;
      const rec = R.recordGame(this.db, { matchId: m.id, gameId: game.id, scoreA, scoreB, forfeit, forfeitWhy: forfeit ? row.forfeit_why ?? 'gg' : null, now, held });
      if (!rec.ok) {
        console.error(`[series] match ${m.id}: game ${game.ordinal} (match ${gameMatchId}) could not be recorded (${rec.error})`);
        return;
      }
      console.log(`[series] match ${m.id}: game ${game.ordinal} recorded ${scoreA ?? '-'} to ${scoreB ?? '-'}${forfeit ? `, forfeited by ${forfeit}` : ''}${held ? ' (match on hold)' : ''}`);
      if (held) this.push(m.id);
    }
    if (held) return;
    this.continueSeries(m.id);
  }

  /** The last chapter a game played and who survives first when it is
   *  replayed (Ruling 5): the team that was survivors second on it. Without
   *  a half-1 row for that map (an unreliable capture) the game's own first
   *  survivors are taken as that map's. */
  private lastChapter(m: P.MatchRow, g: R.GameRow): { map: string; firstSurvivors: Side } | null {
    if (g.match_id === null) return null;
    const last = this.db.prepare('SELECT ordinal, map FROM match_maps WHERE match_id = ? ORDER BY ordinal DESC LIMIT 1').get(g.match_id) as { ordinal: number; map: string } | undefined;
    if (!last) return null;
    const half1 = this.db.prepare('SELECT surv_team FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = 1').get(g.match_id, last.ordinal) as { surv_team: 'a' | 'b' } | undefined;
    const half1Entry: Side = half1 ? this.sideOfPugTeam(g.match_id, half1.surv_team) : this.sideOfEntry(m, g.first_survivors) ?? 'a';
    return { map: last.map, firstSurvivors: tiebreakFirstSurvivors(half1Entry) };
  }

  private scoreline(m: P.MatchRow, v: ReturnType<typeof seriesVerdict>): string {
    const w = v.winner!;
    const l = other(w);
    const rows = R.gamesOf(this.db, m.id);
    // Plan T5 Ruling 9: a forfeit that ends the series says why.
    if (v.forfeit !== null) {
      const why = rows.filter((g) => g.forfeit_side === v.forfeit).at(-1)?.forfeit_why ?? 'gg';
      return `${this.name(m, w)} beat ${this.name(m, l)} by forfeit (${this.name(m, v.forfeit)} ${forfeitHow(why)})`;
    }
    if (v.totalScore) return `${this.name(m, w)} beat ${this.name(m, l)} ${w === 'a' ? v.totalA : v.totalB} to ${w === 'a' ? v.totalB : v.totalA} on total score`;
    const line = `${this.name(m, w)} beat ${this.name(m, l)} ${winsLine(w === 'a' ? v.winsA : v.winsB, w === 'a' ? v.winsB : v.winsA)}`;
    // In a games-won series a forfeited game is a counted loss; when it was
    // the deciding game (the last one to end), the line still names why.
    const last = rows.filter((g) => g.ended_at !== null)
      .sort((x, y) => x.ended_at!.localeCompare(y.ended_at!) || x.id - y.id).at(-1);
    if (!last || last.forfeit_side === null) return line;
    return `${line} (${this.gameLabel(m, last)} by forfeit: ${this.name(m, last.forfeit_side)} ${forfeitHow(last.forfeit_why ?? 'gg')})`;
  }

  /** After a recorded game or a settled pick: a tiebreak, the confirm window,
   *  the loser's pick, or the next game. Idempotent: whatever is already in
   *  place is left alone. The confirm window opens even when the booking is
   *  already ending (the series is over either way); everything else needs
   *  the running booking. */
  continueSeries(matchId: number): void {
    const now = new Date(this.now());
    const m = P.getMatch(this.db, matchId);
    if (!m || m.status !== 'live' || m.booking_id === null) return;
    const b = B.getBooking(this.db, m.booking_id);
    const open = b !== undefined && B.isOpen(b);
    const timers = R.roomTimers(this.db);
    const s = E.stageSettingsOf(E.getStage(this.db, m.stage_id)!);
    const rows = R.gamesOf(this.db, m.id);
    const series = R.seriesGames(this.db, m);
    const v = seriesVerdict(s.veto, series);

    if (v.over) {
      // Out of 'live' first: the close set below may end the booking, and its ended hook must find a finished series.
      if (!R.startConfirm(this.db, { matchId: m.id, timers, now }).ok) return;
      if (b && open) {
        // The box closes after the usual grace (the idle end covers a refused close).
        const graceMs = seriesTimings(this.db).closeGraceMs;
        const closing = B.setCloseAt(this.db, b.id, gamesPlayed(this.db, b.id), new Date(now.getTime() + graceMs).toISOString(), now);
        const mins = Math.round(graceMs / 60_000);
        this.deps.runner.announce(b.id, `Series over: ${this.scoreline(m, v)}. Captains confirm or dispute on the site within ${timers.confirmMinutes} minutes.${closing ? ` The server closes in ${mins} minute${mins === 1 ? '' : 's'}.` : ''}`);
      }
      tellSeriesResult(this.deps, m.event_id, m.id);
      console.log(`[series] match ${m.id}: series over, confirm window open`);
      this.push(m.id);
      return;
    }
    if (!b || !open) return;

    if (v.tiebreakOf) {
      const parent = rows.find((g) => g.id === v.tiebreakOf!.id)!;
      // A tiebreak not yet played (waiting for the box, or being played now) is the one this tie gets.
      const waiting = rows.find((g) => g.tiebreak_of === parent.id && g.score_a === null && g.forfeit_side === null);
      if (waiting) {
        // Its load failed before it was linked (loadNext cleared next_campaign): schedule it again.
        if (waiting.match_id === null && waiting.map !== null && b.next_campaign === null && this.schedule(m, b, rows, parent.campaign, waiting.map, now)) {
          this.deps.runner.announce(b.id, `The tiebreak of game ${parent.ordinal} is loaded again in ${soonText(this.nextGameSeconds(m))}.`);
          this.push(m.id);
        }
        return;
      }
      const played = playOrder(series).map((x) => rows.find((g) => g.id === x.id)!)
        .filter((g) => (g.id === parent.id || g.tiebreak_of === parent.id) && g.match_id !== null).at(-1)!;
      const chapter = this.lastChapter(m, played);
      if (!chapter) {
        if (R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'tiebreak_unknown', now }).ok) {
          this.alert(m, `game ${parent.ordinal} tied but the site has no record of its last chapter, so no tiebreak could be set. It is on hold.`);
          this.push(m.id);
        }
        return;
      }
      const tb = R.addTiebreak(this.db, { matchId: m.id, ofGameId: parent.id, map: chapter.map, firstSurvivors: chapter.firstSurvivors, now });
      if (!tb.ok) {
        // Held, so staff are told once (a held match is not held again) and nothing stalls silently.
        if (R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'tiebreak_refused', now }).ok) {
          this.alert(m, `game ${parent.ordinal} tied again but no further tiebreak could be added (${tb.error}). It is on hold; enter the result on the Events desk.`);
          this.push(m.id);
        }
        return;
      }
      this.schedule(m, b, R.gamesOf(this.db, m.id), parent.campaign, chapter.map, now);
      this.deps.runner.announce(b.id, `Game ${parent.ordinal} is tied ${played.score_a} to ${played.score_b}: its last chapter is replayed as a tiebreaker in ${soonText(this.nextGameSeconds(m))}. ${this.name(m, chapter.firstSurvivors)} start as survivors.`);
      this.push(m.id);
      return;
    }

    const st = R.roomState(this.db, m);
    if (isHumanStep(st.next)) {
      if (m.deadline !== null) return;
      if (!R.openPick(this.db, { matchId: m.id, timers, now }).ok) return;
      const what = st.next.kind === 'pick' ? `pick game ${st.next.game}` : st.next.kind === 'side' ? `choose sides for game ${st.next.game}` : 'choose';
      this.deps.runner.announce(b.id, `${this.name(m, st.next.by)}: ${what} on the site within ${timers.stepSeconds} seconds, or your saved order decides.`);
      this.push(m.id);
      return;
    }
    // The veto may already be waiting on a later game's loser ('wait'); the
    // game due next is scheduled once its row has its sides.
    const next = v.nextGame === null ? undefined : rows.find((g) => g.tiebreak_of === null && g.ordinal === v.nextGame && g.match_id === null);
    if (!next || next.first_survivors === null || b.next_campaign !== null) return;
    this.schedule(m, b, rows, next.campaign, null, now);
    const first = this.sideOfEntry(m, next.first_survivors)!;
    this.deps.runner.announce(b.id, `Next: game ${next.ordinal}, ${campaignDisplayName(this.db, next.campaign)}, in ${soonText(this.nextGameSeconds(m))}. ${this.name(m, first)} start as survivors.`);
    this.push(m.id);
  }

  /** The next game on the box after the stage's next-game delay: appended to the booking unless
   *  an earlier try already appended it and its load then failed (loadNext
   *  clears next_campaign when the burst cannot be built), which shows as
   *  more games allowed than games linked; appending it again would leave
   *  games_allowed ahead for ever and block the close (T3b final review). */
  private schedule(m: P.MatchRow, b: B.BookingRow, rows: R.GameRow[], campaign: string, map: string | null, now: Date): boolean {
    const linked = rows.filter((g) => g.match_id !== null).length;
    if (b.games_allowed <= linked) {
      const r = B.appendTournamentGame(this.db, { bookingId: b.id, campaign, map, now });
      if (!r.ok) console.error(`[series] match ${m.id}: appending ${campaign} to booking ${b.id} failed (${r.error})`);
    }
    // Plan T5 Ruling 16: the stage's snapshot says how long between games.
    const delayMs = this.nextGameSeconds(m) * 1000;
    return B.setNext(this.db, b.id, campaign, new Date(now.getTime() + delayMs).toISOString(), now, null, map);
  }
  private nextGameSeconds(m: P.MatchRow): number {
    return stageRules(this.db, E.getStage(this.db, m.stage_id)!).series.nextGameSeconds;
  }

  /** A pick or side choice landed on a live match (a route or the clock). */
  afterPick(matchId: number): void {
    const m = P.getMatch(this.db, matchId);
    if (!m || m.status !== 'live') return;
    if (isHumanStep(R.roomState(this.db, m).next)) return;
    this.continueSeries(matchId);
  }

  /** Ruling 9: the automatic result, once the window passed or both
   *  confirmed. Resolves true when it changed the match (the result was
   *  recorded or the match was held), false when it did nothing or the
   *  result was refused, so the room clock pushes only on a change. */
  async finalize(matchId: number, now: Date): Promise<boolean> {
    const m = P.getMatch(this.db, matchId);
    if (!m || m.status !== 'confirming') return false;
    const due = (m.deadline !== null && m.deadline <= now.toISOString()) || (m.confirm_a_at !== null && m.confirm_b_at !== null);
    if (!due) return false;
    const s = E.stageSettingsOf(E.getStage(this.db, m.stage_id)!);
    const result = seriesResult(seriesVerdict(s.veto, R.seriesGames(this.db, m)));
    if (!result) {
      const held = R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'no_result', now }).ok;
      if (held) {
        this.alert(m, 'its confirm window ended but the games do not add up to a result. It is on hold.');
        this.push(m.id);
      }
      return held;
    }
    const r = await autoResultFlow(this.db, { eventId: m.event_id, matchId: m.id, result, expect: (x) => x.status === 'confirming', now });
    if (!r.ok) return false;
    console.log(`[series] match ${m.id}: result recorded (${result.scoreA ?? '-'} to ${result.scoreB ?? '-'}${result.forfeit ? ', forfeit' : ''})`);
    this.push(m.id);
    return true;
  }

  async confirm(matchId: number, steamid: string, now = new Date(this.now())): Promise<V.Checked<P.MatchRow>> {
    const r = R.confirmResult(this.db, { matchId, steamid, now });
    if (!r.ok) return r;
    this.push(matchId);
    await this.finalize(matchId, now);
    return r;
  }

  dispute(matchId: number, steamid: string, reason: unknown, now = new Date(this.now())): V.Checked<P.MatchRow> {
    const r = R.disputeMatch(this.db, { matchId, steamid, reason, now });
    if (!r.ok) return r;
    const m = r.value;
    const who = getPlayer(this.db, steamid)?.name ?? steamid;
    const pages = R.gamesOf(this.db, m.id).filter((g) => g.match_id !== null).map((g) => `/match/${g.match_id}`).join(', ');
    publishAdminEvent({
      kind: 'problem',
      text: `Tournament match ${this.title(m)} is DISPUTED by ${who} for ${this.name(m, m.dispute_side!)}: "${m.dispute_reason}". It is on hold. The games (replays and demos): ${pages || 'none'}. Enter the result or reset the room on the Events desk.`,
      link: this.roomLink(m),
    });
    this.push(matchId);
    return r;
  }

  // ---------- subs and the freeze (plan T3c) ----------

  /** The event match a tournament game's token belongs to, with its game row. */
  private matchOfToken(token: string): { m: P.MatchRow; game: R.GameRow; gameMatchId: number } | null {
    const row = this.db.prepare("SELECT id, booking_id FROM matches WHERE token = ? AND kind = 'tournament'").get(token) as { id: number; booking_id: number | null } | undefined;
    if (!row || row.booking_id === null) return null;
    const m = R.matchOfBooking(this.db, row.booking_id);
    if (!m) return null;
    const game = R.gamesOf(this.db, m.id).find((g) => g.match_id === row.id);
    return game ? { m, game, gameMatchId: row.id } : null;
  }

  /** The game of this match being played right now (a live matches row), or null. */
  private liveGameOf(m: P.MatchRow): { game: R.GameRow; token: string } | null {
    for (const game of R.gamesOf(this.db, m.id)) {
      if (game.match_id === null || game.ended_at !== null) continue;
      const row = this.db.prepare("SELECT token FROM matches WHERE id = ? AND state = 'live'").get(game.match_id) as { token: string | null } | undefined;
      if (row?.token) return { game, token: row.token };
    }
    return null;
  }

  private playerName(steamid: string): string {
    return consoleText(getPlayer(this.db, steamid)?.name ?? steamid, 40);
  }

  /** A captain's !sub, forwarded by the box (Rulings 4 to 6). Everything the
   *  site decides is decided here, in room.ts (a registered member of the
   *  entry, not already playing, within the stage's limit, asked by a
   *  manager of that side); the box hears the answer in chat. The room
   *  records the sub before the box is asked, so two requests cannot both
   *  pass the limit. A sub already recorded (the box did not take the
   *  command the first time) is sent again rather than refused (Review
   *  Focus 2). The box refusing because a chapter is being played undoes a
   *  fresh sub (the captain asks again at the next ready-up); the booking's
   *  people and the game's roster follow only a sub that stands. */
  async subRequested(token: string, by: string, outId: string, inId: string, emergency = false): Promise<void> {
    const found = this.matchOfToken(token);
    if (!found) return;
    const { m, game, gameMatchId } = found;
    const b = m.booking_id !== null ? B.getBooking(this.db, m.booking_id) : undefined;
    if (!b || !B.isOpen(b) || b.server_id === null) return;
    const now = new Date(this.now());
    const say = (text: string) => this.deps.runner.announce(b.id, text);
    const limit = stageRules(this.db, E.getStage(this.db, m.stage_id)!).subs.perMatch;
    const recorded = this.db.prepare(
      `SELECT json_extract(detail, '$.side') AS side, json_extract(detail, '$.used') AS used FROM event_log
        WHERE event_id = ? AND action = 'player_subbed' AND ${R.NOT_STAFF_SUB_SQL} AND json_extract(detail, '$.matchId') = ? AND json_extract(detail, '$.out') = ? AND json_extract(detail, '$.in') = ?
        ORDER BY id DESC LIMIT 1`,
    ).get(m.event_id, m.id, outId, inId) as { side: Side; used: number } | undefined;
    const four = recorded ? R.lineupFour(this.db, m.id, R.entryOn(m, recorded.side)) ?? [] : [];
    const standing = recorded !== undefined && four.includes(inId) && !four.includes(outId);
    let side: Side;
    let used: number;
    if (standing) {
      side = recorded!.side;
      used = recorded!.used;
      // A re-send is still the room's decision (Task 6 ledger): the match in a
      // sub phase and the asker a manager of that side, as subPlayer checks.
      const refusal: V.EventError | null = !R.SUB_PHASES.has(m.status) ? 'not_live_phase'
        : !N.entryManagers(this.db, N.getEntry(this.db, R.entryOn(m, side)) ?? { team_id: null, captain_steamid: null }).includes(by) ? 'not_manager' : null;
      if (refusal) {
        say(`Sub refused: ${V.EVENT_ERRORS[refusal].text}`);
        return;
      }
    } else {
      // Plan T5 Ruling 10: the box only sends emergency=1 when its cvar is on;
      // the stage's snapshot is the rule.
      if (emergency && !stageRules(this.db, E.getStage(this.db, m.stage_id)!).subs.emergency) {
        say(`Sub refused: ${V.EVENT_ERRORS.emergency_off.text}`);
        return;
      }
      const r = R.subPlayer(this.db, { matchId: m.id, by, outId, inId, limit, gameId: game.id, emergency, now });
      if (!r.ok) {
        say(`Sub refused: ${V.EVENT_ERRORS[r.error].text}`);
        return;
      }
      side = r.value.side;
      used = r.value.used;
    }
    const replies = await this.deps.runner.send(b.id, [`sm_pug_sub ${token} ${outId} ${inId}`], 'the sub');
    const reply = parseSubReply(replies?.[0], outId, inId);
    // The box refused and the site could not undo the sub: it stands on the
    // site, so the booking and the game roster follow it below (Task 6 ledger).
    let stuck = false;
    if (reply && !reply.ok && reply.error === SUB_NOT_BETWEEN) {
      const rv = standing ? null : R.revertSub(this.db, { matchId: m.id, outId, inId, now: new Date(this.now()) });
      if (rv === null || rv.ok) {
        if (rv) say('Sub refused: subs are made between chapters and a chapter is being played. Type the !sub again at the next ready-up.');
        else say(`The site has ${this.playerName(inId)} in for ${this.playerName(outId)}, but a chapter is being played. Type the !sub again at the next ready-up.`);
        console.log(`[series] match ${m.id}: the box refused ${inId} in for ${outId} (not between chapters)${standing ? '' : '; the sub was undone'}`);
        this.push(m.id);
        return;
      }
      console.error(`[series] match ${m.id}: undoing the sub of ${inId} for ${outId} failed (${rv.error})`);
      this.alert(m, `the server refused ${this.playerName(inId)} in for ${this.playerName(outId)} (a chapter is being played) and the sub could not be undone on the site (${rv.error}). The site's lineup has the sub and the server does not; check it on the Events desk.`);
      stuck = true;
    }
    if (!standing) {
      const swapped = B.swapPlayer(this.db, { bookingId: b.id, side, outId, inId, now });
      if (!swapped.ok) {
        console.error(`[series] match ${m.id}: booking ${b.id} did not swap ${outId} for ${inId} (${swapped.error})`);
        // Plan T3c final review: the presence count and the connect notice read the booking's players.
        this.alert(m, `the booking did not swap ${this.playerName(inId)} in for ${this.playerName(outId)} (${swapped.error}). The lineup and the server have the sub; the booking's players do not, so the "N of 4" count may be off. Check it on the Events desk.`);
      }
      const team = (this.db.prepare('SELECT team FROM match_players WHERE match_id = ? AND player_id = ?').get(gameMatchId, outId) as { team: 'a' | 'b' } | undefined)?.team;
      const added = team ? addTournamentSub(this.db, { matchId: gameMatchId, inId, team, now }) : null;
      if (!added) console.error(`[series] match ${m.id}: game match ${gameMatchId} got no roster row for ${inId} (${team ? 'not a tournament game' : `${outId} is not on its roster`})`);
    }
    const took = reply?.ok === true;
    if (stuck) say(`The site has ${this.playerName(inId)} in for ${this.playerName(outId)}, but a chapter is being played and the server did not take it. Staff were told; type the !sub again at the next ready-up.`);
    else if (took) say(`${this.playerName(inId)} is in for ${this.playerName(outId)} (${this.name(m, side)}, ${emergency ? 'emergency sub' : 'sub'} ${used} of ${limit}).`);
    else say(`The site put ${this.playerName(inId)} in for ${this.playerName(outId)}, but the server did not take it. Type the !sub again.`);
    console.log(`[series] match ${m.id}: ${inId} in for ${outId} on side ${side} (game ${game.ordinal}; the box ${took ? 'took it' : `did not take it: ${reply && !reply.ok ? reply.error : 'no answer'}`})`);
    this.push(m.id);
  }

  /** Staff remove a draft player and put a replacement in from the desk
   *  (drafts plan D2c Ruling 5). Every rule is checked first, writing
   *  nothing; a game on a box with the player on its roster is then asked
   *  to take the sub (sm_pug_sub, as a captain's !sub), and a box that
   *  refuses (mid-chapter) or does not answer refuses the replace as
   *  replace_in_game with what it said, with nothing written. Only then is
   *  the replace made. If it is refused at that point (the room moved on
   *  between the two), the box is asked to undo the sub and staff are told. */
  async staffReplace(o: {
    eventId: number; entryId: number; out: string; in: string; reason: N.ReplaceReason; note: string | null; actor: string; now?: Date;
  }): Promise<V.Checked<{ subbedInMatch: number | null }>> {
    const at = () => o.now ?? new Date(this.now());
    const plan = N.replaceDraftPlayer(this.db, { ...o, now: at(), check: true });
    if (!plan.ok) return plan;
    const took: N.BoxGame[] = [];
    for (const g of plan.value.onBox ?? []) {
      const replies = await this.deps.runner.send(g.bookingId, [`sm_pug_sub ${g.token} ${o.out} ${o.in}`], 'the staff replace');
      const reply = parseSubReply(replies?.[0], o.out, o.in);
      if (!reply || !reply.ok) {
        const kept = await this.undoBoxSubs(took, o.out, o.in);
        const km = kept[0] ? P.getMatch(this.db, kept[0].matchId) : undefined;
        if (km) this.alert(km, `a staff replace of ${this.playerName(o.out)} by ${this.playerName(o.in)} was taken by one server and refused by another, and it was NOT undone: the server has ${this.playerName(o.in)}, the site has ${this.playerName(o.out)}.`);
        console.log(`[series] match ${g.matchId}: the box refused the staff replace of ${o.out} by ${o.in} (${reply ? reply.error : 'no answer'})`);
        return V.fail('replace_in_game', [{ steamid: o.out, problems: [reply ? `The server said: ${reply.error}.` : 'The server did not answer.'] }]);
      }
      took.push(g);
    }
    const r = N.replaceDraftPlayer(this.db, { ...o, now: at(), boxTook: took.map((g) => g.gameMatchId) });
    if (!r.ok) {
      const kept = await this.undoBoxSubs(took, o.out, o.in);
      const m = took[0] ? P.getMatch(this.db, took[0].matchId) : undefined;
      if (m) {
        const what = `a staff replace of ${this.playerName(o.out)} by ${this.playerName(o.in)} was taken by the server but then refused on the site (${r.error})`;
        this.alert(m, kept.length === 0
          ? `${what}; the server undid it.`
          : `${what}, and it was NOT undone: the server has ${this.playerName(o.in)}, the site has ${this.playerName(o.out)}. Put ${this.playerName(o.out)} back in game (!sub) or replace again on the Events desk.`);
      }
      return r;
    }
    if (r.value.subbedInMatch !== null) {
      const m = P.getMatch(this.db, r.value.subbedInMatch);
      const b = m?.booking_id != null ? B.getBooking(this.db, m.booking_id) : undefined;
      if (m && b && B.isOpen(b) && b.server_id !== null) {
        const side = this.sideOfEntry(m, o.entryId);
        // The removed player left the booking: the box's allow list now, not at the minute re-push.
        await this.deps.runner.pushAllowList(b.id);
        this.deps.runner.announce(b.id, `Staff replaced ${this.playerName(o.out)} with ${this.playerName(o.in)}${side ? ` (${this.name(m, side)})` : ''}.`);
      }
      this.push(r.value.subbedInMatch);
    }
    return { ok: true, value: { subbedInMatch: r.value.subbedInMatch } };
  }

  /** The reverse sub on each box that took a staff replace the site then did
   *  not make; the games whose box did not confirm the undo (parseSubReply). */
  private async undoBoxSubs(games: N.BoxGame[], out: string, inn: string): Promise<N.BoxGame[]> {
    const kept: N.BoxGame[] = [];
    for (const g of games) {
      const replies = await this.deps.runner.send(g.bookingId, [`sm_pug_sub ${g.token} ${inn} ${out}`], 'undoing the staff replace');
      const reply = parseSubReply(replies?.[0], inn, out);
      if (!reply || !reply.ok) {
        kept.push(g);
        console.error(`[series] match ${g.matchId}: undoing the staff replace of ${out} by ${inn} on the box failed (${reply ? reply.error : 'no answer'})`);
      }
    }
    return kept;
  }

  /** A reset line (the plugin dropping its match, which lifts any freeze)
   *  signed with the token of an earlier game, arriving after a later game
   *  of the match was frozen: that freeze is the later game's, not the one
   *  the reset lifted. */
  private staleReset(m: P.MatchRow, gameMatchId: number): boolean {
    const r = this.db.prepare(
      `SELECT MAX(CASE WHEN action = 'match_frozen' THEN id END) AS frozen,
              MAX(CASE WHEN action = 'game_started' AND json_extract(detail, '$.gameMatchId') > ? THEN id END) AS later
         FROM event_log WHERE event_id = ? AND action IN ('match_frozen', 'game_started') AND json_extract(detail, '$.matchId') = ?`,
    ).get(gameMatchId, m.event_id, m.id) as { frozen: number | null; later: number | null };
    return r.later !== null && r.frozen !== null && r.frozen > r.later;
  }

  /** The box's ADMINPAUSE line (Ruling 9): the freeze as it stands there. A
   *  call alerts staff on the feed (the Discord card is the mod-call
   *  poster's); so does an in-game admin's !forceunpause, which lifts a
   *  freeze nobody on the desk lifted. A reset (the plugin dropped its
   *  match) may carry the token of a game that has already ended. */
  adminPauseLine(token: string, on: boolean, by: string | null, cause: AdminPauseCause): void {
    const found = this.matchOfToken(token);
    if (!found) return;
    const { m, gameMatchId } = found;
    if (!on && cause === 'reset') {
      const exp = this.expectedResets.get(m.id);
      if (exp && exp.gameMatchId === gameMatchId && (exp.until === null || this.now() <= exp.until)) {
        // The line a replay's or a move's abort sends: once, and only for the freeze it lifted.
        this.expectedResets.delete(m.id);
        if (this.standingFreeze(m) !== exp.frozenId) {
          console.log(`[series] match ${m.id}: the reset line of a replay or move of game match ${gameMatchId} left the freeze set after it alone`);
          return;
        }
      } else if (exp && (exp.until !== null && this.now() > exp.until)) {
        this.expectedResets.delete(m.id);
      }
      if (this.staleReset(m, gameMatchId)) {
        console.log(`[series] match ${m.id}: a reset line from game match ${gameMatchId} left the later game's freeze alone`);
        return;
      }
    }
    // The box's own line for a desk freeze in flight: the staff member who asked, not the box's null.
    const desk = cause === 'staff' && by === null ? this.deskFreezes.get(m.id) : undefined;
    const actor = desk && desk.on === on ? desk.by : by;
    const r = R.setAdminPause(this.db, { matchId: m.id, on, by: actor, cause, now: new Date(this.now()) });
    if (!r.ok) return;
    const who = by ? getPlayer(this.db, by)?.name ?? by : null;
    if (on && cause === 'call') {
      this.alert(m, `${who ?? 'a player'} called staff from the server with !admin. The game is frozen until staff lift it (Unfreeze on the Events desk, or !lift in game).`);
    } else if (!on && cause === 'forced') {
      this.alert(m, `${who ?? 'an admin'} lifted the staff freeze in game with !forceunpause (forced).`);
    }
    this.push(m.id);
  }

  // ---------- technical pauses and staff penalties (plan T5) ----------

  /** The room side of a game's pug team: pug team a is the game's booking_side_a (Ruling 17). */
  private sideOfPugTeam(gameMatchId: number, team: 'a' | 'b'): Side {
    const sideA = (this.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(gameMatchId) as { booking_side_a: Side | null } | undefined)?.booking_side_a ?? 'a';
    return team === 'a' ? sideA : other(sideA);
  }
  private pugTeamOf(gameMatchId: number, side: Side): 'a' | 'b' {
    return this.sideOfPugTeam(gameMatchId, 'a') === side ? 'a' : 'b';
  }
  private gameLabelOf(m: P.MatchRow, gameMatchId: number): string {
    const g = R.gamesOf(this.db, m.id).find((x) => x.match_id === gameMatchId);
    return g ? this.gameLabel(m, g) : 'a game';
  }

  /** The box's TECH line (Rulings 5 to 7, 11, 14): recorded on the match
   *  log; a start and an overrun tell staff on the feed (a flag reaches them
   *  through the mod-call card). A repeat or a line for a game this match
   *  does not hold changes nothing. On an overrun, tactical N >= 0 means the
   *  pause ran on as a tactical one with N left, -1 none left and the game
   *  unpaused, null ran on with tactical pauses unlimited. */
  techLine(token: string, ev: TechLine): void {
    const found = this.matchOfToken(token);
    if (!found) return;
    const { m, gameMatchId } = found;
    const side = this.sideOfPugTeam(gameMatchId, ev.team);
    const r = R.noteTech(this.db, {
      matchId: m.id, gameMatchId, event: ev.event, techId: ev.id, side, cause: ev.cause, by: ev.by,
      used: ev.used, budget: ev.budget, tactical: ev.tactical, text: ev.text, now: new Date(this.now()),
    });
    if (!r.ok) {
      if (r.error !== 'changed') console.warn(`[series] match ${m.id}: a TECH ${ev.event} line was not recorded (${r.error})`);
      return;
    }
    const team = this.name(m, side);
    const where = this.gameLabelOf(m, gameMatchId);
    if (ev.event === 'start') {
      this.alert(m, ev.cause === 'disconnect'
        ? `${team} is paused for a disconnect (${ev.by ? this.playerName(ev.by) : 'a player'}) in ${where}; ${clock(ev.budget - ev.used)} of reconnect time left.`
        : `${team} called a technical pause in ${where}: "${r.value.pause.reason}" (${clock(ev.budget - ev.used)} of technical time left).`);
    } else if (ev.event === 'over') {
      this.alert(m, ev.tactical === null
        ? `${team} ran out of technical time; the pause now uses a tactical pause (tactical pauses are unlimited).`
        : ev.tactical < 0
        ? `${team} ran out of technical time with no tactical pause left; the game was unpaused.`
        : `${team} ran out of technical time; the pause now uses a tactical pause (${ev.tactical} left).`);
    }
    this.push(m.id);
  }

  /** The desk's ruling on a technical pause (Ruling 12). A forfeit needs the
   *  pause's own game to be the one being played, and the box to take
   *  sm_pug_forfeit for the pausing team's pug team (oriented through the
   *  game's booking_side_a); the game then ends through the result path
   *  with forfeit_why=staff. Nothing is written until the box answered. The
   *  game end can land while the answer is awaited and even resolve the
   *  match: room.ts techPenalty still takes a forfeit ruling on a match
   *  that this very forfeit resolved, so the ruling is not lost. */
  async techPenalty(matchId: number, by: string, pauseId: unknown, penalty: unknown, note: unknown): Promise<V.Checked<P.MatchRow>> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    if (penalty !== 'warning' && penalty !== 'forfeit') return V.fail('bad_penalty');
    const n = V.normalizeReason(note);
    if (!n.ok) return n;
    const pause = R.techPausesOf(this.db, m).find((p) => p.id === pauseId);
    if (!pause) return V.fail('pause_not_found');
    if (pause.penalty !== null) return V.fail('already_penalized');
    // The box already took this ruling (a retry after a lost rcon reply, or
    // the game end landed first): the same condition room.ts relaxes on.
    const game = R.gamesOf(this.db, m.id).find((g) => g.match_id === pause.gameMatchId);
    const taken = game !== undefined && game.forfeit_side === pause.side && game.forfeit_why === 'staff';
    if (penalty === 'forfeit' && !taken) {
      const live = this.liveGameOf(m);
      if (!live || live.game.match_id !== pause.gameMatchId) return V.fail('no_live_game');
      const b = this.runningBooking(m);
      if (!b) return V.fail('no_box');
      const team = this.pugTeamOf(pause.gameMatchId, pause.side);
      const replies = await this.deps.runner.send(b.id, [`sm_pug_forfeit ${live.token} ${team}`], 'the forfeit');
      if (!forfeitTook(replies?.[0], team)) return V.fail('no_box');
    }
    const r = R.techPenalty(this.db, { matchId, pauseId, by, penalty, note, now: new Date(this.now()) });
    if (!r.ok) {
      if (penalty === 'forfeit') {
        console.error(`[series] match ${matchId}: the box took the forfeit but the penalty was not recorded (${r.error})`);
        this.alert(m, `the server took the staff forfeit over a technical pause but the site did not record the ruling (${r.error}). Check the match log on the Events desk.`);
      }
      return r;
    }
    tellStaffAction(this.deps, m.event_id, m.id, penalty === 'forfeit' ? 'tech_forfeit' : 'tech_warning',
      `${this.name(m, pause.side)}, ${this.gameLabelOf(m, pause.gameMatchId)}: "${pause.reason}"`);
    this.push(m.id);
    return V.ok(r.value.m);
  }

  /** The desk's Freeze and Unfreeze (Ruling 9): the box first, then the
   *  column, then both rosters. The box's own line for the same change
   *  usually arrives after and changes nothing. */
  async freeze(matchId: number, by: string, on: boolean): Promise<V.Checked<P.MatchRow>> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    if (m.status !== 'connect' && m.status !== 'live') return V.fail('not_live_phase');
    if (on === (m.admin_pause_at !== null)) return V.fail(on ? 'already_frozen' : 'not_frozen');
    const live = this.liveGameOf(m);
    if (!live) return V.fail('no_live_game');
    const b = m.booking_id !== null ? B.getBooking(this.db, m.booking_id) : undefined;
    if (!b || b.server_id === null || !B.isOpen(b)) return V.fail('no_box');
    const who = consoleText(getPlayer(this.db, by)?.name ?? 'Staff', 40);
    this.deskFreezes.set(m.id, { on, by });
    let replies: string[] | null;
    try {
      replies = await this.deps.runner.send(b.id, [`sm_pug_adminpause ${live.token} ${on ? 'on' : 'off'} ${quoted(who)}`], on ? 'the freeze' : 'the unfreeze');
    } finally {
      this.deskFreezes.delete(m.id);
    }
    if (!adminPauseTook(replies?.[0], on)) return V.fail('no_box');
    const r = R.setAdminPause(this.db, { matchId: m.id, on, by, cause: 'staff', now: new Date(this.now()) });
    if (!r.ok && r.error !== 'already_frozen' && r.error !== 'not_frozen') return r;
    tellStaffAction(this.deps, m.event_id, m.id, on ? 'frozen' : 'unfrozen');
    this.push(m.id);
    return V.ok(P.getMatch(this.db, m.id)!);
  }

  // ---------- the desk tools (plan T3c Task 7) ----------

  /** Before a replay or a move: a frozen game's box lifts the freeze as it
   *  drops its match, and its reset line is expected (Task 7 ledger). The
   *  entry this call set, for afterReset, or null. An expectation still in
   *  flight belongs to a replay or move already running, which this call's
   *  runner refuses as busy: it is left alone (Task 8 ledger). */
  private expectReset(m: P.MatchRow, gameMatchId: number): ExpectedReset | null {
    const running = this.expectedResets.get(m.id);
    if (running && running.until === null) return null;
    const frozenId = this.standingFreeze(m);
    if (frozenId === null) {
      this.expectedResets.delete(m.id);
      return null;
    }
    const exp: ExpectedReset = { gameMatchId, frozenId, until: null };
    this.expectedResets.set(m.id, exp);
    return exp;
  }

  /** The match_frozen row of the freeze standing now, or null when not frozen
   *  (a row id, since two freezes in the same millisecond share a timestamp). */
  private standingFreeze(m: P.MatchRow): number | null {
    const fresh = P.getMatch(this.db, m.id);
    if (!fresh || fresh.admin_pause_at === null) return null;
    return (this.db.prepare(
      "SELECT MAX(id) AS id FROM event_log WHERE event_id = ? AND action = 'match_frozen' AND json_extract(detail, '$.matchId') = ?",
    ).get(fresh.event_id, fresh.id) as { id: number | null }).id;
  }

  /** After it. 'lifted': the box dropped the match (a replay it answered, or
   *  a move: the new box starts unfrozen), so the freeze is recorded as lifted
   *  now if its line has not come yet, and a late line is still matched for a
   *  while. 'unknown': the box may or may not have dropped it; only the
   *  expectation is kept a while. 'none': nothing was sent. Only the entry
   *  this call's expectReset set is touched: one the box's line already
   *  consumed, or another call's, is left alone. */
  private afterReset(matchId: number, exp: ExpectedReset | null, what: 'lifted' | 'unknown' | 'none'): void {
    if (!exp || this.expectedResets.get(matchId) !== exp) return;
    if (what === 'none') {
      this.expectedResets.delete(matchId);
      return;
    }
    exp.until = this.now() + RESET_EXPECT_MS;
    const m = P.getMatch(this.db, matchId);
    if (what !== 'lifted' || !m || this.standingFreeze(m) !== exp.frozenId) return;
    const r = R.setAdminPause(this.db, { matchId, on: false, by: null, cause: 'reset', now: new Date(this.now()) });
    if (!r.ok) console.error(`[series] match ${matchId}: recording the freeze the box dropped failed (${r.error})`);
  }

  /** The chapters the desk may replay (Ruling 12): empty unless a game is live. */
  replayable(matchId: number): { ordinal: number; map: string }[] {
    const m = P.getMatch(this.db, matchId);
    if (!m || m.status !== 'live') return [];
    const live = this.liveGameOf(m);
    return live ? replayableChapters(this.db, live.game.match_id!) : [];
  }

  /** Ruling 12: the live game is rebuilt on its box from the chapters before
   *  `ordinal` and that chapter loads from its start. A resume the box
   *  refused has aborted the game and the gameLost hook has held the match
   *  by the time this answers replay_failed; a box that did not answer the
   *  abort leaves the game live and the match as it was (replay_no_answer);
   *  one that answered the abort but not the resume on every try has
   *  dropped its match and any freeze with it; the runner hands the booking
   *  to crash recovery, which restores the game at its current chapter, for
   *  staff to replay again once it is back (replay_dropped). */
  /** The refusals a replay meets before it touches the box: synchronous, so
   *  the desk's route can answer them at once (plan T3c final review). */
  replayCheck(matchId: number, ordinal: unknown): V.Checked<{ m: P.MatchRow; live: { game: R.GameRow; token: string }; b: B.BookingRow; snap: RestoreSnapshot }> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    if (m.status !== 'live') return V.fail('not_live_phase');
    const live = this.liveGameOf(m);
    if (!live) return V.fail('no_live_game');
    const b = this.runningBooking(m);
    if (!b) return V.fail('no_box');
    if (!Number.isInteger(ordinal) || (ordinal as number) < 0) return V.fail('chapter_not_replayable');
    const snap = restoreSnapshot(this.db, live.game.match_id!, { replayFrom: ordinal as number });
    if (!snap) return V.fail('chapter_not_replayable');
    return V.ok({ m, live, b, snap });
  }

  /** The desk's replay (plan T3c final review): the route has answered and
   *  audited it; the replay runs here and staff hear its outcome on the
   *  admin feed. Never rejects. */
  replayInBackground(matchId: number, by: string, ordinal: unknown): Promise<void> {
    const label = Number.isInteger(ordinal) ? `chapter ${(ordinal as number) + 1}` : 'the chapter';
    const tell = (text: string) => {
      const m = P.getMatch(this.db, matchId);
      if (m) this.alert(m, text);
    };
    return this.replayChapter(matchId, by, ordinal).then((r) => {
      if (r.ok) tell(`staff replayed ${label} (${r.value.map}) from its start; the game is live again.`);
      else if (r.error === 'replay_dropped') tell(`the replay of ${label} was dropped by the server; the game is being restored at its current chapter through crash recovery and the freeze was lifted. Replay it again once it is back.`);
      else if (r.error === 'replay_failed') tell(`the server refused the replay of ${label}. ${V.EVENT_ERRORS.replay_failed.text}`);
      else tell(`the replay of ${label} did not run: ${V.EVENT_ERRORS[r.error].text}`);
    }).catch((err: unknown) => {
      console.error(`[series] match ${matchId}: the replay of ${label} failed:`, err instanceof Error ? err.message : err);
      tell(`the replay of ${label} failed with an error (${err instanceof Error ? err.message : String(err)}). Check the server and the match on the Events desk.`);
    });
  }

  async replayChapter(matchId: number, by: string, ordinal: unknown): Promise<V.Checked<{ map: string }>> {
    const c = this.replayCheck(matchId, ordinal);
    if (!c.ok) return c;
    const { m, live, b, snap } = c.value;
    const gameMatchId = live.game.match_id!;
    const exp = this.expectReset(m, gameMatchId);
    const r = await this.deps.runner.replayGame(b.id, gameMatchId, snap);
    this.afterReset(m.id, exp, r === 'busy' ? 'none' : r === 'error' ? 'unknown' : 'lifted');
    if (r === 'busy') return V.fail('changed');
    if (r === 'error') return V.fail('replay_no_answer');
    if (r === 'dropped') {
      this.push(m.id);
      return V.fail('replay_dropped');
    }
    if (r === 'refused') {
      this.push(m.id);
      return V.fail('replay_failed');
    }
    const noted = R.noteReplay(this.db, { matchId: m.id, by, gameId: live.game.id, ordinal: snap.maps.length, map: snap.map, now: new Date(this.now()) });
    if (!noted.ok) console.error(`[series] match ${m.id}: the replay of ${snap.map} was not noted (${noted.error})`);
    tellStaffAction(this.deps, m.event_id, m.id, 'chapter_replayed', `chapter ${snap.maps.length + 1} of ${campaignDisplayName(this.db, snap.campaign)}`);
    console.log(`[series] match ${m.id}: staff ${by} replayed ${snap.map} of game ${live.game.ordinal}`);
    this.push(m.id);
    return V.ok({ map: snap.map });
  }

  /** Ruling 13: the booking lets go of its box and takes the first idle one
   *  through the runner's recovery; the game is restored there. */
  async moveServer(matchId: number, by: string): Promise<V.Checked<P.MatchRow>> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    if (m.status !== 'connect' && m.status !== 'live') return V.fail('not_live_phase');
    const b = this.runningBooking(m);
    if (!b) return V.fail('no_box');
    const live = this.liveGameOf(m);
    // Plan T3c final review: the new box restores the live game from the
    // site's record; a game that cannot be restored (its finale) would be
    // aborted by the move. Refused before anything is cancelled or released.
    if (live && restoreSnapshot(this.db, live.game.match_id!) === null) return V.fail('cannot_move_finale');
    const frozen = m.admin_pause_at !== null;
    const exp = live ? this.expectReset(m, live.game.match_id!) : null;
    let old: number | null;
    try {
      old = await this.deps.runner.moveBooking(b.id);
    } catch (err) {
      this.afterReset(m.id, exp, 'none');
      throw err;
    }
    this.afterReset(m.id, exp, old === null ? 'none' : 'lifted');
    if (old === null) return V.fail('no_box');
    const r = R.noteMove(this.db, { matchId: m.id, by, fromServerId: old, now: new Date(this.now()) });
    if (!r.ok) return r;
    const lifted = frozen ? ' The freeze is lifted (the new box starts unfrozen); freeze it again from the Events desk if needed.' : '';
    this.alert(m, `staff moved it off ${getServer(this.db, old)?.name ?? `server ${old}`}. It takes the first idle box in its region and the game is restored there; with none free it waits, then is held.${lifted}`);
    tellStaffAction(this.deps, m.event_id, m.id, 'server_moved');
    this.push(m.id);
    return V.ok(P.getMatch(this.db, m.id)!);
  }

  /** Ruling 14. */
  extendGrace(matchId: number, by: string, minutes: unknown): V.Checked<P.MatchRow> {
    const r = R.extendGrace(this.db, { matchId, by, minutes, now: new Date(this.now()) });
    if (!r.ok) return r;
    const m = r.value;
    if (m.booking_id !== null) this.deps.runner.announce(m.booking_id, `Staff gave both teams ${minutes as number} more minutes to connect (until ${m.deadline!.slice(11, 16)} UTC).`);
    tellStaffAction(this.deps, m.event_id, m.id, 'grace_extended', `${minutes as number} minutes`);
    this.push(m.id);
    return r;
  }

  /** Ruling 15: the grace of a released connect hold is the booking's. */
  releaseHold(matchId: number, by: string): V.Checked<P.MatchRow> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    const b = m.booking_id !== null ? B.getBooking(this.db, m.booking_id) : undefined;
    const grace = b ? B.bookingRules(b)?.noShowGraceMinutes ?? DEFAULT_GRACE_MINUTES : DEFAULT_GRACE_MINUTES;
    const r = R.releaseHold(this.db, { matchId, by, timers: R.roomTimers(this.db), graceMinutes: grace, now: new Date(this.now()) });
    if (!r.ok) return r;
    if (b && B.isOpen(b) && (r.value.status === 'connect' || r.value.status === 'live')) this.deps.runner.announce(b.id, 'Staff released the hold on this match. Play on.');
    tellStaffAction(this.deps, m.event_id, m.id, 'hold_released');
    this.push(m.id);
    return r;
  }

  /** Ruling 11: a booking made meanwhile is cancelled first, as a reset does;
   *  the room's own refusals are checked before anything is cancelled. */
  reopenVeto(matchId: number, by: string): V.Checked<P.MatchRow> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    // The same checks room.ts makes, in the same order, before any booking is cancelled.
    if (R.gamesOf(this.db, m.id).some((g) => g.match_id !== null)) return V.fail('game_started');
    const from = m.status === 'admin_hold' ? m.hold_from : m.status;
    if (from !== 'veto' && from !== 'lineup' && from !== 'booking') return V.fail('wrong_status');
    if (m.ready_a_at === null || m.ready_b_at === null) return V.fail('not_ready_phase');
    const now = new Date(this.now());
    let cancelled: number | null = null;
    if (m.booking_id !== null) {
      const b = B.getBooking(this.db, m.booking_id);
      if (b && B.isOpen(b)) {
        const c = B.cancelBooking(this.db, { bookingId: b.id, by, staff: true, reason: 'The veto was reopened', now });
        if (!c.ok) return V.fail('booking_open');
        cancelled = b.id;
      }
    }
    const r = R.reopenVeto(this.db, { matchId, by, timers: R.roomTimers(this.db), now });
    if (cancelled !== null) this.deps.runner.onCancelled(cancelled, by, 'The veto was reopened');
    if (!r.ok) return r;
    tellStaffAction(this.deps, m.event_id, m.id, 'veto_reopened');
    this.push(m.id);
    return r;
  }

  /** Ruling 14: the booking is cancelled before the room resets, so no box is orphaned and no hold is raised. */
  reset(matchId: number, by: string, now = new Date(this.now())): V.Checked<P.MatchRow> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    // Checked before the booking is cancelled: a refused reset must leave a running box alone.
    if (!R.RESETTABLE.has(m.status)) return V.fail('wrong_status');
    let cancelled: number | null = null;
    if (m.booking_id !== null) {
      const b = B.getBooking(this.db, m.booking_id);
      if (b && B.isOpen(b)) {
        const c = B.cancelBooking(this.db, { bookingId: b.id, by, staff: true, reason: 'The match room was reset', now });
        if (!c.ok) return V.fail('booking_open');
        cancelled = b.id;
      }
    }
    const r = R.resetRoom(this.db, { matchId, by, now });
    // The wind-down runs after the reset, so its ended hook finds a waiting match and does nothing.
    if (cancelled !== null) this.deps.runner.onCancelled(cancelled, by, 'The match room was reset');
    if (r.ok) this.push(matchId);
    return r;
  }

  /** T3b ledger ruling: staff entered the result (the Events desk) while the
   *  match's booking still runs (connect, live, confirming, or a hold with
   *  an open booking). That booking ends as a staff end (a scheduled one,
   *  with no box yet, is cancelled as staff), so the box is not held until
   *  the idle end. Called after the result is saved: the ended hook then
   *  finds a finished match and holds nothing, and the wind-down aborts a
   *  game still in progress, which is what entering the result means. A
   *  booking already ending or ended is left alone. */
  staffResult(matchId: number, by: string, now = new Date(this.now())): void {
    const m = P.getMatch(this.db, matchId);
    if (!m || m.booking_id === null || (m.status !== 'done' && m.status !== 'forfeit')) return;
    const b = B.getBooking(this.db, m.booking_id);
    if (!b || !B.isOpen(b)) return;
    if (b.state === 'ready' || b.state === 'active') {
      this.deps.runner.announce(b.id, 'Staff entered the result of this match on the site. The server closes now.');
      const r = B.endBooking(this.db, { bookingId: b.id, by, staff: true, now });
      if (!r.ok) { console.error(`[series] match ${m.id}: ending booking ${b.id} after the staff result failed (${r.error})`); return; }
      this.deps.runner.settle(b.id);
    } else {
      const r = B.cancelBooking(this.db, { bookingId: b.id, by, staff: true, reason: 'Staff entered the match result', now });
      if (!r.ok) { console.error(`[series] match ${m.id}: cancelling booking ${b.id} after the staff result failed (${r.error})`); return; }
      this.deps.runner.onCancelled(b.id, by, 'Staff entered the match result');
    }
    console.log(`[series] match ${m.id}: booking ${b.id} ended after the staff result`);
  }
}
