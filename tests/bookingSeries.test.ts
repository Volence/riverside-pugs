import { describe, it, expect } from 'vitest';
import type { BookingGameView } from '../src/bookings/games.js';
import { countsInSeries, gameLine, gameWinner, seriesLine, seriesTally, sideScores } from '../src/bookings/series.js';

const g = (over: Partial<BookingGameView>): BookingGameView => ({
  matchId: 1, campaign: 'dark_wood', state: 'completed', scoreA: 0, scoreB: 0, sideA: 'a', winner: null, voided: false,
  startedAt: '2026-10-11 20:00:00', endedAt: null, restoredAtMap: null, ...over,
});

describe('the series result (owner, 2026-10-11)', () => {
  // Booking 2: big BAD boys side a, Test side b; both games had booking_side_a 'b'.
  const darkWood = g({ matchId: 644, campaign: 'dark_wood', sideA: 'b', scoreA: 347, scoreB: 250, winner: 'a' });
  const bloodHarvest = g({ matchId: 645, campaign: 'blood_harvest', sideA: 'b', scoreA: 328, scoreB: 893, winner: 'b' });

  it('orients each game to the booking sides through its own booking_side_a', () => {
    expect(gameWinner(darkWood)).toBe('b'); // Test
    expect(gameWinner(bloodHarvest)).toBe('a'); // big BAD boys
    expect(sideScores(darkWood)).toEqual({ a: 250, b: 347 });
    expect(seriesTally([darkWood, bloodHarvest])).toEqual({ wins: { a: 1, b: 1 }, draws: 0, counted: 2 });
    expect(seriesLine('Test', 1, 1, 'big BAD boys', 0)).toBe('Test 1 - 1 big BAD boys');
    expect(gameLine(darkWood, 'Dark Wood', 'b')).toBe('Dark Wood: 347 - 250');
    expect(gameLine(bloodHarvest, 'Blood Harvest', 'b')).toBe('Blood Harvest: 328 - 893');
  });

  it('aborted, voided and live games never count, and say so', () => {
    const aborted = g({ state: 'aborted', scoreA: 100, scoreB: 0 });
    const voided = g({ state: 'aborted', voided: true, winner: 'a', scoreA: 500, scoreB: 100 });
    const live = g({ state: 'live', scoreA: 50, scoreB: 0 });
    for (const x of [aborted, voided, live]) expect(countsInSeries(x)).toBe(false);
    expect(seriesTally([aborted, voided, live])).toEqual({ wins: { a: 0, b: 0 }, draws: 0, counted: 0 });
    expect(gameLine(aborted, 'No Mercy', 'a')).toBe('No Mercy: not finished, not counted');
    expect(gameLine(voided, 'No Mercy', 'a')).toBe('No Mercy: voided, not counted');
  });

  it('a draw reads as one, a single game reads sensibly, and a missing winner falls back to the scores', () => {
    const draw = g({ winner: 'draw', scoreA: 400, scoreB: 400 });
    expect(seriesTally([draw])).toEqual({ wins: { a: 0, b: 0 }, draws: 1, counted: 1 });
    expect(seriesLine('Rats', 0, 0, 'Mice', 1)).toBe('Rats 0 - 0 Mice, 1 draw');
    expect(seriesLine('Rats', 1, 1, 'Mice', 2)).toBe('Rats 1 - 1 Mice, 2 draws');
    expect(gameLine(draw, 'No Mercy', 'a')).toBe('No Mercy: 400 - 400 (draw)');
    expect(seriesLine('Rats', 1, 0, 'Mice', 0)).toBe('Rats 1 - 0 Mice');
    expect(gameWinner(g({ winner: null, sideA: null, scoreA: 10, scoreB: 20 }))).toBe('b');
  });
});
