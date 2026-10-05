import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { stubOrchestrator } from './helpers.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';
import { APPEAL_COOKIE } from '../src/appeals/appealSession.js';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({
      PUBLIC_URL: 'https://pug.test',
      DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: 'guild',
    }),
    db, orchestrator: stubOrchestrator(),
    discordApi: fakeDiscordApi({ users: { good: { id: '901', username: 'stranger', globalName: 'Stranger' } }, members: {} }),
    serverExec: async () => {}, serverCleaner: async () => {},
  });
});
afterEach(async () => { await app.close(); });

const cookieFrom = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name);

describe('/appeal Discord sign-in', () => {
  it('needs no Steam session, binds state to a nonce cookie, and lands back on /appeal signed in', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/discord/appeal' });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    expect(state.startsWith('appeal.')).toBe(true);
    const nonce = cookieFrom(start, 'pug_appeal_nonce')!;
    const back = await app.inject({
      method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`,
      cookies: { pug_appeal_nonce: nonce.value },
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/appeal');
    const appeal = cookieFrom(back, APPEAL_COOKIE)!;
    const mine = await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies: { [APPEAL_COOKIE]: appeal.value } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ name: 'Stranger', signedInAs: 'discord' });
  });

  it('a state without its nonce cookie (a link someone else started) fails back to /appeal', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/discord/appeal' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const back = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}` });
    expect(back.headers.location).toBe('/appeal?signin=failed');
    expect(cookieFrom(back, APPEAL_COOKIE)).toBeUndefined();
  });
});
