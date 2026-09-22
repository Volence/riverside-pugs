import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const [MOD, ADMIN, OWNER] = ['76561199000000801', '76561199000000802', '76561199000000803'];
let db: DB;
let app: FastifyInstance;
let fake: FakeTransport;
let ticketId: number;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  fake = new FakeTransport();
  app = await buildServer({
    config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {}, discordModeration: fake.moderation,
  });
  for (const id of [MOD, ADMIN, OWNER]) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  ticketId = Number(db.prepare("INSERT INTO tickets (target_discord_id, target_name, created_at) VALUES ('990', 'Lurky', 'x')").run().lastInsertRowid);
});
afterEach(async () => { await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const rows = () => db.prepare('SELECT kind, until IS NOT NULL AS timed, lifted_at IS NOT NULL AS lifted FROM discord_sanctions').all();

describe('Discord sanctions over HTTP', () => {
  it('a moderator times out: Discord is called, then it is recorded and audited', async () => {
    const r = await post(MOD, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'timeout', minutes: 60, reason: 'spam' });
    expect(r.statusCode).toBe(200);
    expect(fake.moderationCalls).toEqual([{ op: 'timeout', userId: '990', minutes: 60, reason: 'spam' }]);
    expect(rows()).toEqual([{ kind: 'timeout', timed: 1, lifted: 0 }]);
    expect(db.prepare("SELECT action FROM admin_actions WHERE action = 'ticket_discord_sanction'").get()).toBeTruthy();
  });

  it('a refusal writes nothing and says why', async () => {
    fake.moderationRefusals.set('990', { ok: false, why: 'hierarchy', detail: 'x' });
    const r = await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/above the bot/);
    expect(rows()).toEqual([]);
    expect(fake.moderationCalls).toHaveLength(1);
  });

  it('a refused check never reaches Discord', async () => {
    const r = await post(MOD, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' });
    expect(r.statusCode).toBe(403);
    expect(fake.moderationCalls).toEqual([]);
  });

  it('an admin lifts a ban: Discord unbans, then the row is lifted; a moderator cannot', async () => {
    await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' });
    const sid = (db.prepare('SELECT id FROM discord_sanctions').get() as { id: number }).id;
    expect((await post(MOD, `/api/mod/discord-sanctions/${sid}/lift`)).statusCode).toBe(403);
    expect((await post(ADMIN, `/api/mod/discord-sanctions/${sid}/lift`)).statusCode).toBe(200);
    expect(fake.moderationCalls.map((c) => c.op)).toEqual(['ban', 'unban']);
    expect(rows()).toEqual([{ kind: 'ban', timed: 0, lifted: 1 }]);
  });

  it('a restricted ticket audits quietly and hides from a moderator not on its list', async () => {
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    expect((await post(MOD, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'timeout', minutes: 5, reason: 'x' })).statusCode).toBe(404);
    db.prepare("INSERT INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, 'system', 'x')").run(ticketId, ADMIN);
    const seen: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => seen.push(e));
    expect((await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' })).statusCode).toBe(200);
    off();
    expect(seen.filter((e) => JSON.stringify(e).includes('ticket_discord_sanction'))).toEqual([]);
  });

  // Controller ruling (a): lifting a timeout whose member left gets its own
  // wording, distinct from applying one, and records nothing (Task 2's
  // removeTimeout was fixed to stop pretending a departed member's timeout
  // could be lifted).
  it('lifting a timeout for someone who has left the server is refused, with the until baked in, and nothing is recorded', async () => {
    await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'timeout', minutes: 60, reason: 'x' });
    const row = db.prepare('SELECT id, until FROM discord_sanctions').get() as { id: number; until: string };
    fake.moderationRefusals.set('990', { ok: false, why: 'not_member', detail: 'left' });
    const r = await post(ADMIN, `/api/mod/discord-sanctions/${row.id}/lift`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe(
      'they are no longer in the Discord server, so the bot cannot lift the timeout; it ends on its own at ' +
      `${new Date(row.until).toUTCString()}`,
    );
    expect(fake.moderationCalls.map((c) => c.op)).toEqual(['timeout', 'removeTimeout']);
    expect(rows()).toEqual([{ kind: 'timeout', timed: 1, lifted: 0 }]);
  });

  it('has nothing to call Discord with when the bot is not running, and answers 503', async () => {
    const noBotApp = await buildServer({
      config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(),
      serverCleaner: async () => {}, serverExec: async () => {},
      // Deliberately no discordModeration, and this config starts no real
      // bot either (no DISCORD_* env vars), so moderation() falls through to
      // bot?.transport.moderation, and bot stays null.
    });
    const noBotCookie = authedCookie(noBotApp, db, ADMIN);
    const r = await noBotApp.inject({
      method: 'POST', url: `/api/mod/tickets/${ticketId}/discord-sanction`,
      cookies: noBotCookie, payload: { kind: 'ban', reason: 'x' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('the Discord bot is not running');
    expect(rows()).toEqual([]);
    await noBotApp.close();
  });

  // Discord accepted the sanction, but the write that records it threw. The
  // admin feed reaches everyone with feed access, wider than a restricted
  // ticket's own list, so its wording must differ for a restricted ticket.
  describe('the record write failing after Discord accepted', () => {
    it('on a normal ticket: one problem event naming the Discord id and the ticket, 500, nothing audited', async () => {
      db.exec('DROP TABLE discord_sanctions');
      const seen: AdminEvent[] = [];
      const off = subscribeAdminEvents((e) => seen.push(e));
      const r = await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' });
      off();
      expect(r.statusCode).toBe(500);
      expect(r.json().error).toBe('Discord applied it, but recording it failed; an admin has been told');
      const problems = seen.filter((e) => e.kind === 'problem');
      expect(problems).toHaveLength(1);
      const text = (problems[0] as Extract<AdminEvent, { kind: 'problem' }>).text;
      expect(text).toContain('990');
      expect(text).toContain(`ticket #${ticketId}`);
      expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'ticket_discord_sanction'").get()).toEqual({ n: 0 });
      expect(fake.moderationCalls).toHaveLength(1);
    });

    it('on a restricted ticket: one problem event with neutral wording (no Discord id), 500, nothing audited', async () => {
      db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
      db.prepare("INSERT INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, 'system', 'x')").run(ticketId, ADMIN);
      db.exec('DROP TABLE discord_sanctions');
      const seen: AdminEvent[] = [];
      const off = subscribeAdminEvents((e) => seen.push(e));
      const r = await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' });
      off();
      expect(r.statusCode).toBe(500);
      expect(r.json().error).toBe('Discord applied it, but recording it failed; an admin has been told');
      const problems = seen.filter((e) => e.kind === 'problem');
      expect(problems).toHaveLength(1);
      const text = (problems[0] as Extract<AdminEvent, { kind: 'problem' }>).text;
      expect(text).not.toContain('990');
      expect(text).toContain(`ticket #${ticketId}`);
      expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'ticket_discord_sanction'").get()).toEqual({ n: 0 });
      expect(fake.moderationCalls).toHaveLength(1);
    });
  });
});
