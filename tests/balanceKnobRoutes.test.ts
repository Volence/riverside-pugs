import { beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { KNOBS, LIVE, sight } from './balanceFixtures.js';
import { addIgnored } from '../src/balanceIgnore.js';

const ADMIN = '76561198000000009';

describe('balance knob API', () => {
  let db: ReturnType<typeof openDb>;
  let knobsPath: string;
  beforeEach(() => {
    db = openDb(':memory:');
    const s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    sight(db, 1, s1, LIVE);
    knobsPath = join(mkdtempSync(join(tmpdir(), 'knobs-')), 'knobs.json');
    writeFileSync(knobsPath, JSON.stringify(KNOBS));
  });

  async function app(admin = true) {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {},
      serverExec: async () => {}, balanceKnobsPath: knobsPath });
    const steamid = admin ? ADMIN : '76561198000000010';
    const cookies = await authedCookie(a, db, steamid);
    if (admin) db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('lists adjustable knobs with current values, base and restorable patches', async () => {
    const { a, cookies } = await app();
    // The sighted patch starts pending; only a balance patch can be restored from.
    db.prepare("UPDATE balance_patches SET triage = 'balance'").run();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/knobs', cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.knobs.map((k: { cvar: string }) => k.cvar)).toEqual(['z_tank_health', 'versus_boss_flow_min', 'versus_boss_flow_max']);
    expect(body.current.z_tank_health).toBe('8000');
    expect(body.base.number).toBe(1);
    expect(body.restorable.length).toBe(1);
    expect(body.active).toBeNull();
  });

  it('previews without writing anything', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/preview', cookies, payload: { values: { z_tank_health: 7500 } } });
    expect(res.json().diff).toEqual([{ cvar: 'z_tank_health', label: 'Tank health', group: 'tank', from: '8000', to: '7500' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM balance_rollouts').get()).toEqual({ n: 0 });
  });

  it('applies, audits, and lists the rollout', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/apply', cookies,
      payload: { values: { z_tank_health: 7500 }, name: 'Tank 7500', notes: 'lower tank HP', baseRolloutId: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, reused: false });
    const audit = db.prepare("SELECT detail FROM admin_actions WHERE action = 'balance_apply'").all() as { detail: string }[];
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0].detail)).toMatchObject({ reused: false, name: 'Tank 7500', notesSet: true, changes: ['z_tank_health 8000 -> 7500'] });
    const list = await a.inject({ method: 'GET', url: '/api/admin/balance/rollouts', cookies });
    // The fixture server has no addons_dir configured, so the writer's
    // fire-and-forget sync() (kicked off by the apply route) runs and fails
    // fast with "no addons transport configured" well before this second
    // request lands; there is no real I/O in that path to outrun. See
    // tests/balanceWriterWiring.test.ts for the write-actually-lands case,
    // which injects a transport and waits for it.
    expect(list.json().rollouts[0]).toMatchObject({ patchName: 'Tank 7500', servers: [{ name: 'dallas', state: 'failed' }] });
  });

  it('answers 400 with the errors for an invalid draft', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/apply', cookies,
      payload: { values: { z_tank_health: 1 }, name: 'x', notes: 'y', baseRolloutId: null } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/outside/);
  });

  it('refuses an apply made from a preview older than the latest rollout (409), and one with no preview base (400)', async () => {
    const { a, cookies } = await app();
    const pre = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/preview', cookies, payload: { values: { z_tank_health: 7500 } } });
    expect(pre.json().rolloutId).toBeNull();
    const first = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/apply', cookies,
      payload: { values: { z_tank_health: 7500 }, name: 'Tank 7500', notes: 'n', baseRolloutId: null } });
    expect(first.statusCode).toBe(200);
    // A second admin who previewed before that apply.
    const stale = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/apply', cookies,
      payload: { values: { z_tank_health: 7000 }, name: 'Tank 7000', notes: 'n', baseRolloutId: null } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatch(/preview again/i);
    const missing = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/apply', cookies,
      payload: { values: { z_tank_health: 7000 }, name: 'Tank 7000', notes: 'n' } });
    expect(missing.statusCode).toBe(400);
    const fresh = await a.inject({ method: 'POST', url: '/api/admin/balance/knobs/apply', cookies,
      payload: { values: { z_tank_health: 7000 }, name: 'Tank 7000', notes: 'n', baseRolloutId: first.json().rolloutId } });
    expect(fresh.statusCode).toBe(200);
  });

  it('restores values from a patch', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/knobs/restore/1', cookies });
    expect(res.json().values.z_tank_health).toBe('8000');
  });

  it('restore lists only balance patches', async () => {
    const { a, cookies } = await app();
    db.prepare("UPDATE balance_patches SET triage = 'pending'").run();
    const body = (await a.inject({ method: 'GET', url: '/api/admin/balance/knobs', cookies })).json() as { restorable: unknown[] };
    expect(body.restorable).toEqual([]);
  });

  it('a plugin on the site ignore list never blocks an apply', async () => {
    const s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    sight(db, 2, s2, { ...LIVE, 'p:x_noise.smx': '1.a' }, 'queue', '2026-09-24 00:30:00');
    const { a, cookies } = await app();
    const before = (await a.inject({ method: 'GET', url: '/api/admin/balance/knobs', cookies })).json() as { blocking: unknown[] };
    expect(before.blocking).toHaveLength(1);
    addIgnored(db, ['x_noise.smx'], { reason: 'r', by: ADMIN, now: 'x' });
    const after = (await a.inject({ method: 'GET', url: '/api/admin/balance/knobs', cookies })).json() as { blocking: unknown[] };
    expect(after.blocking).toEqual([]);
  });

  it('refuses a non-admin on every route', async () => {
    const { a, cookies } = await app(false);
    for (const [method, url] of [['GET', '/api/admin/balance/knobs'], ['POST', '/api/admin/balance/knobs/preview'],
      ['POST', '/api/admin/balance/knobs/apply'], ['GET', '/api/admin/balance/rollouts'], ['GET', '/api/admin/balance/knobs/restore/1']] as const) {
      expect((await a.inject({ method, url, cookies, payload: method === 'POST' ? {} : undefined })).statusCode).toBe(403);
    }
  });

  it('503 when knobs.json cannot be loaded', async () => {
    writeFileSync(knobsPath, '{');
    const { a, cookies } = await app();
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/knobs', cookies })).statusCode).toBe(503);
  });
});
