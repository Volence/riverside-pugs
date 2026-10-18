import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { upsertPlayer } from '../src/players.js';
import { personByLabel, personOf } from '../src/evaderPeople.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';

const EVADER = '76561198000000001';
const PLAYER = '76561198000000004';
const MOD = '76561198000000008';

let db: DB;
let app: FastifyInstance;
let mod: Record<string, string>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({
      PUBLIC_URL: 'https://pug.test',
      DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: 'guild',
    }),
    db, orchestrator: stubOrchestrator(),
    discordApi: fakeDiscordApi({ users: {}, members: {} }),
    serverExec: async () => {}, serverCleaner: async () => {},
  });
  upsertPlayer(db, { steamid: EVADER, name: 'nepmir', avatar: null }, []);
  mod = authedCookie(app, db, MOD);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});
afterEach(async () => { await app.close(); });

const post = (url: string, payload: object = {}, cookies = mod) => app.inject({ method: 'POST', url, cookies, payload });

describe('person routes', () => {
  it('a moderator creates a person, once per label', async () => {
    expect((await post('/api/admin/people/evaders', { label: 'dethisa', note: 'five accounts' })).statusCode).toBe(200);
    expect(personByLabel(db, 'dethisa')).not.toBeNull();
    expect((await post('/api/admin/people/evaders', { label: 'dethisa' })).statusCode).toBe(400);
  });

  it('adds an account to an existing person or a new one', async () => {
    const created = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    expect((await post(`/api/admin/people/${EVADER}/evader-person`, { personId: created.id })).statusCode).toBe(200);
    expect(personOf(db, 'steam', EVADER)?.label).toBe('dethisa');
    upsertPlayer(db, { steamid: PLAYER, name: 'other', avatar: null }, []);
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { label: 'shove' })).statusCode).toBe(200);
    expect(personOf(db, 'steam', PLAYER)?.label).toBe('shove');
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { personId: created.id })).statusCode).toBe(409);
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { personId: 999 })).statusCode).toBe(404);
  });

  it('removes a member and closes a person', async () => {
    const { id } = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    await post(`/api/admin/people/${EVADER}/evader-person`, { personId: id });
    expect((await post(`/api/admin/people/evaders/${id}/members/remove`, { kind: 'steam', ident: EVADER })).statusCode).toBe(200);
    expect(personOf(db, 'steam', EVADER)).toBeNull();
    expect((await post(`/api/admin/people/evaders/${id}/members/remove`, { kind: 'steam', ident: EVADER })).statusCode).toBe(404);
    expect((await post(`/api/admin/people/evaders/${id}/close`)).statusCode).toBe(200);
    expect((await post(`/api/admin/people/evaders/${id}/close`)).statusCode).toBe(404);
  });

  it('is staff only, and the old flag routes are gone', async () => {
    const player = authedCookie(app, db, PLAYER);
    expect((await post('/api/admin/people/evaders', { label: 'x' }, player)).statusCode).toBe(403);
    expect((await post(`/api/admin/people/${EVADER}/evader`, { reason: 'x' })).statusCode).toBe(404);
  });

  it('the player file says which person an account belongs to, and offers the open ones', async () => {
    const { id } = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    await post(`/api/admin/people/${EVADER}/evader-person`, { personId: id });
    const file = (await app.inject({ method: 'GET', url: `/api/admin/people/${EVADER}`, cookies: mod })).json() as {
      sections: { identity: { evaderPerson: unknown; evaderOptions: unknown } };
    };
    expect(file.sections.identity.evaderPerson).toEqual({ id, label: 'dethisa', closed: false });
    expect(file.sections.identity.evaderOptions).toEqual([{ id, label: 'dethisa' }]);
  });
});
