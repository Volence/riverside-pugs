import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { currentSeasonId } from '../src/players.js';
import { planTankOrder, shuffledOrder, tankSlots } from '../src/tankOrder.js';

describe('tankSlots', () => {
  it('ranks each team by SR on its own, highest first', () => {
    const s = tankSlots([
      { player_id: 'a1', team: 'a', sr: 10 }, { player_id: 'a2', team: 'a', sr: 30 },
      { player_id: 'a3', team: 'a', sr: 20 }, { player_id: 'a4', team: 'a', sr: 5 },
      { player_id: 'b1', team: 'b', sr: 1 }, { player_id: 'b2', team: 'b', sr: 99 },
      { player_id: 'b3', team: 'b', sr: 50 }, { player_id: 'b4', team: 'b', sr: 2 },
    ]);
    expect(['a2', 'a3', 'a1', 'a4'].map((p) => s.get(p))).toEqual([1, 2, 3, 4]);
    expect(['b2', 'b3', 'b4', 'b1'].map((p) => s.get(p))).toEqual([1, 2, 3, 4]);
  });

  it('breaks an SR tie by steamid, so the same roster always gets the same slots', () => {
    const s = tankSlots([{ player_id: '9', team: 'a', sr: 7 }, { player_id: '1', team: 'a', sr: 7 }]);
    expect(s.get('1')).toBe(1);
    expect(s.get('9')).toBe(2);
  });
});

describe('shuffledOrder', () => {
  it('is a permutation of 1..n', () => {
    for (let k = 0; k < 50; k++) expect(shuffledOrder(4).split('').sort().join('')).toBe('1234');
  });

  it('reaches every order', () => {
    const seen = new Set<string>();
    for (let k = 0; k < 2000; k++) seen.add(shuffledOrder(4));
    expect(seen.size).toBe(24);
  });
});

describe('planTankOrder', () => {
  it('uses the season SR of the roster and orders 4 slots', () => {
    const db = openDb(':memory:');
    const season = currentSeasonId(db);
    const ids = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
    for (const id of ids) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, id);
    const mid = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', 'no_mercy')").run(season).lastInsertRowid);
    // Team a: the last player is the best; team b: the first is.
    const mu = [20, 22, 24, 40, 40, 24, 22, 20];
    ids.forEach((id, i) => db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, ?, 3)').run(id, season, mu[i]));
    const roster = ids.map((id, i) => ({ player_id: id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
    const plan = planTankOrder(db, mid, roster, () => 0);
    expect(ids.map((id) => plan.slots.get(id))).toEqual([4, 3, 2, 1, 1, 2, 3, 4]);
    expect(plan.order.split('').sort().join('')).toBe('1234');
  });
});
