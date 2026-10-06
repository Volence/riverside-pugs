import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { campaignDisplayName, campaignRegistry } from '../campaignRegistry.js';
import type { Notifier } from '../notify/notify.js';
import { parseRules, rulesForKind, type MatchRules } from '../rulesets.js';
import { stopAfterMap } from '../stopPoint.js';
import { getTeam } from '../teams/teams.js';
import * as B from '../bookings/bookings.js';
import { SHOWN_MIN } from '../bookings/rules.js';
import type { TournamentHooks } from '../bookings/runner.js';
import { createTournamentGame, gameLinesOf, isPendingGame } from '../bookings/tournamentGames.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import { forfeitMatch } from './flow.js';
import { tellConnect, tellReadyForfeit } from './notices.js';
import { gameNumberOf, playOrder } from './seriesRules.js';
import { other, type Side } from './veto.js';

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

/** Ten minutes without a box: staff are told once (Ruling 8). */
export const SERVER_ALERT_MS = 10 * 60_000;
/** A connect deadline nobody could watch for this long is held, not guessed (Ruling 7). */
export const PRESENCE_FALLBACK_MS = 3 * 60_000;

export interface SeriesRunner {
  announce(bookingId: number, text: string): void;
  settle(bookingId: number): void;
  onCancelled(bookingId: number, by: string | null, reason: string | null): void;
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
  };
}

/** The rules a stage plays by: its snapshot, else its ruleset's tournament reading. */
function stageRules(db: DB, stage: E.StageRow): MatchRules {
  if (stage.rules_json) return parseRules(stage.rules_json);
  const row = db.prepare('SELECT rules_json FROM rulesets WHERE id = ?').get(stage.ruleset_id) as { rules_json: string } | undefined;
  if (!row) throw new Error(`stage ${stage.id}: ruleset ${stage.ruleset_id} is gone`);
  return rulesForKind('tournament', parseRules(row.rules_json));
}

const LIVE_OR_BEFORE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['booking', 'connect', 'live']);

export class SeriesEngine {
  private readonly db: DB;
  private readonly now: () => number;
  /** When each tournament booking's box was last watched (the presence hook), for the fallback. */
  private readonly watched = new Map<number, number>();
  private readonly bootMs: number;
  /** Matches whose booking was refused, told to staff once per process (the tick retries every 5 seconds). */
  private readonly bookAlerted = new Set<number>();

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

  // ---------- the clock's duties ----------

  /** Every 5 seconds from the room clock: book, alert on a long wait, hold a connect deadline nobody could watch. */
  tick(now: Date): void {
    const unbooked = this.db.prepare(`SELECT m.* FROM event_matches m WHERE ${R.ROOM_LIVE_SQL} AND m.status = 'booking' AND m.booking_id IS NULL ORDER BY m.id`)
      .all() as P.MatchRow[];
    for (const m of unbooked) {
      try { this.book(m, now); } catch (err) { console.error(`[series] booking match ${m.id} failed:`, err instanceof Error ? err.message : err); }
    }
    const waiting = this.db.prepare(
      `SELECT m.* FROM event_matches m JOIN bookings b ON b.id = m.booking_id
       WHERE m.status = 'booking' AND m.server_alerted_at IS NULL AND m.booked_at <= ?
         AND b.server_id IS NULL AND b.state = 'scheduled' AND b.ending_at IS NULL`,
    ).all(new Date(now.getTime() - SERVER_ALERT_MS).toISOString()) as P.MatchRow[];
    for (const m of waiting) {
      try {
        if (!R.noteServerAlert(this.db, { matchId: m.id, now }).ok) continue;
        this.alert(m, 'has waited 10 minutes for a server (no idle box in its region can take it). It keeps waiting; free a box, or reset the room or enter the result on the Events desk.');
        this.push(m.id);
      } catch (err) {
        console.error(`[series] server alert for match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    const stale = this.db.prepare("SELECT * FROM event_matches WHERE status = 'connect' AND deadline IS NOT NULL AND deadline <= ?")
      .all(new Date(now.getTime() - PRESENCE_FALLBACK_MS).toISOString()) as P.MatchRow[];
    for (const m of stale) {
      const last = m.booking_id !== null ? this.watched.get(m.booking_id) ?? this.bootMs : this.bootMs;
      if (now.getTime() - last < PRESENCE_FALLBACK_MS) continue;
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
      const team = entry && entry.team_id !== null ? getTeam(this.db, entry.team_id) : undefined;
      const four = R.lineupFour(this.db, m.id, entryId);
      if (!entry || !team || !four) return null;
      const r = N.rosterOf(this.db, entryId);
      const rest = [...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])].filter((x) => !four.includes(x));
      return { teamId: team.id, captain: team.captain_steamid, players: four, spectators: rest };
    };
    const a = side('a');
    const b = side('b');
    if (!a || !b) {
      console.error(`[series] match ${m.id}: cannot book without both teams and their lineups`);
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
  private startText(m: P.MatchRow, g: R.GameRow): string {
    const first = this.sideOfEntry(m, g.first_survivors);
    const label = this.gameLabel(m, g);
    const what = `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${campaignDisplayName(this.db, g.campaign)}${g.tiebreak_of !== null ? ', one chapter' : ''}.`;
    return `${what} ${first ? `${this.name(m, first)} start as survivors. ` : ''}Ready up when both teams are in.`;
  }

  /** Ruling 3: the burst for the game due on this campaign, creating its
   *  rows. Throws when nothing fits, so a setup try fails rather than load a
   *  map with no game behind it. */
  gameLines(bookingId: number, campaign: string): string[] {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || !LIVE_OR_BEFORE.has(m.status)) return [];
    const b = B.getBooking(this.db, bookingId);
    if (!b || b.server_id === null) return [];
    const pending = this.pendingLines(bookingId);
    if (pending.length > 0) return pending;
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
    return [...this.linesFor(m, due, g.matchId), `say [Match] ${this.startText(m, due)}`];
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
    const grace = B.bookingRules(b)?.noShowGraceMinutes ?? 15;
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

  /** A game of this booking finished (the runner's hook). Task 6 records it
   *  and moves the series on; until then nothing happens here. */
  gameEnded(_bookingId: number, _gameMatchId: number): void {
    // Task 6.
  }

  /** A veto action on a live match (a between-game pick). Task 6. */
  afterPick(_matchId: number): void {
    // Task 6.
  }

  /** The automatic result once the confirm window closes. Task 6. */
  async finalize(_matchId: number, _now: Date): Promise<void> {
    // Task 6.
  }

  // Task 6 adds continueSeries, confirm, dispute and reset here, and fills
  // in gameEnded, afterPick and finalize.
}
