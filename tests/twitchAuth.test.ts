import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { fakeTwitchApi } from './fakes/fakeTwitchApi.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
const ENV = {
  PUBLIC_URL: 'https://pug.test',
  TWITCH_CLIENT_ID: 'cid',
  TWITCH_CLIENT_SECRET: 'secret',
};

let db: DB;
let app: FastifyInstance;

async function build(env: Record<string, string>, api = fakeTwitchApi({
  users: { good: { id: '999', login: 'alicetv' } },
})) {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig(env), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    twitchApi: api,
    serverExec: async () => {},
  });
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
  upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
}

afterEach(async () => { await app.close(); });

/** The state the callback expects, obtained the only legitimate way: by
 *  starting the flow and reading it off the redirect. */
async function startFlow(cookies: Record<string, string>): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/auth/twitch', cookies });
  const url = new URL(res.headers.location as string);
  return url.searchParams.get('state')!;
}

describe('twitch unconfigured', () => {
  it('every twitch route 404s', async () => {
    await build({});
    const cookies = authedCookie(app, db, P1);
    expect((await app.inject({ method: 'GET', url: '/auth/twitch', cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/twitch/callback?code=x&state=y', cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/twitch/unlink', cookies })).statusCode).toBe(404);
  });

  it('/api/me reports twitch disabled', async () => {
    await build({});
    const cookies = authedCookie(app, db, P1);
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies })).json();
    expect(me.twitchEnabled).toBe(false);
    expect(me.twitch).toBe(null);
  });
});

describe('twitch configured', () => {
  it('needs a session to start', async () => {
    await build(ENV);
    expect((await app.inject({ method: 'GET', url: '/auth/twitch' })).statusCode).toBe(401);
  });

  it('redirects to twitch with no scope requested', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({ method: 'GET', url: '/auth/twitch', cookies });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pug.test/auth/twitch/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('links on a good callback', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies,
    });
    expect(res.headers.location).toBe(`/player/${P1}?twitch=linked`);
    expect(db.prepare('SELECT twitch_id, twitch_name FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: '999', twitch_name: 'alicetv' });
  });

  it('refuses a state that was not issued at all', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=deadbeef:${Date.now()}`, cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: null });
  });

  it('refuses a state that is not hex', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=zzzz:${Date.now()}`, cookies,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses another session state, so a link cannot be walked onto a victim', async () => {
    await build(ENV);
    const stateForP1 = await startFlow(authedCookie(app, db, P1));
    const cookiesP2 = authedCookie(app, db, P2);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=${stateForP1}`, cookies: cookiesP2,
    });
    expect(res.statusCode).toBe(400);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P2))
      .toEqual({ twitch_id: null });
  });

  it('refuses an expired state', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    const [mac] = state.split(':');
    const stale = `${mac}:${Date.now() - 11 * 60 * 1000}`;
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=${stale}`, cookies,
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports a channel another player already holds', async () => {
    await build(ENV);
    db.prepare("UPDATE players SET twitch_id = '999', twitch_name = 'alicetv' WHERE steamid = ?").run(P2);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies,
    });
    expect(res.headers.location).toBe(`/player/${P1}?twitch=taken`);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: null });
  });

  it('reports a failed exchange rather than throwing', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    const res = await app.inject({
      method: 'GET', url: `/auth/twitch/callback?code=nope&state=${state}`, cookies,
    });
    expect(res.headers.location).toBe(`/player/${P1}?twitch=failed`);
  });

  it('only an active, unbanned player may link, and nothing is sent to Twitch for anyone else', async () => {
    const { banPlayer } = await import('../src/admin/players.js');
    await build(ENV);
    const invited = authedCookie(app, db, P1, { active: false });
    const start = await app.inject({ method: 'GET', url: '/auth/twitch', cookies: invited });
    expect(start.statusCode).toBe(403);
    expect(start.headers.location).toBeUndefined();

    // A state issued while active is no use once banned, even signed in again
    // (the ban ended the session the state was issued to).
    const state = await startFlow(authedCookie(app, db, P2));
    banPlayer(db, P2, P1, 'toxic', 60);
    const cookies = authedCookie(app, db, P2, { active: false });
    const res = await app.inject({ method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies });
    expect(res.statusCode).toBe(403);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P2)).toEqual({ twitch_id: null });
  });

  it('a banned player can still unlink: taking a channel off the site is never refused', async () => {
    const { banPlayer } = await import('../src/admin/players.js');
    await build(ENV);
    authedCookie(app, db, P1);
    db.prepare("UPDATE players SET twitch_id = '999', twitch_name = 'alicetv' WHERE steamid = ?").run(P1);
    banPlayer(db, P1, P2, 'toxic', 60);
    const cookies = authedCookie(app, db, P1, { active: false });
    expect((await app.inject({ method: 'POST', url: '/api/twitch/unlink', cookies })).statusCode).toBe(200);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P1)).toEqual({ twitch_id: null });
  });

  it('unlinks', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    await app.inject({ method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies });
    const res = await app.inject({ method: 'POST', url: '/api/twitch/unlink', cookies });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: null });
  });

  it('/api/me carries the linked channel', async () => {
    await build(ENV);
    const cookies = authedCookie(app, db, P1);
    const state = await startFlow(cookies);
    await app.inject({ method: 'GET', url: `/auth/twitch/callback?code=good&state=${state}`, cookies });
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies })).json();
    expect(me.twitchEnabled).toBe(true);
    expect(me.twitch).toEqual({ id: '999', name: 'alicetv' });
  });
});
