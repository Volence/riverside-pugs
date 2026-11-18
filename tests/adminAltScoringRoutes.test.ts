import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561198000000009';
const USER = '76561198000000010';
const URL = '/api/admin/balance/alt-scoring';

describe('GET /api/admin/balance/alt-scoring', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, winner) VALUES (1, 1, 'completed', 'c_test', 'a')").run();
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (1, 0, 1, 'a', 400)").run();
    db.prepare(`INSERT INTO match_round_alt (match_id, ordinal, half, rule, surv_team, walk, tank, door, walk_mult, door_mult,
        ws, wt, wr, ts, tt, tr, ds, dt, dr, tank_pct, tank_by, tanks, survivors_in, source)
      VALUES (1, 0, 1, 'hr1', 'a', 300, 50, 30, 1, 1, 200, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, 0, 4, 'dump')`).run();
  });

  const server = () => buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });

  it('refuses without a session', async () => {
    const a = await server();
    expect((await a.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
  });

  it('refuses a non-admin', async () => {
    const a = await server();
    const cookies = await authedCookie(a, db, USER);
    expect((await a.inject({ method: 'GET', url: URL, cookies })).statusCode).toBe(403);
  });

  it('returns the report to an admin', async () => {
    const a = await server();
    const cookies = await authedCookie(a, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    const res = await a.inject({ method: 'GET', url: URL, cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toEqual({ matchesWithData: 1, complete: 1, differentWinner: 0, share: { walk: 300 / 380, tank: 50 / 380, door: 30 / 380 },
      // The fixture's stored parts are not its raw components' own.
      mismatchedHalves: 1 });
    expect(body.maps).toEqual([]);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({ id: 1, campaign: 'c_test', altA: 380, altB: 0, altWinner: 'a', complete: true, differs: false, counted: true });
    expect(body.matches[0].halves[0]).toMatchObject({ ordinal: 0, half: 1, map: '', real: 400, total: 380, mismatch: true,
      // Recorded without the health curve.
      curve: null, tankOpen: null, tankClose: null });
  });

  it('returns the health curve and tank window of a half', async () => {
    const curve = [100, 95, 95, 90, 90, 90, 90, 61, 61, 61, 61, 60, 58, 58, 58, 58, 55, 55, 55, -1, -1];
    db.prepare("UPDATE match_round_alt SET curve = ?, tank_open = 30, tank_close = 35 WHERE match_id = 1").run(curve.join(','));
    const a = await server();
    const cookies = await authedCookie(a, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    const res = await a.inject({ method: 'GET', url: URL, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().matches[0].halves[0]).toMatchObject({ curve, tankOpen: 30, tankClose: 35, total: 380 });
  });
});
