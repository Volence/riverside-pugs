import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, closeTicket, setRestricted } from '../src/tickets/actions.js';
import { restrictOpenTicketAbout } from '../src/tickets/store.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { staffThread, threadByDiscordId } from '../src/tickets/threads.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MOD = IDS[6];
const ADMIN = IDS[7];
const deps = { adminSteamIds: [ADMIN] };
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { sync.stop(); off(); });

const file = (reporter: string, targetId: string, category = 'griefing') =>
  (fileReport(db, reporter, { targetId, category, text: 'details' }, deps) as { ticketId: number }).ticketId;
const members = async (threadId: string) => ((await t.threads.memberIds(threadId)) ?? []).sort();

describe('a restricted ticket in Discord', () => {
  it('gets a private thread whose members are its access list, one DM each, and nothing in the forum', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.threadsIn('forum1')).toEqual([]);
    const [thread] = t.threadsIn('chan1');
    expect(thread).toMatchObject({ surface: 'private', name: `Ticket #${id}` });
    expect(await members(thread.id)).toEqual(['907']);
    const inThread = t.live().filter((m) => m.channelId === thread.id);
    expect(inThread).toHaveLength(1);
    expect(JSON.stringify(inThread[0].payload)).toContain('Discord Administrator permission');
    expect(staffThread(db, id)).toMatchObject({ surface: 'private', channel_id: 'chan1', card_message_id: inThread[0].id });
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
    expect(JSON.stringify(t.dms[0].payload)).toContain(`https://pug.test/admin?ticket=${id}`);
    expect(JSON.stringify(t.dms[0].payload)).not.toContain('player5');
    expect(events).toEqual([]);
  });

  it('giving access adds the person to the thread and DMs them, once', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(addAccess(db, id, ADMIN, MOD).ok).toBe(true);
    await sync.idle();
    expect(await members(staffThread(db, id)!.thread_id)).toEqual(['906', '907']);
    expect(t.dms.map((d) => d.userId)).toEqual(['907', '906']);
    await sync.reconcile();
    expect(t.dms).toHaveLength(2);
  });

  it('someone who is no longer on the list, or no longer linked, is taken out of the thread', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    // A stranger added by hand in Discord goes too: the list is the membership.
    await t.threads.addMember(threadId, '555');
    unlinkDiscord(db, MOD);
    await sync.idle();
    expect(await members(threadId)).toEqual(['907']);
  });

  it('a refused DM is dropped silently and never sent again', async () => {
    t.dmsClosed.add('907');
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.dms).toEqual([]);
    expect((db.prepare('SELECT notified_at FROM ticket_access WHERE ticket_id = ?').get(id) as { notified_at: string | null }).notified_at).not.toBeNull();
    t.dmsClosed.clear();
    await sync.reconcile();
    expect(t.dms).toEqual([]);
    expect(events).toEqual([]);
  });

  it('with no tickets channel there is no thread, and the access list is still told', async () => {
    setSetting(db, 'discord_tickets_channel_id', '');
    file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.threadsById.size).toBe(0);
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
  });
});

describe('forum posts that must not exist', () => {
  it('restricting by hand deletes the forum post and opens a private thread', async () => {
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    expect(setRestricted(db, id, MOD, true, [ADMIN]).ok).toBe(true);
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(threadByDiscordId(db, post)!.state).toBe('deleted');
    const now = staffThread(db, id)!;
    expect(now.surface).toBe('private');
    expect(await members(now.thread_id)).toEqual(['906', '907']);
  });

  it('lifting the restriction ends the private thread and posts to the forum', async () => {
    const id = file(IDS[0], IDS[5]);
    setRestricted(db, id, MOD, true, [ADMIN]);
    await sync.idle();
    const priv = staffThread(db, id)!.thread_id;
    expect(setRestricted(db, id, MOD, false, [ADMIN]).ok).toBe(true);
    await sync.idle();
    expect(t.threadsById.get(priv)).toMatchObject({ locked: true, archived: true, deleted: false });
    expect(threadByDiscordId(db, priv)!.state).toBe('ended');
    expect(staffThread(db, id)!.surface).toBe('forum');
    expect(t.threadsIn('forum1')).toHaveLength(1);
  });

  it('blanking a channel setting ends nothing: the thread that exists is kept', async () => {
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    setSetting(db, 'discord_tickets_forum_id', '');
    await sync.reconcile();
    expect(threadByDiscordId(db, post)!.state).toBe('open');
    expect(t.threadsById.get(post)).toMatchObject({ locked: false, archived: false, deleted: false });
    expect(t.live().filter((m) => m.channelId === post)).toHaveLength(1);
  });

  it('making the accused staff deletes every forum post about them, closed tickets included', async () => {
    const closed = file(IDS[0], IDS[5]);
    await sync.idle();
    closeTicket(db, closed, MOD, 'no_action', '');
    await sync.idle();
    const open = file(IDS[0], IDS[5], 'cheating');
    await sync.idle();
    const posts = [staffThread(db, closed)!.thread_id, staffThread(db, open)!.thread_id];
    // What POST /api/admin/players/:id/mod does.
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[5]);
      restrictOpenTicketAbout(db, IDS[5], [ADMIN]);
    })();
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(posts.map((p) => t.threadsById.get(p)!.deleted)).toEqual([true, true]);
    expect(t.threadsIn('forum1')).toEqual([]);
    expect(staffThread(db, open)!.surface).toBe('private');
    expect(staffThread(db, closed)).toBeUndefined();
  });

  it('a normal ticket about staff that could not be restricted has no Discord thread at all', async () => {
    // Nobody to give it to: the only admin is the accused.
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    db.prepare('UPDATE players SET is_admin = 0 WHERE steamid = ?').run(ADMIN);
    db.transaction(() => {
      db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(IDS[5]);
      expect(restrictOpenTicketAbout(db, IDS[5], [])).toBe('nobody');
    })();
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(staffThread(db, id)).toBeUndefined();
    expect(t.threadsIn('forum1')).toEqual([]);
    expect(t.threadsIn('chan1')).toEqual([]);
  });
});

describe('two tickets folded into one', () => {
  it('the survivor keeps its post and says where the other was; the other is locked and archived', async () => {
    const keep = file(IDS[0], IDS[5]);
    const gone = file(IDS[1], IDS[4], 'cheating');
    await sync.idle();
    const keepThread = staffThread(db, keep)!.thread_id;
    const goneThread = staffThread(db, gone)!.thread_id;
    mergePlayers(db, { from: IDS[4], into: IDS[5], by: ADMIN, adminSteamIds: [ADMIN] });
    await sync.idle();
    expect(staffThread(db, keep)!.thread_id).toBe(keepThread);
    expect(threadByDiscordId(db, goneThread)).toMatchObject({ ticket_id: keep, state: 'ended', locked: 1 });
    expect(t.threadsById.get(goneThread)).toMatchObject({ locked: true, archived: true, deleted: false });
    const said = t.live().filter((m) => m.channelId === keepThread).map((m) => JSON.stringify(m.payload)).join('\n');
    expect(said).toContain(`<#${goneThread}>`);
    expect(JSON.stringify(t.byId(keepThread)!.payload)).toContain('2 from 2 people');
    await sync.reconcile();
    expect(t.live().filter((m) => m.channelId === keepThread && JSON.stringify(m.payload).includes(`<#${goneThread}>`))).toHaveLength(1);
  });
});
