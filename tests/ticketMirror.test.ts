import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { closeTicket, reopenTicket } from '../src/tickets/actions.js';
import { insertThread, setThreadLocked, setThreadState, threadByDiscordId } from '../src/tickets/threads.js';
import { attachmentsOf, messageByDiscordId, type MessageRow } from '../src/tickets/messages.js';
import { AttachmentStore, type AttachmentFetcher } from '../src/tickets/attachments.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketMirror } from '../src/discord/ticketMirror.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import type { InboundMessage } from '../src/discord/transport.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MOD = IDS[6];
const ADMIN = IDS[7];
let db: DB;
let t: FakeTransport;
let mirror: TicketMirror;
let root: string;
let dir: string;
let cdn: Record<string, Uint8Array | 'fail'>;
let fetched: string[];
let nudged: number[];
let events: AdminEvent[];
let off: () => void;

const fetcher: AttachmentFetcher = async (url) => {
  fetched.push(url);
  const v = cdn[url];
  if (v === undefined || v === 'fail') return { ok: false, body: null };
  return { ok: true, body: (async function* () { yield v; })() };
};
const store = () => new AttachmentStore({ db, dir, fetcher });
const card = (content: string) => ({ content, embeds: [], components: [] });
const all = () => db.prepare('SELECT * FROM ticket_messages ORDER BY id').all() as MessageRow[];

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  root = mkdtempSync(join(tmpdir(), 'pug-mirror-'));
  dir = join(root, 'ticket-attachments');
  cdn = {};
  fetched = [];
  nudged = [];
  t = new FakeTransport();
  mirror = new TicketMirror({ db, transport: t, store: store(), onChange: (id) => nudged.push(id) });
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { mirror.stop(); off(); rmSync(root, { recursive: true, force: true }); });

const file = (targetId: string) => (fileReport(db, IDS[0], { targetId, category: 'griefing', text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
/** A ticket with a staff thread that exists in the fake and in ticket_threads. */
async function ticketWithThread(targetId: string): Promise<{ id: number; thread: string }> {
  const id = file(targetId);
  const made = await t.threads.createForumPost('forum1', { name: `#${id}`, message: card('the card'), tags: [] });
  insertThread(db, { ticketId: id, kind: 'staff', surface: 'forum', channelId: 'forum1', threadId: made.threadId, cardMessageId: made.messageId, cardHash: 'h' });
  return { id, thread: made.threadId };
}

describe('live', () => {
  it('mirrors a message, its edit and its deletion, in order, and nudges the ticket each time', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    const m = t.userPost(thread, { authorId: '906', authorName: 'Mod on Discord', content: 'first' });
    t.userEdit(m.id, 'second');
    t.userDelete(m.id);
    await mirror.idle();
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({
      ticket_id: id, thread_id: thread, channel: 'staff', discord_message_id: m.id, author_discord_id: '906',
      author_player_id: MOD, author_name: 'Mod on Discord', content: 'second', discord_gone: 1,
    });
    expect(JSON.parse(all()[0].history)).toEqual(['first']);
    expect(all()[0].deleted_at).not.toBeNull();
    expect(nudged).toEqual([id, id, id]);
  });

  it('notes that a message was edited when the edit is the first the bot hears of it', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    await mirror.idle();
    const m = t.userPost(thread, { authorId: '906', content: 'as written' }, false);
    t.userEdit(m.id, 'as edited');
    await mirror.idle();
    const row = messageByDiscordId(db, m.id)!;
    expect(row).toMatchObject({ content: 'as edited', edited_at: '2026-09-22T11:00:00.000Z' });
    // Nothing to put in history: the version before the edit was never seen.
    expect(JSON.parse(row.history)).toEqual([]);
  });

  it('stores an author nobody on the site knows under their Discord name, with no player', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    t.userPost(thread, { authorId: '555', authorName: 'A Stranger', content: 'hello' });
    await mirror.idle();
    expect(all()[0]).toMatchObject({ author_discord_id: '555', author_player_id: null, author_name: 'A Stranger' });
  });

  it('does not mirror the bot, a webhook or a system line', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    t.userPost(thread, { authorId: 'bot', content: 'Another report: cheating', bot: true });
    await t.send(thread, card('a line the bot sent'));
    await mirror.idle();
    expect(all()).toEqual([]);
    expect(nudged).toEqual([]);
  });

  it('does not mirror the bot editing its own card', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    await mirror.idle();
    // Discord announces the bot's own edits, and every card refresh is one.
    t.hooks!.update({
      id: thread, threadId: thread, authorId: 'bot', authorName: 'bot', authorIsBot: true,
      content: 'the card, refreshed', attachments: [], createdAt: '2026-09-22T09:00:00.000Z', editedAt: '2026-09-22T09:30:00.000Z',
    });
    await mirror.idle();
    expect(all()).toEqual([]);
    expect(nudged).toEqual([]);
  });

  it('hears the bot delete a message it mirrored, once, and keeps everything', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    const m = t.userPost(thread, { authorId: '906', content: 'said too much' });
    await mirror.idle();
    // As Task 7's Remove will: the bot deletes it, and Discord tells the bot.
    await t.remove(thread, m.id);
    // And says it again, which a second Remove of the same message does not.
    t.hooks!.remove(thread, m.id);
    await mirror.idle();
    const row = messageByDiscordId(db, m.id)!;
    expect(row).toMatchObject({ content: 'said too much', discord_gone: 1 });
    expect(row.deleted_at).not.toBeNull();
    expect(nudged).toEqual([id, id]);
  });

  it('reads nothing from a thread that is not a ticket, whoever delivers it', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    // The transport asks first, so this is never delivered...
    t.userPost('general-chat', { authorId: '906', content: 'none of our business' });
    // ...and a transport that forgot to ask still gets nowhere: the mirror
    // looks the thread up before it reads a single field off the message.
    let read = false;
    const trap = {
      id: '999999', threadId: 'general-chat', authorId: '906', authorName: 'x', authorIsBot: false,
      get content() { read = true; return 'secret'; }, attachments: [], createdAt: '2026-09-22T10:00:00.000Z', editedAt: null,
    } as InboundMessage;
    t.hooks!.create(trap);
    t.hooks!.update(trap);
    await mirror.idle();
    expect(read).toBe(false);
    expect(all()).toEqual([]);
    expect(t.hooks!.watches(thread)).toBe(true);
    expect(t.hooks!.watches('general-chat')).toBe(false);
  });

  it('a message delivered twice is one message', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    const m = t.userPost(thread, { authorId: '906', content: 'once' });
    t.hooks!.create(m);
    await mirror.idle();
    await mirror.backfill();
    expect(all()).toHaveLength(1);
  });
});

