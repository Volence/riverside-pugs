import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('match_presence', () => {
  it('has the columns the spec names, plus the hold and the two anchors', () => {
    const cols = (db.prepare('PRAGMA table_info(match_presence)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      'match_id', 'steamid', 'state', 'since', 'remaining_s', 'remaining_at',
      'held', 'hold_until', 'low_alert_at', 'updated_at',
    ]);
  });

  it('is one row per player per match', () => {
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'live', 'dead_air')").run();
    const ins = db.prepare(
      "INSERT INTO match_presence (match_id, steamid, state, since, updated_at) VALUES (1, '76561199000000001', 'connected', 'x', 'x')",
    );
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE|PRIMARY/);
  });

  it('does not reference players, so the merge foreign key audit stays honest', () => {
    const fks = db.prepare('PRAGMA foreign_key_list(match_presence)').all() as { table: string }[];
    expect(fks.map((f) => f.table)).toEqual(['matches']);
  });
});

describe('what came with it', () => {
  it('a match starts with an unknown plugin capability', () => {
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'live', 'dead_air')").run();
    expect(db.prepare('SELECT leave_control FROM matches WHERE id = 1').get()).toEqual({ leave_control: null });
  });

  it('seeds and validates the two clock settings', () => {
    expect(getSetting(db, 'clock_hold_max_minutes')).toBe('30');
    expect(getSetting(db, 'abandon_low_alert_seconds')).toBe('90');
    expect(validateSetting('clock_hold_max_minutes', '45')).toEqual({ ok: true, value: '45' });
    expect(validateSetting('clock_hold_max_minutes', '0').ok).toBe(false);
    expect(validateSetting('clock_hold_max_minutes', '121').ok).toBe(false);
    expect(validateSetting('abandon_low_alert_seconds', '0')).toEqual({ ok: true, value: '0' });
    expect(validateSetting('abandon_low_alert_seconds', '601').ok).toBe(false);
  });
});
