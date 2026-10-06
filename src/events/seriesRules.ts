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
 *
 * A game's winner is never stored; it is derived here, so it can never
 * disagree with its scores. A row only ever carries `forfeit`, the side
 * that typed !gg: forfeit set means the other side won that game, no
 * scores needed; otherwise two unequal scores decide it; otherwise (tied or
 * unplayed) it has no winner yet. In a games-won series (Bo1/Bo3/Bo5) a
 * forfeited game is simply a loss for the forfeiting side, counted like any
 * other game. In a total-score series (Bo2) a forfeit instead ends the
 * whole series at once, for the other side, recorded with no scores.
 */

export interface SeriesGame {
  id: number; ordinal: number; tiebreakOf: number | null; scoreA: number | null; scoreB: number | null;
  /** The side that typed !gg on this game, or null. */
  forfeit: Side | null;
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
  /** The side whose !gg ended a Bo2 series at once, or null (including when
   *  a forfeit merely lost one game of a games-won series: there it is just
   *  a counted loss, not a series-ending forfeit). */
  forfeit: Side | null;
}

/** A row counts as played once it has two scores or a forfeit; a forfeit
 *  carries no scores. */
const played = (g: SeriesGame): boolean => g.forfeit !== null || (g.scoreA !== null && g.scoreB !== null);
const scored = (g: SeriesGame): boolean => g.scoreA !== null && g.scoreB !== null;
const isSeriesGame = (g: SeriesGame): boolean => g.tiebreakOf === null;

/** The winner of one row, derived from its forfeit or its scores; null
 *  while tied or unplayed. room.ts recordGame writes event_games.winner
 *  (a convenience for views) from this, so the two never disagree. */
export function winnerOf(g: SeriesGame): Side | null {
  if (g.forfeit !== null) return other(g.forfeit);
  if (g.scoreA !== null && g.scoreB !== null && g.scoreA !== g.scoreB) return g.scoreA > g.scoreB ? 'a' : 'b';
  return null;
}

export function gameNumberOf(g: SeriesGame, games: SeriesGame[]): number {
  return g.tiebreakOf === null ? g.ordinal : games.find((x) => x.id === g.tiebreakOf)?.ordinal ?? g.ordinal;
}

/** Series games keep 1..5; a game's tiebreaks are 10 * game + 1, + 2, ...
 *  up to 10 * game + 9 (room.ts addTiebreak refuses an ordinal already
 *  taken); null once that game has used all ten slots. */
export function tiebreakOrdinal(parent: Pick<SeriesGame, 'id' | 'ordinal'>, games: SeriesGame[]): number | null {
  const existing = games.filter((g) => g.tiebreakOf === parent.id).map((g) => g.ordinal);
  const next = existing.length === 0 ? parent.ordinal * 10 + 1 : Math.max(...existing) + 1;
  return next > parent.ordinal * 10 + 9 ? null : next;
}

/** "2 games to 1", "1 game to 0": the winner's games counted, singular when one. */
export function winsLine(won: number, lost: number): string {
  return `${won} ${won === 1 ? 'game' : 'games'} to ${lost}`;
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
  return last ? { winner: winnerOf(last) } : null;
}

export function seriesVerdict(config: VetoConfig, games: SeriesGame[]): SeriesVerdict {
  const bestOf = config.games;
  const totalScore = bestOf === 2;
  const series = games.filter(isSeriesGame).sort((x, y) => x.ordinal - y.ordinal);
  let totalA = 0;
  let totalB = 0;
  for (const g of games) if (scored(g)) { totalA += g.scoreA!; totalB += g.scoreB!; }
  const base = {
    bestOf, totalScore, decided: [] as Side[], winsA: 0, winsB: 0, totalA, totalB, over: false,
    winner: null as Side | null, tiebreakOf: null as SeriesGame | null, nextGame: null as number | null, forfeit: null as Side | null,
  };

  if (totalScore) {
    // A !gg on either game (or a tiebreak) ends a total-score series at
    // once, for the other side, before totals even come into it.
    // The first in play order (game 1, its tiebreaks, game 2), whatever order the rows came in.
    const forfeited = playOrder(games).find((g) => g.forfeit !== null);
    if (forfeited) return { ...base, over: true, winner: other(forfeited.forfeit!), forfeit: forfeited.forfeit };
    const done = series.filter(played).length;
    if (done < 2) return { ...base, nextGame: done + 1 };
    const a = series.reduce((n, g) => n + g.scoreA!, 0);
    const b = series.reduce((n, g) => n + g.scoreB!, 0);
    let winner: Side | null = a > b ? 'a' : b > a ? 'b' : null;
    const last = series[1]!;
    // Tied totals: only a tiebreak of game 2 can break them (game 2's own
    // result is already inside the totals, so it must not stand in here).
    if (winner === null) {
      const tb = lastTiebreak(last, games);
      winner = tb ? winnerOf(tb) : null;
    }
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
  if (v.forfeit !== null) return { winner: v.winner, scoreA: null, scoreB: null, forfeit: true };
  return v.totalScore
    ? { winner: v.winner, scoreA: v.totalA, scoreB: v.totalB, forfeit: false }
    : { winner: v.winner, scoreA: v.winsA, scoreB: v.winsB, forfeit: false };
}
