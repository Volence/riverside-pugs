import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('booking games schema', () => {
  it('matches carry an optional booking and which booking side is team a', () => {
    const cols = (db.prepare('PRAGMA table_info(matches)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('booking_id');
    expect(cols).toContain('booking_side_a');
    const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid);
    expect(db.prepare('SELECT booking_id, booking_side_a FROM matches WHERE id = ?').get(id)).toEqual({ booking_id: null, booking_side_a: null });
    expect(() => db.prepare("UPDATE matches SET booking_side_a = 'c' WHERE id = ?").run(id)).toThrow(/CHECK/);
  });

  it('bookings carry the playlist position and a pending next campaign', () => {
    const cols = (db.prepare('PRAGMA table_info(bookings)').all() as { name: string; dflt_value: string | null }[]);
    expect(cols.find((c) => c.name === 'playlist_pos')?.dflt_value).toBe('0');
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['next_campaign', 'next_at']));
  });

  it('ships booking_game_min_players', () => {
    expect(getSetting(db, 'booking_game_min_players')).toBe('6');
    expect(validateSetting('booking_game_min_players', '9').ok).toBe(false);
  });
});
