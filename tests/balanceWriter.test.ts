import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, claimIdle, markLive, type ServerRow } from '../src/serverPool.js';
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

  it('defers a live box to the release path', async () => {
    const f = fakeBoxes();
    markLive(db, s2);
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    const out = await w.sync();
    expect(out.find((o) => o.serverId === s2)?.skipped).toBe('busy');
    expect(state(s2).state).toBe('pending');
  });

  it('the release path writes an offline (restarting) box', async () => {
    const f = fakeBoxes();
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(s2);
    await new BalanceRolloutWriter({ db, transport: f.transport }).writeForRelease(s2);
    expect(state(s2).state).toBe('written');
    expect(f.disk.get(`${s2}/pug_balance.cfg`)).toBe('CONTENT');
  });

  it('the release path writes an idle box', async () => {
    const f = fakeBoxes();
    await new BalanceRolloutWriter({ db, transport: f.transport }).writeForRelease(s2);
    expect(state(s2).state).toBe('written');
  });

  it('the release path leaves a box a new match has already claimed (reserved or live) to the sweep', async () => {
    const f = fakeBoxes();
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(s1);
    markLive(db, s2);
    const w = new BalanceRolloutWriter({ db, transport: f.transport });
    await w.writeForRelease(s1);
    await w.writeForRelease(s2);
    expect(state(s1).state).toBe('pending');
    expect(state(s2).state).toBe('pending');
    expect(f.disk.size).toBe(0);
  });

  it('coalesces sweeps: a sync queued behind another that has not started returns the same promise', async () => {
    const f = fakeBoxes();
    let puts = 0;
    const transport = (s: ServerRow, dir: string): AddonsTransport => {
      const t = f.transport(s, dir);
      return { ...t, async put(local, name) { puts += 1; return t.put(local, name); } };
    };
    const w = new BalanceRolloutWriter({ db, transport });
    const a = w.sync();
    const b = w.sync();
    expect(b).toBe(a);
    expect(await b).toEqual(await a);
    expect(puts).toBe(2); // one per server, not two passes
    const c = w.sync();
    expect(c).not.toBe(a);
    await c;
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

  it('boot verify: a matching file marks written, a changed file is put back to pending and rewritten', async () => {
    const f = fakeBoxes();
    f.disk.set(`${s1}/pug_balance.cfg`, 'CONTENT');
    f.disk.set(`${s2}/pug_balance.cfg`, 'OLD');
    db.prepare("UPDATE balance_rollout_servers SET state = 'confirmed' WHERE server_id = ?").run(s2);
    await new BalanceRolloutWriter({ db, transport: f.transport }).verifyAll();
    expect(state(s1).state).toBe('written');
    expect(state(s2).state).toBe('written');
    expect(f.disk.get(`${s2}/pug_balance.cfg`)).toBe('CONTENT');
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

  it('a timed-out write is tracked until it actually settles, and is not retried until then', async () => {
    const disk = new Map<string, string>();
    const resolvers = new Map<number, () => void>();
    const hangOnce = new Set<number>([s1]);
    const transport = (s: ServerRow): AddonsTransport => ({
      async put(local, name) {
        if (hangOnce.has(s.id)) {
          hangOnce.delete(s.id);
          await new Promise<void>((resolve) => resolvers.set(s.id, resolve));
        }
        disk.set(`${s.id}/${name}`, readFileSync(local, 'utf8'));
      },
      async readText(name) { return disk.get(`${s.id}/${name}`) ?? null; },
      async size() { return null; },
      async remove() {},
    });
    const w = new BalanceRolloutWriter({ db, transport, timeoutMs: 20 });

    await w.sync();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'timed out after 20 ms' });
    expect(state(s2).state).toBe('written');

    const out = await w.sync();
    expect(out.find((o) => o.serverId === s1)?.skipped).toBe('previous write still running');
    expect(state(s1).state).toBe('failed');

    // The original write finally lands. Let its continuation, and the
    // in-flight tracking promise's own settle handler, actually run.
    resolvers.get(s1)!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    await w.sync();
    expect(state(s1).state).toBe('written');
    expect(disk.get(`${s1}/pug_balance.cfg`)).toBe('CONTENT');
  });

  it('re-checks status right before each write, so a status change mid-pass is honoured', async () => {
    const f = fakeBoxes();
    const transport = (s: ServerRow, dir: string): AddonsTransport => {
      const t = f.transport(s, dir);
      return {
        ...t,
        async put(local, name) {
          if (s.id === s1) markLive(db, s2);
          return t.put(local, name);
        },
      };
    };
    const w = new BalanceRolloutWriter({ db, transport });
    const out = await w.sync();
    expect(out.find((o) => o.serverId === s2)?.skipped).toBe('busy');
    expect(state(s2).state).toBe('pending');
  });

  it('writeForRelease caps its wait and does not write a box that has gone live by the time its turn comes', async () => {
    const disk = new Map<string, string>();
    const transport = (s: ServerRow): AddonsTransport => ({
      // Every server hangs forever, standing in for a slow earlier pass that
      // is still occupying the chain when the release below needs its turn.
      async put() { await new Promise<void>(() => {}); },
      async readText(name) { return disk.get(`${s.id}/${name}`) ?? null; },
      async size() { return null; },
      async remove() {},
    });
    // s4 is filler: a third box that genuinely hangs its own bounded wait, so
    // the pass this test occupies the chain with (s1, s2, s4, each a full
    // timeoutMs) clearly outlasts writeForRelease's 2x timeoutMs cap. s3 is
    // the box under test: already live by the time the pass reaches it, so it
    // costs the pass nothing and is skipped as busy there.
    const s3 = addServer(db, { name: 'r3', host: '10.0.0.3', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const s4 = addServer(db, { name: 'r4', host: '10.0.0.4', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle', addons_dir = '/g/left4dead/addons' WHERE id IN (?, ?)").run(s3, s4);
    db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, ?, 'pending'), (1, ?, 'pending')").run(s3, s4);

    const timeoutMs = 150;
    const w = new BalanceRolloutWriter({ db, transport, timeoutMs });
    void w.sync(); // occupies the chain for ~3 x timeoutMs (s1, s2, s4 each time out; s3 is skipped free)

    markLive(db, s3);
    const startedAt = Date.now();
    await w.writeForRelease(s3);
    const elapsed = Date.now() - startedAt;
    // The cap fires at 2 x timeoutMs (300 ms) and the pass ahead finishes at
    // about 3 x timeoutMs (450 ms); both bounds sit well clear of either edge.
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs * 2 - 5); // resolved by the cap, not earlier
    expect(elapsed).toBeLessThan(timeoutMs * 2.5); // and well before the pass it was queued behind finishes

    // Flush the chain (the pass, then writeForRelease's own deferred turn).
    await w.sync();
    expect(state(s3).state).not.toBe('written');
    expect(disk.has(`${s3}/pug_balance.cfg`)).toBe(false);
  });

  it('after the cap, the deferred release turn writes only an idle box, not one still offline for the restart', async () => {
    const disk = new Map<string, string>();
    const hanging = new Set<number>();
    const transport = (s: ServerRow): AddonsTransport => ({
      async put(local, name) {
        if (hanging.has(s.id)) await new Promise<void>(() => {});
        disk.set(`${s.id}/${name}`, readFileSync(local, 'utf8'));
      },
      async readText(name) { return disk.get(`${s.id}/${name}`) ?? null; },
      async size() { return null; },
      async remove() {},
    });
    // Same shape as above: s1, s2 and s4 hang and hold the chain for about
    // 3 x timeoutMs; s3 is the box being released, offline for its restart.
    // Its own put would succeed, so only the post-cap idle rule keeps it
    // from being written once its turn finally comes after the cap.
    const s3 = addServer(db, { name: 'r3', host: '10.0.0.3', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const s4 = addServer(db, { name: 'r4', host: '10.0.0.4', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle', addons_dir = '/g/left4dead/addons' WHERE id IN (?, ?)").run(s3, s4);
    db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, ?, 'pending'), (1, ?, 'pending')").run(s3, s4);
    for (const id of [s1, s2, s4]) hanging.add(id);

    const w = new BalanceRolloutWriter({ db, transport, timeoutMs: 60 });
    void w.sync();
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(s3);
    await w.writeForRelease(s3); // resolved by the cap
    await w.sync(); // flush: the pass, the deferred release turn, then this pass (which skips offline s3 as busy)
    expect(disk.has(`${s3}/pug_balance.cfg`)).toBe(false);
    expect(state(s3).state).toBe('pending');
  });
});

describe('BalanceRolloutWriter holds a box out of the pool while it writes', () => {
  const statusOf = (sid: number) => (db.prepare('SELECT status FROM servers WHERE id = ?').get(sid) as { status: string }).status;

  it('the sweep takes the box out of the pool for the write, so claimIdle cannot hand it to a match mid-write', async () => {
    const f = fakeBoxes();
    const during: { status: string; claimed: number | null }[] = [];
    const transport = (s: ServerRow, dir: string): AddonsTransport => {
      const t = f.transport(s, dir);
      return { ...t, async put(local, name) {
        during.push({ status: statusOf(s.id), claimed: claimIdle(db)?.id ?? null });
        return t.put(local, name);
      } };
    };
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    const freed: number[] = [];
    await new BalanceRolloutWriter({ db, transport, onFreed: () => freed.push(1) }).sync();
    expect(during).toEqual([{ status: 'reserved', claimed: null }]);
    expect(statusOf(s1)).toBe('idle');
    expect(state(s1).state).toBe('written');
    expect(freed.length).toBe(1);
  });

  it('the release path holds an idle box the same way', async () => {
    const f = fakeBoxes();
    const during: string[] = [];
    const transport = (s: ServerRow, dir: string): AddonsTransport => {
      const t = f.transport(s, dir);
      return { ...t, async put(local, name) { during.push(statusOf(s.id)); return t.put(local, name); } };
    };
    await new BalanceRolloutWriter({ db, transport }).writeForRelease(s1);
    expect(during).toEqual(['reserved']);
    expect(statusOf(s1)).toBe('idle');
  });

  it('never frees a box a match took over during the write', async () => {
    const f = fakeBoxes();
    const transport = (s: ServerRow, dir: string): AddonsTransport => {
      const t = f.transport(s, dir);
      return { ...t, async put(local, name) {
        // An in-game !load_4v4p adopted on this box while the file went out.
        db.prepare("INSERT INTO matches (season_id, state, campaign, server_id, origin) VALUES (1, 'live', 'dead_air', ?, 'in_game')").run(s.id);
        markLive(db, s.id);
        return t.put(local, name);
      } };
    };
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    await new BalanceRolloutWriter({ db, transport }).sync();
    expect(statusOf(s1)).toBe('live');
  });

  it('never frees a box a queue match is configuring on, even if it reads reserved', async () => {
    const f = fakeBoxes();
    const transport = (s: ServerRow, dir: string): AddonsTransport => {
      const t = f.transport(s, dir);
      return { ...t, async put(local, name) {
        // Adopted, finished and claimed again by the queue, all mid-write.
        db.prepare("INSERT INTO matches (season_id, state, campaign, server_id, origin) VALUES (1, 'configuring', 'dead_air', ?, 'queue')").run(s.id);
        return t.put(local, name);
      } };
    };
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    await new BalanceRolloutWriter({ db, transport }).sync();
    expect(statusOf(s1)).toBe('reserved');
  });

  it('skips a box with players on it, and one whose player count cannot be read, and puts it back in the pool', async () => {
    const f = fakeBoxes();
    const humans = async (s: ServerRow) => {
      expect(statusOf(s.id)).toBe('reserved'); // counted under the hold, not before it
      if (s.id === s1) return 2;
      throw new Error('rcon connect timeout');
    };
    const out = await new BalanceRolloutWriter({ db, transport: f.transport, humans }).sync();
    expect(out.find((o) => o.serverId === s1)?.skipped).toBe('players on the server');
    expect(out.find((o) => o.serverId === s2)?.skipped).toMatch(/could not count players/);
    expect(f.disk.size).toBe(0);
    expect(state(s1).state).toBe('pending');
    expect(statusOf(s1)).toBe('idle');
    expect(statusOf(s2)).toBe('idle');
  });

  it('writes a box whose player count is zero', async () => {
    const f = fakeBoxes();
    await new BalanceRolloutWriter({ db, transport: f.transport, humans: async () => 0 }).sync();
    expect(state(s1).state).toBe('written');
  });

  it('the release path counts players on an idle box too, but not on one offline for its restart', async () => {
    const f = fakeBoxes();
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(s2);
    const asked: number[] = [];
    const w = new BalanceRolloutWriter({ db, transport: f.transport, humans: async (s) => { asked.push(s.id); return 3; } });
    await w.writeForRelease(s1);
    await w.writeForRelease(s2);
    expect(asked).toEqual([s1]);
    expect(state(s1).state).toBe('pending');
    expect(state(s2).state).toBe('written');
  });

  it('a timeout aborts the transport call, and the box stays held until that call has settled', async () => {
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    const transport = (): AddonsTransport => ({
      // Ignores the abort, standing in for a rename already on the wire.
      put: (_l, _n, opts) => { signal = opts?.signal; return new Promise<void>((r) => { finish = r; }); },
      readText: async () => null, size: async () => null, remove: async () => {},
    });
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    const w = new BalanceRolloutWriter({ db, transport, timeoutMs: 20 });
    await w.sync();
    expect(state(s1)).toEqual({ state: 'failed', last_error: 'timed out after 20 ms' });
    expect(signal?.aborted).toBe(true);
    expect(statusOf(s1)).toBe('reserved');
    expect(claimIdle(db)).toBeNull();
    finish();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(statusOf(s1)).toBe('idle');
  });
});
