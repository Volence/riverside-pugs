import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { FleetReader, readingStates, readingsOf } from '../src/fleetReader.js';
import type { TreeFile, TreeReader } from '../src/fleetTree.js';

type DB = ReturnType<typeof openDb>;
const F = (path: string, h = 'a'): TreeFile => ({ path, size: 1, sha256: h });
const fake = (out: TreeFile[] | Error | (() => Promise<TreeFile[]>), kind: TreeReader['kind'] = 'local'): TreeReader => ({
  kind, read: typeof out === 'function' ? out : async () => { if (out instanceof Error) throw out; return out; },
});

describe('FleetReader', () => {
  let db: DB;
  let s1: number, s2: number;
  let t = 0;
  const now = () => `2026-09-24 10:00:${String(t++ % 60).padStart(2, '0')}`;
  beforeEach(() => {
    db = openDb(':memory:');
    s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  });

  it('reads a box and stores its files, replacing the previous reading', async () => {
    let files = [F('left4dead/cfg/a.cfg'), F('left4dead/cfg/b.cfg')];
    const r = new FleetReader({ db, reader: () => fake(async () => files), now });
    expect(r.request([s1])).toEqual({ [s1]: 'queued' });
    await r.idle();
    files = [F('left4dead/cfg/a.cfg', 'z')];
    r.request([s1]);
    await r.idle();
    expect([...readingsOf(db).get(s1)!.entries()]).toEqual([['left4dead/cfg/a.cfg', { size: 1, sha256: 'z' }]]);
    expect(readingStates(db).find((x) => x.serverId === s1)).toMatchObject({ error: null });
  });

  it('refuses a busy or disabled box and one with no transport', () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(s1);
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    const r = new FleetReader({ db, reader: () => fake([]), now });
    expect(r.request([s1, s2, 99])).toEqual({ [s1]: 'busy', [s2]: 'disabled', 99: 'unknown' });
    const db2 = openDb(':memory:');
    const id = addServer(db2, { name: 'x', host: 'h', port: 1, rconPort: 1, rconPassword: 'x' });
    expect(new FleetReader({ db: db2, reader: () => null, now }).request([id])).toEqual({ [id]: 'no_transport' });
  });

  it('a box that turns busy before its read starts is skipped, keeping the old reading', async () => {
    const r = new FleetReader({ db, reader: () => fake([F('left4dead/cfg/a.cfg')]), now });
    r.request([s1]); await r.idle();
    const r2 = new FleetReader({ db, reader: () => fake([]), now });
    r2.request([s1]);
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(s1);
    await r2.idle();
    expect(readingsOf(db).get(s1)!.size).toBe(1);
    expect(readingStates(db).find((x) => x.serverId === s1)!.error).toMatch(/busy/);
  });

  it('a failure or a time-out keeps the old reading and records the error; other boxes go on', async () => {
    let fail = false;
    const r = new FleetReader({ db, now, limits: { local: 20 },
      reader: (s) => fake(s.id === s1 && fail ? () => new Promise<TreeFile[]>(() => {}) : async () => [F('left4dead/cfg/a.cfg')]) });
    r.request([s1, s2]); await r.idle();
    fail = true;
    r.request([s1, s2]); await r.idle();
    const st = readingStates(db);
    expect(st.find((x) => x.serverId === s1)!.error).toMatch(/timed out/);
    expect(readingsOf(db).get(s1)!.size).toBe(1);
    expect(st.find((x) => x.serverId === s2)!.error).toBeNull();
  });

  it('a second request for a queued box joins it', async () => {
    let reads = 0;
    const r = new FleetReader({ db, now, reader: () => fake(async () => { reads++; return []; }) });
    r.request([s1]); r.request([s1]);
    expect(r.pending(s1)).toBe(true);
    await r.idle();
    expect(reads).toBe(1);
  });

  it('the daily tick queues enabled idle boxes never read or read over 24 h ago', () => {
    db.prepare("INSERT INTO fleet_readings (server_id, read_at, attempt_at) VALUES (?, datetime('now', '-2 hours'), datetime('now'))").run(s1);
    const r = new FleetReader({ db, reader: () => fake([]), now });
    expect(r.tick()).toEqual([s2]);
  });
});
