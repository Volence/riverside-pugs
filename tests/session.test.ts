import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, sessionValue } from '../src/session.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const P1 = '76561198000000001';
const ADMIN = '76561198000000009';
const DAY = 24 * 60 * 60 * 1000;

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    serverCleaner: async () => {}, serverExec: async () => {},
  });
});
afterEach(async () => { vi.useRealTimers(); await app.close(); });

const me = (cookies: Record<string, string>) => app.inject({ method: 'GET', url: '/api/me', cookies });
const cookieAt = (steamid: string, issuedAt: number, epoch = 0) =>
  ({ [SESSION_COOKIE]: app.signCookie(sessionValue(steamid, epoch, issuedAt)) });

describe('sessions', () => {
  it('a login cookie carries when it was issued and works', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    const unsigned = app.unsignCookie(cookie.value);
    expect(unsigned.valid).toBe(true);
    expect(unsigned.value).toMatch(new RegExp(`^${P1}\\.\\d{13}\\.0$`));
    expect((await me({ [SESSION_COOKIE]: cookie.value })).statusCode).toBe(200);
  });

  // The cookie used to be the bare signed SteamID: valid for ever, wherever
  // it ended up, with no way to take it back.
  it('the old cookie, a bare signed SteamID, is no longer a session', async () => {
    authedCookie(app, db, P1);
    expect((await me({ [SESSION_COOKIE]: app.signCookie(P1) })).statusCode).toBe(401);
  });

  it('expires 30 days after it was issued, whatever the browser says', async () => {
    authedCookie(app, db, P1);
    expect((await me(cookieAt(P1, Date.now() - SESSION_MAX_AGE_MS + 60_000))).statusCode).toBe(200);
    expect((await me(cookieAt(P1, Date.now() - SESSION_MAX_AGE_MS - 60_000))).statusCode).toBe(401);
  });

  it('refuses a cookie dated in the future, an unsigned one, and junk', async () => {
    authedCookie(app, db, P1);
    expect((await me(cookieAt(P1, Date.now() + DAY))).statusCode).toBe(401);
    expect((await me({ [SESSION_COOKIE]: sessionValue(P1, 0) })).statusCode).toBe(401);
    expect((await me({ [SESSION_COOKIE]: app.signCookie(`${P1}.abc.0`) })).statusCode).toBe(401);
    expect((await me({ [SESSION_COOKIE]: app.signCookie(`${P1}.${Date.now()}`) })).statusCode).toBe(401);
  });

  it('slides: a session more than a day old is reissued, a fresh one is left alone', async () => {
    authedCookie(app, db, P1);
    const fresh = await me(cookieAt(P1, Date.now() - 60_000));
    expect(fresh.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();

    const old = await me(cookieAt(P1, Date.now() - 2 * DAY));
    const renewed = old.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(renewed).toBeTruthy();
    const issuedAt = Number(app.unsignCookie(renewed.value).value!.split('.')[1]);
    expect(Date.now() - issuedAt).toBeLessThan(60_000);
    expect(renewed.httpOnly).toBe(true);
    expect(renewed.sameSite).toBe('Lax');
  });

  it('never reissues a cookie that is not a valid session', async () => {
    authedCookie(app, db, P1);
    const res = await me(cookieAt(P1, Date.now() - SESSION_MAX_AGE_MS - DAY));
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it('POST /auth/logout clears the cookie', async () => {
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({ method: 'POST', url: '/auth/logout', cookies });
    expect(res.statusCode).toBe(200);
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cleared.value).toBe('');
    expect(new Date(cleared.expires as unknown as string).getTime()).toBeLessThan(Date.now());
    // Harmless without a session, so a stale tab can always sign out.
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(200);
  });

  it('signing out does not renew the session it is ending', async () => {
    authedCookie(app, db, P1);
    const res = await app.inject({ method: 'POST', url: '/auth/logout', cookies: cookieAt(P1, Date.now() - 2 * DAY) });
    const set = res.cookies.filter((c) => c.name === SESSION_COOKIE);
    expect(set).toHaveLength(1);
    expect(set[0].value).toBe('');
  });

  describe('session_epoch: taking every cookie back at once', () => {
    let admin: Record<string, string>;
    beforeEach(() => {
      admin = authedCookie(app, db, ADMIN);
      db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    });
    const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: admin, payload });

    it('a ban ends every session the player has, and a new login still works', async () => {
      const cookies = authedCookie(app, db, P1);
      expect((await me(cookies)).statusCode).toBe(200);
      await post(`/api/admin/players/${P1}/ban`, { reason: 'griefing' });
      expect((await me(cookies)).statusCode).toBe(401);
      // They can sign in again, and are then told they are banned.
      const again = authedCookie(app, db, P1, { active: false });
      const res = await me(again);
      expect(res.statusCode).toBe(200);
      expect(res.json().ban).toMatchObject({ reason: 'griefing' });
    });

    it('a change of admin flag ends the sessions of whoever it was changed for', async () => {
      const cookies = authedCookie(app, db, P1);
      await post(`/api/admin/players/${P1}/admin`, { isAdmin: true });
      expect((await me(cookies)).statusCode).toBe(401);
      const asAdmin = authedCookie(app, db, P1);
      await post(`/api/admin/players/${P1}/admin`, { isAdmin: false });
      expect((await app.inject({ method: 'GET', url: '/api/admin/players', cookies: asAdmin })).statusCode).toBe(401);
    });

    it('setting the flag to what it already is signs nobody out', async () => {
      const cookies = authedCookie(app, db, P1);
      await post(`/api/admin/players/${P1}/admin`, { isAdmin: false });
      expect((await me(cookies)).statusCode).toBe(200);
    });

    it('an admin can sign a player out everywhere, and it is audited', async () => {
      const cookies = authedCookie(app, db, P1);
      const res = await post(`/api/admin/players/${P1}/sign-out`);
      expect(res.statusCode).toBe(200);
      expect((await me(cookies)).statusCode).toBe(401);
      expect((await me(admin)).statusCode).toBe(200);
      const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: admin })).json();
      expect(audit.actions[0]).toMatchObject({ action: 'sign_out', target: P1, adminId: ADMIN });
      // Admins only.
      const user = authedCookie(app, db, P1);
      expect((await app.inject({ method: 'POST', url: `/api/admin/players/${ADMIN}/sign-out`, cookies: user })).statusCode).toBe(403);
    });
  });
});
