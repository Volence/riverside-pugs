import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPlayer, currentSeasonId } from '../src/players.js';
import { UNRATED_SR, displaySr, seasonSr } from '../src/rating.js';

describe('seasonSr', () => {
  it('reads a rated player and gives an unrated one the starting SR without writing a row', () => {
    const db = openDb(':memory:');
    const season = currentSeasonId(db);
    upsertPlayer(db, { steamid: '76561199000000901', name: 'a', avatar: null }, []);
    upsertPlayer(db, { steamid: '76561199000000902', name: 'b', avatar: null }, []);
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, 30, 2)').run('76561199000000901', season);
    expect(seasonSr(db, '76561199000000901', season)).toBe(displaySr(30, 2));
    expect(seasonSr(db, '76561199000000902', season)).toBe(UNRATED_SR);
    expect(db.prepare('SELECT COUNT(*) AS n FROM player_ratings WHERE player_id = ?').get('76561199000000902')).toEqual({ n: 0 });
  });
});
