import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, claimTicket, closeTicket, reopenTicket } from '../src/tickets/actions.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { staffThread } from '../src/tickets/threads.js';
import { reporterThreadsOf, requestPing } from '../src/tickets/reporterChat.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { ReporterChats, CHAT_ENDED_ON_CLOSE } from '../src/discord/reporterChats.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000042${i}`);
const [R1, R2, ACCUSED, , , MOD2, MOD, ADMIN] = IDS;
const D = (id: string) => `96${IDS.indexOf(id)}`;
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let chats: ReporterChats;

beforeEach(async () => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `96${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1', serialise: (fn) => sync.serialise(fn) });
  sync.start();
  await sync.idle();
});
afterEach(() => sync.stop());

const file = (by: string, target: string, category = 'griefing', text = 'x') =>
  fileReport(db, by, { targetId: target, category, text }, { adminSteamIds: [ADMIN] }) as { ok: true; reportId: number; ticketId: number };
const inPost = (ticketId: number) => t.live().filter((m) => m.channelId === staffThread(db, ticketId)!.thread_id);
const pingLines = (ticketId: number) => inPost(ticketId).filter((m) => /opened a chat/.test(m.payload.content ?? ''));

describe('telling staff about a chat', () => {
  it('a normal ticket, unclaimed: one line in the forum post pinging everyone who may read the forum', async () => {
    const r = file(R1, ACCUSED);
    await sync.idle();
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    const [line] = pingLines(r.ticketId);
    expect(line.payload.mentionUserIds!.sort()).toEqual([D(MOD2), D(MOD), D(ADMIN)].sort());
    await sync.reconcile();
    expect(pingLines(r.ticketId)).toHaveLength(1);
  });

  it('claimed: only the claimer, and a reopen inside the hour pings nobody', async () => {
    const r = file(R1, ACCUSED);
    claimTicket(db, r.ticketId, MOD, true);
    await sync.idle();
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    expect(pingLines(r.ticketId).map((m) => m.payload.mentionUserIds)).toEqual([[D(MOD)]]);
    const [th] = reporterThreadsOf(db, r.ticketId);
    await chats.end(r.ticketId, th.id, MOD);
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    expect(pingLines(r.ticketId)).toHaveLength(1);
    // An hour later the waiting ping goes out.
    db.prepare("UPDATE reporter_chat_pings SET last_ping_at = '2000-01-01T00:00:00.000Z'").run();
    await sync.reconcile();
    expect(pingLines(r.ticketId)).toHaveLength(2);
  });

  it('a pending ping is dropped, not sent, once its own thread has ended', async () => {
    const r = file(R1, ACCUSED);
    await sync.idle();
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    expect(pingLines(r.ticketId)).toHaveLength(1);
    const [th] = reporterThreadsOf(db, r.ticketId);
    await chats.end(r.ticketId, th.id, MOD);
    // Reopened inside the hour: a new ping is requested but throttled, same as above.
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    expect(pingLines(r.ticketId)).toHaveLength(1);
    // Ended again while that ping is still only pending, never sent.
    await chats.end(r.ticketId, th.id, MOD);
    // An hour later the pending ping becomes due, but its thread is not open.
    db.prepare("UPDATE reporter_chat_pings SET last_ping_at = '2000-01-01T00:00:00.000Z'").run();
    await sync.reconcile();
    expect(pingLines(r.ticketId)).toHaveLength(1);
  });

  it('a restricted ticket: its access list is DMed a link and nothing else, and nothing goes in any post', async () => {
    const r = file(R1, ACCUSED, 'unsafe', 'he threatened me');
    addAccess(db, r.ticketId, ADMIN, MOD);
    await sync.idle();
    const before = t.dms.length;
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    const pings = t.dms.slice(before);
    expect(pings.map((d) => d.userId).sort()).toEqual([D(MOD), D(ADMIN)].sort());
    for (const d of pings) {
      const said = JSON.stringify(d.payload);
      expect(said).toContain(`The reporter wrote on ticket #${r.ticketId}`);
      expect(said).toContain(`https://pug.test/admin/people/tickets/${r.ticketId}`);
      expect(said).not.toContain('threatened');
      expect(said).not.toContain('player0');
    }
    expect(staffThread(db, r.ticketId)).toBeUndefined();
    const [th] = reporterThreadsOf(db, r.ticketId);
    requestPing(db, th.thread_id);
    await sync.reconcile();
    expect(t.dms.length - before).toBe(2);
  });
});

