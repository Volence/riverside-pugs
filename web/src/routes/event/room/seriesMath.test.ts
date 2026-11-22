import { describe, it, expect } from 'vitest';
import type { RoomGame, RoomSeries } from '../../../api';
import { seriesMath, seriesNeedsText } from './seriesMath';

const game = (n: number, state: RoomGame['state'], a: number | null, b: number | null, live: RoomGame['live'] = null, over: Partial<RoomGame> = {}): RoomGame => ({
  id: n, game: n, ordinal: n, tiebreak: false, campaign: 'no_mercy', campaignName: n === 1 ? 'No Mercy' : 'Dead Air', map: null,
  pickedBy: 'a', sideBy: 'b', firstSurvivors: 'b', matchId: 10 + n, state, scoreA: a, scoreB: b, winner: null, forfeit: null, live, ...over,
});
const bo2 = (over: Partial<RoomSeries> = {}): RoomSeries => ({ bestOf: 2, totalScore: true, winsA: 0, winsB: 0, totalA: 0, totalB: 0, over: false, winner: null, ...over });
const name = (s: 'a' | 'b') => (s === 'a' ? 'Rats' : 'Bats');

describe('seriesMath', () => {
  it('is null with no series row', () => {
    expect(seriesMath({ series: null, games: [] })).toBeNull();
  });

  it('total score, team B ahead: adds the live game and says what team A must outscore them by', () => {
    // The DT2 case the room header was fixed for (EventMatch.test.tsx).
    const m = seriesMath({
      series: bo2({ winsB: 1, totalA: 2211, totalB: 2480 }),
      games: [game(1, 'done', 2211, 2480, null, { winner: 'b' }), game(2, 'live', null, null, { map: 'mc5m3_cemetery', scoreA: 930, scoreB: 148 })],
    })!;
    expect(m).toMatchObject({ a: 3141, b: 2628, liveIncluded: true, leader: 'a', gap: 513, needs: { side: 'b', tie: 513, lead: 514 }, toWin: null });
    expect(m.games).toEqual([
      expect.objectContaining({ title: 'Game 1', a: 2211, b: 2480, state: 'done', winner: 'b', map: null }),
      expect.objectContaining({ title: 'Game 2', a: 930, b: 148, state: 'live', winner: null, map: 'mc5m3_cemetery' }),
    ]);
    expect(seriesNeedsText(m, name)).toBe('Bats must outscore Rats by 513 to tie, 514 to lead');
  });

  it('total score, the other way round: team A trails after game 1 with game 2 not started', () => {
    const m = seriesMath({ series: bo2({ winsB: 1, totalA: 534, totalB: 2816 }), games: [game(1, 'done', 534, 2816), game(2, 'upcoming', null, null)] })!;
    expect(m).toMatchObject({ a: 534, b: 2816, liveIncluded: false, leader: 'b', gap: 2282, needs: { side: 'a', tie: 2282, lead: 2283 } });
    expect(m.games[1]).toMatchObject({ state: 'upcoming', a: null, b: null });
    expect(seriesNeedsText(m, name)).toBe('Rats must outscore Bats by 2282 to tie, 2283 to lead');
  });

  it('total score level, and over: no needs, the live game no longer added', () => {
    const level = seriesMath({ series: bo2({ totalA: 600, totalB: 400 }), games: [game(1, 'done', 600, 400), game(2, 'live', null, null, { map: null, scoreA: 0, scoreB: 200 })] })!;
    expect(level).toMatchObject({ a: 600, b: 600, leader: null, gap: 0, needs: null });
    expect(seriesNeedsText(level, name)).toBe('Level on 600');
    const done = seriesMath({
      series: bo2({ totalA: 1200, totalB: 900, over: true, winner: 'a' }),
      games: [game(1, 'done', 600, 400), game(2, 'live', null, null, { map: null, scoreA: 9, scoreB: 9 })],
    })!;
    expect(done).toMatchObject({ a: 1200, b: 900, liveIncluded: false, needs: null });
    expect(seriesNeedsText(done, name)).toBe('Rats win the series');
  });

  it('a !gg loses the game whatever its score', () => {
    const m = seriesMath({ series: bo2({ totalA: 900, totalB: 100, over: true, winner: 'b' }), games: [game(1, 'done', 900, 100, null, { forfeit: 'a', winner: 'a' })] })!;
    expect(m.games[0]).toMatchObject({ winner: 'b', forfeit: 'a' });
  });

  it('best of three: games won, and games each side still needs', () => {
    const m = seriesMath({
      series: { bestOf: 3, totalScore: false, winsA: 1, winsB: 0, totalA: 700, totalB: 500, over: false, winner: null },
      games: [game(1, 'done', 700, 500, null, { winner: 'a' }), game(2, 'live', null, null, { map: null, scoreA: 100, scoreB: 300 })],
    })!;
    // A live game never counts toward games won.
    expect(m).toMatchObject({ a: 1, b: 0, liveIncluded: false, leader: 'a', needs: null, toWin: { a: 1, b: 2 } });
    expect(seriesNeedsText(m, name)).toBe('First to 2: Rats 1 win away, Bats 2 wins away');
  });
});
