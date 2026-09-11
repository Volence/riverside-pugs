import { describe, it, expect } from 'vitest';
import { sideTotals } from './matchTotals';
import type { StatDef, MatchPlayerStats } from './api';

const defs = [
  { key: 'skeets', side: 'survivor', direction: 'high_good' },
  { key: 'damage_as_si', side: 'infected', direction: 'high_good' },
] as unknown as StatDef[];

const player = (steamid: string, team: 'a' | 'b', stats: Record<string, number>) => ({
  steamid, name: steamid, team, siDamage: 0, siKills: 0, commonKills: 0,
  ffDealt: 0, revives: 0, srDelta: 0, stats,
}) as unknown as MatchPlayerStats;

describe('sideTotals', () => {
  it('splits a team by the side each stat belongs to', () => {
    const players = [
      player('p1', 'a', { skeets: 3, damage_as_si: 500 }),
      player('p2', 'a', { skeets: 1, damage_as_si: 200 }),
      player('p3', 'b', { skeets: 9, damage_as_si: 9 }),
    ];
    const a = sideTotals(players, 'a', defs);
    expect(a.survivor).toEqual({ skeets: 4 });
    expect(a.infected).toEqual({ damage_as_si: 700 });
  });

  it('counts only the requested team', () => {
    const players = [
      player('p1', 'a', { skeets: 3 }),
      player('p2', 'b', { skeets: 100 }),
    ];
    expect(sideTotals(players, 'a', defs).survivor).toEqual({ skeets: 3 });
  });

  it('drops a key with no known side rather than guessing', () => {
    const players = [player('p1', 'a', { skeets: 3, not_a_stat: 7 })];
    expect(sideTotals(players, 'a', defs).survivor).toEqual({ skeets: 3 });
    expect(sideTotals(players, 'a', defs).infected).toEqual({});
  });

  it('omits a stat nobody recorded rather than reporting zero', () => {
    const players = [player('p1', 'a', {})];
    expect(sideTotals(players, 'a', defs).survivor).toEqual({});
  });
});
