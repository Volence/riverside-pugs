import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import { APPEAL_COOKIE } from '../src/appeals/appealSession.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { AppealSync } from '../src/discord/appealSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198000000001';
const MOD = '76561198000000008';
const OTHERADMIN = '76561198000000009';
let db: DB;
let app: FastifyInstance;
let fake: FakeTransport;

beforeEach(async () => {
  db = openDb(':memory:');
  fake = new FakeTransport();
  app = await buildServer({
    config: loadConfig({ PUBLIC_URL: 'https://pug.test' }),
    db, orchestrator: stubOrchestrator(), serverExec: async () => {}, serverCleaner: async () => {},
    discordModeration: fake.moderation,
  });
  setSetting(db, 'appeals_enabled', '1');
  upsertPlayer(db, { steamid: P, name: 'telltale', avatar: null }, []);
  upsertPlayer(db, { steamid: MOD, name: 'mod', avatar: null }, []);
  upsertPlayer(db, { steamid: OTHERADMIN, name: 'otheradmin', avatar: null }, []);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OTHERADMIN);
});
afterEach(async () => { await app.close(); });

/** A banned player's cookie: ban first, then sign in, as a real login would. */
function bannedCookie(steamid: string, by = 'system') {
  const ban = insertBan(db, steamid, by, 'abandon', null);
  return { ban, cookies: authedCookie(app, db, steamid, { active: false }) };
}

describe('an appeal against a ban from a restricted ticket, for a moderator not on its access list', () => {
  let ticketId: number;
  let ban: number;
  let cookies: Record<string, string>;
  let id: number;

  beforeEach(async () => {
    ticketId = Number(db.prepare(
      "INSERT INTO tickets (target_id, target_name, created_at) VALUES (?, 'telltale', 'x')",
    ).run(P).lastInsertRowid);
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    db.prepare("INSERT INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, 'system', 'x')").run(ticketId, OTHERADMIN);
    ({ ban, cookies } = bannedCookie(P, OTHERADMIN));
    db.prepare('UPDATE bans SET ticket_id = ? WHERE id = ?').run(ticketId, ban);
    const seen: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => seen.push(e));
    const filed = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'ban', id: ban, whatHappened: 'a', whyLift: 'b' } });
    off();
    id = filed.json().id as number;
    // No feed 'appeal' event: a restricted ticket's appeal is quiet, same as
    // its ticket would be.
    expect(seen.filter((e) => e.kind === 'appeal')).toEqual([]);
  });

  it('a moderator off the access list gets 404 from GET, ask and decide, and the appeal is absent from the list', async () => {
    const mod = authedCookie(app, db, MOD);
    expect((await app.inject({ method: 'GET', url: `/api/mod/appeals/${id}`, cookies: mod })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/ask`, cookies: mod, payload: { question: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'deny' } })).statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/mod/appeals?state=open', cookies: mod });
    expect(list.json().appeals.map((a: { id: number }) => a.id)).not.toContain(id);
  });

  it('a moderator on the access list sees it, and deciding it is audited quietly (no admin_action event)', async () => {
    const admin = authedCookie(app, db, OTHERADMIN);
    expect((await app.inject({ method: 'GET', url: `/api/mod/appeals/${id}`, cookies: admin })).statusCode).toBe(200);
    const seen: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => seen.push(e));
    const r = await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: admin, payload: { outcome: 'deny' } });
    off();
    expect(r.statusCode).toBe(200);
    expect(seen.filter((e) => e.kind === 'admin_action')).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'appeal_deny'").get()).toEqual({ n: 1 });
  });

  it('AppealSync makes no forum post for it', async () => {
    setSetting(db, 'discord_tickets_forum_id', '5000');
    const sync = new AppealSync({ db, transport: fake, publicUrl: 'https://pug.test', intervalMs: 0 });
    await sync.reconcile();
    expect(fake.threadsIn('5000')).toHaveLength(0);
  });
});

describe('an appeal by a staff member', () => {
  it('a moderator gets 404 (not 403) on GET, ask and decide', async () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(P);
    const { ban, cookies } = bannedCookie(P, OTHERADMIN);
    const filed = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'ban', id: ban, whatHappened: 'a', whyLift: 'b' } });
    const id = filed.json().id as number;
    const mod = authedCookie(app, db, MOD);
    expect((await app.inject({ method: 'GET', url: `/api/mod/appeals/${id}`, cookies: mod })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/ask`, cookies: mod, payload: { question: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'deny' } })).statusCode).toBe(404);
  });
});

describe('a tampered appeal cookie', () => {
  it('gets 401 from /api/appeals/mine', async () => {
    const good = app.signCookie(`901.${Date.now()}.${Buffer.from('stranger').toString('base64url')}`);
    const tampered = `${good.slice(0, -1)}${good.at(-1) === 'a' ? 'b' : 'a'}`;
    const r = await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies: { [APPEAL_COOKIE]: tampered } });
    expect(r.statusCode).toBe(401);
  });
});
