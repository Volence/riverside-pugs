import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle, release, markLive, markOffline, getServer } from '../src/serverPool.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedTwo() {
  addServer(db, { name: 's1', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'p1' });
  addServer(db, { name: 's2', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'p2' });
}

describe('serverPool', () => {
  it('addServer inserts as idle by default and getServer reads it back', () => {
    const id = addServer(db, { name: 's1', host: 'h', port: 1, rconPort: 2, rconPassword: 'x', status: 'idle' });
    const s = getServer(db, id)!;
    expect(s.name).toBe('s1');
    expect(s.status).toBe('idle');
    expect(s.rcon_password).toBe('x');
  });

  it('claimIdle reserves exactly one idle server per call', () => {
    seedTwo();
    const a = claimIdle(db)!;
    const b = claimIdle(db)!;
    expect(a.id).not.toBe(b.id);
    expect(getServer(db, a.id)!.status).toBe('reserved');
    expect(claimIdle(db)).toBeNull();
  });

  it('does not claim offline/reserved/live servers', () => {
    const id = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 2, rconPassword: 'x', status: 'offline' });
    expect(claimIdle(db)).toBeNull();
    markOffline(db, id);
    expect(getServer(db, id)!.status).toBe('offline');
  });

  it('release/markLive/markOffline transition status', () => {
    seedTwo();
    const s = claimIdle(db)!;
    markLive(db, s.id);
    expect(getServer(db, s.id)!.status).toBe('live');
    release(db, s.id);
    expect(getServer(db, s.id)!.status).toBe('idle');
    markOffline(db, s.id);
    expect(getServer(db, s.id)!.status).toBe('offline');
  });
});
