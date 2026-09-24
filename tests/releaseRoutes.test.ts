import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { parseHumans } from '../src/serverRestart.js';
import type { TreeWriter } from '../src/fleetWrite.js';

const ADMIN = '76561198000000009';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CFG = 'left4dead/cfg/pug_match.cfg';

describe('parseHumans', () => {
  it('reads the player count from status', () => {
    expect(parseHumans('hostname: x\nplayers : 3 (8 max)\n')).toBe(3);
    expect(parseHumans('players : 0 humans, 4 bots (8 max)')).toBe(0);
    expect(parseHumans('nothing')).toBe(0);
  });
});

describe('release routes', () => {
  let root: string, work: string, db: ReturnType<typeof openDb>;
  const files = new Map<string, Buffer>();
  const writer: TreeWriter = {
    kind: 'local', read: async (p) => files.get(p) ?? null, write: async (p, b) => { files.set(p, b); },
    remove: async (p) => { files.delete(p); }, hash: async (ps) => new Map(ps.map((p) => [p, files.has(p) ? sha(files.get(p)!.toString()) : null])),
  };
  const git = (...a: string[]) => execFileSync('git', ['-C', work, ...a], { stdio: 'pipe' }).toString().trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rr-'));
    work = join(root, 'work');
    mkdirSync(join(work, 'overrides/left4dead/cfg'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'master', work]);
    git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
    writeFileSync(join(work, 'overrides/left4dead/cfg/pug_match.cfg'), 'z_tank_health 8000\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    writeFileSync(join(work, 'overrides/left4dead/cfg/pug_match.cfg'), 'z_tank_health 7500\n');
    git('add', '-A'); git('commit', '-qm', 'tank 7500');
    db = openDb(join(root, 'data', 'pug.db'));
    addServer(db, { name: 'Dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("UPDATE servers SET addons_transport = 'local', addons_dir = ? WHERE id = 1").run(join(root, 'game/left4dead/addons'));
    files.clear();
    files.set(CFG, Buffer.from('z_tank_health 8000\n'));
    db.prepare("INSERT INTO fleet_readings (server_id, read_at, attempt_at) VALUES (1, datetime('now'), datetime('now'))").run();
    db.prepare('INSERT INTO fleet_files (server_id, path, size, sha256) VALUES (1, ?, 19, ?)').run(CFG, sha('z_tank_health 8000\n'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function app() {
    const config = { ...loadConfig({ DB_PATH: join(root, 'data', 'pug.db'), DEPLOY_REPO_URL: work }), devMode: false };
    const a = await buildServer({ config, db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
      releaseWriter: () => writer, releaseHumans: async () => 0, serverRestarter: { restart: async () => true } });
    const cookies = await authedCookie(a, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('lists commits, stages one, reviews it per box with the cvar diff, deploys and undoes', async () => {
    const { a, cookies } = await app();
    const list = (await a.inject({ method: 'GET', url: '/api/admin/releases', cookies })).json() as { commits: { hash: string; subject: string }[] };
    expect(list.commits.map((c) => c.subject)).toEqual(['tank 7500', 'base']);
    const staged = (await a.inject({ method: 'POST', url: '/api/admin/releases/stage', cookies, payload: { commit: list.commits[0].hash } })).json() as { id: number };
    const review = (await a.inject({ method: 'GET', url: `/api/admin/releases/${staged.id}`, cookies })).json() as {
      state: string; invalid: string[]; perBox: { name: string; lines: string[]; deployable: boolean }[]; suggestion: string };
    expect(review.state).toBe('staged');
    expect(review.perBox[0]).toMatchObject({ name: 'Dallas', deployable: true });
    expect(review.perBox[0].lines).toEqual(['cfg changed: cfg/pug_match.cfg', '  z_tank_health 8000 → 7500']);
    const dep = await a.inject({ method: 'POST', url: `/api/admin/releases/${staged.id}/deploy`, cookies,
      payload: { targets: [1], canary: null, balance: { decision: 'balance', name: 'Tank 7500', notes: 'test' } } });
    expect(dep.json()).toEqual({ ok: true });
    await (a as unknown as { releaseEngine: { tick(): Promise<void> } }).releaseEngine.tick();
    expect(files.get(CFG)!.toString()).toBe('z_tank_health 7500\n');
    const undo = (await a.inject({ method: 'POST', url: `/api/admin/releases/${staged.id}/undo`, cookies, payload: {} })).json() as { id: number };
    await (a as unknown as { releaseEngine: { tick(): Promise<void> } }).releaseEngine.tick();
    expect(files.get(CFG)!.toString()).toBe('z_tank_health 8000\n');
    expect(undo.id).toBeGreaterThan(staged.id);
    const actions = (db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'release_%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['release_stage', 'release_deploy', 'release_undo']);
  });

  it('refuses a non-admin', async () => {
    const { a } = await app();
    const other = await authedCookie(a, db, '76561198000000010');
    expect((await a.inject({ method: 'GET', url: '/api/admin/releases', cookies: other })).statusCode).toBe(403);
  });
});
