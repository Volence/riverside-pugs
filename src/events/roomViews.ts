import type { DB } from '../db.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { getPlayer } from '../players.js';
import { getServer } from '../serverPool.js';
import * as B from '../bookings/bookings.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import { matchLabel, phaseOf, playEntriesOf, type PlayEntry, type RoomPhase } from './playViews.js';
import { gameNumberOf, playOrder, seriesVerdict } from './seriesRules.js';
import { vetoSummary } from './vetoConfig.js';
import { isHumanStep, type VetoActionKind } from './veto.js';

/** What the match room page shows (tournaments plan T3a). Lineups stay
 *  secret until both are locked, and preferences never appear here
 *  (Global Constraints). */

export { phaseOf, type RoomPhase } from './playViews.js';

export interface RoomCampaign { slug: string; name: string; state: 'open' | 'banned' | 'picked' | 'decider'; by: 'a' | 'b' | null; game: number | null }
export interface RoomLogLine { step: number; side: 'a' | 'b'; action: VetoActionKind; campaign: string | null; campaignName: string | null; auto: boolean; at: string }
/** One row of the series in play order (a tiebreak right after its game),
 *  with its score once recorded and the running score while it is live
 *  (plan T3b). game is the series game a tiebreak stands in for. */
export interface RoomGame {
  id: number; game: number; ordinal: number; tiebreak: boolean; campaign: string; campaignName: string; map: string | null;
  pickedBy: 'a' | 'b' | null; sideBy: 'a' | 'b' | null; firstSurvivors: 'a' | 'b' | null;
  matchId: number | null; state: 'upcoming' | 'live' | 'done'; scoreA: number | null; scoreB: number | null; winner: 'a' | 'b' | null;
  /** The side that typed !gg on this game (it lost the game whatever the score), or null. */
  forfeit: 'a' | 'b' | null;
  live: { map: string | null; scoreA: number; scoreB: number } | null;
}
export interface RoomSeries { bestOf: number; totalScore: boolean; winsA: number; winsB: number; totalA: number; totalB: number; over: boolean; winner: 'a' | 'b' | null }
/** The match's booked server (plan T3b). connect is shown only to staff and
 *  the booking's accepted people; present is each side's locked four on the
 *  box at the last minute watch. */
export interface RoomServer {
  state: 'waiting' | 'setup' | 'ready' | 'ended'; name: string | null; since: string;
  connect: { host: string; port: number; password: string } | null; present: { a: number; b: number } | null; graceEndsAt: string | null;
}
export interface RoomPlayer { steamid: string; name: string }
/** a and b are null only while a bracket match still waits for its teams. */
export interface MatchRoomView {
  id: number; eventSlug: string; eventName: string; roundLabel: string; a: PlayEntry | null; b: PlayEntry | null; phase: RoomPhase;
  higher: 'a' | 'b' | null; deadline: string | null; serverNow: string; ready: { a: boolean; b: boolean };
  vetoSummary: string; pool: RoomCampaign[]; log: RoomLogLine[]; games: RoomGame[];
  next: { kind: 'order' | 'ban' | 'pick' | 'side'; by: 'a' | 'b'; game: number | null; step: number } | { kind: 'wait'; game: number } | null;
  lineups: { a: RoomPlayer[] | null; b: RoomPlayer[] | null; aLocked: boolean; bLocked: boolean };
  holdReason: string | null;
  result: { winner: 'a' | 'b'; scoreA: number | null; scoreB: number | null; forfeit: boolean } | null;
  me: { side: 'a' | 'b'; manager: boolean; playable: RoomPlayer[]; defaultFour: string[] | null } | null;
  series: RoomSeries | null;
  server: RoomServer | null;
  confirm: { deadline: string | null; a: boolean; b: boolean } | null;
  dispute: { side: 'a' | 'b'; byName: string; reason: string; at: string } | null;
}
export interface PrefsView {
  entryId: number; defaultFour: string[] | null; side: 'survivors' | 'infected' | null; roster: RoomPlayer[];
  stages: { stageId: number; ordinal: number; pool: { slug: string; name: string }[]; order: string[] }[];
}

const player = (db: DB, steamid: string): RoomPlayer => ({ steamid, name: getPlayer(db, steamid)?.name ?? steamid });
/** Everyone on an entry's roster, coach included. */
const rosterSet = (db: DB, entryId: number): Set<string> => {
  const r = N.rosterOf(db, entryId);
  return new Set([...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])]);
};

