import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle, isSideHeld } from '../src/serverPool.js';
import { getSetting } from '../src/settings.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

function add(name: string): number {
  return addServer(db, { name, host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
}

describe('side_games', () => {
  it('hides a held box from claimIdle while the row is open', () => {
    const a = add('a');
    const b = add('b');
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (?, 'tok', 'side_x')").run(a);
    expect(isSideHeld(db, a)).toBe(true);
    expect(claimIdle(db)?.id).toBe(b);
  });

  it('gives the box back once the row is ended', () => {
    const a = add('a');
    db.prepare("INSERT INTO side_games (server_id, token, password, ended_at) VALUES (?, 't', 'p', datetime('now'))").run(a);
    expect(isSideHeld(db, a)).toBe(false);
    expect(claimIdle(db)?.id).toBe(a);
  });

  it('seeds the settings off with a minimum of 4', () => {
    expect(getSetting(db, 'sidegames_enabled')).toBe('0');
    expect(getSetting(db, 'sidegames_min_players')).toBe('4');
  });
});
