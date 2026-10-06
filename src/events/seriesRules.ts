import type { VetoConfig } from './vetoConfig.js';
import { other, type Side } from './veto.js';
import type { ResultInput } from './validate.js';

/**
 * The arithmetic of a series (tournaments plan T3b Ruling 5), pure over the
 * rows of event_games. Bo1, Bo3 and Bo5 are games won; Bo2 is total score
 * across both games. A tied game is replayed as a tiebreak game (a row with
 * tiebreak_of = the tied series game, ordinal 10 * game + k); the last
 * tiebreak played stands for its game, and a tiebreak that ties again asks
 * for another. Sides a and b are the event match's entry_a and entry_b.
 */

export interface SeriesGame {
  id: number; ordinal: number; tiebreakOf: number | null; scoreA: number | null; scoreB: number | null; winner: Side | null;
  /** A matches row exists for it (it was pushed to the box). */
  started: boolean;
}
export interface SeriesVerdict {
  bestOf: number; totalScore: boolean;
  /** The winner of each series game in order (a tiebreak standing in for its game), up to the first undecided: the veto engine's winners. */
  decided: Side[];
  winsA: number; winsB: number; totalA: number; totalB: number;
  over: boolean; winner: Side | null;
  /** The series game whose tie needs a tiebreak now, or null. */
  tiebreakOf: SeriesGame | null;
  /** The next series game to play (1-based) when none is pending and the series is not over. */
  nextGame: number | null;
}

const played = (g: SeriesGame): boolean => g.scoreA !== null && g.scoreB !== null;
const isSeriesGame = (g: SeriesGame): boolean => g.tiebreakOf === null;

export function gameNumberOf(g: SeriesGame, games: SeriesGame[]): number {
  return g.tiebreakOf === null ? g.ordinal : games.find((x) => x.id === g.tiebreakOf)?.ordinal ?? g.ordinal;
}

/** Series games keep 1..5; a game's tiebreaks are 10 * game + 1, + 2, ...
 *  (at most ten per game before the next game's range starts; room.ts
 *  addTiebreak refuses an ordinal already taken). */
export function tiebreakOrdinal(parent: Pick<SeriesGame, 'id' | 'ordinal'>, games: SeriesGame[]): number {
  return parent.ordinal * 10 + games.filter((g) => g.tiebreakOf === parent.id).length + 1;
}

/** Game 1, its tiebreaks, game 2, its tiebreaks, ... */
export function playOrder(games: SeriesGame[]): SeriesGame[] {
  return [...games].sort((x, y) => gameNumberOf(x, games) - gameNumberOf(y, games) || x.ordinal - y.ordinal);
}

/** Ruling 5: the team that was survivors second on the replayed chapter starts as survivors. */
export const tiebreakFirstSurvivors = (half1Survivors: Side): Side => other(half1Survivors);

/** The last played tiebreak of a series game, or undefined. */
function lastTiebreak(g: SeriesGame, games: SeriesGame[]): SeriesGame | undefined {
  return games.filter((x) => x.tiebreakOf === g.id && played(x)).sort((x, y) => x.ordinal - y.ordinal).at(-1);
}

/** The result that stands for a series game: its last played tiebreak's, else its own; null until played. */
function standing(g: SeriesGame, games: SeriesGame[]): { winner: Side | null } | null {
  const last = lastTiebreak(g, games) ?? (played(g) ? g : null);
  return last ? { winner: last.winner } : null;
}

export function seriesVerdict(config: VetoConfig, games: SeriesGame[]): SeriesVerdict {
  const bestOf = config.games;
  const totalScore = bestOf === 2;
  const series = games.filter(isSeriesGame).sort((x, y) => x.ordinal - y.ordinal);
  let totalA = 0;
  let totalB = 0;
  for (const g of games) if (played(g)) { totalA += g.scoreA!; totalB += g.scoreB!; }
  const base = { bestOf, totalScore, decided: [] as Side[], winsA: 0, winsB: 0, totalA, totalB, over: false, winner: null as Side | null, tiebreakOf: null as SeriesGame | null, nextGame: null as number | null };

  if (totalScore) {
    const done = series.filter(played).length;
    if (done < 2) return { ...base, nextGame: done + 1 };
    const a = series.reduce((n, g) => n + g.scoreA!, 0);
    const b = series.reduce((n, g) => n + g.scoreB!, 0);
    let winner: Side | null = a > b ? 'a' : b > a ? 'b' : null;
    const last = series[1]!;
    // Tied totals: only a tiebreak of game 2 can break them (game 2's own
    // result is already inside the totals, so it must not stand in here).
    if (winner === null) winner = lastTiebreak(last, games)?.winner ?? null;
    if (winner === null) return { ...base, tiebreakOf: last };
    return { ...base, over: true, winner };
  }

  const decided: Side[] = [];
  let winsA = 0;
  let winsB = 0;
  let tiebreakOf: SeriesGame | null = null;
  for (const g of series) {
    const s = standing(g, games);
    if (!s) break;
    if (s.winner === null) { tiebreakOf = g; break; }
    decided.push(s.winner);
    if (s.winner === 'a') winsA++; else winsB++;
    if (winsA > bestOf / 2 || winsB > bestOf / 2) break;
  }
  const winner: Side | null = winsA > bestOf / 2 ? 'a' : winsB > bestOf / 2 ? 'b' : null;
  const over = winner !== null;
  const nextGame = over || tiebreakOf !== null || decided.length >= bestOf ? null : decided.length + 1;
  return { ...base, decided, winsA, winsB, over, winner, tiebreakOf, nextGame };
}

/** The event result for a finished series (play.ts recordResult input), or null while it runs. */
export function seriesResult(v: SeriesVerdict): ResultInput | null {
  if (!v.over || v.winner === null) return null;
  return v.totalScore
    ? { winner: v.winner, scoreA: v.totalA, scoreB: v.totalB, forfeit: false }
    : { winner: v.winner, scoreA: v.winsA, scoreB: v.winsB, forfeit: false };
}