export function matchRoomView(db: DB, ev: E.EventRow, m: P.MatchRow, viewer: string | null, staff: boolean, now = new Date()): MatchRoomView {
  const settings = E.stageSettingsOf(E.getStage(db, m.stage_id)!);
  const entries = playEntriesOf(db, ev);
  const sideOfEntry = (id: number | null): 'a' | 'b' | null => (id === null ? null : id === m.entry_a ? 'a' : id === m.entry_b ? 'b' : null);
  const name = (slug: string) => campaignDisplayName(db, slug);
  const st = m.room_opened_at !== null && m.entry_a !== null && m.entry_b !== null ? R.roomState(db, m) : null;
  const vetoRows = db.prepare('SELECT step, side, action, campaign, auto, at FROM event_vetoes WHERE event_match_id = ? ORDER BY step').all(m.id) as
    { step: number; side: 'a' | 'b'; action: VetoActionKind; campaign: string | null; auto: number; at: string }[];
  const games = R.gamesOf(db, m.id);
  const pool: RoomCampaign[] = settings.campaignPool.map((slug) => {
    const ban = st?.bans.find((b) => b.campaign === slug);
    // A tiebreak shares its game's campaign: the series game names the tile.
    const game = games.find((g) => g.campaign === slug && g.tiebreak_of === null) ?? games.find((g) => g.campaign === slug);
    if (ban) return { slug, name: name(slug), state: 'banned', by: ban.side, game: null };
    if (game) return { slug, name: name(slug), state: game.picked_by === null ? 'decider' : 'picked', by: sideOfEntry(game.picked_by), game: game.ordinal };
    return { slug, name: name(slug), state: 'open', by: null, game: null };
  });

  // Lineup secrecy: a locked four is shown to its own roster and staff only,
  // and to everyone once both are locked.
  const locked = R.lineupsOf(db, m.id).filter((l) => l.game === 1);
  const lineupOf = (side: 'a' | 'b') => {
    const id = side === 'a' ? m.entry_a : m.entry_b;
    return id === null ? undefined : locked.find((l) => l.entry_id === id);
  };
  const both = lineupOf('a') !== undefined && lineupOf('b') !== undefined;
  const mySide: 'a' | 'b' | null = viewer === null ? null
    : m.entry_a !== null && rosterSet(db, m.entry_a).has(viewer) ? 'a'
      : m.entry_b !== null && rosterSet(db, m.entry_b).has(viewer) ? 'b' : null;
  const showLineup = (side: 'a' | 'b'): RoomPlayer[] | null => {
    const l = lineupOf(side);
    if (!l || !(both || staff || mySide === side)) return null;
    return (JSON.parse(l.steamids) as string[]).map((s) => player(db, s));
  };

  const manager = mySide !== null && viewer !== null && R.sideOf(db, m, viewer) === mySide;
  const myEntry = mySide === null ? null : R.entryOn(m, mySide);
  // Plan T3b: a live match has its between-game pick and side steps too.
  const next: MatchRoomView['next'] = !st || !((m.status === 'veto' && m.ready_a_at !== null && m.ready_b_at !== null) || m.status === 'live') ? null
    : isHumanStep(st.next) ? { kind: st.next.kind, by: st.next.by, game: 'game' in st.next ? st.next.game : null, step: vetoRows.length }
      : st.next.kind === 'wait' ? { kind: 'wait', game: st.next.game } : null;
  const resolved = P.RESOLVED.has(m.status) && m.status !== 'bye' && m.winner_entry !== null;
  const entry = (id: number | null) => (id === null ? null : entries.get(id) ?? null);

  const seriesRows = R.seriesGames(db, m);
  const verdict = seriesRows.length > 0 ? seriesVerdict(settings.veto, seriesRows) : null;
  const booking = m.booking_id !== null ? B.getBooking(db, m.booking_id) : undefined;
  const canConnect = staff || (viewer !== null && booking !== undefined && B.acceptedPeople(db, booking.id).some((p) => p.steamid === viewer));
  /** A live game's running score from our capture, turned from the game's
   *  match teams to the room's sides by its booking_side_a. */
  const liveScore = (gameMatchId: number): RoomGame['live'] => {
    const live = db.prepare('SELECT current_map FROM match_live WHERE match_id = ?').get(gameMatchId) as { current_map: string | null } | undefined;
    if (!live) return null;
    const row = db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(gameMatchId) as { booking_side_a: 'a' | 'b' | null } | undefined;
    const sideA = row?.booking_side_a ?? 'a';
    const totals = { a: 0, b: 0 };
    for (const r of db.prepare('SELECT surv_team, SUM(score) AS s FROM match_rounds WHERE match_id = ? GROUP BY surv_team').all(gameMatchId) as { surv_team: 'a' | 'b'; s: number }[]) totals[r.surv_team] = r.s;
    return { map: live.current_map, scoreA: sideA === 'a' ? totals.a : totals.b, scoreB: sideA === 'a' ? totals.b : totals.a };
  };
  const roomGames: RoomGame[] = playOrder(seriesRows).map((sg) => {
    const g = games.find((x) => x.id === sg.id)!;
    const state: RoomGame['state'] = g.score_a !== null || g.forfeit_side !== null ? 'done' : g.match_id !== null ? 'live' : 'upcoming';
    return {
      id: g.id, game: gameNumberOf(sg, seriesRows), ordinal: g.ordinal, tiebreak: g.tiebreak_of !== null, campaign: g.campaign, campaignName: name(g.campaign), map: g.map,
      pickedBy: sideOfEntry(g.picked_by), sideBy: sideOfEntry(g.side_by), firstSurvivors: sideOfEntry(g.first_survivors),
      matchId: g.match_id, state, scoreA: g.score_a, scoreB: g.score_b, winner: sideOfEntry(g.winner), forfeit: g.forfeit_side, live: state === 'live' ? liveScore(g.match_id!) : null,
    };
  });
  let server: RoomServer | null = null;
  if (booking) {
    const s = booking.server_id !== null ? getServer(db, booking.server_id) : undefined;
    const running = (booking.state === 'ready' || booking.state === 'active') && booking.ending_at === null;
    const sides = B.sidesOf(db, booking.id);
    server = {
      state: !B.isOpen(booking) ? 'ended' : running ? 'ready' : booking.server_id === null ? 'waiting' : 'setup',
      name: s?.name ?? null, since: booking.created_at,
      connect: running && canConnect && s ? { host: s.host, port: s.port, password: booking.password } : null,
      present: running ? { a: sides.find((x) => x.side === 'a')?.present_now ?? 0, b: sides.find((x) => x.side === 'b')?.present_now ?? 0 } : null,
      graceEndsAt: m.status === 'connect' ? m.deadline : null,
    };
  }
  return {
    id: m.id, eventSlug: ev.slug, eventName: ev.name, roundLabel: matchLabel(db, ev, m), a: entry(m.entry_a), b: entry(m.entry_b), phase: phaseOf(m),
    higher: m.room_higher, deadline: m.deadline, serverNow: now.toISOString(), ready: { a: m.ready_a_at !== null, b: m.ready_b_at !== null },
    vetoSummary: vetoSummary(settings.veto, settings.campaignPool.length), pool,
    log: vetoRows.map((r) => ({
      step: r.step, side: r.side, action: r.action, campaign: r.campaign, campaignName: r.campaign === null ? null : name(r.campaign), auto: r.auto === 1, at: r.at,
    })),
    games: roomGames,
    next,
    lineups: { a: showLineup('a'), b: showLineup('b'), aLocked: lineupOf('a') !== undefined, bLocked: lineupOf('b') !== undefined },
    holdReason: m.status === 'admin_hold' ? m.hold_reason : null,
    result: resolved ? { winner: m.winner_entry === m.entry_a ? 'a' : 'b', scoreA: m.score_a, scoreB: m.score_b, forfeit: m.status === 'forfeit' } : null,
    me: mySide === null ? null : {
      side: mySide, manager,
      playable: manager && myEntry !== null ? R.playableOf(db, myEntry).map((s) => player(db, s)) : [],
      defaultFour: manager && myEntry !== null ? R.entryPrefs(db, myEntry).defaultFour : null,
    },
    series: verdict ? {
      bestOf: verdict.bestOf, totalScore: verdict.totalScore, winsA: verdict.winsA, winsB: verdict.winsB, totalA: verdict.totalA, totalB: verdict.totalB,
      over: verdict.over, winner: verdict.winner,
    } : null,
    server,
    confirm: m.status === 'confirming' ? { deadline: m.deadline, a: m.confirm_a_at !== null, b: m.confirm_b_at !== null } : null,
    dispute: m.dispute_side !== null ? { side: m.dispute_side, byName: getPlayer(db, m.dispute_by ?? '')?.name ?? 'a captain', reason: m.dispute_reason ?? '', at: m.disputed_at ?? '' } : null,
  };
}

export function prefsView(db: DB, ev: E.EventRow, entryId: number): PrefsView {
  const p = R.entryPrefs(db, entryId);
  return {
    entryId, defaultFour: p.defaultFour, side: p.side, roster: R.playableOf(db, entryId).map((s) => player(db, s)),
    stages: E.stagesOf(db, ev.id).map((s) => ({
      stageId: s.id, ordinal: s.ordinal,
      pool: E.stageSettingsOf(s).campaignPool.map((slug) => ({ slug, name: campaignDisplayName(db, slug) })),
      order: R.campaignPrefs(db, entryId, s.id),
    })),
  };
}
