import type { MatchRoomView, RoomGame } from '../../../api';
import { gameTitle } from './roomText';

/**
 * The series math of a match room, as one pure function the room header
 * (MatchHero) and the caster tools (desk, studio, room scene) all read, so
 * the numbers on air are the numbers on the match page.
 *
 * Total-score series (the Bo2, owner 2026-11-22): the total is the recorded
 * games plus the live game's running score while the series is still being
 * played; the gap is what the trailing team must outscore the leader by over
 * what is left, to tie (gap) or to lead (gap + 1). Players were working this
 * out by hand in chat on DT2 night ("Need 1196 to tie").
 *
 * Best of N: the total is games won, and each side's games still needed.
 */

type Side = 'a' | 'b';

export interface SeriesGameLine {
  id: number;
  /** "Game 1", or "Tiebreak of game 2". */
  title: string;
  campaignName: string;
  state: RoomGame['state'];
  /** The recorded score once done, the running score while live, else null. */
  a: number | null;
  b: number | null;
  /** The live map while the game is being played. */
  map: string | null;
  /** Who won the game (a !gg loses it whatever the score); null until done. */
  winner: Side | null;
  forfeit: Side | null;
}

export interface SeriesMath {
  totalScore: boolean;
  bestOf: number;
  over: boolean;
  winner: Side | null;
  games: SeriesGameLine[];
  /** Total score so far (live game included) or games won. */
  a: number;
  b: number;
  /** A live game's running score is inside a and b. */
  liveIncluded: boolean;
  leader: Side | null;
  /** |a - b|. */
  gap: number;
  /** Total score, not over, not level: the trailing side, and what it must
   *  outscore the leader by over what is left to tie and to lead. */
  needs: { side: Side; tie: number; lead: number } | null;
  /** Best of N, not over: games each side still needs to win the series. */
  toWin: { a: number; b: number } | null;
}

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

function line(g: RoomGame): SeriesGameLine {
  const live = g.state === 'live' && g.live ? g.live : null;
  return {
    id: g.id, title: gameTitle(g), campaignName: g.campaignName, state: g.state,
    a: live ? live.scoreA : g.state === 'done' ? g.scoreA : null,
    b: live ? live.scoreB : g.state === 'done' ? g.scoreB : null,
    map: live ? live.map : null,
    winner: g.state === 'done' ? (g.forfeit ? other(g.forfeit) : g.winner) : null,
    forfeit: g.forfeit,
  };
}

/** Null for a match with no series row (a forfeit before any game). */
export function seriesMath(v: Pick<MatchRoomView, 'series' | 'games'>): SeriesMath | null {
  const s = v.series;
  if (!s) return null;
  // The series row adds a game only once it is recorded; a total-score
  // series still being played adds the live game's running score too.
  const live = s.totalScore && !s.over ? v.games.filter((g) => g.state === 'live' && g.live) : [];
  const running = (side: Side) => live.reduce((n, g) => n + (side === 'a' ? g.live!.scoreA : g.live!.scoreB), 0);
  const a = s.totalScore ? s.totalA + running('a') : s.winsA;
  const b = s.totalScore ? s.totalB + running('b') : s.winsB;
  const leader: Side | null = a > b ? 'a' : b > a ? 'b' : null;
  const gap = Math.abs(a - b);
  const needs = s.totalScore && !s.over && leader !== null ? { side: other(leader), tie: gap, lead: gap + 1 } : null;
  const clinch = Math.floor(s.bestOf / 2) + 1;
  const toWin = !s.totalScore && !s.over ? { a: Math.max(0, clinch - s.winsA), b: Math.max(0, clinch - s.winsB) } : null;
  return {
    totalScore: s.totalScore, bestOf: s.bestOf, over: s.over, winner: s.winner,
    games: v.games.map(line), a, b, liveIncluded: live.length > 0, leader, gap, needs, toWin,
  };
}

/** The one-line read of the math for casters, by team name. */
export function seriesNeedsText(m: SeriesMath, name: (s: Side) => string): string {
  if (m.over) return m.winner ? `${name(m.winner)} win the series` : 'Series over';
  if (m.totalScore) {
    if (!m.needs) return m.a === 0 && m.b === 0 ? 'Level' : `Level on ${m.a}`;
    const lead = m.leader!;
    return `${name(m.needs.side)} must outscore ${name(lead)} by ${m.needs.tie} to tie, ${m.needs.lead} to lead`;
  }
  const t = m.toWin!;
  const one = (s: Side) => `${name(s)} ${t[s]} ${t[s] === 1 ? 'win' : 'wins'} away`;
  return `First to ${Math.floor(m.bestOf / 2) + 1}: ${one('a')}, ${one('b')}`;
}
