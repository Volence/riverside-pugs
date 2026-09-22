import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { getPlayer, upsertPlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
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
    serverExec: async () => {},
  });
});

describe('auth', () => {
  it('GET /auth/steam redirects to steam openid', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/steam' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('steamcommunity.com/openid/login');
  });

  it('hands verifyLogin the return URL this site asked steam for', async () => {
    let seen: string | undefined;
    const local = await buildServer({
      config: loadConfig({ PUBLIC_URL: 'https://pug.example' }),
      db,
      verifyLogin: async (_q, returnTo) => { seen = returnTo; return P1; },
      fetchPersona: async () => ({ name: 'alice', avatar: null }),
      orchestrator: stubOrchestrator(),
      serverExec: async () => {},
    });
    const login = await local.inject({ method: 'GET', url: '/auth/steam' });
    const asked = new URL(login.headers.location as string).searchParams.get('openid.return_to');
    await local.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
    expect(seen).toBe('https://pug.example/auth/steam/return');
    expect(seen).toBe(asked);
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

  // A merged alt used to sign in, get a fresh `invited` row and be a separate
  // identity again, with the alias still pointing its game traffic at the main.
  describe('a Steam account that has been merged into another', () => {
    const MAIN = '76561198000000099';
    beforeEach(() => {
      upsertPlayer(db, { steamid: MAIN, name: 'main', avatar: null }, []);
      addAlias(db, { steamid: P1, canonical: MAIN, by: 'test' });
    });

    it('is refused at login: no player row, no session, and it is told why', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toMatch(/merged into another/i);
      expect(res.body).toMatch(/contact an admin/i);
      expect(getPlayer(db, P1)).toBeUndefined();
      expect(res.cookies.find((c) => c.name === 'pug_session')).toBeUndefined();
    });

    it('is never signed in as the main, which would hand the main to whoever holds the alt', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
      expect(res.body).not.toContain(MAIN);
      expect(res.cookies).toEqual([]);
    });

    it('is not an active player even with a row left over from before, on the site or as an admin', async () => {
      // The row the old hole could leave behind.
      const cookies = authedCookie(app, db, P1);
      db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(P1);
      expect((await app.inject({ method: 'POST', url: '/api/queue/join', cookies })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/admin/players', cookies })).statusCode).toBe(403);
    });
  });
});
