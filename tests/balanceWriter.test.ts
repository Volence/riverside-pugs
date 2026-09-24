import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, getServer, markLive, type ServerRow } from '../src/serverPool.js';
import type { AddonsTransport } from '../src/addonsTransport.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';
import { BalanceRolloutWriter, cfgDirOf } from '../src/balanceWriter.js';
import { readFileSync } from 'node:fs';

type DB = ReturnType<typeof openDb>;

/** An in-memory cfg dir per server; `corrupt` makes read-back return other bytes. */
function fakeBoxes() {
  const disk = new Map<string, string>();
  const opts = { fail: new Set<number>(), corrupt: new Set<number>(), dirs: [] as string[] };
  const transport = (s: ServerRow, dir: string): AddonsTransport => {
    opts.dirs.push(dir);
    return {
      async put(local, name) {
        if (opts.fail.has(s.id)) throw new Error('connection refused');
        disk.set(`${s.id}/${name}`, readFileSync(local, 'utf8'));
      },
      async readText(name) {
        const v = disk.get(`${s.id}/${name}`);
        return v === undefined ? null : opts.corrupt.has(s.id) ? `${v}junk` : v;
      },
      async size() { return null; },
      async remove() {},
    };
  };
  return { disk, opts, transport };
}

let db: DB;
let s1: number;
let s2: number;
beforeEach(() => {
  db = openDb(':memory:');
  s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  db.prepare("UPDATE servers SET status = 'idle', addons_dir = '/g/left4dead/addons'").run();
  db.prepare("INSERT INTO balance_patches (id, fingerprint, source, first_seen_at) VALUES (1, 'f', 'announced', 'now')").run();
  db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 1, '{}', 'CONTENT', 'a', 'now')").run();
  db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, ?, 'pending'), (1, ?, 'pending')").run(s1, s2);
});
const state = (sid: number) => (db.prepare('SELECT state, last_error FROM balance_rollout_servers WHERE server_id = ?').get(sid) as { state: string; last_error: string | null });

describe('cfgDirOf', () => {
  it('replaces the addons segment with cfg', () => {
    expect(cfgDirOf({ addons_dir: '/left4dead/addons' } as never)).toBe('/left4dead/cfg');
    expect(cfgDirOf({ addons_dir: '/home/l4d/l4d1-a/left4dead/addons/' } as never)).toBe('/home/l4d/l4d1-a/left4dead/cfg');
    expect(cfgDirOf({ addons_dir: null } as never)).toBeNull();
    expect(cfgDirOf({ addons_dir: '/weird' } as never)).toBeNull();
  });
});

describe('BalanceRolloutWriter', () => {
  it('writes idle boxes, reads back, and marks them written', async () => {
    const f = fakeBoxes();
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    await w.sync();
    expect(f.disk.get(`${s1}/pug_balance.cfg`)).toBe('CONTENT');
    expect(f.opts.dirs[0]).toBe('/g/left4dead/cfg');
    expect(state(s1).state).toBe('written');
    expect(state(s2).state).toBe('written');
  });

  it('defers a live box, and the release path writes it regardless of status', async () => {
    const f = fakeBoxes();
    markLive(db, s2);
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    const out = await w.sync();
    expect(out.find((o) => o.serverId === s2)?.skipped).toBe('busy');
    expect(state(s2).state).toBe('pending');
    await w.writeForRelease(s2);
    expect(state(s2).state).toBe('written');
  });

  it('a failed write is failed with its error, alerts once, and is retried', async () => {
    const f = fakeBoxes();
    f.opts.fail.add(s1);
    const alerts: string[] = [];
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') alerts.push(e.text); });
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    await w.sync();
    await w.sync();
    off();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'connection refused' });
    expect(alerts.length).toBe(1);
    f.opts.fail.clear();
    await w.sync();
    expect(state(s1).state).toBe('written');
  });

  it('a read-back that differs is a failure', async () => {
    const f = fakeBoxes();
    f.opts.corrupt.add(s1);
    await new BalanceRolloutWriter({ db, transport: f.transport }).sync();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'read-back differs from what was written' });
  });

  it('boot verify: a matching file marks written, a changed file goes back to pending and is rewritten', async () => {
    const f = fakeBoxes();
    f.disk.set(`${s1}/pug_balance.cfg`, 'CONTENT');
    f.disk.set(`${s2}/pug_balance.cfg`, 'OLD');
    db.prepare("UPDATE balance_rollout_servers SET state = 'confirmed' WHERE server_id = ?").run(s2);
    markLive(db, s2);
    await new BalanceRolloutWriter({ db, transport: f.transport }).verifyAll();
    expect(state(s1).state).toBe('written');
    expect(state(s2)).toEqual({ state: 'pending', last_error: 'the file on the box differs from the rollout' });
  });

  it('a server with no transport is failed, not skipped silently', async () => {
    db.prepare('UPDATE servers SET addons_dir = NULL WHERE id = ?').run(s1);
    await new BalanceRolloutWriter({ db, transport: fakeBoxes().transport }).sync();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'no addons transport configured' });
  });

  it('adds rows for servers enabled after the apply and skips disabled ones', async () => {
    const s3 = addServer(db, { name: 'r3', host: '10.0.0.3', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle', addons_dir = '/g/left4dead/addons' WHERE id = ?").run(s3);
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    await new BalanceRolloutWriter({ db, transport: fakeBoxes().transport }).sync();
    expect(state(s3).state).toBe('written');
    expect(state(s2).state).toBe('pending');
  });

  it('does nothing without an active rollout', async () => {
    db.prepare("UPDATE balance_rollouts SET superseded_at = 'x'").run();
    expect(await new BalanceRolloutWriter({ db, transport: fakeBoxes().transport }).sync()).toEqual([]);
  });

  it('a hung transport times out instead of wedging the chain', async () => {
    const hung = (): AddonsTransport => ({ put: () => new Promise(() => {}), readText: async () => null, size: async () => null, remove: async () => {} });
    const w = new BalanceRolloutWriter({ db, transport: hung, timeoutMs: 20 });
    await w.sync();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'timed out after 20 ms' });
  });
});

// getServer is imported to keep the ServerRow import used by type-only checks.
void getServer;
