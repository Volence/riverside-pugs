import { describe, it, expect } from 'vitest';
import { gameNumberOf, playOrder, seriesResult, seriesVerdict, tiebreakFirstSurvivors, tiebreakOrdinal, type SeriesGame } from '../src/events/seriesRules.js';
import { presetConfig, type VetoConfig } from '../src/events/vetoConfig.js';

let nextId = 1;
const game = (ordinal: number, o: Partial<SeriesGame> = {}): SeriesGame =>
  ({ id: nextId++, ordinal, tiebreakOf: null, scoreA: null, scoreB: null, winner: null, started: false, ...o });
const played = (ordinal: number, a: number, b: number, o: Partial<SeriesGame> = {}): SeriesGame =>
  game(ordinal, { scoreA: a, scoreB: b, winner: a > b ? 'a' : b > a ? 'b' : null, started: true, ...o });
const bo3: VetoConfig = presetConfig('loser_picks', 7);
const bo2: VetoConfig = presetConfig('home_away', 4);
const bo1: VetoConfig = presetConfig('ban_to_one', 7);

describe('seriesVerdict for games won (Bo1, Bo3, Bo5)', () => {
  it('counts wins, names the next game, and ends once a team has more than half', () => {
    expect(seriesVerdict(bo3, [game(1)])).toMatchObject({ bestOf: 3, totalScore: false, decided: [], winsA: 0, winsB: 0, over: false, winner: null, tiebreakOf: null, nextGame: 1 });
    const one = [played(1, 900, 400)];
    expect(seriesVerdict(bo3, one)).toMatchObject({ decided: ['a'], winsA: 1, winsB: 0, over: false, nextGame: 2 });
    const two = [...one, played(2, 300, 800)];
    expect(seriesVerdict(bo3, two)).toMatchObject({ decided: ['a', 'b'], winsA: 1, winsB: 1, over: false, nextGame: 3 });
    const three = [...two, played(3, 500, 450)];
    expect(seriesVerdict(bo3, three)).toMatchObject({ decided: ['a', 'b', 'a'], winsA: 2, winsB: 1, over: true, winner: 'a', nextGame: null });
    expect(seriesResult(seriesVerdict(bo3, three))).toEqual({ winner: 'a', scoreA: 2, scoreB: 1, forfeit: false });
    expect(seriesVerdict(bo3, [played(1, 1, 0), played(2, 1, 0), game(3)])).toMatchObject({ over: true, winner: 'a', winsA: 2, nextGame: null });
    expect(seriesVerdict(bo1, [played(1, 10, 20)])).toMatchObject({ over: true, winner: 'b', decided: ['b'] });
    expect(seriesResult(seriesVerdict(bo1, [game(1)]))).toBeNull();
  });

  it('asks for a tiebreak of a tied game, takes the tiebreak as that game\'s result, and asks again when the tiebreak ties', () => {
    const tied = played(1, 500, 500);
    const v1 = seriesVerdict(bo3, [tied, game(2)]);
    expect(v1).toMatchObject({ decided: [], over: false, nextGame: null });
    expect(v1.tiebreakOf?.id).toBe(tied.id);
    expect(tiebreakOrdinal(tied, [tied])).toBe(11);
    const tb1 = played(11, 40, 40, { tiebreakOf: tied.id });
    expect(seriesVerdict(bo3, [tied, tb1, game(2)]).tiebreakOf?.id).toBe(tied.id);
    expect(tiebreakOrdinal(tied, [tied, tb1])).toBe(12);
    const tb2 = played(12, 40, 60, { tiebreakOf: tied.id });
    const v3 = seriesVerdict(bo3, [tied, tb1, tb2, game(2)]);
    expect(v3).toMatchObject({ decided: ['b'], winsA: 0, winsB: 1, tiebreakOf: null, nextGame: 2 });
    expect(gameNumberOf(tb2, [tied, tb1, tb2])).toBe(1);
    expect(playOrder([game(2), tb2, tied, tb1]).map((g) => g.ordinal)).toEqual([1, 11, 12, 2]);
  });
});

describe('seriesVerdict for total score (Bo2)', () => {
  it('adds both games, and breaks a tie with a tiebreak of game 2 whose score alone decides', () => {
    const g1 = played(1, 600, 500);
    const g2 = game(2);
    expect(seriesVerdict(bo2, [g1, g2])).toMatchObject({ totalScore: true, totalA: 600, totalB: 500, over: false, nextGame: 2, tiebreakOf: null });
    const g2w = played(2, 400, 550);
    expect(seriesVerdict(bo2, [g1, g2w])).toMatchObject({ totalA: 1000, totalB: 1050, over: true, winner: 'b', nextGame: null });
    expect(seriesResult(seriesVerdict(bo2, [g1, g2w]))).toEqual({ winner: 'b', scoreA: 1000, scoreB: 1050, forfeit: false });
    const g2t = played(2, 400, 500);
    const tiedTotals = seriesVerdict(bo2, [g1, g2t]);
    expect(tiedTotals).toMatchObject({ totalA: 1000, totalB: 1000, over: false, nextGame: null });
    expect(tiedTotals.tiebreakOf?.id).toBe(g2t.id);
    const tb = played(21, 70, 30, { tiebreakOf: g2t.id });
    const broken = seriesVerdict(bo2, [g1, g2t, tb]);
    expect(broken).toMatchObject({ over: true, winner: 'a', totalA: 1070, totalB: 1030 });
    expect(seriesResult(broken)).toEqual({ winner: 'a', scoreA: 1070, scoreB: 1030, forfeit: false });
  });

  it('never feeds the veto engine a winner (loser picks is refused for Bo2)', () => {
    expect(seriesVerdict(bo2, [played(1, 1, 0), played(2, 1, 0)]).decided).toEqual([]);
  });
});

describe('tiebreak sides', () => {
  it('starts the team that was survivors second on the replayed chapter as survivors', () => {
    expect(tiebreakFirstSurvivors('a')).toBe('b');
    expect(tiebreakFirstSurvivors('b')).toBe('a');
  });
});
