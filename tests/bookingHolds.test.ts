import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle } from '../src/serverPool.js';
import { pickLeaseServer } from '../src/practiceLeases.js';
import { setSetting } from '../src/settings.js';

const A = '76561199000000601';
const B = '76561199000000602';
const START = Date.parse('2026-10-02T20:00:00.000Z');
const MIN = 60_000;
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [A, B]) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'x', 'active')").run(id);
});
const box = (name: string) => {
  const id = addServer(db, { name, host: 'h', port: 27015 + name.length, rconPort: 1, rconPassword: 'x' });
  db.prepare("UPDATE servers SET status = 'idle', enabled = 1 WHERE id = ?").run(id);
  return id;
};
const book = (bConfirmed = true) => {
  const id = Number(db.prepare(
    `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('scrim', ?, ?, 'p', 't', 'standard', '{}', '[]', ?, 'x')`,
  ).run(new Date(START).toISOString(), new Date(START + 60 * MIN).toISOString(), A).lastInsertRowid);
  db.prepare("INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, 'a', ?, 'x'), (?, 'b', ?, ?)")
    .run(id, A, id, B, bConfirmed ? 'x' : null);
  return id;
};

describe('boxes kept back for bookings', () => {
  it('a PUG cannot take the last idle box a booking due within the protect window needs', () => {
    box('a');
    book();
    expect(claimIdle(db, START - 80 * MIN)?.name).toBe('a');
    db.prepare("UPDATE servers SET status = 'idle'").run();
    expect(claimIdle(db, START - 70 * MIN)).toBeNull();
  });

  it('a second idle box is still the queue\'s', () => {
    box('a'); box('bb');
    book();
    expect(claimIdle(db, START - 10 * MIN)?.name).toBe('a');
    expect(claimIdle(db, START - 10 * MIN)).toBeNull();
  });

  it('an unconfirmed invite keeps nothing back', () => {
    box('a');
    book(false);
    expect(claimIdle(db, START - 10 * MIN)?.name).toBe('a');
  });

  it('a practice lease counts the kept boxes as taken', () => {
    box('a'); box('bb');
    setSetting(db, 'practice_reserve_idle', '1');
    expect(pickLeaseServer(db, START - 10 * MIN).ok).toBe(true);
    book();
    expect(pickLeaseServer(db, START - 10 * MIN)).toEqual({ ok: false, reason: 'no_server' });
  });
});
