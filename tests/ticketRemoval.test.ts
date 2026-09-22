import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertThread, setThreadLocked, threadByDiscordId } from '../src/tickets/threads.js';
import { closeTicket } from '../src/tickets/actions.js';
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

/** The cast: eight linked players, one of them a moderator and one an admin. */
function seed(into: DB): void {
  IDS.forEach((id, i) => {
    upsertPlayer(into, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(into, id);
    linkDiscord(into, id, `90${i}`, `d${i}`);
  });
  into.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  into.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
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
/** Someone posts the horrible thing with a picture, edits it once, and the
 *  mirror copies it all. Mirrored BEFORE the edit, because that is what leaves
 *  the earlier version in the history: a message edited before the mirror ever
 *  saw it is stored as it reads now, with nothing behind it. */
async function horrible(thread: string) {
  const m = t.userPost(thread, { authorId: '555', authorName: 'A Stranger', content: 'an earlier version', attachments: [
    { id: 'a1', name: 'picture.png', contentType: 'image/png', size: 50, url: 'https://cdn.discordapp.com/1/picture.png' },
  ] });
  await mirror.idle();
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

  it('says so, without naming anything, when the database was too busy to empty the log', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { row } = await horrible(thread);
    // As SQLite answers when another connection is reading: no throw, and
    // nothing folded back.
    const real = db.pragma.bind(db);
    db.pragma = ((source: string, options?: object) => (source === 'wal_checkpoint(TRUNCATE)'
      ? [{ busy: 1, log: 4, checkpointed: 0 }]
      : real(source, options as never))) as typeof db.pragma;
    const said: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { said.push(args.map(String).join(' ')); });

    expect(removeMessage(db, dir, id, row.id, MOD, 'gore').ok).toBe(true);

    spy.mockRestore();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/could not be emptied/);
    // Not a ticket id, a message id or a SteamID: the console is read by
    // whoever runs the box, and the ticket may be one they may not see.
    expect(said[0]).not.toMatch(/\d/);
    // And the removal itself stands.
    expect(messageById(db, row.id)).toMatchObject({ content: '', history: '[]', removed_by: MOD, removed_reason: 'gore' });
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

  /** A Discord that refuses every delete, as a bot without Manage Messages
   *  does. Returns the way back. */
  function refusesDeletes(): () => void {
    const real = t.remove.bind(t);
    t.remove = async () => { throw new Error('Missing Permissions'); };
    return () => { t.remove = real; };
  }

  it('tells the admins once that a removed message is still standing in Discord, and names nothing', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    refusesDeletes();
    events.length = 0;

    expect(removeMessage(db, dir, id, row.id, MOD, '').ok).toBe(true);
    await mirror.sweepRemovals();
    await mirror.sweepRemovals();

    // Still owed, and still standing: the sweep tries again every time.
    expect(messageById(db, row.id)!.discord_gone).toBe(0);
    expect(t.inbox.find((m) => m.id === discordId)!.deleted).toBe(false);
    const problems = events.filter((e) => e.kind === 'problem');
    // Once per process, however many sweeps fail.
    expect(problems).toHaveLength(1);
    const text = problems[0].kind === 'problem' ? problems[0].text : '';
    expect(text).toMatch(/Manage Messages/);
    for (const secret of [thread, discordId, `#${id}`, ACCUSED, 'A Stranger', '555']) expect(text).not.toContain(secret);
  });

  it('is asked again by the reconciler\'s timer, so a delete that failed is retried without a restart', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    const recover = refusesDeletes();

    expect(removeMessage(db, dir, id, row.id, MOD, '').ok).toBe(true);
    await mirror.sweepRemovals();
    expect(messageById(db, row.id)!.discord_gone).toBe(0);

    recover();
    const sync = new TicketSync({
      db, transport: t, publicUrl: 'http://x', intervalMs: 5, sweepRemovals: () => { void mirror.sweepRemovals(); },
    });
    sync.start();
    await vi.waitFor(() => expect(messageById(db, row.id)!.discord_gone).toBe(1));
    sync.stop();
    expect(t.inbox.find((m) => m.id === discordId)!.deleted).toBe(true);
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
  const NOT_HERE = 'This only works on a message inside a ticket thread you have access to.';
  const run = (userId: string, channelId: string, messageId: string, m: () => TicketMirror | null = () => mirror) =>
    handleRemoveCommand({ db, attachmentsDir: dir, mirror: m }, { kind: 'message_command', name: REMOVE_COMMAND, userId, userName: 'x', channelId, messageId });
  const said = (r: { payload: { content?: string } }) => r.payload.content ?? '';
  const auditRows = () => (db.prepare('SELECT admin_id, action, target, detail FROM admin_actions ORDER BY id')
    .all() as { admin_id: string; action: string; target: string; detail: string }[])
    .map((a) => ({ ...a, detail: JSON.parse(a.detail) as object }));

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
    expect(said(elsewhere)).toBe(NOT_HERE);
    // Off the restricted ticket's list: the same words as "not a ticket thread".
    expect(said(await run('906', restricted.thread, b.id))).toBe(said(elsewhere));
    // Someone who CAN see both tickets, naming a message from the wrong thread.
    expect(said(await run('907', restricted.thread, a.discordId))).toBe(said(elsewhere));
    expect(messageById(db, a.row.id)!.content).toBe(HORRIBLE);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
  });

  /** The site's guard is inGoodStanding, which asks the bans table as well as
   *  players.status. A moderator banned a moment ago is not staff here either. */
  it('refuses a moderator whose ban is only in the bans table, in the same words as a player', async () => {
    const { thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'system', ?)")
      .run(MOD, new Date().toISOString());
    expect(db.prepare('SELECT status FROM players WHERE steamid = ?').get(MOD)).toEqual({ status: 'active' });
    expect(said(await run('906', thread, discordId))).toBe(said(await run('901', thread, discordId)));
    expect(said(await run('906', thread, discordId))).toBe('Staff only.');
    expect(messageById(db, row.id)!.content).toBe(HORRIBLE);
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
      { admin_id: MOD, action: 'ticket_remove', target: String(id), detail: { messageId: row.id, files: 1, mirrored: true, via: 'discord' } },
    ]);
    expect(dump()).not.toContain(HORRIBLE);
    expect(said(await run('906', thread, discordId))).toMatch(/already removed/i);
  });

  /** Right-clicking Remove again on a message that is still standing is the
   *  only retry a moderator has, and it used to be a bare refusal. */
  it('asks the bot to try the Discord delete again when the message was already removed on the site', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    let attempts = 0;
    const real = t.remove.bind(t);
    t.remove = async (channelId, messageId) => {
      attempts++;
      if (attempts === 1) throw new Error('Missing Permissions');
      await real(channelId, messageId);
    };
    expect(removeMessage(db, dir, id, row.id, MOD, '').ok).toBe(true);
    await mirror.sweepRemovals();
    expect(attempts).toBe(1);
    expect(messageById(db, row.id)!.discord_gone).toBe(0);

    expect(said(await run('906', thread, discordId)))
      .toBe('That message was already removed on the site. The bot has been asked again to delete it here.');

    // Asked, not waited for: the command answers at once and the sweep runs
    // on its own chain.
    await mirror.idle();
    expect(attempts).toBe(2);
    expect(messageById(db, row.id)!.discord_gone).toBe(1);
    expect(t.inbox.find((m) => m.id === discordId)!.deleted).toBe(true);
    // Nothing removed twice: the second command wrote no second audit row.
    expect(auditRows()).toHaveLength(0);
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
    expect(db.prepare("SELECT detail FROM admin_actions WHERE action = 'ticket_remove'").get()).toEqual({ detail: '{"mirrored":false,"via":"discord"}' });
    expect(events).toEqual([]);
    expect(said(await run('907', thread, thread))).toMatch(/ticket's own card/);
    expect(t.byId(thread)!.deleted).toBe(false);
  });

  /** The two ways the unmirrored branch can say "deleted" without having
   *  deleted anything. Nothing there is written down, so there is nothing to
   *  retry: it either happens now or it is refused. */
  it('with no bot running it refuses instead of claiming a deletion, and audits nothing', async () => {
    const { thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    await mirror.idle();
    mirror.stop();
    const missed = t.userPost(thread, { authorId: '555', content: HORRIBLE }, false);

    expect(said(await run('906', thread, missed.id, () => null))).toBe(NOT_HERE);

    expect(t.inbox.find((m) => m.id === missed.id)!.deleted).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE kind = 'removed'").get()).toEqual({ n: 0 });
  });

  /** A message written while the bot was away, which the site never copied. */
  async function unmirrored(thread: string) {
    mirror.start();
    await mirror.idle();
    mirror.stop();
    const missed = t.userPost(thread, { authorId: '555', content: HORRIBLE }, false);
    mirror = newMirror();
    return missed;
  }
  /** A closed ticket, its thread locked and archived as the reconciler leaves
   *  one, and a Discord that refuses to archive it again. Everything up to and
   *  including the delete works; only the tidying up after it fails. Returns
   *  the way to let Discord recover. */
  async function refusesReArchiving(ticketId: number, thread: string): Promise<() => void> {
    expect(closeTicket(db, ticketId, MOD, 'no_action', '')).toEqual({ ok: true });
    setThreadLocked(db, threadByDiscordId(db, thread)!.id, true);
    await t.threads.setLocked(thread, true);
    await t.threads.setArchived(thread, true);
    const real = t.threads.setArchived;
    t.threads.setArchived = async (id, archived) => {
      if (archived) throw new Error('discord down');
      await real(id, archived);
    };
    return () => { t.threads.setArchived = real; };
  }

  it('a delete Discord refuses is not audited as one that happened', async () => {
    const { thread } = await ticketWithThread(ACCUSED);
    const missed = await unmirrored(thread);
    // The delete itself, refused. Stubbed rather than driven through
    // failThreadOps, which the fake's remove() does not consume.
    const real = t.remove.bind(t);
    t.remove = async (channelId, messageId) => {
      if (messageId === missed.id) throw new Error('discord down');
      await real(channelId, messageId);
    };

    expect(said(await run('906', thread, missed.id))).toMatch(/would not delete/i);

    expect(t.inbox.find((m) => m.id === missed.id)!.deleted).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE kind = 'removed'").get()).toEqual({ n: 0 });
  });

  /** The audit records what happened to the MESSAGE. A thread left unarchived
   *  is a tidiness problem the reconciler's next pass repairs. */
  it('records the deletion when only the tidying up afterwards failed, and has the reconciler finish it', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    const missed = await unmirrored(thread);
    const recover = await refusesReArchiving(id, thread);

    expect(said(await run('906', thread, missed.id))).toMatch(/^Deleted\./);

    expect(t.inbox.find((m) => m.id === missed.id)!.deleted).toBe(true);
    expect(auditRows()).toEqual([{ admin_id: MOD, action: 'ticket_remove', target: String(id), detail: { mirrored: false, via: 'discord' } }]);
    expect(db.prepare("SELECT detail FROM ticket_events WHERE ticket_id = ? AND kind = 'removed'").get(id)).toEqual({ detail: '{"mirrored":false}' });
    // Left open in Discord, and the ROW says so: the reconciler reads the row
    // and nothing else, and a row still saying locked is a row it skips.
    expect(t.threadsById.get(thread)).toMatchObject({ archived: false, locked: true });
    expect(threadByDiscordId(db, thread)!.locked).toBe(0);

    // So the next pass puts Discord back the way the closed ticket says.
    recover();
    const sync = new TicketSync({ db, transport: t, publicUrl: 'http://x', intervalMs: 0 });
    await sync.reconcile();
    sync.stop();
    expect(t.threadsById.get(thread)).toMatchObject({ archived: true, locked: true });
    expect(threadByDiscordId(db, thread)!.locked).toBe(1);
  });

  it('counts the Discord half as done for a mirrored message when only the tidying up failed', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    await refusesReArchiving(id, thread);

    expect(said(await run('906', thread, discordId))).toMatch(/the message is deleted here/);

    expect(t.inbox.find((m) => m.id === discordId)!.deleted).toBe(true);
    expect(messageById(db, row.id)!.discord_gone).toBe(1);
    expect(auditRows()).toEqual([
      { admin_id: MOD, action: 'ticket_remove', target: String(id), detail: { messageId: row.id, files: 1, mirrored: true, via: 'discord' } },
    ]);
  });
});

