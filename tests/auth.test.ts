import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { getPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const P1 = '76561198000000001';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}),
    db,
    verifyLogin: async () => P1,
    fetchPersona: async (steamid) => ({ name: 'alice', avatar: null }),
    orchestrator: stubOrchestrator(),
  });
});

describe('auth', () => {
  it('GET /auth/steam redirects to steam openid', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/steam' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('steamcommunity.com/openid/login');
  });

  it('GET /auth/steam/return creates player, sets cookie, redirects home', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.cookies.find((c) => c.name === 'pug_session')).toBeTruthy();
    expect(getPlayer(db, P1)!.name).toBe('alice');
  });

  it('GET /api/me returns 401 without session, player with session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'GET', url: '/api/me',
      cookies: authedCookie(app, db, P1, { active: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('invited');
  });

  it('POST /api/register activates with correct invite code, rejects wrong', async () => {
    setSetting(db, 'invite_code', 'sekrit');
    const cookies = authedCookie(app, db, P1, { active: false });
    const bad = await app.inject({
      method: 'POST', url: '/api/register', cookies, payload: { code: 'nope' },
    });
    expect(bad.statusCode).toBe(403);
    const good = await app.inject({
      method: 'POST', url: '/api/register', cookies, payload: { code: 'sekrit' },
    });
    expect(good.statusCode).toBe(200);
    expect(getPlayer(db, P1)!.status).toBe('active');
  });
});
