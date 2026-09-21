import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    serverExec: async () => {},
  });
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
  upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
});
afterEach(async () => { await app.close(); });

describe('POST /api/profile', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/profile', payload: { bio: 'hi' } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an account that was never let in, and a banned one, and saves nothing', async () => {
    const { banPlayer } = await import('../src/admin/players.js');
    const invited = authedCookie(app, db, P1, { active: false });
    const a = await app.inject({ method: 'POST', url: '/api/profile', cookies: invited, payload: { bio: 'buy gold at evil' } });
    expect(a.statusCode).toBe(403);
    authedCookie(app, db, P2);
    banPlayer(db, P2, P1, 'toxic', 60);
    // Signed in again after the ban, which ended the session they had.
    const banned = authedCookie(app, db, P2, { active: false });
    const b = await app.inject({ method: 'POST', url: '/api/profile', cookies: banned, payload: { bio: 'still here' } });
    expect(b.statusCode).toBe(403);
    expect(db.prepare('SELECT bio FROM players WHERE bio IS NOT NULL').all()).toEqual([]);
    // Reading your own profile is untouched by any of this.
    expect((await app.inject({ method: 'GET', url: `/api/players/${P2}`, cookies: banned })).statusCode).toBe(200);
  });

  it('saves the signed-in player their own fields', async () => {
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({
      method: 'POST', url: '/api/profile', cookies,
      payload: { bio: 'i main hunter', pronouns: 'they/them', country: 'us', links: { x: '@alice' } },
    });
    expect(res.statusCode).toBe(200);
    const prof = await app.inject({ method: 'GET', url: `/api/players/${P1}` });
    const body = prof.json();
    expect(body.player.bio).toBe('i main hunter');
    expect(body.player.pronouns).toBe('they/them');
    expect(body.player.country).toBe('US');
    expect(body.social).toEqual([
      { platform: 'x', label: 'X', handle: 'alice', url: 'https://x.com/alice' },
    ]);
  });

  it('refuses a link in the bio with a message the form can show', async () => {
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({
      method: 'POST', url: '/api/profile', cookies, payload: { bio: 'visit evil.gg' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/links/i);
  });

  it('writes only to the caller, whatever the body says', async () => {
    const cookies = authedCookie(app, db, P1);
    await app.inject({
      method: 'POST', url: '/api/profile', cookies,
      payload: { steamid: P2, bio: 'not bobs' },
    });
    const bob = await app.inject({ method: 'GET', url: `/api/players/${P2}` });
    expect(bob.json().player.bio).toBe(null);
    const me = await app.inject({ method: 'GET', url: `/api/players/${P1}` });
    expect(me.json().player.bio).toBe('not bobs');
  });

  it('serves nulls and an empty social list for an untouched profile', async () => {
    const prof = await app.inject({ method: 'GET', url: `/api/players/${P2}` });
    const body = prof.json();
    expect(body.player.bio).toBe(null);
    expect(body.player.pronouns).toBe(null);
    expect(body.player.country).toBe(null);
    expect(body.player.twitchName).toBe(null);
    expect(body.social).toEqual([]);
  });

  it('exposes twitchName on a profile once linked', async () => {
    db.prepare("UPDATE players SET twitch_id = '9', twitch_name = 'alicetv' WHERE steamid = ?").run(P1);
    const prof = await app.inject({ method: 'GET', url: `/api/players/${P1}` });
    expect(prof.json().player.twitchName).toBe('alicetv');
  });

  it('never serves the twitch id, only the public login', async () => {
    db.prepare("UPDATE players SET twitch_id = '123456', twitch_name = 'alicetv' WHERE steamid = ?").run(P1);
    const prof = await app.inject({ method: 'GET', url: `/api/players/${P1}` });
    expect(JSON.stringify(prof.json())).not.toContain('123456');
  });
});
