import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator() });
});

describe('GET /api/queue', () => {
  it('is public and lists who is queued', async () => {
    const steamid = '76561198000000001';
    const cookie = authedCookie(app, db, steamid);
    expect((await app.inject({ method: 'POST', url: '/api/queue/join', cookies: cookie })).statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/queue' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.players[0].steamid).toBe(steamid);
  });

  it('never exposes connect details', async () => {
    const body = await app.inject({ method: 'GET', url: '/api/queue' }).then((r) => r.json());
    expect(JSON.stringify(body)).not.toContain('password');
    expect(body.connect).toBeUndefined();
  });
});
