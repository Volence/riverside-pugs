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
import { FakeTransport } from './fakes/fakeTransport.js';

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
  it('a banned player sees their ban, files once, and answers the one question', async () => {
    const { ban, cookies } = bannedCookie(P);
    const mine = await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies });
    expect(mine.json()).toMatchObject({ enabled: true, items: [{ ref: { kind: 'ban', id: ban }, canAppeal: true }] });
    const filed = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'ban', id: ban, whatHappened: 'lag', whyLift: 'router' } });
    expect(filed.statusCode).toBe(200);
    const id = filed.json().id as number;
    db.prepare("UPDATE appeals SET state = 'asked', question = 'Which map?', asked_by = ?, asked_at = ? WHERE id = ?").run(ADMIN, new Date().toISOString(), id);
    const ans = await app.inject({ method: 'POST', url: `/api/appeals/${id}/answer`, cookies, payload: { answer: 'Dead Air 2' } });
    expect(ans.json()).toEqual({ ok: true, state: 'answered' });
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
