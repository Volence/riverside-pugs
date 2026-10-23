import { describe, it, expect } from 'vitest';
import { favLabel, pct, statFavWon } from './TeamBalance';
import type { TeamBalanceRow } from '../../../api';

const row = (chosenStatA: number, winner: string | null): TeamBalanceRow => ({
  matchId: 1, createdAt: '', enabled: true, overGate: true, gateFired: true, moved: 2,
  bestRatingA: 0.5, bestStatA: 0.7, chosenRatingA: 0.52, chosenStatA, winner, state: 'completed',
});

describe('team balance panel', () => {
  it('labels the favourite side and its odds', () => {
    expect(favLabel(0.63)).toBe('A 63%');
    expect(favLabel(0.37)).toBe('B 63%');
    expect(pct(null)).toBe('-');
  });

  it('says whether the stat favourite of the teams that played won', () => {
    expect(statFavWon(row(0.6, 'a'))).toBe(true);
    expect(statFavWon(row(0.4, 'a'))).toBe(false);
    expect(statFavWon(row(0.4, 'draw'))).toBeNull();
    expect(statFavWon(row(0.4, null))).toBeNull();
  });
});
