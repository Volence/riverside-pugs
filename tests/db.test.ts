import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { getSetting, setSetting, getJsonSetting } from '../src/settings.js';

describe('openDb', () => {
  it('creates all tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual([
      'match_players', 'matches', 'player_ratings', 'players',
      'rating_history', 'seasons', 'servers', 'settings',
    ]);
  });

  it('seeds season 1 and default settings, idempotently', () => {
    const db = openDb(':memory:');
    const seasons = db.prepare('SELECT * FROM seasons').all();
    expect(seasons).toHaveLength(1);
    expect(getSetting(db, 'invite_code')).toBe('change-me');
    expect(getSetting(db, 'ready_seconds')).toBe('60');
    expect(getSetting(db, 'vote_seconds')).toBe('30');
    expect(getJsonSetting<string[]>(db, 'map_pool')).toEqual([
      'no_mercy', 'death_toll', 'dead_air', 'blood_harvest',
    ]);
  });

  it('settings set/get roundtrip', () => {
    const db = openDb(':memory:');
    setSetting(db, 'invite_code', 'sekrit');
    expect(getSetting(db, 'invite_code')).toBe('sekrit');
  });
});
