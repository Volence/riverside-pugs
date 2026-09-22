import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertThread, setThreadLocked, threadByDiscordId } from '../src/tickets/threads.js';
import { attachmentsOf, messageByDiscordId, messageById } from '../src/tickets/messages.js';
import { AttachmentStore, type AttachmentFetcher } from '../src/tickets/attachments.js';
import { removeMessage } from '../src/tickets/removal.js';
import { subscribeTicketSignals, type TicketSignal } from '../src/tickets/signals.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketMirror } from '../src/discord/ticketMirror.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { handleRemoveCommand, REMOVE_COMMAND } from '../src/discord/ticketRemove.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, PLAYER, , , , ACCUSED, MOD, ADMIN] = IDS;
const HORRIBLE = 'the horrible thing that was said';
let db: DB;
let t: FakeTransport;
let mirror: TicketMirror;
let root: string;
let dir: string;
let signals: TicketSignal[];
let events: AdminEvent[];
let offs: (() => void)[];

const fetcher: AttachmentFetcher = async () => ({ ok: true, body: (async function* () { yield new Uint8Array(50).fill(3); })() });
const card = (content: string) => ({ content, embeds: [], components: [] });
const newMirror = (opts: { serialise?: (fn: () => Promise<void>) => Promise<void> } = {}) =>
  new TicketMirror({ db, transport: t, store: new AttachmentStore({ db, dir, fetcher }), ...opts });

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  root = mkdtempSync(join(tmpdir(), 'pug-remove-'));
  dir = join(root, 'ticket-attachments');
  t = new FakeTransport();
  mirror = newMirror();
  signals = [];
  events = [];
  offs = [subscribeTicketSignals((s) => signals.push(s)), subscribeAdminEvents((e) => events.push(e))];
});
afterEach(() => { mirror.stop(); for (const off of offs) off(); rmSync(root, { recursive: true, force: true }); });

