import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { openDb, type DB } from '../src/db.js';
import { teamRoutes } from '../src/routes/teams.js';
import type { CommunityStore } from '../src/community/store.js';
import { authedCookie } from './helpers.js';

/**
 * The real bot never DMs in tests built on buildServer (bot stays null, so
 * opts.dm() returns null); this test registers the route plugin on a bare
 * Fastify instance with a stub `dm` so the 24-hour cap is actually exercised.
 */
const CAP = '76561199000000401';
const TARGET = '76561199000000402';

describe('invite DM is capped to one per team per player per 24 hours', () => {
  let db: DB;
  let app: FastifyInstance;
  let dmCalls: string[];
  let cookies: Record<string, Record<string, string>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
    app = Fastify();
    await app.register(cookie, { secret: 'a'.repeat(32) });
    dmCalls = [];
    await app.register(teamRoutes, {
      db,
      store: () => ({}) as CommunityStore,
      publicUrl: 'https://example.test',
      dm: () => async (userId: string) => { dmCalls.push(userId); },
    });
    cookies = { [CAP]: authedCookie(app, db, CAP), [TARGET]: authedCookie(app, db, TARGET) };
    db.prepare('UPDATE players SET discord_id = ? WHERE steamid = ?').run('d-target', TARGET);
  });
  afterEach(async () => { await app.close(); });

  const call = (method: 'GET' | 'POST', url: string, as: string, payload?: object) =>
    app.inject({ method, url, cookies: cookies[as], payload });

  it('invite, cancel, invite again sends exactly one DM', async () => {
    const slug = (await call('POST', '/api/teams', CAP, { name: 'Rats', tag: 'RR' })).json().slug as string;
    const inv1 = await call('POST', `/api/teams/${slug}/invites`, CAP, { steamid: TARGET });
    expect(inv1.statusCode).toBe(201);
    await call('POST', `/api/teams/invites/${inv1.json().inviteId}/cancel`, CAP);
    const inv2 = await call('POST', `/api/teams/${slug}/invites`, CAP, { steamid: TARGET });
    expect(inv2.statusCode).toBe(201);
    expect(dmCalls).toEqual(['d-target']);
  });

  it('a second invite more than 24 hours later DMs again', async () => {
    const slug = (await call('POST', '/api/teams', CAP, { name: 'Rats', tag: 'RR' })).json().slug as string;
    const inv1 = await call('POST', `/api/teams/${slug}/invites`, CAP, { steamid: TARGET });
    await call('POST', `/api/teams/invites/${inv1.json().inviteId}/cancel`, CAP);
    // Backdate the first invite's created_at by 25 hours so it falls outside the window.
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE team_invites SET created_at = ? WHERE id = ?').run(past, inv1.json().inviteId);
    const inv2 = await call('POST', `/api/teams/${slug}/invites`, CAP, { steamid: TARGET });
    expect(inv2.statusCode).toBe(201);
    expect(dmCalls).toEqual(['d-target', 'd-target']);
  });
});
