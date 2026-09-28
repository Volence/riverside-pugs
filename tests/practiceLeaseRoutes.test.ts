import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { openDb, type DB } from '../src/db.js';
import { practiceRoutes } from '../src/routes/practice.js';
import { addServer } from '../src/serverPool.js';
import { PracticeLeases, getLease } from '../src/practiceLeases.js';
import { authedCookie } from './helpers.js';

const OWNER = '76561199000000061';
const FRIEND = '76561199000000062';
const ADMIN = '76561199000000063';

let db: DB;
let app: FastifyInstance;
let leases: PracticeLeases;
let sent: string[][];
let owner: Record<string, string>;
let friend: Record<string, string>;
let admin: Record<string, string>;

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function seedServers(n: number): void {
  for (let i = 1; i <= n; i++) {
    const id = addServer(db, { name: `Box ${i}`, host: `10.0.0.${i}`, port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare('UPDATE servers SET restart_after_match = 1 WHERE id = ?').run(id);
  }
}

beforeEach(async () => {
  db = openDb(':memory:');
  sent = [];
  leases = new PracticeLeases({
    db, publicUrl: 'https://riversidepug.com',
    rcon: async (_s, cmds) => { sent.push(cmds); return cmds.map((c) => (c === 'status' ? 'players : 0 humans, 0 bots (31 max)' : '')); },
    release: async () => true,
    sleep: async () => {},
  });
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(practiceRoutes, { db, replayDir: '', r2: null, leases });
  await app.ready();
  owner = authedCookie(app, db, OWNER);
  friend = authedCookie(app, db, FRIEND);
  admin = authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});
afterEach(async () => { leases.stop(); await app.close(); });

const start = (payload: object, cookies: Record<string, string> | null = owner) =>
  app.inject({ method: 'POST', url: '/api/practice/leases', payload, cookies: cookies ?? undefined });

describe('POST /api/practice/leases', () => {
  it('refuses anyone signed out', async () => {
    seedServers(2);
    expect((await start({ kind: 'park' }, null)).statusCode).toBe(401);
  });

  it('starts a park and then hands the same park to the next player', async () => {
    seedServers(3);
    const a = await start({ kind: 'park' });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ joined: false, lease: { id: 1, kind: 'park', server: 'Box 3', isOwner: true, capacity: 8 } });
    const b = await start({ kind: 'park' }, friend);
    expect(b.json()).toMatchObject({ joined: true, lease: { id: 1, isOwner: false } });
  });

  it('says all servers are busy when none can be spared', async () => {
    seedServers(1);
    const r = await start({ kind: 'park' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('All servers are busy with PUGs right now. Try again in a few minutes.');
  });

  it('checks the drill code and preloads it', async () => {
    seedServers(2);
    expect((await start({ kind: 'drill', drillCode: 'ZZZZ' })).statusCode).toBe(404);
    expect((await start({ kind: 'park', drillCode: 'ZZZZ' })).statusCode).toBe(400);
    db.prepare("INSERT INTO practice_drills (code, spec_json, ordinal, half, t_ms) VALUES ('K7QX', '{}', 0, 1, 0)").run();
    const r = await start({ kind: 'drill', drillCode: 'k7qx' });
    expect(r.statusCode).toBe(200);
    expect(r.json().lease.drillCode).toBe('K7QX');
    await flush();
    expect(sent.at(-1)?.at(-1)).toBe('sm_drill_load K7QX');
  });

  it('a second lease of your own is a 409 naming the first', async () => {
    seedServers(3);
    await start({ kind: 'drill' });
    const r = await start({ kind: 'drill' });
    expect(r.statusCode).toBe(409);
    expect(r.json().leaseId).toBe(1);
  });

  it('rejects an unknown kind', async () => {
    expect((await start({ kind: 'ranked' })).statusCode).toBe(400);
  });
});

describe('GET /api/practice/park', () => {
  it('lists parks without host or password, and tells a logged-in viewer their own lease', async () => {
    seedServers(2);
    await start({ kind: 'park' });
    const anon = await app.inject({ method: 'GET', url: '/api/practice/park' });
    expect(anon.json()).toMatchObject({ available: true, mine: null, parks: [{ id: 1, server: 'Box 2', humans: 0, capacity: 8 }] });
    const body = anon.body;
    expect(body).not.toContain(getLease(db, 1)!.password);
    expect(body).not.toContain('10.0.0.2');
    const mine = await app.inject({ method: 'GET', url: '/api/practice/park', cookies: owner });
    expect(mine.json().mine).toEqual({ id: 1, kind: 'park' });
  });
});

describe('GET /api/practice/leases/:id', () => {
  it('shows the connect line and password to any logged-in player, not to the signed out', async () => {
    seedServers(2);
    await start({ kind: 'drill' });
    expect((await app.inject({ method: 'GET', url: '/api/practice/leases/1' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url: '/api/practice/leases/1', cookies: friend });
    expect(r.json()).toMatchObject({
      isOwner: false, canEnd: false,
      connect: { host: '10.0.0.2', port: 27015, password: getLease(db, 1)!.password },
    });
    expect((await app.inject({ method: 'GET', url: '/api/practice/leases/9', cookies: friend })).statusCode).toBe(404);
  });
});

describe('POST /api/practice/leases/:id/end', () => {
  it('only the owner or an admin may end it; an admin end is audited', async () => {
    seedServers(2);
    await start({ kind: 'drill' });
    await flush();
    const end = (c: Record<string, string>) => app.inject({ method: 'POST', url: '/api/practice/leases/1/end', cookies: c });
    expect((await end(friend)).statusCode).toBe(403);
    const r = await end(admin);
    expect(r.statusCode).toBe(200);
    expect(getLease(db, 1)!.end_reason).toBe('admin');
    expect((await end(owner)).statusCode).toBe(409);
    expect(db.prepare("SELECT action, target FROM admin_actions WHERE action = 'practice_end'").all())
      .toEqual([{ action: 'practice_end', target: '1' }]);
  });
});

describe('GET /api/admin/practice/leases', () => {
  it('is admin only', async () => {
    seedServers(2);
    await start({ kind: 'park' });
    expect((await app.inject({ method: 'GET', url: '/api/admin/practice/leases', cookies: friend })).statusCode).toBe(403);
    const r = await app.inject({ method: 'GET', url: '/api/admin/practice/leases', cookies: admin });
    expect(r.json().leases).toMatchObject([{ id: 1, kind: 'park', owner: { steamid: OWNER } }]);
  });
});