const file = (targetId: string, category = 'griefing') =>
  (fileReport(db, R1, { targetId, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
async function ticketWithThread(targetId: string, category = 'griefing'): Promise<{ id: number; thread: string }> {
  const id = file(targetId, category);
  const made = await t.threads.createForumPost('forum1', { name: `#${id}`, message: card('the card'), tags: [] });
  insertThread(db, { ticketId: id, kind: 'staff', surface: 'forum', channelId: 'forum1', threadId: made.threadId, cardMessageId: made.messageId, cardHash: 'h' });
  return { id, thread: made.threadId };
}
/** Someone posts the horrible thing with a picture, edits it once, and the mirror copies it all. */
async function horrible(thread: string) {
  const m = t.userPost(thread, { authorId: '555', authorName: 'A Stranger', content: 'an earlier version', attachments: [
    { id: 'a1', name: 'picture.png', contentType: 'image/png', size: 50, url: 'https://cdn.discordapp.com/1/picture.png' },
  ] });
  t.userEdit(m.id, HORRIBLE);
  await mirror.idle();
  return { discordId: m.id, row: messageByDiscordId(db, m.id)! };
}
const dump = () => JSON.stringify([
  db.prepare('SELECT * FROM ticket_messages').all(), db.prepare('SELECT * FROM ticket_events').all(),
  db.prepare('SELECT * FROM admin_actions').all(), events,
]);
/** Every pragma this connection is asked for, from now on. */
function watchPragmas(): string[] {
  const seen: string[] = [];
  const real = db.pragma.bind(db);
  db.pragma = ((source: string, options?: object) => {
    seen.push(source);
    return real(source, options as never);
  }) as typeof db.pragma;
  return seen;
}

describe('removeMessage', () => {
  it('destroys the text, its history and its files, and keeps only a tombstone', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { row } = await horrible(thread);
    const before = attachmentsOf(db, row.id)[0];
    expect(existsSync(join(dir, before.stored_name!))).toBe(true);
    signals.length = 0;

    expect(removeMessage(db, dir, id, row.id, MOD, '  not for anyone to see  ', new Date('2026-09-22T12:00:00.000Z'))).toEqual({ ok: true, files: 1 });

    expect(messageById(db, row.id)).toMatchObject({
      content: '', history: '[]', removed_at: '2026-09-22T12:00:00.000Z', removed_by: MOD, removed_reason: 'not for anyone to see',
      author_name: 'A Stranger', discord_gone: 0,
    });
    expect(attachmentsOf(db, row.id)[0]).toMatchObject({
      filename: 'picture.png', size: 50, sha256: before.sha256, stored_name: null, removed_at: '2026-09-22T12:00:00.000Z',
    });
    expect(readdirSync(dir)).toEqual([]);
    const ev = db.prepare("SELECT actor_id, detail FROM ticket_events WHERE ticket_id = ? AND kind = 'removed'").get(id) as { actor_id: string; detail: string };
    expect(ev.actor_id).toBe(MOD);
    expect(JSON.parse(ev.detail)).toEqual({ messageId: row.id, files: 1 });
    expect(signals).toEqual([{ kind: 'ticket', ticketId: id }]);
    expect(dump()).not.toContain(HORRIBLE);
    expect(dump()).not.toContain('an earlier version');
  });

  it('answers a ticket you cannot see as it answers one that does not exist, and refuses a second removal', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED, 'unsafe');
    const other = file(PLAYER);
    mirror.start();
    const { row } = await horrible(thread);
    expect(removeMessage(db, dir, id, row.id, MOD, '')).toEqual(removeMessage(db, dir, 9999, row.id, MOD, ''));
    expect(removeMessage(db, dir, id, row.id, MOD, '')).toMatchObject({ ok: false, status: 404 });
    // The right message through the wrong ticket.
    expect(removeMessage(db, dir, other, row.id, MOD, '')).toMatchObject({ ok: false, status: 404 });
    expect(messageById(db, row.id)!.content).toBe(HORRIBLE);
    expect(removeMessage(db, dir, id, row.id, ADMIN, '').ok).toBe(true);
    expect(removeMessage(db, dir, id, row.id, ADMIN, '')).toMatchObject({ ok: false, status: 409 });
  });

  it('caps the reason and empties the write-ahead log, so the text is nowhere in the database', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { row } = await horrible(thread);
    const pragmas = watchPragmas();

    expect(removeMessage(db, dir, id, row.id, MOD, 'x'.repeat(250)).ok).toBe(true);

    expect(messageById(db, row.id)!.removed_reason).toBe('x'.repeat(200));
    expect(pragmas).toContain('wal_checkpoint(TRUNCATE)');
    expect(JSON.stringify(db.prepare('SELECT * FROM ticket_messages').all())).not.toContain(HORRIBLE);
  });
});

