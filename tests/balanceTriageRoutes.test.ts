import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { recordBalanceSighting } from '../src/balancePatches.js';
import { addIgnored } from '../src/balanceIgnore.js';
import { KNOBS } from './balanceFixtures.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN = '76561198000000009';
const USER = '76561198000000010';
const BASE = { 'c:z_tank_health': '8000', 'p:pug-match.smx': '1.a' };

describe('patch triage routes', () => {
  let db: ReturnType<typeof openDb>;
  let knobsPath: string;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'completed', 'x', ?)").run('d'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a'), (1, 0, 2, 'b')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: BASE, versionless: KNOBS.versionless, now: '2026-09-20 00:00:00' });
    db.prepare("UPDATE balance_patches SET triage = 'balance', name = 'Base' WHERE id = 1").run();
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 2, inventory: { ...BASE, 'p:x_noise.smx': '1.a' }, versionless: KNOBS.versionless, now: '2026-09-21 00:00:00' });
    knobsPath = join(mkdtempSync(join(tmpdir(), 'knobs-')), 'knobs.json');
    writeFileSync(knobsPath, JSON.stringify(KNOBS));
  });

  async function app(asAdmin = true) {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {}, balanceKnobsPath: knobsPath });
    const cookies = await authedCookie(a, db, asAdmin ? ADMIN : USER);
    if (asAdmin) db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('lists the pending patch with its card info', async () => {
    const { a, cookies } = await app();
    const body = (await a.inject({ method: 'GET', url: '/api/admin/balance/patches', cookies })).json() as { patches: { id: number; triage: string; changes: string[]; onlyPluginsChanged: boolean; triageBase: { id: number } }[] };
    expect(body.patches[1]).toMatchObject({ id: 2, triage: 'pending', changes: ['plugin added: x_noise'], onlyPluginsChanged: true, triageBase: { id: 1 } });
  });

  it('refuses a non-admin', async () => {
    const { a, cookies } = await app(false);
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/2/triage', cookies, payload: { decision: 'fold', into: 1 } });
    expect(res.statusCode).toBe(403);
  });

  it('balance, fold, unfold and ignore, each audited', async () => {
    const { a, cookies } = await app();
    const post = (url: string, payload?: object) => a.inject({ method: 'POST', url, cookies, payload: payload ?? {} });
    expect((await post('/api/admin/balance/patches/2/triage', { decision: 'bogus' })).statusCode).toBe(400);
    expect((await post('/api/admin/balance/patches/2/triage', { decision: 'fold', into: 1 })).json()).toEqual({ ok: true, target: 1 });
    expect((await post('/api/admin/balance/patches/2/unfold')).json()).toEqual({ ok: true });
    const ig = await post('/api/admin/balance/patches/2/triage', { decision: 'ignore', into: 1, plugins: ['x_noise.smx'] });
    expect(ig.json()).toEqual({ ok: true, target: 1 });
    const list = (await a.inject({ method: 'GET', url: '/api/admin/balance/ignored-plugins', cookies })).json() as { plugins: { file: string; source: string }[] };
    expect(list.plugins.map((p) => [p.file, p.source])).toEqual([['l4d_tvwatch.smx', 'knobs'], ['x_noise.smx', 'site']]);
    const actions = (db.prepare("SELECT action FROM admin_actions WHERE action IN ('triage_patch','unfold_patch') ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['triage_patch', 'unfold_patch', 'triage_patch']);
  });

  it('balance decision names the patch', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/2/triage', cookies, payload: { decision: 'balance', name: 'Noise on', notes: '' } });
    expect(res.json()).toEqual({ ok: true });
    expect(db.prepare('SELECT triage, name FROM balance_patches WHERE id = 2').get()).toEqual({ triage: 'balance', name: 'Noise on' });
  });

  it('removing a site ignored plugin works and is audited; a knobs.json one is refused', async () => {
    addIgnored(db, ['x_noise.smx'], { reason: 'r', by: ADMIN, now: 'x' });
    const { a, cookies } = await app();
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/balance/ignored-plugins/x_noise.smx', cookies })).json()).toEqual({ ok: true });
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/balance/ignored-plugins/l4d_tvwatch.smx', cookies })).statusCode).toBe(409);
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/balance/ignored-plugins/nope.smx', cookies })).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'unignore_plugin'").get()).toEqual({ n: 1 });
  });
});
