import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertMessage } from '../src/tickets/messages.js';
import { setRestricted } from '../src/tickets/actions.js';
import { reporterThreadsOf } from '../src/tickets/reporterChat.js';
import { ReporterChats } from '../src/discord/reporterChats.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000045${i}`);
const [R1, R2, ACCUSED, NOLINK, , , MOD, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
let t: FakeTransport;
const cookie: Record<string, Record<string, string>> = {};

async function boot(withBot: boolean) {
  db = openDb(':memory:');
  t = new FakeTransport();
  const chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1' });
  app = await buildServer({
    config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    ...(withBot ? { reporterChats: chats } : {}),
  });
  IDS.forEach((id, i) => {
    cookie[id] = authedCookie(app, db, id);
    if (id !== NOLINK) linkDiscord(db, id, `99${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
}
afterEach(async () => { await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });
const file = (by: string, target = ACCUSED) =>
  fileReport(db, by, { targetId: target, category: 'griefing', text: 'x' }, { adminSteamIds: [OWNER] }) as { reportId: number; ticketId: number };

describe('with the bot running', () => {
  beforeEach(() => boot(true));

  it('a player opens a chat from My reports and gets the link; nobody else can', async () => {
    const r = file(R1);
    const res = await post(R1, `/api/reports/${r.reportId}/chat`);
    expect(res.statusCode).toBe(200);
    const [th] = reporterThreadsOf(db, r.ticketId);
    expect(res.json()).toEqual({ ok: true, url: `https://discord.com/channels/g1/${th.thread_id}` });
    expect((await post(R2, `/api/reports/${r.reportId}/chat`)).statusCode).toBe(404);
  });

  it('a player with no Discord linked is told to link it', async () => {
    const r = file(NOLINK);
    const res = await post(NOLINK, `/api/reports/${r.reportId}/chat`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Link your Discord/);
  });

  it('staff contact, join and end, each audited; the page lists the chat', async () => {
    const r = file(R1);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/reports/${r.reportId}/contact`)).statusCode).toBe(200);
    expect((await post(OWNER, `/api/mod/tickets/${r.ticketId}/chats/join`)).statusCode).toBe(200);
    const d = (await get(MOD, `/api/mod/tickets/${r.ticketId}`)).json();
    const [th] = reporterThreadsOf(db, r.ticketId);
    // The test config has no Discord, so there is no guild id to link with.
    expect(d.reporterChats).toEqual([{ id: th.id, reporterName: 'p450', state: 'open', url: null }]);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/${th.id}/end`)).statusCode).toBe(200);
    const actions = (db.prepare('SELECT action FROM admin_actions ORDER BY id').all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['ticket_contact', 'ticket_chat_join', 'ticket_chat_end']);
    // The accused sees none of it.
    expect((await post(ACCUSED, `/api/mod/tickets/${r.ticketId}/chats/join`)).statusCode).toBe(403);
  });

  it('Remove everything from this person: every message they wrote in the ticket, and the chat ends', async () => {
    const r = file(R1);
    await post(MOD, `/api/mod/tickets/${r.ticketId}/reports/${r.reportId}/contact`);
    const [th] = reporterThreadsOf(db, r.ticketId);
    const say = (id: string, author: string, player: string | null, content: string) => insertMessage(db, {
      ticketId: r.ticketId, threadId: th.thread_id, channel: 'reporter', discordMessageId: id, authorDiscordId: author,
      authorPlayerId: player, authorName: 'x', content, createdAt: '2026-09-23T00:00:00Z',
    });
    say('7001', '990', R1, 'awful one');
    say('7002', '990', R1, 'awful two');
    say('7003', '996', MOD, 'staff reply');
    const res = await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/${th.id}/remove-all`);
    expect(res.json()).toEqual({ ok: true, removed: 2, ended: true });
    const left = (db.prepare('SELECT content FROM ticket_messages ORDER BY id').all() as { content: string }[]).map((m) => m.content);
    expect(left).toEqual(['', '', 'staff reply']);
    expect(reporterThreadsOf(db, r.ticketId, 'ended')).toHaveLength(1);
  });

  // A restricted ticket's chat routes must answer the same 404 a viewer off
  // the access list gets everywhere else on it (canSeeTicket), never a 403:
  // a 403 would tell a mod who is not on the list that the ticket exists,
  // and it must change nothing either.
  it('a mod off the access list of a restricted ticket gets 404, not 403, from every chat route, and changes nothing', async () => {
    const r = file(R1);
    expect(setRestricted(db, r.ticketId, OWNER, true, [OWNER])).toEqual({ ok: true });
    const opened = await post(OWNER, `/api/mod/tickets/${r.ticketId}/reports/${r.reportId}/contact`);
    expect(opened.statusCode).toBe(200);
    const [th] = reporterThreadsOf(db, r.ticketId);
    const actionsBefore = db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get();

    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/reports/${r.reportId}/contact`)).statusCode).toBe(404);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/join`)).statusCode).toBe(404);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/${th.id}/end`)).statusCode).toBe(404);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/${th.id}/remove-all`)).statusCode).toBe(404);

    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual(actionsBefore);
    expect(reporterThreadsOf(db, r.ticketId, 'open').map((x) => x.id)).toEqual([th.id]);
  });

  it('closing without the tick queues no thank-you', async () => {
    const r = file(R1);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/close`, { outcome: 'warned', note: '', tellReporters: false })).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_notices').get()).toEqual({ n: 0 });
    const s = file(R2, R1);
    expect((await post(MOD, `/api/mod/tickets/${s.ticketId}/close`, { outcome: 'warned', note: '' })).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_notices').get()).toEqual({ n: 1 });
  });
});

describe('with no bot', () => {
  beforeEach(() => boot(false));

  it('says the bot is not running, after the checks that need no bot', async () => {
    const r = file(R1);
    expect((await post(R1, `/api/reports/${r.reportId}/chat`)).statusCode).toBe(503);
    const n = file(NOLINK, R2);
    expect((await post(NOLINK, `/api/reports/${n.reportId}/chat`)).statusCode).toBe(400);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/join`)).statusCode).toBe(503);
  });
});