describe('files', () => {
  it('stores an allowed file on disk and records a refused one without storing it', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    cdn['https://cdn.discordapp.com/1/shot.png'] = new Uint8Array(64).fill(1);
    const m = t.userPost(thread, { authorId: '906', content: 'look', attachments: [
      { id: 'a1', name: 'shot.png', contentType: 'image/png', size: 64, url: 'https://cdn.discordapp.com/1/shot.png' },
      { id: 'a2', name: 'tool.exe', contentType: 'application/x-msdownload', size: 9000, url: 'https://cdn.discordapp.com/1/tool.exe' },
    ] });
    await mirror.idle();
    const rows = attachmentsOf(db, messageByDiscordId(db, m.id)!.id);
    expect(rows.map((r) => [r.filename, r.discord_attachment_id, r.size, r.skip_reason, r.stored_name !== null])).toEqual([
      ['shot.png', 'a1', 64, null, true], ['tool.exe', 'a2', 9000, 'type', false],
    ]);
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(dir)).toEqual([rows[0].stored_name]);
  });

  it('downloads a file once however many times its message is delivered', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    const url = 'https://cdn.discordapp.com/1/twice.png';
    cdn[url] = new Uint8Array(16).fill(3);
    mirror.start();
    const m = t.userPost(thread, { authorId: '906', content: 'look', attachments: [
      { id: 'a1', name: 'twice.png', contentType: 'image/png', size: 16, url },
    ] });
    await mirror.idle();
    t.hooks!.create(m);
    t.hooks!.update(m);
    await mirror.idle();
    await mirror.backfill();
    expect(fetched).toEqual([url]);
    expect(attachmentsOf(db, messageByDiscordId(db, m.id)!.id)).toHaveLength(1);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('deletes a file it stored when the row that points at it cannot be written, and still nudges', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    const url = 'https://cdn.discordapp.com/1/shot.png';
    cdn[url] = new Uint8Array(8).fill(4);
    db.exec("CREATE TRIGGER no_files BEFORE INSERT ON ticket_attachments BEGIN SELECT RAISE(ABORT, 'no room'); END");
    mirror.start();
    const m = t.userPost(thread, { authorId: '906', content: 'look', attachments: [
      { id: 'a1', name: 'shot.png', contentType: 'image/png', size: 8, url },
    ] });
    await mirror.idle();
    // The message is kept; the file nothing can point at is not left behind.
    expect(messageByDiscordId(db, m.id)).toBeDefined();
    expect(attachmentsOf(db, messageByDiscordId(db, m.id)!.id)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    // And the page hears about the message, whatever became of its file.
    expect(nudged).toEqual([id]);
  });

  it('deletes a file it retried when the row it belongs to cannot be updated', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    const url = 'https://cdn.discordapp.com/1/clip.mp4';
    cdn[url] = 'fail';
    const m = t.userPost(thread, { authorId: '906', content: '', attachments: [{ id: 'a1', name: 'clip.mp4', contentType: 'video/mp4', size: 32, url }] });
    mirror.start();
    await mirror.idle();
    cdn[url] = new Uint8Array(32).fill(2);
    db.exec("CREATE TRIGGER no_files BEFORE UPDATE ON ticket_attachments BEGIN SELECT RAISE(ABORT, 'no room'); END");
    await mirror.backfill();
    expect(attachmentsOf(db, messageByDiscordId(db, m.id)!.id)[0]).toMatchObject({ skip_reason: 'fetch_failed', stored_name: null });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a download that failed is tried again by the next backfill, with a fresh link', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    const url = 'https://cdn.discordapp.com/1/clip.mp4';
    cdn[url] = 'fail';
    const m = t.userPost(thread, { authorId: '906', content: '', attachments: [{ id: 'a1', name: 'clip.mp4', contentType: 'video/mp4', size: 32, url }] });
    await mirror.idle();
    const row = () => attachmentsOf(db, messageByDiscordId(db, m.id)!.id)[0];
    expect(row()).toMatchObject({ skip_reason: 'fetch_failed', stored_name: null });
    cdn[url] = new Uint8Array(32).fill(2);
    await mirror.backfill();
    expect(row()).toMatchObject({ skip_reason: null, size: 32 });
    expect(existsSync(join(dir, row().stored_name!))).toBe(true);
    expect(attachmentsOf(db, messageByDiscordId(db, m.id)!.id)).toHaveLength(1);
  });
});

