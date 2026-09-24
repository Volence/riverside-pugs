import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561198000000009';

describe('balance compare routes', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'Old', 'detected', '2026-09-01 00:00:00'), (2, 'New', 'detected', '2026-09-10 00:00:00')").run();
  });
  async function app(admin = true) {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = await authedCookie(a, db, admin ? ADMIN : '76561198000000010');
    if (admin) db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('returns a comparison', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/compare?a=1&b=2', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rows: [], counts: { real: 0 } });
  });

  it('rejects bad parameters and unknown metrics', async () => {
    const { a, cookies } = await app();
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/compare?a=x&b=2', cookies })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/metric?metric=nope&phase=all&a=1&b=2', cookies })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/metric?metric=round.saferoom&phase=lunch&a=1&b=2', cookies })).statusCode).toBe(400);
  });

  it('returns metric detail', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/metric?metric=round.saferoom&phase=all&a=1&b=2', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ metric: 'round.saferoom', trend: [], perMap: [], perPatch: [{ patchId: 1, value: null, matches: 0 }, { patchId: 2, value: null, matches: 0 }] });
  });

  it('refuses a non-admin', async () => {
    const { a, cookies } = await app(false);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/compare?a=1&b=2', cookies })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/metric?metric=round.saferoom&phase=all&a=1&b=2', cookies })).statusCode).toBe(403);
  });
});
