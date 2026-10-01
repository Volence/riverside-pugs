import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { holdFor } from '../src/serverHolds.js';
import { claimableServers } from '../src/serverPool.js';
import { validateSetting } from '../src/settingsSchema.js';
import { getSetting } from '../src/settings.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const A = '76561199000000401';
let db: DB;
let serverId: number;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'a', 'active')").run(A);
  serverId = Number(db.prepare(
    "INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('s1', 'h', 27015, 27015, 'pw', 'idle')",
  ).run().lastInsertRowid);
});

const booking = (over: Record<string, unknown> = {}) => {
  const row = {
    purpose: 'scrim', starts_at: '2026-10-02T20:00:00.000Z', ends_at: '2026-10-02T22:00:00.000Z',
    password: 'abcdefgh', tv_password: 'hgfedcba', game_config: 'standard', rules_json: '{}', playlist_json: '["no_mercy"]',
    created_by: A, created_at: '2026-10-01T12:00:00.000Z', server_id: null, ended_at: null, ...over,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO bookings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(row)).lastInsertRowid);
};

describe('booking schema', () => {
  it('servers carry a region, na by default', () => {
    expect(db.prepare('SELECT region FROM servers WHERE id = ?').get(serverId)).toEqual({ region: 'na' });
  });

  it('a booking starts scheduled in region na and refuses an unknown state', () => {
    const id = booking();
    expect(db.prepare('SELECT state, region, extended_minutes, setup_attempts FROM bookings WHERE id = ?').get(id))
      .toEqual({ state: 'scheduled', region: 'na', extended_minutes: 0, setup_attempts: 0 });
    expect(() => db.prepare("UPDATE bookings SET state = 'paused' WHERE id = ?").run(id)).toThrow(/CHECK/);
  });

  it('an open booking with a box holds it, ahead of any other holder', () => {
    db.prepare("INSERT INTO practice_leases (server_id, kind, owner_player_id, password, last_human_at, ends_at) VALUES (?, 'park', ?, 'x', '2026-10-01', '2026-10-01')")
      .run(serverId, A);
    const id = booking({ server_id: serverId });
    expect(holdFor(db, serverId)).toEqual({ kind: 'booking', rowId: id });
    expect(claimableServers(db)).toEqual([]);
  });

  it('a booking without a box, or one whose box is back, holds nothing', () => {
    booking();
    booking({ server_id: serverId, ended_at: '2026-10-02T22:05:00.000Z' });
    expect(holdFor(db, serverId)).toBeNull();
    expect(claimableServers(db).map((s) => s.id)).toEqual([serverId]);
  });

  it('booking_people has one row per person per booking', () => {
    const id = booking();
    const ins = db.prepare("INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, ?, ?, 'player', 'accepted', ?, 'x')");
    ins.run(id, 'a', A, A);
    expect(() => ins.run(id, 'b', A, A)).toThrow(/UNIQUE|PRIMARY/);
  });

  it('ships the booking settings with defaults and bounds', () => {
    expect(getSetting(db, 'pug_reserve_servers')).toBe('2');
    expect(getSetting(db, 'booking_max_upcoming')).toBe('4');
    expect(getSetting(db, 'booking_protect_minutes')).toBe('75');
    expect(validateSetting('booking_hold_lead_minutes', '20')).toEqual({ ok: true, value: '20' });
  });

  it('drops the extend setting from the admin page', () => {
    expect(validateSetting('booking_extend_minutes', '30').ok).toBe(false);
  });

  it('backfills games_allowed from the playlist once, and never over a count already set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pug-games-allowed-'));
    try {
      const file = join(dir, 'pug.db');
      let fdb = openDb(file);
      fdb.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'a', 'active')").run(A);
      const ins = fdb.prepare(
        `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
         VALUES ('scrim', '2026-10-02T20:00:00.000Z', '2026-10-02T22:00:00.000Z', 'p', 't', 'standard', '{}', ?, ?, 'x')`,
      );
      // Rows as an older site wrote them: no count yet.
      const two = Number(ins.run('["no_mercy","death_toll"]', A).lastInsertRowid);
      const one = Number(ins.run('["dead_air"]', A).lastInsertRowid);
      fdb.close();
      fdb = openDb(file);
      const allowed = (id: number) => (fdb.prepare('SELECT games_allowed, ends_at, close_at FROM bookings WHERE id = ?').get(id));
      expect(allowed(two)).toEqual({ games_allowed: 2, ends_at: '2026-10-02T22:00:00.000Z', close_at: null });
      expect(allowed(one)).toEqual({ games_allowed: 1, ends_at: '2026-10-02T22:00:00.000Z', close_at: null });
      fdb.prepare('UPDATE bookings SET games_allowed = 5 WHERE id = ?').run(two);
      fdb.close();
      fdb = openDb(file);
      expect(allowed(two)).toMatchObject({ games_allowed: 5 });
      expect(allowed(one)).toMatchObject({ games_allowed: 1 });
      fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
