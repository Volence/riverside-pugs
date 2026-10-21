import { describe, it, expect } from 'vitest';
import { summarizeDuoMatches, summarizeStints } from '../scripts/duo-review.js';

describe('summarizeDuoMatches', () => {
  it('compares duo team wins with plain and bonus predictions', () => {
    const s = summarizeDuoMatches([
      { duoTeam: 'a', winner: 'a', pPlain: 0.5, pDuo: 0.6, margin: 100, forfeit: false, abandons: 0, fourStack: false, band: 'high' },
      { duoTeam: 'b', winner: 'a', pPlain: 0.5, pDuo: 0.4, margin: 300, forfeit: true, abandons: 1, fourStack: false, band: 'low' },
      { duoTeam: null, winner: 'b', pPlain: 0.5, pDuo: null, margin: 50, forfeit: false, abandons: 0, fourStack: false, band: null },
    ]);
    expect(s.duo.matches).toBe(2);
    expect(s.duo.duoWinRate).toBe(0.5);
    expect(s.duo.predictedPlain).toBeCloseTo(0.5);
    expect(s.duo.predictedWithBonus).toBeCloseTo(0.6); // duo team's own chance: 0.6 and 1-0.4
    expect(s.duo.forfeitRate).toBe(0.5);
    expect(s.solo.matches).toBe(1);
    expect(s.solo.meanMargin).toBe(50);
    expect(s.byBand.high.matches).toBe(1);
  });
});

describe('summarizeStints', () => {
  const duo = { playerA: 'p1', playerB: 'p2', createdMs: 1000, endedMs: 50000 as number | null };
  it('splits stints, waits and ready fails by whether a duo was active over the stint', () => {
    const s = summarizeStints(
      [
        { playerId: 'p1', joinedMs: 1000, endedMs: 61000, outcome: 'popped', requeued: false }, // duo ended mid-stint: solo
        { playerId: 'p2', joinedMs: 2000, endedMs: 4000, outcome: 'left', requeued: false }, // duo
        { playerId: 'p1', joinedMs: 4000, endedMs: 10000, outcome: 'popped', requeued: false }, // duo
        { playerId: 'p3', joinedMs: 2000, endedMs: 182000, outcome: 'popped', requeued: false }, // solo
        { playerId: 'p3', joinedMs: 0, endedMs: 999999, outcome: 'popped', requeued: true }, // solo, wait not counted
      ],
      [duo],
      [{ playerId: 'p1', atMs: 3000 }, { playerId: 'p3', atMs: 3000 }, { playerId: 'p1', atMs: 90000 }],
    );
    expect(s.stints).toBe(5);
    expect(s.duoShare).toBeCloseTo(2 / 5);
    expect(s.duo.meanPoppedWaitMinutes).toBeCloseTo(0.1);
    expect(s.solo.meanPoppedWaitMinutes).toBeCloseTo(2);
    // duo: 1 fail over 1 popped stint; solo: p3, and p1 after the duo ended, over 3 popped stints
    expect(s.duo.readyFailRate).toBeCloseTo(1);
    expect(s.solo.readyFailRate).toBeCloseTo(2 / 3);
  });
  it('an open duo (no end) covers later stints', () => {
    const s = summarizeStints(
      [{ playerId: 'p2', joinedMs: 90000, endedMs: 95000, outcome: 'popped', requeued: false }],
      [{ ...duo, endedMs: null }],
      [],
    );
    expect(s.duoShare).toBe(1);
  });
});
