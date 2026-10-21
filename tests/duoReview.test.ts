import { describe, it, expect } from 'vitest';
import { summarizeDuoMatches } from '../scripts/duo-review.js';

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
