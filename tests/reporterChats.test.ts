import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, claimTicket, closeTicket } from '../src/tickets/actions.js';
import { reporterThreadsOf, CHAT_CLOSED } from '../src/tickets/reporterChat.js';
import { ReporterChats, CHAT_OPENING, CHAT_ENDED_BY_STAFF } from '../src/discord/reporterChats.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000041${i}`);
const [R1, R2, ACCUSED, , , MOD2, MOD, ADMIN] = IDS;
const D = (id: string) => `95${IDS.indexOf(id)}`;
const LURKER = { kind: 'discord' as const, discordId: '9990', name: 'Lurky', timedOutUntil: null };
let db: DB;
let t: FakeTransport;
let chats: ReporterChats;
let members: Map<string, boolean>;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `95${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  t = new FakeTransport();
  members = new Map();
  chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1', isMember: (id) => members.get(id) ?? null });
});

const file = (by: string | typeof LURKER, target: string, category = 'griefing', text = 'x') =>
  fileReport(db, by, { targetId: target, category, text }, { adminSteamIds: [ADMIN] }) as { ok: true; reportId: number; ticketId: number };
const memberIds = (threadId: string) => [...t.threadsById.get(threadId)!.members].sort();
const kinds = (ticketId: number) => (db.prepare('SELECT kind FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(ticketId) as { kind: string }[]).map((e) => e.kind);
const said = (threadId: string) => t.live().filter((m) => m.channelId === threadId).map((m) => m.payload.content ?? m.payload.embeds[0]?.description ?? '');

describe('a reporter opens a chat', () => {
  it('gets a private thread in the tickets channel with the claimer, one opening line, and a ping asked for', async () => {
    const r = file(R1, ACCUSED);
    claimTicket(db, r.ticketId, MOD, true);
    const res = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    const [th] = reporterThreadsOf(db, r.ticketId, 'open');
    expect(res).toEqual({ ok: true, url: `https://discord.com/channels/g1/${th.thread_id}`, created: true, reopened: false });
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ parentId: 'chan1', surface: 'private', name: 'Chat with the moderators' });
    expect(th).toMatchObject({ reporter_id: R1, reporter_discord_id: null, surface: 'private', channel_id: 'chan1' });
    expect(memberIds(th.thread_id)).toEqual([D(R1), D(MOD)].sort());
    expect(said(th.thread_id)).toEqual([CHAT_OPENING]);
    expect(kinds(r.ticketId)).toContain('reporter_chat');
    expect(db.prepare('SELECT wanted_at IS NOT NULL AS w FROM reporter_chat_pings WHERE thread_id = ?').get(th.thread_id)).toEqual({ w: 1 });
  });

  it('pressing again links the same thread and changes nothing', async () => {
    const r = file(R1, ACCUSED);
    const first = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    const again = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(again).toMatchObject({ ok: true, created: false, reopened: false });
    expect(first.ok && again.ok && first.url === again.url).toBe(true);
    expect(t.threadsIn('chan1')).toHaveLength(1);
    expect(said(reporterThreadsOf(db, r.ticketId)[0].thread_id)).toHaveLength(1);
  });

  it('a Discord-only reporter chats on their own Discord id', async () => {
    const r = file(LURKER, ACCUSED, 'toxicity');
    const res = await chats.openForReporter(r.reportId, { kind: 'discord', discordId: '9990', timedOutUntil: null });
    expect(res).toMatchObject({ ok: true, created: true });
    const [th] = reporterThreadsOf(db, r.ticketId);
    expect(th).toMatchObject({ reporter_id: null, reporter_discord_id: '9990' });
    expect(memberIds(th.thread_id)).toEqual(['9990']);
  });

  it('refuses somebody else\'s report without making anything', async () => {
    const r = file(R1, ACCUSED);
    expect(await chats.openForReporter(r.reportId, { kind: 'player', steamid: R2 })).toEqual({ ok: false, status: 404, error: CHAT_CLOSED });
    expect(t.threadsById.size).toBe(0);
  });

  it('someone the member list says is not in the server: nothing is made', async () => {
    const r = file(R1, ACCUSED);
    members.set(D(R1), false);
    const res = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(res.ok ? '' : res.error).toMatch(/not in the Discord server/);
    expect(t.threadsById.size).toBe(0);
  });

  it('an add Discord refuses deletes the thread it had just made', async () => {
    const r = file(R1, ACCUSED);
    t.notInGuild.add(D(R1));
    const res = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(t.threadsIn('chan1')).toEqual([]);
    expect(reporterThreadsOf(db, r.ticketId)).toEqual([]);
  });

  it('a thread deleted by hand is made again', async () => {
    const r = file(R1, ACCUSED);
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    const [first] = reporterThreadsOf(db, r.ticketId);
    await t.threads.deleteThread(first.thread_id);
    const res = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(res).toMatchObject({ ok: true, created: true });
    expect(reporterThreadsOf(db, r.ticketId).map((th) => th.id)).not.toContain(first.id);
  });

  it('says so when no tickets channel is set', async () => {
    setSetting(db, 'discord_tickets_channel_id', '');
    const r = file(R1, ACCUSED);
    expect(await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 })).toMatchObject({ ok: false, status: 503 });
  });
});

