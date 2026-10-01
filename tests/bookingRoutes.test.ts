import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const P = Array.from({ length: 4 }, (_, i) => `7656119900000030${i}`);
const ADMIN = '76561199000000390';
const MOD = '76561199000000391';
const START = new Date(Date.now() + 3 * 24 * 3_600_000);
START.setUTCMinutes(0, 0, 0);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'bookingroutes-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    bookingRcon: async () => { throw new Error('no rcon in route tests'); },
  });
  cookies = {};
  for (const id of [...P, ADMIN, MOD]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'map_pool'").run(JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: 'h', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
const create = async (as = P[0], opponent: object = { steamid: P[1] }) => {
  const r = await call('POST', '/api/bookings', as, { opponent, startsAt: START.toISOString(), minutes: 90, playlist: ['no_mercy'] });
  expect(r.statusCode).toBe(201);
  return r.json().id as number;
};

describe('the switch', () => {
  it('off hides every route; admins-only lets admins through', async () => {
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/bookings/mine', ADMIN)).statusCode).toBe(404);
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/bookings/mine', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/bookings/mine', P[0])).statusCode).toBe(404);
    expect((await call('GET', '/api/bookings/options')).statusCode).toBe(404);
  });
});

describe('booking flow', () => {
  it('options list the pool with typical lengths and the limits', async () => {
    const r = (await call('GET', '/api/bookings/options', P[0])).json();
    expect(r.campaigns.map((c: { slug: string }) => c.slug)).toEqual(['no_mercy', 'death_toll']);
    expect(r.campaigns[0].minutes).toBe(60);
    expect(r.limits).toMatchObject({ minMinutes: 60, maxMinutes: 180, stepMinutes: 30, playlistMax: 4 });
    expect(r.rulesets.map((x: { name: string }) => x.name)).toContain('Casual Scrim');
  });

  it('create, view, confirm, cancel', async () => {
    const id = await create();
    expect((await call('GET', `/api/bookings/${id}`, P[2])).statusCode).toBe(404);
    const v = (await call('GET', `/api/bookings/${id}`, P[1])).json();
    expect(v.viewer).toMatchObject({ side: 'b', invited: true });
    const refused = await call('POST', `/api/bookings/${id}/confirm`, P[2]);
    expect(refused.statusCode).toBe(404);
    const confirmed = await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().sides[1].confirmed).toBe(true);
    const mine = (await call('GET', '/api/bookings/mine', P[1])).json();
    expect(mine.open.map((b: { id: number }) => b.id)).toEqual([id]);
    const cancelled = await call('POST', `/api/bookings/${id}/cancel`, P[1], { reason: 'cannot make it' });
    expect(cancelled.json()).toMatchObject({ state: 'cancelled', cancel: { side: 'b', reason: 'cannot make it' } });
  });

  it('refusals carry the reason text and status', async () => {
    const r = await call('POST', '/api/bookings', P[0], { opponent: { steamid: P[1] }, startsAt: START.toISOString(), minutes: 45, playlist: ['no_mercy'] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/length/);
  });

  it('people: add, accept, remove', async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    const added = await call('POST', `/api/bookings/${id}/people`, P[0], { side: 'a', steamid: P[2], role: 'ringer' });
    expect(added.statusCode).toBe(200);
    expect((await call('POST', `/api/bookings/${id}/accept`, P[2])).statusCode).toBe(200);
    const removed = await call('POST', `/api/bookings/${id}/people/${P[2]}/remove`, P[0]);
    expect(removed.json().sides[0].people.map((p: { steamid: string }) => p.steamid)).toEqual([P[0]]);
  });

  it('notification preferences', async () => {
    const r = await call('POST', '/api/bookings/prefs', P[0], { type: 'booking_ready', enabled: false });
    expect(r.json().prefs.find((p: { type: string }) => p.type === 'booking_ready').enabled).toBe(false);
    expect((await call('POST', '/api/bookings/prefs', P[0], { type: 'nope', enabled: false })).statusCode).toBe(400);
  });
});

describe('staff', () => {
  it('lists bookings for staff only, and a staff cancel is audited and counts against nobody', async () => {
    const id = await create();
    expect((await call('GET', '/api/admin/bookings', P[0])).statusCode).toBe(403);
    const list = (await call('GET', '/api/admin/bookings', MOD)).json();
    expect(list.bookings.map((b: { id: number }) => b.id)).toEqual([id]);
    expect((await call('POST', `/api/admin/bookings/${id}/cancel`, MOD, { reason: 'test' })).statusCode).toBe(200);
    expect(db.prepare('SELECT state, cancel_side FROM bookings WHERE id = ?').get(id)).toEqual({ state: 'cancelled', cancel_side: null });
    expect(db.prepare("SELECT action FROM admin_actions WHERE action = 'booking_cancel'").all()).toHaveLength(1);
  });
});
