import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { getServer } from '../serverPool.js';
import * as B from '../bookings/bookings.js';
import { replayableChapters } from '../bookings/restore.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import { stageTable } from './flow.js';
import { groupLabel, roundLabel } from './format.js';
import { weekDates, weekOfRound } from './league.js';
import { openProposal, proposalsOf } from './schedule.js';
import { deskPauses, type DeskPause } from './pauseViews.js';
import type * as V from './validate.js';

/** Brackets, standings and rounds of the stages that have started (plan T2),
 *  for the public event page and the desk alike. Never SR. */

/** Where a match's room stands (plan T3a). Lives here rather than in
 *  roomViews.ts, which imports this file; roomViews.ts re-exports it. */
export type RoomPhase = 'pending' | 'waiting' | 'ready' | 'veto' | 'lineup' | 'server' | 'connect' | 'live' | 'confirming' | 'hold' | 'done';

export function phaseOf(m: Pick<P.MatchRow, 'status' | 'ready_a_at' | 'ready_b_at'>): RoomPhase {
  switch (m.status) {
    case 'pending': return 'pending';
    case 'waiting': return 'waiting';
    case 'veto': return m.ready_a_at !== null && m.ready_b_at !== null ? 'veto' : 'ready';
    case 'lineup': return 'lineup';
    case 'booking': return 'server';
    case 'connect': return 'connect';
    case 'live': return 'live';
    case 'confirming': return 'confirming';
    case 'admin_hold': return 'hold';
    default: return 'done';
  }
}

export interface PlayEntry { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; out: boolean }
export interface PlayMatch {
  id: number; group: number; round: number; slot: number; a: PlayEntry | null; b: PlayEntry | null; status: string;
  winner: 'a' | 'b' | null; scoreA: number | null; scoreB: number | null; forfeit: boolean; bye: boolean; phase: RoomPhase;
  /** Plan T4: the match's time (UTC ISO) and where it came from; null with no time. */
  scheduledAt: string | null; scheduleSource: 'default' | 'agreed' | 'staff' | null;
  /** Staff only (plan T3c Ruling 16): filled by stagePlayViews with staff: true. */
  desk?: PlayMatchDesk;
}
/** What only the Events desk sees of a match (plan T3c Ruling 16). */
export interface PlayMatchDesk {
  holdReason: string | null; holdFrom: string | null;
  dispute: { side: 'a' | 'b'; byName: string; reason: string; at: string } | null;
  frozen: boolean; graceEndsAt: string | null;
  booking: { id: number; state: string; serverName: string | null; recovering: boolean } | null;
  liveGame: { matchId: number; campaign: string; chapters: { ordinal: number; map: string }[] } | null;
  subs: { a: number; b: number };
  /** Plan T4: a window stage's match only. */
  schedule: { windowStart: string | null; windowEnd: string | null; proposal: { side: 'a' | 'b'; byName: string; time: string; autoAcceptAt: string | null } | null; proposals: number } | null;
  /** Plan T5: the technical pauses with names, and whether each one's game is being played. */
  pauses: DeskPause[];
}
/** dates: a league round's week, first and last day (YYYY-MM-DD); null for
 *  every other stage type. defaultAt: a window round's default time or a
 *  rolling round's date (plan T4 Rulings 2 and 3); window: the round's
 *  window on a window stage. */
export interface PlayRound {
  group: number; round: number; label: string; dates: { from: string; to: string } | null;
  defaultAt: string | null; window: { from: string; to: string } | null; matches: PlayMatch[];
}
export interface PlayStanding {
  entry: PlayEntry; group: number; rank: number; groupRank: number; played: number; wins: number; losses: number;
  points: number; buchholz: number; scoreDiff: number;
}
export interface StagePlayView {
  ordinal: number; type: V.StageType; status: 'live' | 'finished'; layout: 'bracket' | 'table';
  groups: { number: number; label: string }[]; rounds: PlayRound[]; standings: PlayStanding[]; advanceCount: number | null;
  /** Swiss, or a league paired Swiss: a later round's existence locks a
   *  table match's result (play.ts recordResult). */
  pairsAsItGoes: boolean;
}

/** Every entry of the event as a bracket shows it, by entry id. */
export function playEntriesOf(db: DB, ev: E.EventRow): Map<number, PlayEntry> {
  return new Map(N.entriesOf(db, ev.id).map((e): [number, PlayEntry] => [e.id, {
    id: e.id, name: e.name, tag: e.tag, logoKey: e.logo_key, seed: e.seed, out: e.status === 'dropped' || e.status === 'disqualified',
  }]));
}

/** A stage's round labels and league dates, from its matches. */
function stageLabels(ev: E.EventRow, s: E.StageRow, ms: P.MatchRow[]) {
  const st = E.stageSettingsOf(s);
  // A double elimination of 2 is played as a single final (bracket.ts createBracket).
  const labelType: V.StageType = st.type === 'double_elim' && ms.every((m) => m.grp === 1) ? 'single_elim' : st.type;
  // Ruling 19: week 1 starts on the season start, or the day the stage started.
  const league = st.type === 'league' ? st.config as V.StageConfigs['league'] : null;
  const seasonStart = league ? league.seasonStart ?? (s.started_at ?? ev.starts_at).slice(0, 10) : null;
  const last = new Map<number, number>();
  for (const m of ms) last.set(m.grp, Math.max(last.get(m.grp) ?? 0, m.round));
  return {
    labelType,
    label: (grp: number, round: number) => roundLabel(labelType, st.config, grp, round, last.get(grp)!),
    dates: (round: number) => (league && seasonStart ? weekDates(seasonStart, weekOfRound(round, league.matchesPerWeek)) : null),
    times: (round: number) => {
      const t = P.roundTimes(s, round, s.started_at ?? ev.starts_at);
      return { defaultAt: t.at, window: t.from !== null && t.to !== null ? { from: t.from, to: t.to } : null };
    },
  };
}

