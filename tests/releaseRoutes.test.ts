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
    // A release restarts only on a count of exactly 0, so no count is no 0.
    expect(() => parseHumans('nothing')).toThrow();
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
    // The fleet view names the release once the box's reading shows its copy.
    db.prepare('UPDATE fleet_files SET size = 19, sha256 = ? WHERE server_id = 1 AND path = ?').run(sha('z_tank_health 7500\n'), CFG);
    const fleet = (await a.inject({ method: 'GET', url: '/api/admin/fleet', cookies })).json() as { repo: { label: string }; rows: { path: string; cells: Record<string, { origin: number | null; label: string }> }[] };
    expect(fleet.rows.find((r) => r.path === CFG)!.cells['1']).toMatchObject({ label: 'repo', origin: staged.id });
    const undo = (await a.inject({ method: 'POST', url: `/api/admin/releases/${staged.id}/undo`, cookies, payload: {} })).json() as { id: number };
    await (a as unknown as { releaseEngine: { tick(): Promise<void> } }).releaseEngine.tick();
    expect(files.get(CFG)!.toString()).toBe('z_tank_health 8000\n');
    expect(undo.id).toBeGreaterThan(staged.id);
    const actions = (db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'release_%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['release_stage', 'release_deploy', 'release_undo']);
  });

  it('warns when a per-box file would be replaced by the shared copy', async () => {
    mkdirSync(join(work, 'overrides/left4dead/cfg'), { recursive: true });
    writeFileSync(join(work, 'overrides/left4dead/cfg/local.cfg'), 'tv_title "Dallas"\n');
    git('add', '-A'); git('commit', '-qm', 'shared local');
    db.prepare('INSERT INTO fleet_files (server_id, path, size, sha256) VALUES (1, ?, 5, ?)').run('left4dead/cfg/local.cfg', sha('other'));
    const { a, cookies } = await app();
    await a.inject({ method: 'POST', url: '/api/admin/releases/refresh', cookies });
    const { id } = (await a.inject({ method: 'POST', url: '/api/admin/releases/stage', cookies, payload: { commit: 'master' } })).json() as { id: number };
    const review = (await a.inject({ method: 'GET', url: `/api/admin/releases/${id}`, cookies })).json() as { perBox: { warnings: string[] }[] };
    expect(review.perBox[0].warnings.join(' ')).toMatch(/per-box file and would be replaced by the shared copy: add this box's own copy under boxes\/dallas\//);
  });

  /** Stages master and returns Dallas's review row. */
  async function stageAndReview() {
    const { a, cookies } = await app();
    await a.inject({ method: 'POST', url: '/api/admin/releases/refresh', cookies });
    const { id } = (await a.inject({ method: 'POST', url: '/api/admin/releases/stage', cookies, payload: { commit: 'master' } })).json() as { id: number };
    const review = (await a.inject({ method: 'GET', url: `/api/admin/releases/${id}`, cookies })).json() as { perBox: { deployable: boolean; warnings: string[]; lines: string[] }[] };
    return review.perBox[0];
  }
  const LOCAL = 'left4dead/cfg/local.cfg';

  it('keeps a box on its own layer after a rename', async () => {
    mkdirSync(join(work, 'boxes/dallas/left4dead/cfg'), { recursive: true });
    writeFileSync(join(work, 'boxes/dallas/left4dead/cfg/local.cfg'), 'exec secrets.cfg\n');
    git('add', '-A'); git('commit', '-qm', 'dallas local');
    writeFileSync(join(work, 'overrides/left4dead/cfg/pug_match.cfg'), 'z_tank_health 7000\n');
    git('add', '-A'); git('commit', '-qm', 'tank 7000');
    db.prepare('INSERT INTO fleet_files (server_id, path, size, sha256) VALUES (1, ?, 17, ?)').run(LOCAL, sha('exec secrets.cfg\n'));
    // An earlier release shipped Dallas its own local.cfg.
    const prev = Number(db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at, deployed_at) VALUES ('deploy', '[]', 'done', '1', 'x', 'x')").run().lastInsertRowid);
    db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, 1, 'restarted', '[]', ?, 'x')")
      .run(prev, JSON.stringify({ [LOCAL]: { sha256: sha('exec secrets.cfg\n'), blob: 'b' } }));
    db.prepare("UPDATE servers SET name = 'Dallas TX' WHERE id = 1").run();
    const box = await stageAndReview();
    expect(box.deployable).toBe(true);
    expect(box.lines.join(' ')).not.toMatch(/local\.cfg/);
  });

  it('refuses to plan a box whose slug has no folder under boxes/', async () => {
    mkdirSync(join(work, 'boxes/chicago/left4dead/cfg'), { recursive: true });
    writeFileSync(join(work, 'boxes/chicago/left4dead/cfg/local.cfg'), 'x\n');
    git('add', '-A'); git('commit', '-qm', 'chicago only');
    const box = await stageAndReview();
    expect(box.deployable).toBe(false);
    expect(box.warnings.join(' ')).toMatch(/no boxes\/dallas\/ folder/);
  });

  it('blocks a release that would remove a per-box file', async () => {
    mkdirSync(join(work, 'boxes/dallas/left4dead/cfg'), { recursive: true });
    writeFileSync(join(work, 'boxes/dallas/left4dead/cfg/local.cfg'), 'exec secrets.cfg\n');
    writeFileSync(join(work, 'boxes/dallas/left4dead/cfg/other.cfg'), 'x\n');
    git('add', '-A'); git('commit', '-qm', 'dallas local');
    git('rm', '-q', 'boxes/dallas/left4dead/cfg/local.cfg'); git('commit', '-qm', 'oops');
    db.prepare('INSERT INTO fleet_files (server_id, path, size, sha256) VALUES (1, ?, 17, ?)').run(LOCAL, sha('exec secrets.cfg\n'));
    const box = await stageAndReview();
    expect(box.deployable).toBe(false);
    expect(box.warnings.join(' ')).toMatch(/would remove the per-box file cfg\/local\.cfg/);
  });

  it('refuses a release that would remove a file the site writes', async () => {
    const BAL = 'left4dead/cfg/pug_balance.cfg';
    db.prepare('INSERT INTO fleet_files (server_id, path, size, sha256) VALUES (1, ?, 5, ?)').run(BAL, sha('x'));
    // Shipped by a release from before the rule.
    const prev = Number(db.prepare("INSERT INTO releases (kind, sources_json, state, created_by, created_at, deployed_at) VALUES ('deploy', '[]', 'done', '1', 'x', 'x')").run().lastInsertRowid);
    db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, 1, 'restarted', '[]', ?, 'x')")
      .run(prev, JSON.stringify({ [BAL]: { sha256: sha('x'), blob: 'b' } }));
    const { a, cookies } = await app();
    await a.inject({ method: 'POST', url: '/api/admin/releases/refresh', cookies });
    const { id } = (await a.inject({ method: 'POST', url: '/api/admin/releases/stage', cookies, payload: { commit: 'master' } })).json() as { id: number };
    const review = (await a.inject({ method: 'GET', url: `/api/admin/releases/${id}`, cookies })).json() as { state: string; invalid: string[] };
    expect(review.state).toBe('invalid');
    expect(review.invalid.join(' ')).toMatch(/would remove left4dead\/cfg\/pug_balance\.cfg from Dallas, which the site writes/);
  });

  it('refuses a committed rcon_password, and only warns on a tv_password', async () => {
    writeFileSync(join(work, 'overrides/left4dead/cfg/pug_match.cfg'), 'z_tank_health 7000\ntv_password "watch"\n');
    git('add', '-A'); git('commit', '-qm', 'tv password');
    const box = await stageAndReview();
    expect(box.deployable).toBe(true);
    expect(box.warnings.join(' ')).toMatch(/tv_password is set in cfg\/pug_match\.cfg/);
    writeFileSync(join(work, 'overrides/left4dead/cfg/pug_match.cfg'), 'z_tank_health 7000\nrcon_password "hunter2"\n');
    git('add', '-A'); git('commit', '-qm', 'rcon password');
    const { a, cookies } = await app();
    await a.inject({ method: 'POST', url: '/api/admin/releases/refresh', cookies });
    const { id } = (await a.inject({ method: 'POST', url: '/api/admin/releases/stage', cookies, payload: { commit: 'master' } })).json() as { id: number };
    const review = (await a.inject({ method: 'GET', url: `/api/admin/releases/${id}`, cookies })).json() as { state: string; invalid: string[] };
    expect(review.state).toBe('invalid');
    expect(review.invalid.join(' ')).toMatch(/rcon_password is set in left4dead\/cfg\/pug_match\.cfg.*secrets\.cfg/);
  });

  it('refuses a non-admin', async () => {
    const { a } = await app();
    const other = await authedCookie(a, db, '76561198000000010');
    expect((await a.inject({ method: 'GET', url: '/api/admin/releases', cookies: other })).statusCode).toBe(403);
  });
});
