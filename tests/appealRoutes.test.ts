import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer } from '../src/players.js';
import { insertBan, banMessage } from '../src/admin/players.js';
import { APPEAL_COOKIE } from '../src/appeals/appealSession.js';
import { postStaffMessage } from '../src/appeals/store.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';

export const P = '76561198000000001';
export const Q = '76561198000000002';
export const MOD = '76561198000000008';
export const ADMIN = '76561198000000009';
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
  for (const id of [P, Q]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-1)}`, avatar: null }, []);
});
afterEach(async () => { await app.close(); });

/** A banned player's cookie: ban first, then sign in, as a real login would. */
function bannedCookie(steamid: string, minutes: number | null = null, by = 'system') {
  const ban = insertBan(db, steamid, by, 'abandon', minutes);
  return { ban, cookies: authedCookie(app, db, steamid, { active: false }) };
}
const discordCookie = (discordId: string, name = 'stranger') =>
  ({ [APPEAL_COOKIE]: app.signCookie(`${discordId}.${Date.now()}.${Buffer.from(name).toString('base64url')}`) });

describe('player appeal routes', () => {
  it('a banned player sees their ban, files once, and writes back and forth with staff', async () => {
    const { ban, cookies } = bannedCookie(P);
    const mine = await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies });
    expect(mine.json()).toMatchObject({ enabled: true, items: [{ ref: { kind: 'ban', id: ban }, canAppeal: true }] });
    const filed = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'ban', id: ban, whatHappened: 'lag', whyLift: 'router' } });
    expect(filed.statusCode).toBe(200);
    const id = filed.json().id as number;
    const more = await app.inject({ method: 'POST', url: `/api/appeals/${id}/messages`, cookies, payload: { body: 'It was round 2' } });
    expect(more.json()).toEqual({ ok: true, state: 'open' });
    postStaffMessage(db, id, ADMIN, 'Which map?');
    // The path from before the thread still works for a page loaded then.
    const ans = await app.inject({ method: 'POST', url: `/api/appeals/${id}/answer`, cookies, payload: { answer: 'Dead Air 2' } });
    expect(ans.json()).toEqual({ ok: true, state: 'answered' });
    const after = (await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies })).json();
    expect(after.items[0].appeal).toMatchObject({ state: 'answered', canWrite: true });
    // Staff are "Staff" to the player: no author on any message.
    expect(after.items[0].appeal.messages).toEqual([
      { fromStaff: false, body: 'It was round 2', at: expect.any(String) },
      { fromStaff: true, body: 'Which map?', at: expect.any(String) },
      { fromStaff: false, body: 'Dead Air 2', at: expect.any(String) },
    ]);
    expect(JSON.stringify(after)).not.toContain(ADMIN);
  });

  it('a forged ref (somebody else\'s ban) is refused and nothing is stored', async () => {
    const { cookies } = bannedCookie(P);
    const theirs = insertBan(db, Q, 'system', 'abandon', null);
    const r = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'ban', id: theirs, whatHappened: 'a', whyLift: 'b' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('You have nothing to appeal.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM appeals').get()).toEqual({ n: 0 });
  });

  it('a Discord-only person with no player row appeals their sanction through the appeal cookie', async () => {
    const sid = Number(db.prepare(`INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at)
      VALUES ('901', 'ban', NULL, 'spam', ?, ?)`).run(MOD, new Date().toISOString()).lastInsertRowid);
    const cookies = discordCookie('901');
    const mine = await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies });
    expect(mine.json().items).toMatchObject([{ ref: { kind: 'sanction', id: sid }, sanctionKind: 'ban', canAppeal: true }]);
    const filed = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'sanction', id: sid, whatHappened: 'a', whyLift: 'b' } });
    expect(filed.statusCode).toBe(200);
    expect(db.prepare('SELECT source, discord_id, appellant_name FROM appeals').get())
      .toEqual({ source: 'appeal_page', discord_id: '901', appellant_name: 'stranger' });
  });

  it('nobody signed in gets 401; an expired appeal cookie is no sign-in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/appeals/mine' })).statusCode).toBe(401);
    const old = { [APPEAL_COOKIE]: app.signCookie(`901.${Date.now() - 2 * 3600_000}.eA`) };
    expect((await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies: old })).statusCode).toBe(401);
  });

  it('the bot reply points at /appeal only while appeals are on', () => {
    insertBan(db, P, 'system', 'abandon', null);
    expect(banMessage(db, P, 'https://pug.test')).toContain('https://pug.test/appeal');
    setSetting(db, 'appeals_enabled', '0');
    expect(banMessage(db, P, 'https://pug.test')).not.toContain('/appeal');
  });
});

describe('staff appeal routes', () => {
  const staff = () => {
    const mod = authedCookie(app, db, MOD);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    const admin = authedCookie(app, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { mod, admin };
  };
  const fileAs = async (cookies: Record<string, string>, kind: 'ban' | 'sanction', id: number) =>
    (await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind, id, whatHappened: 'a', whyLift: 'b' } })).json().id as number;

  it('a moderator lists, writes twice, and denies; the audit rows name the writer and the decider', async () => {
    const { mod } = staff();
    const { ban, cookies } = bannedCookie(P);
    const id = await fileAs(cookies, 'ban', ban);
    const list = await app.inject({ method: 'GET', url: '/api/mod/appeals?state=open', cookies: mod });
    expect(list.json().appeals.map((a: { id: number }) => a.id)).toEqual([id]);
    expect((await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/messages`, cookies: mod, payload: { body: 'Which map?' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/ask`, cookies: mod, payload: { question: 'And round?' } })).statusCode).toBe(200);
    const detail = (await app.inject({ method: 'GET', url: `/api/mod/appeals/${id}`, cookies: mod })).json();
    expect(detail.messages).toEqual([
      { fromStaff: true, authorName: 'p008', body: 'Which map?', at: expect.any(String) },
      { fromStaff: true, authorName: 'p008', body: 'And round?', at: expect.any(String) },
    ]);
    const deny = await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'deny' } });
    expect(deny.statusCode).toBe(200);
    expect(db.prepare("SELECT admin_id, action FROM admin_actions WHERE action LIKE 'appeal_%'").all())
      .toEqual([{ admin_id: MOD, action: 'appeal_ask' }, { admin_id: MOD, action: 'appeal_ask' }, { admin_id: MOD, action: 'appeal_deny' }]);
  });

  it('a moderator cannot decide an appeal against an admin\'s ban', async () => {
    const { mod } = staff();
    const { ban, cookies } = bannedCookie(P, null, ADMIN);
    const id = await fileAs(cookies, 'ban', ban);
    const r = await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'accept' } });
    expect(r.statusCode).toBe(403);
  });

  it('accepting a moderator-issued Discord timeout lifts it in Discord, records the lift, and a moderator may do it', async () => {
    const { mod } = staff();
    const sid = Number(db.prepare(`INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at)
      VALUES ('901', 'timeout', ?, 'spam', ?, ?)`).run(new Date(Date.now() + 7 * 86400_000).toISOString(), MOD, new Date().toISOString()).lastInsertRowid);
    const id = await fileAs(discordCookie('901'), 'sanction', sid);
    const r = await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'accept' } });
    expect(r.statusCode).toBe(200);
    expect(fake.moderationCalls).toMatchObject([{ op: 'removeTimeout', userId: '901' }]);
    expect(db.prepare('SELECT lifted_by FROM discord_sanctions WHERE id = ?').get(sid)).toEqual({ lifted_by: MOD });
  });

  // Discord is lifted before recordDecision writes: if that write then
  // loses (somebody else decided first, or the sweep mooted it), the lift
  // already happened for real and must still be recorded, not left
  // dangling with discord_sanctions saying "active".
  it('a decision that loses the race to an earlier one still records the Discord lift, and reports a quiet problem', async () => {
    const { mod } = staff();
    const sid = Number(db.prepare(`INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at)
      VALUES ('901', 'timeout', ?, 'spam', ?, ?)`).run(new Date(Date.now() + 7 * 86400_000).toISOString(), MOD, new Date().toISOString()).lastInsertRowid);
    const id = await fileAs(discordCookie('901'), 'sanction', sid);
    const removeTimeout = fake.moderation.removeTimeout;
    // Stands in for the race: between this request's decideCheck and its
    // recordDecision write, another request (or the sweep) decides first.
    fake.moderation.removeTimeout = async (userId, reason) => {
      db.prepare("UPDATE appeals SET state = 'denied', decided_by = ?, decided_at = ? WHERE id = ?").run(ADMIN, new Date().toISOString(), id);
      return removeTimeout(userId, reason);
    };
    try {
      const seen: AdminEvent[] = [];
      const off = subscribeAdminEvents((e) => seen.push(e));
      const r = await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'accept' } });
      off();
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('this appeal has already been decided');
      // Discord really did lift it, so the row must say so despite the race.
      expect(db.prepare('SELECT lifted_at IS NOT NULL AS lifted, lifted_by FROM discord_sanctions WHERE id = ?').get(sid))
        .toEqual({ lifted: 1, lifted_by: MOD });
      const problems = seen.filter((e) => e.kind === 'problem');
      expect(problems).toHaveLength(1);
      const text = (problems[0] as Extract<AdminEvent, { kind: 'problem' }>).text;
      expect(text).toContain(`Appeal #${id}`);
      expect(text).toContain('already been decided');
      // No Discord id or name leaks into the admin feed problem line.
      expect(text).not.toContain('901');
    } finally {
      fake.moderation.removeTimeout = removeTimeout;
    }
  });

  it('only an admin marks a ban final', async () => {
    const { mod, admin } = staff();
    const { ban, cookies } = bannedCookie(P);
    const id = await fileAs(cookies, 'ban', ban);
    expect((await app.inject({ method: 'POST', url: `/api/admin/appeals/${id}/final`, cookies: mod, payload: { on: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/admin/appeals/${id}/final`, cookies: admin, payload: { on: true } })).statusCode).toBe(200);
    expect(db.prepare('SELECT no_appeal FROM bans WHERE id = ?').get(ban)).toEqual({ no_appeal: 1 });
  });
});
