import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { setSetting } from '../src/settings.js';

let db: DB;
let app: FastifyInstance;
let cookie: Record<string, string>;

const STEAMID = '76561198000000001';

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverExec: async () => {} });
  cookie = authedCookie(app, db, STEAMID);
});

async function post(url: string, payload?: object) {
  return app.inject({ method: 'POST', url, cookies: cookie, payload });
}

async function get(url: string) {
  return app.inject({ method: 'GET', url, cookies: cookie });
}

describe('POST /api/queue/side', () => {
  it('refuses to opt in while side games are off (the default), and allows opting out', async () => {
    await post('/api/queue/join');
    const r = await post('/api/queue/side', { on: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('side games are off');
    expect((await get('/api/state')).json().queue.sideOptIn).toBe(false);
    expect((await post('/api/queue/side', { on: false })).statusCode).toBe(200);
  });

  it('toggles side games for a queued player', async () => {
    setSetting(db, 'sidegames_enabled', '1');
    await post('/api/queue/join');
    expect((await post('/api/queue/side', { on: true })).statusCode).toBe(200);
    expect((await get('/api/state')).json().queue.sideOptIn).toBe(true);
  });

  it('refuses the toggle when not queued', async () => {
    setSetting(db, 'sidegames_enabled', '1');
    expect((await post('/api/queue/side', { on: true })).statusCode).toBe(409);
  });

  it('rejects a non-boolean on', async () => {
    setSetting(db, 'sidegames_enabled', '1');
    await post('/api/queue/join');
    expect((await post('/api/queue/side', { on: 'yes' })).statusCode).toBe(400);
  });
});

describe('sideGame on state and public queue', () => {
  it('state and public queue carry sideGame (null with none running)', async () => {
    expect((await get('/api/state')).json().sideGame).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/queue' })).json().sideGame).toBeNull();
  });

  it('state and public queue say whether side games are on', async () => {
    expect((await get('/api/state')).json().sideGamesEnabled).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/queue' })).json().sideGamesEnabled).toBe(false);
    setSetting(db, 'sidegames_enabled', '1');
    expect((await get('/api/state')).json().sideGamesEnabled).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/queue' })).json().sideGamesEnabled).toBe(true);
  });
});