describe('the Discord half', () => {
  it('deletes the message in Discord, once, and an edit that arrives late changes nothing', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    removeMessage(db, dir, id, row.id, MOD, '');
    await mirror.sweepRemovals();
    expect(await t.threads.fetchMessage(thread, discordId)).toBeNull();
    expect(messageById(db, row.id)!.discord_gone).toBe(1);
    t.hooks!.update({ id: discordId, threadId: thread, authorId: '555', authorName: 'A Stranger', authorIsBot: false, content: HORRIBLE, attachments: [], createdAt: row.created_at, editedAt: '2026-09-22T13:00:00.000Z' });
    await mirror.idle();
    // deleted_at stays null: the bot hears its own delete back, and a removed
    // message is past being deleted.
    expect(messageById(db, row.id)).toMatchObject({ content: '', history: '[]', deleted_at: null });
  });

  it('a removal made while the bot was down is finished when it comes back', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    mirror.stop();
    removeMessage(db, dir, id, row.id, MOD, '');
    expect(await t.threads.fetchMessage(thread, discordId)).not.toBeNull();
    mirror = newMirror();
    mirror.start();
    await mirror.idle();
    expect(await t.threads.fetchMessage(thread, discordId)).toBeNull();
    expect(messageById(db, row.id)!.discord_gone).toBe(1);
  });

  it('opens an archived thread to delete in it, and closes it again if the bot had locked it', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    await t.threads.setLocked(thread, true);
    await t.threads.setArchived(thread, true);
    setThreadLocked(db, threadByDiscordId(db, thread)!.id, true);
    removeMessage(db, dir, id, row.id, MOD, '');
    await mirror.sweepRemovals();
    expect(t.inbox.find((m) => m.id === discordId)!.deleted).toBe(true);
    expect(t.threadsById.get(thread)).toMatchObject({ archived: true, locked: true });
  });

  it('a thread that no longer exists owes nothing', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { row } = await horrible(thread);
    await t.threads.deleteThread(thread);
    removeMessage(db, dir, id, row.id, MOD, '');
    await mirror.sweepRemovals();
    expect(messageById(db, row.id)!.discord_gone).toBe(1);
  });

  it('waits for the reconciler, so the two never open and archive one thread at once', async () => {
    const sync = new TicketSync({ db, transport: t, publicUrl: 'http://x', intervalMs: 0 });
    mirror = newMirror({ serialise: (fn) => sync.serialise(fn) });
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    removeMessage(db, dir, id, row.id, MOD, '');
    // The reconciler's chain, busy with a pass that has not finished.
    let release = () => {};
    const held = sync.serialise(() => new Promise<void>((resolve) => { release = resolve; }));
    const swept = mirror.sweepRemovals();
    // Long enough that a sweep on a chain of its own would have finished.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.inbox.find((m) => m.id === discordId)!.deleted).toBe(false);
    release();
    await held;
    await swept;
    expect(t.inbox.find((m) => m.id === discordId)!.deleted).toBe(true);
    sync.stop();
  });

  it('destroys a file whose download finishes after its message was removed', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    let arrive = () => {};
    const slow: AttachmentFetcher = async () => {
      await new Promise<void>((resolve) => { arrive = resolve; });
      return { ok: true, body: (async function* () { yield new Uint8Array(50).fill(3); })() };
    };
    mirror = new TicketMirror({ db, transport: t, store: new AttachmentStore({ db, dir, fetcher: slow }) });
    mirror.start();
    const m = t.userPost(thread, { authorId: '555', authorName: 'A Stranger', content: HORRIBLE, attachments: [
      { id: 'a1', name: 'picture.png', contentType: 'image/png', size: 50, url: 'https://cdn.discordapp.com/1/picture.png' },
    ] });
    // The message is stored; its file is still coming down the wire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const row = messageByDiscordId(db, m.id)!;
    expect(removeMessage(db, dir, id, row.id, MOD, '')).toEqual({ ok: true, files: 0 });
    arrive();
    await mirror.idle();
    expect(attachmentsOf(db, row.id)[0]).toMatchObject({ filename: 'picture.png', size: 50, stored_name: null, removed_at: messageById(db, row.id)!.removed_at });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('Remove from ticket, the Discord command', () => {
  const run = (userId: string, channelId: string, messageId: string) =>
    handleRemoveCommand({ db, attachmentsDir: dir, mirror: () => mirror }, { kind: 'message_command', name: REMOVE_COMMAND, userId, userName: 'x', channelId, messageId });
  const said = (r: { payload: { content?: string } }) => r.payload.content ?? '';

  it('is for staff, inside a ticket thread they can see, and answers privately', async () => {
    const open = await ticketWithThread(ACCUSED);
    const restricted = await ticketWithThread(PLAYER, 'unsafe');
    mirror.start();
    const a = await horrible(open.thread);
    const b = t.userPost(restricted.thread, { authorId: '907', content: HORRIBLE });
    await mirror.idle();
    const player = await run('901', open.thread, a.discordId);
    expect(player.ephemeral).toBe(true);
    expect(said(player)).toBe('Staff only.');
    const elsewhere = await run('906', 'general-chat', a.discordId);
    // Off the restricted ticket's list: the same words as "not a ticket thread".
    expect(said(await run('906', restricted.thread, b.id))).toBe(said(elsewhere));
    // Someone who CAN see both tickets, naming a message from the wrong thread.
    expect(said(await run('907', restricted.thread, a.discordId))).toBe(said(elsewhere));
    expect(messageById(db, a.row.id)!.content).toBe(HORRIBLE);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
  });

  it('removes at once: the site copy, the files and the Discord message, audited as from Discord', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    const r = await run('906', thread, discordId);
    expect(r.ephemeral).toBe(true);
    expect(said(r)).toMatch(/cannot be undone/);
    expect(messageById(db, row.id)).toMatchObject({ content: '', removed_by: MOD, discord_gone: 1 });
    expect(readdirSync(dir)).toEqual([]);
    expect(await t.threads.fetchMessage(thread, discordId)).toBeNull();
    const audit = db.prepare('SELECT admin_id, action, target, detail FROM admin_actions').all() as { admin_id: string; action: string; target: string; detail: string }[];
    expect(audit.map((a) => ({ ...a, detail: JSON.parse(a.detail) }))).toEqual([
      { admin_id: MOD, action: 'ticket_remove', target: String(id), detail: { messageId: row.id, files: 1, via: 'discord' } },
    ]);
    expect(dump()).not.toContain(HORRIBLE);
    expect(said(await run('906', thread, discordId))).toMatch(/already removed/i);
  });

  it('deletes a message the mirror never copied, leaves the card alone, and is quiet on a restricted ticket', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED, 'unsafe');
    mirror.start();
    await mirror.idle();
    mirror.stop();
    const missed = t.userPost(thread, { authorId: '555', content: HORRIBLE }, false);
    mirror = newMirror();
    events.length = 0;
    expect(said(await run('907', thread, missed.id))).toMatch(/had not been copied/);
    expect(t.inbox.find((m) => m.id === missed.id)!.deleted).toBe(true);
    expect(db.prepare("SELECT detail FROM ticket_events WHERE ticket_id = ? AND kind = 'removed'").get(id)).toEqual({ detail: '{"mirrored":false}' });
    expect(events).toEqual([]);
    expect(said(await run('907', thread, thread))).toMatch(/ticket's own card/);
    expect(t.byId(thread)!.deleted).toBe(false);
  });
});

