import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { seedPlayers } from './weeklyFixtures.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('weekly awards schema', () => {
  it('creates both tables and the two settings', () => {
    db.prepare("INSERT INTO weekly_award_weeks (week_start, frozen_at) VALUES ('2026-09-21', '2026-09-28 00:05:00')").run();
    expect(getSetting(db, 'weekly_min_games')).toBe('5');
    expect(getSetting(db, 'discord_weekly_channel_id')).toBe('');
  });

  it('merge moves awards to the kept account and collapses a duplicate', () => {
    const [keep, dup, other] = seedPlayers(db, 3);
    const ins = db.prepare(
      "INSERT INTO weekly_awards (week_start, award, kind, player_id, value, games) VALUES ('2026-09-21', ?, 'avg', ?, ?, 5)",
    );
    ins.run('skeets', keep, 4);
    ins.run('skeets', dup, 4);     // tie on the same award: collapses into one row
    ins.run('crowns', dup, 1);     // moves
    ins.run('revives', other, 2);  // untouched
    mergePlayers(db, { from: dup, into: keep });
    const rows = db.prepare('SELECT award, player_id FROM weekly_awards ORDER BY award').all();
    expect(rows).toEqual([
      { award: 'crowns', player_id: keep },
      { award: 'revives', player_id: other },
      { award: 'skeets', player_id: keep },
    ]);
  });
});
