import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const A = '76561198000000201';
const B = '76561198000000202';
let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverExec: async () => {} });
});

const post = (url: string, cookies: Record<string, string>, payload?: object) =>
  app.inject({ method: 'POST', url, cookies, payload });

describe('duo routes', () => {
  it('refuses before Season 1', async () => {
    const ca = authedCookie(app, db, A);
    authedCookie(app, db, B);
    const res = await post('/api/duo/invite', ca, { steamid: B });
    expect(res.statusCode).toBe(409);
  });

  it('invite, accept, show in state, end', async () => {
    db.prepare('UPDATE seasons SET ranks = 1').run();
    const ca = authedCookie(app, db, A);
    const cb = authedCookie(app, db, B);
    const inv = await post('/api/duo/invite', ca, { steamid: B });
    expect(inv.statusCode).toBe(200);
    const id = inv.json().inviteId;
    expect((await post(`/api/duo/invites/${id}/accept`, cb)).statusCode).toBe(200);
    const st = await app.inject({ method: 'GET', url: '/api/state', cookies: ca });
    expect(st.json().duo.partner.steamid).toBe(B);
    expect((await post('/api/duo/end', cb)).statusCode).toBe(200);
  });

  it('rejects a bad steamid and a bad invite id', async () => {
    db.prepare('UPDATE seasons SET ranks = 1').run();
    const ca = authedCookie(app, db, A);
    expect((await post('/api/duo/invite', ca, { steamid: 'nope' })).statusCode).toBe(400);
    expect((await post('/api/duo/invites/abc/accept', ca)).statusCode).toBe(400);
  });

  it('needs a signed-in player', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/duo/end' })).statusCode).toBe(401);
  });
});
