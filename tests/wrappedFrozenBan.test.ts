import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { frozenPlayer } from '../src/seasonWrapped.js';

/**
 * Season 1 flip, 2026-11-03: every frozen deck 404'd because frozenPlayer's
 * ban check compared the bans row's player_id with itself, so one active ban
 * anywhere took down everybody's Wrapped.
 */
describe('frozen Wrapped and bans', () => {
  it('someone else being banned leaves a deck up; the banned player\'s own goes', () => {
    const db = openDb(':memory:');
    for (const id of ['76561198000000001', '76561198000000002']) {
      db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(id, id);
      db.prepare("INSERT INTO season_wrapped (season_id, player_id, data, frozen_at) VALUES (1, ?, ?, datetime('now'))")
        .run(id, JSON.stringify({ v: 1, steamid: id }));
    }
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES ('76561198000000002', 'x', 'admin', ?)")
      .run(new Date(Date.now() - 60_000).toISOString());
    expect(frozenPlayer(db, 1, '76561198000000001')?.steamid).toBe('76561198000000001');
    expect(frozenPlayer(db, 1, '76561198000000002')).toBeNull();
  });
});
