import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

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
  it('toggles side games for a queued player', async () => {
    await post('/api/queue/join');
    expect((await post('/api/queue/side', { on: true })).statusCode).toBe(200);
    expect((await get('/api/state')).json().queue.sideOptIn).toBe(true);
  });

  it('refuses the toggle when not queued', async () => {
    expect((await post('/api/queue/side', { on: true })).statusCode).toBe(409);
  });

  it('rejects a non-boolean on', async () => {
    await post('/api/queue/join');
    expect((await post('/api/queue/side', { on: 'yes' })).statusCode).toBe(400);
  });
});

describe('sideGame on state and public queue', () => {
  it('state and public queue carry sideGame (null with none running)', async () => {
    expect((await get('/api/state')).json().sideGame).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/queue' })).json().sideGame).toBeNull();
  });
});