describe('staff', () => {
  it('Contact reporter opens it with the presser in it, and asks for no ping', async () => {
    const r = file(R1, ACCUSED);
    const res = await chats.contact(r.ticketId, r.reportId, MOD2);
    expect(res).toMatchObject({ ok: true, created: true });
    const [th] = reporterThreadsOf(db, r.ticketId);
    expect(memberIds(th.thread_id)).toEqual([D(R1), D(MOD2)].sort());
    expect(db.prepare('SELECT COUNT(*) AS n FROM reporter_chat_pings').get()).toEqual({ n: 0 });
  });

  it('Join puts the presser in every open chat; someone off a restricted list gets a 404', async () => {
    const a = file(R1, ACCUSED);
    file(R2, ACCUSED, 'afk');
    const reports = db.prepare('SELECT id FROM ticket_reports WHERE ticket_id = ? ORDER BY id').all(a.ticketId) as { id: number }[];
    await chats.openForReporter(reports[0].id, { kind: 'player', steamid: R1 });
    await chats.openForReporter(reports[1].id, { kind: 'player', steamid: R2 });
    expect(await chats.join(a.ticketId, MOD2)).toMatchObject({ ok: true });
    for (const th of reporterThreadsOf(db, a.ticketId)) expect(memberIds(th.thread_id)).toContain(D(MOD2));
    const secret = file(R1, ACCUSED, 'unsafe', 'threats');
    await chats.openForReporter(secret.reportId, { kind: 'player', steamid: R1 });
    expect(await chats.join(secret.ticketId, MOD2)).toMatchObject({ ok: false, status: 404 });
    addAccess(db, secret.ticketId, ADMIN, MOD2);
    expect(await chats.join(secret.ticketId, MOD2)).toMatchObject({ ok: true });
  });

  it('End: a farewell, the reporter taken out, locked and archived; the reporter can open it again', async () => {
    const r = file(R1, ACCUSED);
    await chats.contact(r.ticketId, r.reportId, MOD);
    const [th] = reporterThreadsOf(db, r.ticketId);
    expect(await chats.end(r.ticketId, th.id, MOD)).toEqual({ ok: true });
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: true, archived: true, deleted: false });
    expect(memberIds(th.thread_id)).toEqual([D(MOD)]);
    expect(said(th.thread_id)).toContain(CHAT_ENDED_BY_STAFF);
    expect(reporterThreadsOf(db, r.ticketId, 'ended').map((x) => x.id)).toEqual([th.id]);
    expect(await chats.end(r.ticketId, th.id, MOD)).toMatchObject({ ok: false, status: 409 });

    const back = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(back).toMatchObject({ ok: true, created: false, reopened: true });
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: false, archived: false });
    expect(memberIds(th.thread_id)).toEqual([D(R1), D(MOD)].sort());
    expect(reporterThreadsOf(db, r.ticketId, 'open').map((x) => x.id)).toEqual([th.id]);
  });

  it('nothing on a closed ticket', async () => {
    const r = file(R1, ACCUSED);
    closeTicket(db, r.ticketId, MOD, 'no_action', '', false);
    expect(await chats.contact(r.ticketId, r.reportId, MOD)).toMatchObject({ ok: false, status: 409 });
    expect(await chats.join(r.ticketId, MOD)).toMatchObject({ ok: false, status: 409 });
  });
});
