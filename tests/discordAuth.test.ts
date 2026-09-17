import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { getPlayer, linkDiscord, createLinkCode, upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
const DISCORD_ENV = {
  PUBLIC_URL: 'https://pug.test',
  DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: 'guild',
};

let db: DB;
let app: FastifyInstance;

async function build(env: Record<string, string>, api = fakeDiscordApi({
  users: { good: { id: '111', username: 'alice', globalName: 'Alice' } },
  members: { '111': [] },
})) {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig(env), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    discordApi: api,
  });
}

afterEach(async () => { await app.close(); });

describe('discord auth, unconfigured', () => {
  beforeEach(() => build({}));
  it('every discord route 404s', async () => {
    const cookies = authedCookie(app, db, P1);
    expect((await app.inject({ method: 'GET', url: '/auth/discord', cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/discord/callback?code=x&state=y', cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies })).statusCode).toBe(404);
  });
  it('/api/me reports discord disabled', async () => {
    const cookies = authedCookie(app, db, P1);
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies })).json();
    expect(me.discordEnabled).toBe(false);
    expect(me.discord).toBeNull();
  });
});

describe('discord auth, configured', () => {
  beforeEach(() => build(DISCORD_ENV));

  it('authorize needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/discord' })).statusCode).toBe(401);
  });

  it('authorize redirects to discord with client id, redirect uri and a state', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const res = await app.inject({ method: 'GET', url: '/auth/discord', cookies });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pug.test/auth/discord/callback');
    expect(url.searchParams.get('scope')).toBe('identify');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  async function stateFor(cookies: Record<string, string>): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/auth/discord', cookies });
    return new URL(res.headers.location as string).searchParams.get('state')!;
  }

  it('callback with a bad state is rejected and links nothing', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const res = await app.inject({ method: 'GET', url: '/auth/discord/callback?code=good&state=forged:123', cookies });
    expect(res.statusCode).toBe(400);
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
  });

  it('a state minted for another session does not work', async () => {
    const other = authedCookie(app, db, P2, { active: false });
    const state = await stateFor(other);
    const cookies = authedCookie(app, db, P1, { active: false });
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`, cookies });
    expect(res.statusCode).toBe(400);
  });

  it('callback links the account, activates a guild member and returns to the profile', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const state = await stateFor(cookies);
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`, cookies });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/player/${P1}?discord=linked`);
    const p = getPlayer(db, P1)!;
    expect(p.discord_id).toBe('111');
    expect(p.discord_name).toBe('Alice');
    expect(p.status).toBe('active');
  });

  it('callback for an account linked elsewhere redirects with taken and changes nothing', async () => {
    upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
    linkDiscord(db, P2, '111', 'Alice');
    const cookies = authedCookie(app, db, P1, { active: false });
    const state = await stateFor(cookies);
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`, cookies });
    expect(res.headers.location).toBe(`/player/${P1}?discord=taken`);
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
  });

  it('callback where Discord refuses the code redirects with failed', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const state = await stateFor(cookies);
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=bad&state=${encodeURIComponent(state)}`, cookies });
    expect(res.headers.location).toBe(`/player/${P1}?discord=failed`);
  });

  it('link-code links, activates, and cannot be reused', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const code = createLinkCode(db, '111', 'Alice');
    const res = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, active: true, discordName: 'Alice' });
    expect(getPlayer(db, P1)?.discord_id).toBe('111');
    const again = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_code');
  });

  it('link-code for a taken account is 409', async () => {
    upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
    linkDiscord(db, P2, '111', 'Alice');
    const cookies = authedCookie(app, db, P1, { active: false });
    const code = createLinkCode(db, '111', 'Alice');
    const res = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(res.statusCode).toBe(409);
  });

  it('link-code needs a session', async () => {
    const code = createLinkCode(db, '111', 'Alice');
    expect((await app.inject({ method: 'POST', url: '/api/discord/link-code', payload: { code } })).statusCode).toBe(401);
  });

  it('unlink clears the link', async () => {
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    expect((await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies })).statusCode).toBe(200);
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
  });

  it('/api/me carries the link', async () => {
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies })).json();
    expect(me.discordEnabled).toBe(true);
    expect(me.discord).toEqual({ id: '111', name: 'Alice' });
  });

  it('steam login activates an invited player already linked to a guild member', async () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    linkDiscord(db, P1, '111', 'Alice');
    await app.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
    expect(getPlayer(db, P1)?.status).toBe('active');
  });
});

describe('login return-to', () => {
  beforeEach(() => build({}));

  it('returns to a relative next path after steam login', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/steam?next=%2Flink%2Fdiscord%3Fcode%3Dabc' });
    const nextCookie = start.cookies.find((c) => c.name === 'pug_next');
    expect(nextCookie).toBeTruthy();
    const res = await app.inject({
      method: 'GET', url: '/auth/steam/return?openid.mode=id_res',
      cookies: { pug_next: nextCookie!.value },
    });
    expect(res.headers.location).toBe('/link/discord?code=abc');
  });

  it('ignores an absolute or protocol-relative next', async () => {
    for (const next of ['//evil.com/x', 'https://evil.com', '/\\evil.com']) {
      const start = await app.inject({ method: 'GET', url: `/auth/steam?next=${encodeURIComponent(next)}` });
      const c = start.cookies.find((x) => x.name === 'pug_next');
      const res = await app.inject({
        method: 'GET', url: '/auth/steam/return?openid.mode=id_res',
        cookies: c ? { pug_next: c.value } : {},
      });
      expect(res.headers.location).toBe('/');
    }
  });
});
