import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess } from '../src/tickets/actions.js';
import { staffThread } from '../src/tickets/threads.js';
import { messageByDiscordId } from '../src/tickets/messages.js';
import { removeMessage, removeMessages } from '../src/tickets/removal.js';
import { reporterThreadsOf } from '../src/tickets/reporterChat.js';
import { AttachmentStore, type AttachmentFetcher } from '../src/tickets/attachments.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { TicketMirror } from '../src/discord/ticketMirror.js';
import { ReporterChats } from '../src/discord/reporterChats.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000043${i}`);
const [R1, , ACCUSED, , , , MOD, ADMIN] = IDS;
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

describe('the relay onto the forum post', () => {
  it('copies what the reporter writes, headed with their name, and not what staff write', async () => {
    const c = await chatAbout();
    await chats.join(c.ticketId, MOD);
    t.userPost(c.chat, { authorId: D(R1), authorName: 'Reporter Name', content: 'he did it again' });
    t.userPost(c.chat, { authorId: D(MOD), authorName: 'A Mod', content: 'thanks, looking now' });
    await settle();
    const got = copies(c.ticketId);
    expect(got).toHaveLength(1);
    expect(got[0].payload.embeds[0].title).toBe('From the reporter, Reporter Name');
    expect(got[0].payload.embeds[0].description).toBe('he did it again');
    expect(got[0].payload.mentionUserIds).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 1 });
    await sync.reconcile();
    expect(copies(c.ticketId)).toHaveLength(1);
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
});
