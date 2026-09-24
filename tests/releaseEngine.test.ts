import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { addServer, getServer } from '../src/serverPool.js';
import { ReleaseEngine } from '../src/releaseEngine.js';
import type { TreeWriter } from '../src/fleetWrite.js';
import type { Op } from '../src/releaseStage.js';

type DB = ReturnType<typeof openDb>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const A = 'left4dead/cfg/a.cfg', B = 'left4dead/cfg/b.cfg';

function box(files: Record<string, string>, fail: { on?: 'write' | 'hash'; path?: string } = {}) {
  const fs = new Map<string, Buffer>(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  const w: TreeWriter = {
    kind: 'local',
    read: async (p) => fs.get(p) ?? null,
    write: async (p, b) => { if (fail.on === 'write' && (!fail.path || fail.path === p)) throw new Error('disk full'); fs.set(p, b); },
    remove: async (p) => { fs.delete(p); },
    hash: async (ps) => new Map(ps.map((p) => [p, fail.on === 'hash' ? 'bad' : fs.has(p) ? sha(fs.get(p)!.toString()) : null])),
  };
  return { fs, w };
}

describe('ReleaseEngine', () => {
  let db: DB, dir: string, s1: number, s2: number;
  let boxes: Record<number, ReturnType<typeof box>>;
  let restarts: number[];
  const blobs: Record<string, string> = { ba: 'A2', bb: 'B1' };
  const plan: Op[] = [
    { path: A, op: 'write', kind: 'update', size: 2, sha256: sha('A2'), blob: 'ba' },
    { path: B, op: 'write', kind: 'add', size: 2, sha256: sha('B1'), blob: 'bb' },
  ];
  function stage(ops: Op[] = plan) {
    const id = Number(db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at) VALUES ('deploy', '[]', 'staged', '1', datetime('now'))").run().lastInsertRowid);
    for (const s of [s1, s2]) db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, ?, 'staged', ?, '{}', 'x')").run(id, s, JSON.stringify(ops));
    return id;
  }
  const engine = (over: Partial<ConstructorParameters<typeof ReleaseEngine>[0]> = {}) => new ReleaseEngine({
    db, releasesDir: dir, devMode: false,
    blob: async (id) => Buffer.from(blobs[id]),
    writer: (s) => boxes[s.id].w,
    restarter: { restart: async (s) => { restarts.push(s.id); return true; } },
    humans: async () => 0, sleep: async () => {}, ...over,
  });
  const boxState = (id: number, s: number) => (db.prepare('SELECT state, error FROM release_boxes WHERE release_id = ? AND server_id = ?').get(id, s) as { state: string; error: string | null });
  const relState = (id: number) => (db.prepare('SELECT state FROM releases WHERE id = ?').get(id) as { state: string }).state;

  beforeEach(() => {
    db = openDb(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'rel-'));
    s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    boxes = { [s1]: box({ [A]: 'A1' }), [s2]: box({ [A]: 'A1' }) };
    restarts = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const later = { decision: 'later' as const };

  it('deploys to every target: backup, write, verify, restart, and the release is done', async () => {
    const e = engine();
    const id = stage();
    expect(e.deploy(id, { targets: [s1, s2], canary: null, balance: later, adminId: '1' })).toEqual({ ok: true });
    await e.tick(); await e.settled();
    expect(boxes[s1].fs.get(A)!.toString()).toBe('A2');
    expect(boxes[s2].fs.get(B)!.toString()).toBe('B1');
    expect(boxState(id, s1).state).toBe('restarted');
    expect(restarts).toEqual([s1, s2]);
    expect(getServer(db, s1)!.status).toBe('idle');
    expect(relState(id)).toBe('done');
  });

  it('a failure restores the backup, marks the box failed without restart, and other boxes go on', async () => {
    boxes[s1] = box({ [A]: 'A1' }, { on: 'write', path: B });
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1, s2], canary: null, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    expect(boxes[s1].fs.get(A)!.toString()).toBe('A1');
    expect(boxes[s1].fs.has(B)).toBe(false);
    expect(boxState(id, s1)).toEqual({ state: 'failed', error: expect.stringMatching(/disk full/) });
    expect(boxState(id, s2).state).toBe('restarted');
    expect(restarts).toEqual([s2]);
    expect(getServer(db, s1)!.status).toBe('idle');
  });

  it('a verify mismatch is a failure', async () => {
    boxes[s1] = box({ [A]: 'A1' }, { on: 'hash' });
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    expect(boxState(id, s1).state).toBe('failed');
    expect(boxState(id, s2).state).toBe('skipped');
  });

  it('canary first: waits for continue; a failed canary halts the rest', async () => {
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1, s2], canary: s2, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    expect(boxState(id, s2).state).toBe('restarted');
    expect(boxState(id, s1).state).toBe('pending');
    expect(relState(id)).toBe('canary_wait');
    await e.tick(); await e.settled();
    expect(boxState(id, s1).state).toBe('pending');
    expect(e.continueRelease(id, '1')).toEqual({ ok: true });
    await e.tick(); await e.settled();
    expect(boxState(id, s1).state).toBe('restarted');
    expect(relState(id)).toBe('done');

    boxes[s2] = box({ [A]: 'A2', [B]: 'B1' }, { on: 'write' });
    const id2 = stage([plan[0]]);
    boxes[s2].fs.set(A, Buffer.from('A1'));
    e.deploy(id2, { targets: [s1, s2], canary: s2, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    expect(relState(id2)).toBe('halted');
    expect(boxState(id2, s1).state).toBe('skipped');
  });

  it('a busy box waits; its turn comes when idle, or through the release hook', async () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(s1);
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    expect(boxState(id, s1).state).toBe('waiting');
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(s1); // the releaser is restarting it
    await e.forRelease(s1);
    expect(boxState(id, s1).state).toBe('restarted');
    expect(restarts).toEqual([]); // the releaser does the restart
  });

  it('never touches a parked (offline) box outside the release hook', async () => {
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(s1);
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    expect(boxState(id, s1).state).toBe('waiting');
    expect(boxes[s1].fs.get(A)!.toString()).toBe('A1');
    expect(getServer(db, s1)!.status).toBe('offline');
  });

  it('refuses a stale plan and an undo under a newer release', async () => {
    const e = engine();
    const older = stage();
    db.prepare("UPDATE releases SET created_at = '2000-01-01 00:00:00' WHERE id = ?").run(older);
    const newer = stage();
    e.deploy(newer, { targets: [s1], canary: null, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    expect(e.deploy(older, { targets: [s1], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/review this commit again/) });
    // An older deployed release on the same box cannot be undone past the newer one.
    db.prepare("UPDATE releases SET state = 'done', deployed_at = '2000-01-01 00:00:00' WHERE id = ?").run(older);
    db.prepare("UPDATE release_boxes SET state = 'restarted' WHERE release_id = ? AND server_id = ?").run(older, s1);
    expect(e.undo(older, [s1], '1')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/undo it first/) });
  });

  it('the release hook is capped behind a slow box', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    boxes[s2].w.read = async (p) => { await slow; return boxes[s2].fs.get(p) ?? null; };
    const e = engine({ hookCapMs: 20 });
    const id = stage();
    e.deploy(id, { targets: [s1, s2], canary: null, balance: later, adminId: '1' });
    db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(s1);
    const t = e.tick();
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(s1);
    const started = Date.now();
    await e.forRelease(s1);
    expect(Date.now() - started).toBeLessThan(1000);
    release();
    await t; await e.settled();
  });

  it('waits for the box to empty, up to a limit, before restarting', async () => {
    let n = 2;
    const e = engine({ humans: async () => n--, emptyWaitMs: 10_000, emptyPollMs: 1 });
    const id = stage();
    e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    expect(restarts).toEqual([s1]);
    expect(n).toBe(-1);
  });

  it('refuses in dev mode, a second in-flight release, bad targets and a nameless balance patch', () => {
    const id = stage();
    expect(engine({ devMode: true }).deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 409 });
    const e = engine();
    expect(e.deploy(id, { targets: [], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 400 });
    expect(e.deploy(id, { targets: [99], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 400 });
    expect(e.deploy(id, { targets: [s1], canary: null, balance: { decision: 'balance', name: ' ' }, adminId: '1' })).toMatchObject({ ok: false, status: 400 });
    expect(e.deploy(id, { targets: [s1], canary: null, balance: later, adminId: '1' })).toEqual({ ok: true });
    expect(e.deploy(stage(), { targets: [s1], canary: null, balance: later, adminId: '1' })).toMatchObject({ ok: false, status: 409 });
  });

  it('undo restores exactly: updated files back, added files removed', async () => {
    const e = engine();
    const id = stage();
    e.deploy(id, { targets: [s1, s2], canary: null, balance: later, adminId: '1' });
    await e.tick(); await e.settled();
    const u = e.undo(id, [s1], '1');
    expect(u).toMatchObject({ ok: true });
    await e.tick(); await e.settled();
    expect(boxes[s1].fs.get(A)!.toString()).toBe('A1');
    expect(boxes[s1].fs.has(B)).toBe(false);
    expect(boxes[s2].fs.get(A)!.toString()).toBe('A2'); // not undone
    expect(boxState(id, s1).state).toBe('undone');
    expect(e.expireBackups(Date.now() + 31 * 86_400_000)).toBe(2);
    expect(e.undo(id, [s2], '1')).toMatchObject({ ok: false, status: 409 });
  });

  it('recover marks an interrupted box failed and lifts its hold', () => {
    const id = stage();
    db.prepare("UPDATE releases SET state = 'deploying' WHERE id = ?").run(id);
    db.prepare("UPDATE release_boxes SET state = 'writing' WHERE release_id = ? AND server_id = ?").run(id, s1);
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(s1);
    engine().recover();
    expect(boxState(id, s1)).toEqual({ state: 'failed', error: expect.stringMatching(/interrupted/) });
    expect(getServer(db, s1)!.status).toBe('idle');
  });
});
