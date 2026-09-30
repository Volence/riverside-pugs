import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561199000000091';
const PLAYER = '76561199000000092';
const MOD = '76561199000000093';

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  cookies = {};
  for (const id of [ADMIN, PLAYER, MOD]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1, is_admin = 0 WHERE steamid = ?').run(MOD);
});
afterEach(async () => { await app.close(); });

describe('queue activity is admin only', () => {
  it('the old public path is gone', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/activity' });
    expect(res.statusCode).not.toBe(200);
  });

  it('refuses anonymous visitors, players and moderators, and answers an admin', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/activity' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/activity', cookies: cookies[PLAYER] })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/activity', cookies: cookies[MOD] })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/api/admin/activity', cookies: cookies[ADMIN] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pops).toHaveLength(7);
  });
});
