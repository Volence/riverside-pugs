import { describe, it, expect } from 'vitest';
import type { WinLine, WinPoint } from '../api';
import { describePoint, fmtChance, wholePercent, winSummary } from './WinChart';

const pt = (o: number | null, half: number | null, t: 'a' | 'b' | null, a: number, b: number, pA: number): WinPoint =>
  ({ ordinal: o, half, survTeam: t, map: o === null ? null : 'l4d_vs_airport02_offices', scoreA: a, scoreB: b, pA });

describe('fmtChance', () => {
  it('never claims certainty along the way, but the final point is exact', () => {
    expect(fmtChance(0.004)).toBe('under 1%');
    expect(fmtChance(0.996)).toBe('over 99%');
    expect(fmtChance(0.42)).toBe('42%');
    expect(fmtChance(1, true)).toBe('100%');
  });

  it('rounds both sides the same way, so they add up to 100', () => {
    for (const p of [0.735, 0.265, 0.125, 0.5, 0.505, 0.995 - 0.5]) {
      expect(wholePercent(p) + wholePercent(1 - p)).toBe(100);
    }
  });
});

describe('describePoint', () => {
  it('names the map, the team and what that half scored', () => {
    const prev = pt(0, 2, 'b', 60, 46, 0.5);
    expect(describePoint(pt(1, 1, 'a', 619, 46, 0.68), prev)).toBe('Map 2 The Crane, Team A survivors scored 559');
    expect(describePoint(pt(null, null, null, 0, 0, 0.5))).toBe('Before the first half');
  });
});

describe('winSummary', () => {
  const points = [
    pt(null, null, null, 0, 0, 0.5), pt(0, 1, 'a', 62, 0, 0.42), pt(0, 2, 'b', 62, 46, 0.52),
    pt(1, 1, 'a', 619, 46, 0.68), pt(1, 2, 'b', 619, 771, 0.24), pt(2, 1, 'b', 619, 848, 0.25),
    pt(2, 2, 'a', 695, 848, 0.16), pt(3, 1, 'b', 695, 926, 0.2), pt(3, 2, 'a', 1321, 926, 1),
  ];

  it('calls a win from under 25% a comeback and tells the biggest swing from the side it favoured', () => {
    const line: WinLine = { points, turning: 8, winnerLow: { index: 6, p: 0.16 }, halves: 3898 };
    expect(winSummary(line)).toEqual([
      "Comeback: Team A won from 16%, after Team A's survivor half on map 3 (The Crane).",
      "Biggest swing: Team A's survivor half on map 4 (The Crane), which took Team A from 20% to 100%.",
    ]);
  });

  it('says wire to wire when the winner never trailed on the odds', () => {
    const line: WinLine = { points: [points[0], pt(0, 1, 'b', 0, 600, 0.2), pt(0, 2, 'a', 50, 600, 0)], turning: 1, winnerLow: { index: 0, p: 0.5 }, halves: 10 };
    expect(winSummary(line)[0]).toBe('Team B were ahead on the odds from the first half to the last.');
    expect(winSummary(line)[1]).toBe("Biggest swing: Team B's survivor half on map 1 (The Crane), which took Team B from 50% to 80%.");
  });

  it('speaks in the present for a match still being played, and never claims a winner', () => {
    const line: WinLine = { points: points.slice(0, 3), turning: 1, winnerLow: null, halves: 10, halvesLeft: 6 };
    expect(winSummary(line)).toEqual([
      'Right now: Team A 52%, Team B 48%, with 6 survivor halves left to play.',
      "Biggest swing so far: Team A's survivor half on map 1 (The Crane), which took Team B from 50% to 58%.",
    ]);
    expect(winSummary({ ...line, halvesLeft: 1 })[0]).toContain('1 survivor half left');
  });
});
