import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { adminDefaultCompare } from '../src/balancePublic.js';

type DBT = ReturnType<typeof openDb>;

const ADMIN = '76561198000000009';
const OTHER = '76561198000000010';

async function app(db: DBT, admin?: 'admin' | 'other' | 'none') {
  const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  if (admin === undefined || admin === 'none') return { a, cookies: {} as Record<string, string> };
  const steamid = admin === 'admin' ? ADMIN : OTHER;
  const cookies = await authedCookie(a, db, steamid);
  if (admin === 'admin') db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  return { a, cookies };
}

/** Patch 1: 40 matches, saferoom 20%. Patch 2: 40 matches, saferoom 80%.
 *  Copied from tests/balancePublic.test.ts's compareDb(), which explains the
 *  unique computed_at tag needed to keep the compare-result memo cache
 *  (src/metrics/compare/cache.ts) from leaking a result between tests: the
 *  cache key is data-shape based, not db-identity based, so two in-memory
 *  dbs with identical round_metric_context contents and computed_at would
 *  otherwise collide. */
let compareDbSeq = 0;
function compareDb(nA = 40, nB = 40) {
  const db = openDb(':memory:');
  const computedAt = `route-n${++compareDbSeq}`;
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare(`INSERT INTO balance_patches (id, name, notes, source, inputs_json, first_seen_at) VALUES
    (1, 'Old', 'old notes', 'detected', '{"c:z_tank_health":"8000"}', '2026-09-01 00:00:00'),
    (2, 'New', 'new notes', 'detected', '{"c:z_tank_health":"7500"}', '2026-09-10 00:00:00')`).run();
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at) VALUES (?, 1, 'completed', 'x', 'queue', ?)");
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, 0, ?, 'mapA', 'queue', ?, 25, 25, 0, 0, 'e', '${computedAt}')`);
  const row = db.prepare('INSERT INTO round_metrics VALUES (?, 0, ?, ?, ?, ?, ?)');
  let id = 1;
  const add = (patch: number, n: number, safeEvery: number, day: number) => {
    for (let i = 0; i < n; i++, id++) {
      match.run(id, `2026-09-${String(day).padStart(2, '0')} 10:${String(i).padStart(2, '0')}:00`);
      for (const half of [1, 2]) {
        ctx.run(id, half, patch);
        row.run(id, half, 'round.saferoom', 'all', (i * 2 + half) % safeEvery === 0 ? 1 : 0, 1);
      }
    }
  };
  add(1, nA, 5, 5);   // 1 in 5 rounds safe
  add(2, nB, 1, 15);  // every side B round is safe
  return db;
}

describe('balance public routes', () => {
  let db: DBT;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare(`INSERT INTO balance_patches (id, name, notes, source, inputs_json, first_seen_at) VALUES
      (1, 'Old', 'old notes', 'detected', '{}', '2026-09-01 00:00:00'),
      (2, 'New', 'new notes', 'detected', '{}', '2026-09-10 00:00:00')`).run();
  });

  it('GET /api/balance/patches: no cookie needed, only published, newest first', async () => {
    const { a } = await app(db);
    db.prepare("UPDATE balance_patches SET published_at = '2026-09-20 00:00:00' WHERE id = 1").run();
    const res = await a.inject({ method: 'GET', url: '/api/balance/patches' });
    expect(res.statusCode).toBe(200);
    expect(res.json().patches.map((p: { id: number }) => p.id)).toEqual([1]);

    db.prepare("UPDATE balance_patches SET published_at = '2026-09-21 00:00:00' WHERE id = 2").run();
    const res2 = await a.inject({ method: 'GET', url: '/api/balance/patches' });
    expect(res2.json().patches.map((p: { id: number }) => p.id)).toEqual([2, 1]);
  });

  it('GET /api/balance/patches/:id: 404 unpublished, unknown, non-numeric; 200 published, no cookie', async () => {
    const { a } = await app(db);
    expect((await a.inject({ method: 'GET', url: '/api/balance/patches/1' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/balance/patches/1' })).json()).toEqual({ error: 'no such patch' });
    expect((await a.inject({ method: 'GET', url: '/api/balance/patches/999' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/balance/patches/abc' })).statusCode).toBe(404);

    db.prepare("UPDATE balance_patches SET published_at = '2026-09-20 00:00:00' WHERE id = 1").run();
    const res = await a.inject({ method: 'GET', url: '/api/balance/patches/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(1);
  });

  it('admin preview: returns unpublished entry for admin, 403 non-admin, 401 no cookie', async () => {
    const { a: aAdmin, cookies: adminCookies } = await app(db, 'admin');
    const res = await aAdmin.inject({ method: 'GET', url: '/api/admin/balance/patches/1/public', cookies: adminCookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(1);

    const { a: aOther, cookies: otherCookies } = await app(db, 'other');
    expect((await aOther.inject({ method: 'GET', url: '/api/admin/balance/patches/1/public', cookies: otherCookies })).statusCode).toBe(403);

    const { a: aNone } = await app(db, 'none');
    expect((await aNone.inject({ method: 'GET', url: '/api/admin/balance/patches/1/public' })).statusCode).toBe(401);
  });

  it('POST publish: 400 missing notes, 200 valid then public, admin_actions row, 400 bad body, 404 unknown, 403 non-admin', async () => {
    db.prepare("UPDATE balance_patches SET notes = '' WHERE id = 1").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at) VALUES (1, 1, 'completed', 'x', 'queue', '2026-09-05 10:00:00')").run();
    db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
      VALUES (1, 0, 1, 'mapA', 'queue', 1, 25, 25, 0, 0, 'e', 'publish-test')`).run();
    const { a, cookies } = await app(db, 'admin');

    const bad = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/1/publish', cookies, payload: { published: true } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/notes/);

    db.prepare("UPDATE balance_patches SET notes = 'why' WHERE id = 1").run();
    const ok = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/1/publish', cookies, payload: { published: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const pub = await a.inject({ method: 'GET', url: '/api/balance/patches' });
    expect(pub.json().patches.map((p: { id: number }) => p.id)).toEqual([1]);

    const actions = db.prepare("SELECT * FROM admin_actions WHERE action = 'publish_patch' AND target = '1'").all();
    expect(actions.length).toBe(1);

    const badBody = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/1/publish', cookies, payload: { published: 'yes' } });
    expect(badBody.statusCode).toBe(400);

    const unknown = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/999/publish', cookies, payload: { published: true } });
    expect(unknown.statusCode).toBe(404);

    const { a: aOther, cookies: otherCookies } = await app(db, 'other');
    const forbidden = await aOther.inject({ method: 'POST', url: '/api/admin/balance/patches/1/publish', cookies: otherCookies, payload: { published: true } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('single flight: concurrent public GETs for the same patch share one comparison', async () => {
    const cdb = compareDb();
    cdb.prepare("UPDATE balance_patches SET published_at = '2026-09-20 00:00:00' WHERE id = 1").run();
    cdb.prepare("UPDATE balance_patches SET published_at = '2026-09-21 00:00:00' WHERE id = 2").run();
    const { a } = await app(cdb);

    const [r1, r2] = await Promise.all([
      a.inject({ method: 'GET', url: '/api/balance/patches/2' }),
      a.inject({ method: 'GET', url: '/api/balance/patches/2' }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual(r2.json());
    expect(JSON.stringify(r1.json())).toBe(JSON.stringify(r2.json()));

    // better-sqlite3 is synchronous and the compare memo is a plain in-process
    // cache, so there is no async window for two requests to race into two
    // separate computations: this just confirms the cache is doing its job
    // (spec planning review item 5), not that the route itself dedupes.
    const first = adminDefaultCompare(cdb, 1, 2);
    expect(adminDefaultCompare(cdb, 1, 2)).toBe(first);
  });
});
