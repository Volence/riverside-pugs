import { describe, it, expect } from 'vitest';
import type { WinLine, WinPoint } from '../api';
import { chartSlots, describePoint, fmtChance, wholePercent, winSummary } from './WinChart';

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

  it("calls a scrim or tournament game's teams by name, with a plain apostrophe after an s", () => {
    const line: WinLine = { points, turning: 8, winnerLow: { index: 6, p: 0.16 }, halves: 3898 };
    expect(winSummary(line, { a: 'Poop Packers', b: 'Bone Breakage' })).toEqual([
      "Comeback: Poop Packers won from 16%, after Poop Packers' survivor half on map 3 (The Crane).",
      "Biggest swing: Poop Packers' survivor half on map 4 (The Crane), which took Poop Packers from 20% to 100%.",
    ]);
    expect(describePoint(pt(1, 1, 'b', 619, 46, 0.68), undefined, { a: 'Rats', b: 'Bats' })).toBe('Map 2 The Crane, Bats survivors scored 46');
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

/** A point during a half: the score is the one the half started from. */
const during = (o: number, half: number, t: 'a' | 'b', a: number, b: number, tMs: number, pA: number, moment?: WinPoint['moment']): WinPoint =>
  ({ ...pt(o, half, t, a, b, pA), tMs, ...(moment ? { moment } : {}) });

describe('chartSlots', () => {
  it('gives each half equal width and places its points by time between its half markers', () => {
    const line: WinLine = {
      points: [
        pt(null, null, null, 0, 0, 0.5),
        during(0, 1, 'a', 0, 0, 0, 0.5), during(0, 1, 'a', 0, 0, 30_000, 0.55), during(0, 1, 'a', 0, 0, 120_000, 0.7, 'saferoom'),
        pt(0, 1, 'a', 600, 0, 0.72),
        pt(0, 2, 'b', 600, 80, 0.8),
      ],
      turning: 4, winnerLow: null, halves: 10,
    };
    expect(chartSlots(line)).toEqual({ at: [0, 0, 0.25, 1, 1, 2], span: 2 });
  });

  it('spreads a half still being played over what the finished halves took, and keeps room for the halves to come', () => {
    const line: WinLine = {
      points: [
        pt(null, null, null, 0, 0, 0.5),
        during(0, 1, 'a', 0, 0, 0, 0.5), during(0, 1, 'a', 0, 0, 200_000, 0.6), pt(0, 1, 'a', 500, 0, 0.6),
        during(0, 2, 'b', 500, 0, 0, 0.6), during(0, 2, 'b', 500, 0, 50_000, 0.5),
      ],
      turning: null, winnerLow: null, halves: 10, halvesLeft: 3,
    };
    const { at, span } = chartSlots(line);
    expect(span).toBe(4);
    expect(at.slice(4)).toEqual([1, 1.25]);
    // With nothing finished to go by, a half is taken as six minutes long.
    expect(chartSlots({ ...line, points: line.points.slice(0, 2).concat(during(0, 1, 'a', 0, 0, 90_000, 0.4)), halvesLeft: 8 }).at)
      .toEqual([0, 0, 0.25]);
  });

  it('is the old even spacing on a line of half-end points alone', () => {
    const line: WinLine = { points: [pt(null, null, null, 0, 0, 0.5), pt(0, 1, 'a', 1, 0, 0.6), pt(0, 2, 'b', 1, 1, 0.5)], turning: 1, winnerLow: null, halves: 1, halvesLeft: 6 };
    expect(chartSlots(line)).toEqual({ at: [0, 1, 2], span: 8 });
  });
});

describe('winSummary with points during halves', () => {
  // Map 3 is B's survivor half: a tank at 2:00, and B's chance falls from
  // 68% to 31% inside the next 25 s.
  const points: WinPoint[] = [
    pt(null, null, null, 0, 0, 0.5), pt(0, 1, 'a', 600, 0, 0.6), pt(0, 2, 'b', 600, 500, 0.55),
    pt(1, 1, 'a', 1200, 500, 0.4), pt(1, 2, 'b', 1200, 1100, 0.32),
    during(2, 1, 'b', 1200, 1100, 115_000, 0.32), during(2, 1, 'b', 1200, 1100, 120_000, 0.36, 'tank_spawn'),
    during(2, 1, 'b', 1200, 1100, 140_000, 0.69, 'wipe'), pt(2, 1, 'b', 1200, 1250, 0.71),
    pt(2, 2, 'a', 1900, 1250, 1),
  ];

  it('names the moment inside the biggest swing by its likeliest cause, from the survivors\' side', () => {
    // The tank at 2:00 and the wipe 20 s on are both in the window: the wipe
    // is what moved it.
    const line: WinLine = { points, turning: 7, turningFrom: 5, winnerLow: { index: 4, p: 0.32 }, halves: 10 };
    expect(winSummary(line)[1]).toBe('Biggest swing: Wipe on map 3: 68% to 31% for Team B.');
  });

  it('counts a moment on the point the swing starts from, and speaks in the present while live', () => {
    const tank = points.map((p, i) => (i === 5 ? { ...p, moment: 'tank_spawn' as const } : { ...p, moment: undefined }));
    const line: WinLine = { points: tank.slice(0, 8), turning: 7, turningFrom: 5, winnerLow: null, halves: 10, halvesLeft: 3 };
    expect(winSummary(line)[1]).toBe('Biggest swing so far: Tank on map 3: 68% to 31% for Team B.');
  });

  it('without a moment in the window tells the half as before, and a low during a half says during', () => {
    const plain = points.map((p) => ({ ...p, moment: undefined }));
    const line: WinLine = { points: plain, turning: 7, turningFrom: 5, winnerLow: { index: 5, p: 0.2 }, halves: 10 };
    expect(winSummary(line)).toEqual([
      "Comeback: Team A won from 20%, during Team B's survivor half on map 3 (The Crane).",
      "Biggest swing: Team B's survivor half on map 3 (The Crane), which took Team A from 32% to 69%.",
    ]);
  });

  it('describes a point during a half by its time and moment', () => {
    expect(describePoint(points[6]!)).toBe('Map 3 The Crane, Team B survivors, 2:00 in: tank spawned');
    expect(describePoint(points[5]!)).toBe('Map 3 The Crane, Team B survivors, 1:55 in');
  });
});