describe('what is left on the disk', () => {
  /** The claim the owner is buying: gone for good. A real file, because the
   *  in-memory database has no write-ahead log to leave anything in. */
  it('leaves no trace of the text in the database file or its log', async () => {
    const dbPath = join(root, 'pug.db');
    db = openDb(dbPath);
    seed(db);
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror = newMirror();
    mirror.start();
    const { row } = await horrible(thread);
    const onDisk = () => readFileSync(dbPath).toString('latin1') + readFileSync(`${dbPath}-wal`).toString('latin1');
    // What the message and its earlier version look like on disk before it goes.
    expect(onDisk()).toContain(HORRIBLE);
    expect(onDisk()).toContain('an earlier version');

    expect(removeMessage(db, dir, id, row.id, MOD, 'gore').ok).toBe(true);

    expect(onDisk()).not.toContain(HORRIBLE);
    expect(onDisk()).not.toContain('an earlier version');

    // And a wall of text, the case that matters most: over about 450 bytes
    // SQLite keeps the start of the value in the row and puts the rest on
    // overflow pages of its own, so the two ends are looked for separately.
    // Freeing those pages is what secure_delete is for, and without it 334
    // characters of this survive the checkpoint (measured, 2026-09-21).
    const HEAD = 'the-start-of-the-wall-Vx9';
    const TAIL = 'the-end-of-the-wall-Vx9';
    const big = t.userPost(thread, { authorId: '555', authorName: 'A Stranger', content: `${HEAD}${'q'.repeat(4000)}${TAIL}` });
    await mirror.idle();
    expect(onDisk()).toContain(HEAD);
    expect(onDisk()).toContain(TAIL);

    expect(removeMessage(db, dir, id, messageByDiscordId(db, big.id)!.id, MOD, '').ok).toBe(true);

    expect(onDisk()).not.toContain(HEAD);
    expect(onDisk()).not.toContain(TAIL);
    // The tombstone is still there, so this is not an empty database.
    expect(messageById(db, row.id)).toMatchObject({ removed_by: MOD, removed_reason: 'gore', author_name: 'A Stranger' });
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
    expect(JSON.parse(audit.detail)).toEqual({ messageId: row.id, files: 1, mirrored: true, via: 'site' });
    expect(dump()).not.toContain(HORRIBLE);
    expect(JSON.stringify(d)).not.toContain(HORRIBLE);
  });
});
