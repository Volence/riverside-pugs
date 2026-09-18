import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle, release, markLive, markOffline, getServer, setEnabled, listServers } from '../src/serverPool.js';

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

describe('serverPool enabled flag', () => {
  it('defaults to enabled, so an upgrade never silently parks a server', () => {
    const id = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 2, rconPassword: 'x' });
    expect(getServer(db, id)!.enabled).toBe(1);
    expect(claimIdle(db)!.id).toBe(id);
  });

  it('will not claim a disabled server however idle it looks', () => {
    const id = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 2, rconPassword: 'x' });
    setEnabled(db, id, false);
    expect(getServer(db, id)!.status).toBe('idle');
    expect(claimIdle(db)).toBeNull();
  });

  it('skips a disabled server and takes the next enabled one', () => {
    seedTwo();
    setEnabled(db, 1, false);
    const got = claimIdle(db)!;
    expect(got.id).toBe(2);
  });

  it('re-enabling makes it claimable again without touching status', () => {
    const id = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 2, rconPassword: 'x' });
    setEnabled(db, id, false);
    expect(claimIdle(db)).toBeNull();
    setEnabled(db, id, true);
    expect(claimIdle(db)!.id).toBe(id);
  });

  it('disabling a live server leaves the match alone and only blocks the next claim', () => {
    // The case this exists for: a box misbehaves mid-evening. Disabling it must
    // not abort the match on it, and the release at the end must still run.
    const id = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 2, rconPassword: 'x' });
    claimIdle(db);
    markLive(db, id);
    setEnabled(db, id, false);
    expect(getServer(db, id)!.status).toBe('live');
    release(db, id);
    expect(getServer(db, id)!.status).toBe('idle');
    expect(claimIdle(db)).toBeNull();
  });

  it('listServers reports every server in id order with its flag', () => {
    seedTwo();
    setEnabled(db, 2, false);
    expect(listServers(db).map((s) => [s.id, s.enabled])).toEqual([[1, 1], [2, 0]]);
  });
});