/** One match's round label, exactly as its stage's bracket shows it. */
export function matchLabel(db: DB, ev: E.EventRow, m: P.MatchRow): string {
  return stageLabels(ev, E.getStage(db, m.stage_id)!, P.matchesOf(db, m.stage_id)).label(m.grp, m.round);
}

function deskOf(db: DB, m: P.MatchRow): PlayMatchDesk {
  const booking = m.booking_id !== null ? B.getBooking(db, m.booking_id) : undefined;
  const server = booking && booking.server_id !== null ? getServer(db, booking.server_id) : undefined;
  const live = m.status === 'live' ? R.gamesOf(db, m.id).find((g) => g.match_id !== null && g.ended_at === null
    && !!db.prepare("SELECT 1 FROM matches WHERE id = ? AND state = 'live'").get(g.match_id)) : undefined;
  return {
    holdReason: m.status === 'admin_hold' ? m.hold_reason : null, holdFrom: m.status === 'admin_hold' ? m.hold_from : null,
    dispute: m.dispute_side !== null ? { side: m.dispute_side, byName: getPlayer(db, m.dispute_by ?? '')?.name ?? 'a captain', reason: m.dispute_reason ?? '', at: m.disputed_at ?? '' } : null,
    frozen: m.admin_pause_at !== null,
    graceEndsAt: m.status === 'connect' ? m.deadline : null,
    booking: booking ? { id: booking.id, state: B.isOpen(booking) ? booking.state : 'ended', serverName: server?.name ?? null, recovering: booking.recovering_at !== null } : null,
    liveGame: live ? { matchId: live.match_id!, campaign: live.campaign, chapters: replayableChapters(db, live.match_id!) } : null,
    subs: { a: R.subsUsed(db, m, 'a'), b: R.subsUsed(db, m, 'b') },
    schedule: E.getStage(db, m.stage_id)!.scheduling !== 'window' ? null : (() => {
      const p = openProposal(db, m.id);
      return {
        windowStart: m.window_start, windowEnd: m.window_end,
        proposal: p ? { side: p.side, byName: getPlayer(db, p.proposed_by)?.name ?? 'a captain', time: p.proposed_time, autoAcceptAt: p.auto_accept_at } : null,
        proposals: proposalsOf(db, m.id).length,
      };
    })(),
    pauses: deskPauses(db, m, live ? live.match_id! : null),
  };
}

/** opts.staff (plan T3c Ruling 16): each match also carries its desk block. */
export function stagePlayViews(db: DB, ev: E.EventRow, opts: { staff?: boolean } = {}): StagePlayView[] {
  const entries = playEntriesOf(db, ev);
  const entry = (id: number | null) => (id === null ? null : entries.get(id) ?? null);
  return E.stagesOf(db, ev.id).filter((s) => s.status !== 'pending').map((s) => {
    const st = E.stageSettingsOf(s);
    const elim = st.type === 'single_elim' || st.type === 'double_elim';
    const ms = P.matchesOf(db, s.id);
    const { labelType, label, dates, times } = stageLabels(ev, s, ms);
    const rounds: PlayRound[] = [];
    for (const m of ms) {
      let r = rounds.find((x) => x.group === m.grp && x.round === m.round);
      if (!r) {
        r = { group: m.grp, round: m.round, label: label(m.grp, m.round), dates: dates(m.round), ...times(m.round), matches: [] };
        rounds.push(r);
      }
      const resolved = P.RESOLVED.has(m.status);
      const row: PlayMatch = {
        id: m.id, group: m.grp, round: m.round, slot: m.slot, a: entry(m.entry_a), b: entry(m.entry_b), status: m.status,
        winner: !resolved || m.winner_entry === null ? null : m.winner_entry === m.entry_a ? 'a' : 'b',
        scoreA: m.score_a, scoreB: m.score_b, forfeit: m.status === 'forfeit', bye: m.status === 'bye', phase: phaseOf(m),
        scheduledAt: m.scheduled_at, scheduleSource: m.schedule_source,
      };
      if (opts.staff) row.desk = deskOf(db, m);
      r.matches.push(row);
    }
    const groups = [...new Set(ms.map((m) => m.grp))].sort((x, y) => x - y).map((n) => ({ number: n, label: groupLabel(labelType, n) }));
    const standings = elim ? [] : stageTable(db, s).map((t): PlayStanding => ({
      entry: entry(t.entryId)!, group: t.group, rank: t.rank, groupRank: t.groupRank, played: t.played, wins: t.wins, losses: t.losses,
      points: t.points, buchholz: t.buchholz, scoreDiff: t.scoreDiff,
    }));
    return {
      ordinal: s.ordinal, type: st.type, status: s.status as 'live' | 'finished', layout: elim ? 'bracket' : 'table',
      groups, rounds, standings, advanceCount: st.advanceCount, pairsAsItGoes: P.totalRounds(s) !== null,
    };
  });
}
