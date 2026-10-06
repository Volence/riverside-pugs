import type { DB } from '../db.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import { stageTable } from './flow.js';
import { groupLabel, roundLabel } from './format.js';
import { weekDates, weekOfRound } from './league.js';
import type * as V from './validate.js';

/** Brackets, standings and rounds of the stages that have started (plan T2),
 *  for the public event page and the desk alike. Never SR. */

export interface PlayEntry { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; out: boolean }
export interface PlayMatch {
  id: number; group: number; round: number; slot: number; a: PlayEntry | null; b: PlayEntry | null; status: string;
  winner: 'a' | 'b' | null; scoreA: number | null; scoreB: number | null; forfeit: boolean; bye: boolean;
}
/** dates: a league round's week, first and last day (YYYY-MM-DD); null for
 *  every other stage type. */
export interface PlayRound { group: number; round: number; label: string; dates: { from: string; to: string } | null; matches: PlayMatch[] }
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

export function stagePlayViews(db: DB, ev: E.EventRow): StagePlayView[] {
  const entries = new Map(N.entriesOf(db, ev.id).map((e): [number, PlayEntry] => [e.id, {
    id: e.id, name: e.name, tag: e.tag, logoKey: e.logo_key, seed: e.seed, out: e.status === 'dropped' || e.status === 'disqualified',
  }]));
  const entry = (id: number | null) => (id === null ? null : entries.get(id) ?? null);
  return E.stagesOf(db, ev.id).filter((s) => s.status !== 'pending').map((s) => {
    const st = E.stageSettingsOf(s);
    const elim = st.type === 'single_elim' || st.type === 'double_elim';
    const ms = P.matchesOf(db, s.id);
    // A double elimination of 2 is played as a single final (bracket.ts createBracket).
    const labelType: V.StageType = st.type === 'double_elim' && ms.every((m) => m.grp === 1) ? 'single_elim' : st.type;
    // Ruling 19: week 1 starts on the season start, or the day the stage started.
    const league = st.type === 'league' ? st.config as V.StageConfigs['league'] : null;
    const seasonStart = league ? league.seasonStart ?? (s.started_at ?? ev.starts_at).slice(0, 10) : null;
    const leagueDates = (round: number) => (league && seasonStart ? weekDates(seasonStart, weekOfRound(round, league.matchesPerWeek)) : null);
    const last = new Map<number, number>();
    for (const m of ms) last.set(m.grp, Math.max(last.get(m.grp) ?? 0, m.round));
    const rounds: PlayRound[] = [];
    for (const m of ms) {
      let r = rounds.find((x) => x.group === m.grp && x.round === m.round);
      if (!r) {
        r = { group: m.grp, round: m.round, label: roundLabel(labelType, st.config, m.grp, m.round, last.get(m.grp)!), dates: leagueDates(m.round), matches: [] };
        rounds.push(r);
      }
      const resolved = P.RESOLVED.has(m.status);
      r.matches.push({
        id: m.id, group: m.grp, round: m.round, slot: m.slot, a: entry(m.entry_a), b: entry(m.entry_b), status: m.status,
        winner: !resolved || m.winner_entry === null ? null : m.winner_entry === m.entry_a ? 'a' : 'b',
        scoreA: m.score_a, scoreB: m.score_b, forfeit: m.status === 'forfeit', bye: m.status === 'bye',
      });
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