describe('backfill', () => {
  it('on start, picks up what was written while the bot was away, a page at a time, and skips the bot', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    t.fetchPageSize = 2;
    const seen = t.userPost(thread, { authorId: '906', content: 'before the restart' }, false);
    // Already stored, as if mirrored before the bot went down.
    mirror.start();
    await mirror.idle();
    mirror.stop();
    expect(all().map((m) => m.discord_message_id)).toEqual([seen.id]);

    for (const content of ['one', 'two', 'three', 'four', 'five']) t.userPost(thread, { authorId: '907', content }, false);
    await t.send(thread, card('Another report: afk'));
    mirror = new TicketMirror({ db, transport: t, store: store(), onChange: (n) => nudged.push(n) });
    mirror.start();
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['before the restart', 'one', 'two', 'three', 'four', 'five']);
    expect(all()[1]).toMatchObject({ ticket_id: id, author_player_id: ADMIN });
  });

  it('reads an archived thread without unarchiving it', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    t.userPost(thread, { authorId: '906', content: 'written before Discord archived it' }, false);
    await t.threads.setArchived(thread, true);
    mirror.start();
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['written before Discord archived it']);
    expect(t.threadsById.get(thread)!.archived).toBe(true);
  });

  it('copies a thread the bot has retired, and reads nothing from one it deleted', async () => {
    const a = await ticketWithThread(IDS[5]);
    const b = await ticketWithThread(IDS[4]);
    t.userPost(a.thread, { authorId: '906', content: 'said before the fold' }, false);
    t.userPost(b.thread, { authorId: '906', content: 'in a thread that is gone' }, false);
    setThreadState(db, threadByDiscordId(db, a.thread)!.id, 'folded');
    setThreadState(db, threadByDiscordId(db, b.thread)!.id, 'deleted');
    mirror.start();
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['said before the fold']);
  });

  it('reads the history it missed before storing a live message, when the start pass was refused', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    t.userPost(thread, { authorId: '906', content: 'first while away' }, false);
    t.userPost(thread, { authorId: '906', content: 'second while away' }, false);
    // The one refusal lands on this thread's first fetch, as a rate limit does.
    t.failThreadOps = 1;
    mirror.start();
    await mirror.idle();
    expect(all()).toEqual([]);
    // Storing this one first would move the backfill's starting point past
    // the two above and lose them for good.
    const live = t.userPost(thread, { authorId: '907', content: 'and now, live' });
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['first while away', 'second while away', 'and now, live']);
    expect(messageByDiscordId(db, live.id)).toBeDefined();
  });

  it('reads the history it skipped before storing a live message in a locked thread', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    closeTicket(db, id, MOD, 'no_action', '');
    setThreadLocked(db, threadByDiscordId(db, thread)!.id, true);
    t.userPost(thread, { authorId: '907', content: 'written while it was locked' }, false);
    mirror.start();
    await mirror.idle();
    expect(all()).toEqual([]);
    t.userPost(thread, { authorId: '906', content: 'and now, live' });
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['written while it was locked', 'and now, live']);
  });

  it('leaves locked threads alone on start, and catches up when the ticket is reopened', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    closeTicket(db, id, MOD, 'no_action', '');
    setThreadLocked(db, threadByDiscordId(db, thread)!.id, true);
    t.userPost(thread, { authorId: '907', content: 'written into a locked thread by someone who can' }, false);
    mirror.start();
    await mirror.idle();
    expect(all()).toEqual([]);
    expect(reopenTicket(db, id, MOD).ok).toBe(true);
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['written into a locked thread by someone who can']);
  });

  it('one thread Discord refuses does not stop the others', async () => {
    const a = await ticketWithThread(IDS[5]);
    const b = await ticketWithThread(IDS[4]);
    t.userPost(a.thread, { authorId: '906', content: 'in a' }, false);
    t.userPost(b.thread, { authorId: '906', content: 'in b' }, false);
    t.failThreadOps = 1;
    mirror.start();
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['in b']);
    await mirror.backfill();
    expect(all().map((m) => m.content).sort()).toEqual(['in a', 'in b']);
  });
});