describe('closing', () => {
  it('ends every chat, then thanks every reporter once', async () => {
    const r = file(R1, ACCUSED);
    file(R2, ACCUSED, 'afk');
    await sync.idle();
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    const [th] = reporterThreadsOf(db, r.ticketId);
    const dmsBefore = t.dms.length;
    closeTicket(db, r.ticketId, MOD, 'warned', '', true);
    await sync.idle();
    expect(reporterThreadsOf(db, r.ticketId, 'ended').map((x) => x.id)).toEqual([th.id]);
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: true, archived: true });
    expect([...t.threadsById.get(th.thread_id)!.members]).not.toContain(D(R1));
    expect(t.live().some((m) => m.channelId === th.thread_id && m.payload.embeds[0]?.description === CHAT_ENDED_ON_CLOSE)).toBe(true);
    const thanks = t.dms.slice(dmsBefore);
    expect(thanks.map((d) => d.userId).sort()).toEqual([D(R1), D(R2)].sort());
    for (const d of thanks) expect(d.payload.content).toBe('Thank you for your report. The ticket is now closed.');
    await sync.reconcile();
    expect(t.dms.length - dmsBefore).toBe(2);
  });

  it('without the tick nobody is told; reopened before the bot got to it, nobody is told', async () => {
    const a = file(R1, ACCUSED);
    await sync.idle();
    const before = t.dms.length;
    closeTicket(db, a.ticketId, MOD, 'warned', '', false);
    await sync.idle();
    expect(t.dms.length).toBe(before);
    sync.stop();
    reopenTicket(db, a.ticketId, MOD);
    closeTicket(db, a.ticketId, MOD, 'warned', '', true);
    reopenTicket(db, a.ticketId, MOD);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await sync.idle();
    expect(t.dms.length).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_notices WHERE sent_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('reopened while the pass is still awaiting an earlier Discord call: no close DM, and the chat is not ended with the closed farewell', async () => {
    const r = file(R1, ACCUSED);
    await sync.idle();
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    const [th] = reporterThreadsOf(db, r.ticketId);
    const dmsBefore = t.dms.length;
    // The pass reads its ticket row once at the top, then awaits several
    // Discord calls (ejectOutsiders, the forbidden-post sweep, the forum's
    // revoke-only sync) before it ever reaches the chat-ending and close-DM
    // steps. Reopen the ticket from inside one of those awaited calls, the
    // way a moderator's own request would land in that same window.
    const realSyncAccess = t.threads.syncMemberAccess.bind(t.threads);
    let flipped = false;
    t.threads.syncMemberAccess = (async (...args: Parameters<typeof realSyncAccess>) => {
      if (!flipped) { flipped = true; reopenTicket(db, r.ticketId, MOD); }
      return realSyncAccess(...args);
    }) as typeof t.threads.syncMemberAccess;
    closeTicket(db, r.ticketId, MOD, 'warned', '', true);
    await sync.idle();
    expect(t.dms.length).toBe(dmsBefore);
    expect(reporterThreadsOf(db, r.ticketId, 'open').map((x) => x.id)).toEqual([th.id]);
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: false, archived: false });
  });
});

describe('who stays in a chat', () => {
  it('a moderator demoted after joining is taken out; the reporter stays', async () => {
    const r = file(R1, ACCUSED);
    await sync.idle();
    await chats.contact(r.ticketId, r.reportId, MOD2);
    const [th] = reporterThreadsOf(db, r.ticketId);
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(MOD2);
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect([...t.threadsById.get(th.thread_id)!.members]).toEqual([D(R1)]);
  });

  it('a stranger added by hand goes, even from an ended chat, which stays locked', async () => {
    const r = file(R1, ACCUSED);
    await sync.idle();
    await chats.contact(r.ticketId, r.reportId, MOD);
    const [th] = reporterThreadsOf(db, r.ticketId);
    await chats.end(r.ticketId, th.id, MOD);
    t.threadsById.get(th.thread_id)!.members.add('555');
    await sync.reconcile();
    expect([...t.threadsById.get(th.thread_id)!.members]).not.toContain('555');
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: true, archived: true });
  });
});
