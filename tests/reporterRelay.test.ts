import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, setRestricted } from '../src/tickets/actions.js';
import { foldTicket, getTicketRow } from '../src/tickets/store.js';
import { staffThread } from '../src/tickets/threads.js';
import { insertMessage, messageByDiscordId } from '../src/tickets/messages.js';
import { removeMessage, removeMessages } from '../src/tickets/removal.js';
import { reporterThreadsOf } from '../src/tickets/reporterChat.js';
import { AttachmentStore, type AttachmentFetcher } from '../src/tickets/attachments.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { TicketMirror } from '../src/discord/ticketMirror.js';
import { ReporterChats } from '../src/discord/reporterChats.js';
import { syncRelay } from '../src/discord/reporterRelay.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000043${i}`);
const [R1, , ACCUSED, ACCUSED2, , , MOD, ADMIN] = IDS;
const D = (id: string) => `97${IDS.indexOf(id)}`;
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let mirror: TicketMirror;
let chats: ReporterChats;
let root: string;

const fetcher: AttachmentFetcher = async () => ({ ok: true, body: (async function* () { yield new Uint8Array(10).fill(1); })() });

beforeEach(async () => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `97${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  root = mkdtempSync(join(tmpdir(), 'pug-relay-'));
  t = new FakeTransport();
  mirror = new TicketMirror({
    db, transport: t, store: new AttachmentStore({ db, dir: join(root, 'files'), fetcher }),
    serialise: (fn) => sync.serialise(fn),
    onReporterActivity: (th, m, fresh) => sync.reporterActivity(th, m, fresh),
  });
  sync = new TicketSync({
    db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0,
    saveBeforeDelete: (id) => mirror.catchUp(id), sweepRemovals: () => { void mirror.sweepRemovals(); },
  });
  chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1', serialise: (fn) => sync.serialise(fn) });
  sync.start();
  mirror.start();
  await settle();
});
afterEach(() => { mirror.stop(); sync.stop(); rmSync(root, { recursive: true, force: true }); });

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) { await mirror.idle(); await sync.idle(); }
}
async function chatAbout(category = 'griefing', text = 'x') {
  const r = fileReport(db, R1, { targetId: ACCUSED, category, text }, { adminSteamIds: [ADMIN] }) as { reportId: number; ticketId: number };
  await settle();
  await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
  await settle();
  return { ...r, chat: reporterThreadsOf(db, r.ticketId)[0].thread_id };
}
const copies = (ticketId: number) => {
  const post = staffThread(db, ticketId)?.thread_id;
  return t.live().filter((m) => m.channelId === post && (m.payload.embeds[0]?.title ?? '').startsWith('From the reporter'));
};

/** Every relay copy on a ticket's forum post, reporter's and staff's, in post order. */
const allCopies = (ticketId: number) => {
  const post = staffThread(db, ticketId)?.thread_id;
  return t.live().filter((m) => m.channelId === post && /^From the (reporter|moderators), /.test(m.payload.embeds[0]?.title ?? ''));
};

describe('the relay onto the forum post', () => {
  it('copies the whole conversation: the reporter headed as the reporter, staff as the moderators', async () => {
    const c = await chatAbout();
    await chats.join(c.ticketId, MOD);
    t.userPost(c.chat, { authorId: D(R1), authorName: 'Reporter Name', content: 'he did it again' });
    t.userPost(c.chat, { authorId: D(MOD), authorName: 'A Mod', content: 'thanks, looking now' });
    await settle();
    const got = allCopies(c.ticketId);
    expect(got.map((m) => [m.payload.embeds[0].title, m.payload.embeds[0].description])).toEqual([
      ['From the reporter, Reporter Name', 'he did it again'],
      ['From the moderators, A Mod', 'thanks, looking now'],
    ]);
    expect(got.every((m) => (m.payload.mentionUserIds ?? []).length === 0)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 2 });
    // A full pass after that copies nothing twice.
    await sync.reconcile();
    expect(allCopies(c.ticketId)).toHaveLength(2);
  });

  it('a staff reply removed on the site takes its copy with it', async () => {
    const c = await chatAbout();
    await chats.join(c.ticketId, MOD);
    const s = t.userPost(c.chat, { authorId: D(MOD), authorName: 'A Mod', content: 'oops wrong chat' });
    await settle();
    expect(allCopies(c.ticketId)).toHaveLength(1);
    const row = messageByDiscordId(db, s.id)!;
    expect(removeMessage(db, join(root, 'files'), c.ticketId, row.id, ADMIN, 'wrong chat')).toMatchObject({ ok: true });
    await mirror.sweepRemovals();
    await settle();
    expect(allCopies(c.ticketId)).toEqual([]);
  });

  it('rebuilds the post in order when a message older than a copy has none yet (staff replies from before this change)', async () => {
    const c = await chatAbout();
    await chats.join(c.ticketId, MOD);
    t.userPost(c.chat, { authorId: D(R1), authorName: 'Reporter Name', content: 'one' });
    await settle();
    const s = t.userPost(c.chat, { authorId: D(MOD), authorName: 'A Mod', content: 'two' });
    await settle();
    t.userPost(c.chat, { authorId: D(R1), authorName: 'Reporter Name', content: 'three' });
    await settle();
    // The state production is in: the staff reply was never copied.
    const staffCopy = db.prepare('SELECT relay_thread_id, relay_message_id FROM relay_messages WHERE source_message_id = ?').get(s.id) as { relay_thread_id: string; relay_message_id: string };
    await t.remove(staffCopy.relay_thread_id, staffCopy.relay_message_id);
    db.prepare('DELETE FROM relay_messages WHERE source_message_id = ?').run(s.id);
    expect(allCopies(c.ticketId).map((m) => m.payload.embeds[0].description)).toEqual(['one', 'three']);
    await sync.reconcileTicket(c.ticketId);
    await settle();
    expect(allCopies(c.ticketId).map((m) => m.payload.embeds[0].description)).toEqual(['one', 'two', 'three']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 3 });
    // And a second pass leaves it alone.
    const before = t.messages.length;
    await sync.reconcileTicket(c.ticketId);
    await settle();
    expect(t.messages.length).toBe(before);
    await sync.reconcile();
    expect(allCopies(c.ticketId)).toHaveLength(3);
  });

  it('an edit edits the copy; a delete in Discord deletes it', async () => {
    const c = await chatAbout();
    const m = t.userPost(c.chat, { authorId: D(R1), content: 'first words' });
    await settle();
    t.userEdit(m.id, 'second words');
    await settle();
    expect(copies(c.ticketId).map((x) => x.payload.embeds[0].description)).toEqual(['second words']);
    t.userDelete(m.id);
    await settle();
    expect(copies(c.ticketId)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 0 });
    // Deleted in Discord, the original stays on the site as before.
    expect(messageByDiscordId(db, m.id)!.content).toBe('second words');
  });

  it('a file travels as a link to the ticket page, never as Discord\'s own link', async () => {
    const c = await chatAbout();
    t.userPost(c.chat, { authorId: D(R1), content: '', attachments: [
      { id: 'a1', name: 'shot.png', contentType: 'image/png', size: 10, url: 'https://cdn.discordapp.com/x/shot.png' },
    ] });
    await settle();
    const [copy] = copies(c.ticketId);
    const said = JSON.stringify(copy.payload);
    expect(said).toContain('https://pug.test/admin/people/tickets/');
    expect(said).not.toContain('cdn.discordapp.com');
    expect(said).not.toContain('shot.png');
  });

  it('Remove takes the copy with it', async () => {
    const c = await chatAbout();
    const m = t.userPost(c.chat, { authorId: D(R1), content: 'something awful' });
    await settle();
    const row = messageByDiscordId(db, m.id)!;
    expect(removeMessage(db, join(root, 'files'), c.ticketId, row.id, MOD, '').ok).toBe(true);
    await mirror.sweepRemovals();
    await settle();
    expect(copies(c.ticketId)).toEqual([]);
    expect(JSON.stringify(t.live())).not.toContain('something awful');
  });

  it('Remove everything from this person: every message and every copy, in one pass', async () => {
    const c = await chatAbout();
    const a = t.userPost(c.chat, { authorId: D(R1), content: 'one' });
    const b = t.userPost(c.chat, { authorId: D(R1), content: 'two' });
    t.userPost(c.chat, { authorId: D(MOD), content: 'staff reply' });
    await settle();
    const ids = [messageByDiscordId(db, a.id)!.id, messageByDiscordId(db, b.id)!.id];
    expect(removeMessages(db, join(root, 'files'), c.ticketId, ids, MOD, '')).toEqual({ ok: true, removed: 2, files: 0 });
    expect(removeMessages(db, join(root, 'files'), c.ticketId, ids, MOD, '')).toEqual({ ok: true, removed: 0, files: 0 });
    await mirror.sweepRemovals();
    await settle();
    expect(copies(c.ticketId)).toEqual([]);
    expect(t.live().filter((m) => m.channelId === c.chat).map((m) => m.payload.content)).not.toContain('one');
    const events = (db.prepare("SELECT detail FROM ticket_events WHERE kind = 'removed'").all() as { detail: string }[]).map((e) => JSON.parse(e.detail));
    expect(events).toEqual([{ messageIds: ids, count: 2, files: 0 }]);
  });

  it('a restricted ticket: nothing is copied anywhere; its list is DMed once for two messages', async () => {
    const c = await chatAbout('unsafe', 'threats');
    addAccess(db, c.ticketId, ADMIN, MOD);
    await settle();
    const before = t.dms.length;
    db.prepare('DELETE FROM reporter_chat_pings').run();
    t.userPost(c.chat, { authorId: D(R1), content: 'he messaged me again' });
    t.userPost(c.chat, { authorId: D(R1), content: 'and again' });
    await settle();
    expect(staffThread(db, c.ticketId)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 0 });
    const pings = t.dms.slice(before);
    expect(pings.map((d) => d.userId).sort()).toEqual([D(MOD), D(ADMIN)].sort());
    expect(JSON.stringify(pings)).not.toContain('messaged me');
  });

  it('re-reads the ticket before relaying, so a restrict landing mid-pass copies nothing', async () => {
    const c = await chatAbout();
    // The `t` the reconciler passes to syncRelay is captured near the start
    // of its long async pass; simulate a moderator restricting the ticket in
    // the window before this call runs by handing syncRelay that now-stale,
    // still-unrestricted row directly. The message is inserted straight into
    // ticket_messages (not through the mirror) so nothing but this direct
    // call could possibly relay it: a pass through the running sync/mirror
    // pair would re-read the ticket itself and mask a missing guard here.
    const stale = getTicketRow(db, c.ticketId)!;
    expect(stale.restricted).toBe(0);
    setRestricted(db, c.ticketId, ADMIN, true, [ADMIN]);
    insertMessage(db, {
      ticketId: c.ticketId, threadId: c.chat, channel: 'reporter', discordMessageId: 'stale-msg-1',
      authorDiscordId: D(R1), authorPlayerId: R1, authorName: 'Reporter Name', content: 'after the restrict landed',
      createdAt: new Date().toISOString(),
    });
    const post = staffThread(db, c.ticketId)!;
    await syncRelay({ db, transport: t, publicUrl: 'https://pug.test' }, stale, post);
    expect(copies(c.ticketId)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 0 });
  });

  // A fold moves the reporter's messages onto the survivor ticket, but a
  // relay row still names the old post they were copied to. When the
  // survivor already had its own open post before the fold, that old one is
  // marked 'folded' and later retired (locked, archived) rather than simply
  // becoming the survivor's: its stray copy must be taken off it, or a later
  // Remove, which only ever looks at the row's current thread, would never
  // find it.
  it('a fold that retires the old post deletes the stray copy there before making a new one on the survivor\'s', async () => {
    const a = await chatAbout();
    const said = t.userPost(a.chat, { authorId: D(R1), content: 'evidence here' });
    await settle();
    const [oldCopy] = copies(a.ticketId);
    expect(oldCopy).toBeTruthy();
    const oldPostId = staffThread(db, a.ticketId)!.thread_id;

    // A second ticket, about someone else, that already has its own open
    // forum post before the fold: this is what makes the fold mark A's post
    // 'folded' and retire it, rather than just relabel it as B's.
    const b = fileReport(db, R1, { targetId: ACCUSED2, category: 'afk', text: 'y' }, { adminSteamIds: [ADMIN] }) as { reportId: number; ticketId: number };
    await settle();
    expect(staffThread(db, b.ticketId)).toBeTruthy();

    db.transaction(() => foldTicket(db, a.ticketId, b.ticketId, 'merge'))();
    // Neither mergePlayers nor adopt.ts signals the survivor after a fold:
    // retireFolded and syncRelay only run as part of a full sweep, same as
    // the "unclaimed" ping test above needs one for its own throttled ping.
    await sync.reconcile();
    await settle();

    // The old post is retired: locked and archived, its stray copy gone.
    expect(t.threadsById.get(oldPostId)).toMatchObject({ locked: true, archived: true });
    expect(t.messages.find((m) => m.channelId === oldPostId && m.id === oldCopy.id)?.deleted).toBe(true);

    // The survivor's own post gets its own copy instead.
    const newCopies = copies(b.ticketId);
    expect(newCopies).toHaveLength(1);
    expect(newCopies[0].payload.embeds[0].description).toBe('evidence here');
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 1 });

    // And a later Remove finds it there, on the row's current thread, not
    // stranded on the old, now-inaccessible one.
    const row = messageByDiscordId(db, said.id)!;
    expect(removeMessage(db, join(root, 'files'), b.ticketId, row.id, MOD, '').ok).toBe(true);
    await mirror.sweepRemovals();
    await settle();
    expect(copies(b.ticketId)).toEqual([]);
  });
});