describe('POST /api/mod/tickets/:id/messages/:mid/remove', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('removes for staff who can see the ticket, audits without the content, and the file stops being served', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { row } = await horrible(thread);
    const aid = attachmentsOf(db, row.id)[0].id;
    app = await buildServer({
      config: loadConfig({ ADMIN_STEAMIDS: ADMIN, TICKET_ATTACHMENTS_DIR: dir }), db,
      orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    });
    const as = (steamid: string) => authedCookie(app, db, steamid);
    const url = `/api/mod/tickets/${id}/messages/${row.id}/remove`;
    expect((await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}/attachments/${aid}`, cookies: as(MOD) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, cookies: as(PLAYER), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, cookies: as(ACCUSED), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/mod/tickets/9999/messages/${row.id}/remove`, cookies: as(MOD), payload: {} })).statusCode).toBe(404);
    const r = await app.inject({ method: 'POST', url, cookies: as(MOD), payload: { reason: 'gore' } });
    expect(r.json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}/attachments/${aid}`, cookies: as(MOD) })).statusCode).toBe(404);
    const d = (await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}`, cookies: as(MOD) })).json();
    expect(d.messages[0]).toMatchObject({ content: '', history: [], removed: { by: MOD, reason: 'gore' } });
    expect(d.messages[0].attachments[0]).toMatchObject({ filename: 'picture.png', size: 50, stored: false, removed: true });
    const audit = db.prepare("SELECT detail FROM admin_actions WHERE action = 'ticket_remove'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toEqual({ messageId: row.id, files: 1 });
    expect(dump()).not.toContain(HORRIBLE);
    expect(JSON.stringify(d)).not.toContain(HORRIBLE);
  });
});