describe('a forum post that must not exist', () => {
  /** A ticket whose forum post TicketSync has to delete: the ticket has been
   *  restricted, so the staff forum must not hold a post about it. */
  const restrict = (id: number) => db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(id);
  const syncWith = (saveBeforeDelete: (threadId: string) => Promise<void>) =>
    new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0, saveBeforeDelete });

  it('is copied onto the site before Discord deletes it', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    t.userPost(thread, { authorId: '906', content: 'written while the bot was down' }, false);
    restrict(id);
    // The mirror is deliberately not started: what lands here landed because
    // the reconciler asked for it before deleting the post, not because the
    // backfill on start happened to get there first.
    const sync = syncWith((threadId) => mirror.catchUp(threadId));
    await sync.reconcile();
    sync.stop();
    expect(all().map((m) => m.content)).toEqual(['written while the bot was down']);
    expect(await t.threads.exists(thread)).toBe(false);
    expect(threadByDiscordId(db, thread)!.state).toBe('deleted');
  });

  it('goes even when the copy fails, and an admin is told that something was lost', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    t.userPost(thread, { authorId: '906', content: 'written while the bot was down' }, false);
    restrict(id);
    // Discord refuses the read, so the mirror cannot copy the thread: the real
    // mirror, not a stub, because the only thing that reports this is the
    // failure travelling back out of catchUp.
    t.threads.fetchAfter = async () => { throw new Error('rate limited'); };
    const sync = syncWith((threadId) => mirror.catchUp(threadId));
    await sync.reconcile();
    sync.stop();
    expect(all()).toEqual([]);
    expect(await t.threads.exists(thread)).toBe(false);
    expect(threadByDiscordId(db, thread)!.state).toBe('deleted');
    const problems = events.filter((e) => e.kind === 'problem');
    expect(problems).toHaveLength(1);
    // Every admin reads the feed, and one of them may be who this is about.
    const text = problems[0].kind === 'problem' ? problems[0].text : '';
    expect(text).toContain('rate limited');
    for (const secret of [thread, `#${id}`, 'player5', IDS[5], '906']) expect(text).not.toContain(secret);
  });
});
