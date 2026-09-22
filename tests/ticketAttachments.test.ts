import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertAttachment, insertMessage } from '../src/tickets/messages.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { allowedType, attachmentPath, AttachmentStore, httpFetcher, type AttachmentFetcher } from '../src/tickets/attachments.js';
import type { InboundAttachment } from '../src/discord/transport.js';

const IDS = Array.from({ length: 4 }, (_, i) => `7656119900000000${i}`);
const MB = 1024 * 1024;
let db: DB;
let dir: string;
let root: string;
let calls: string[];
let events: AdminEvent[];
let off: () => void;
let seq = 0;

const bytes = (n: number) => new Uint8Array(n).fill(7);
/** url -> what the CDN answers. 'fail' is a 404, 'throw' is a dead connection. */
const fetcherOf = (map: Record<string, Uint8Array | 'fail' | 'throw'>): AttachmentFetcher => async (url) => {
  calls.push(url);
  const v = map[url];
  if (v === 'throw' || v === undefined) throw new Error('socket hang up');
  if (v === 'fail') return { ok: false, body: null };
  // Two chunks, so the streaming cap is exercised mid-body.
  const half = Math.floor(v.byteLength / 2);
  return { ok: true, body: (async function* () { yield v.subarray(0, half); yield v.subarray(half); })() };
};
const att = (name: string, size: number, url = `https://cdn.discordapp.com/${name}`): InboundAttachment =>
  ({ id: `a${++seq}`, name, contentType: null, size, url });

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  root = mkdtempSync(join(tmpdir(), 'pug-attach-'));
  // Not made yet on purpose: the store makes it on the first file it keeps.
  dir = join(root, 'ticket-attachments');
  calls = [];
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { off(); rmSync(root, { recursive: true, force: true }); });

const ticket = (target: string) => (fileReport(db, IDS[0], { targetId: target, category: 'griefing', text: 'x' }, { adminSteamIds: [] }) as { ticketId: number }).ticketId;
/** Save, and record the outcome the way the mirror does, so quotas count it. */
async function keep(store: AttachmentStore, ticketId: number, a: InboundAttachment) {
  const r = await store.save(ticketId, a);
  const m = insertMessage(db, {
    ticketId, threadId: '9001', channel: 'staff', discordMessageId: `d${++seq}`, authorDiscordId: '906', authorPlayerId: null,
    authorName: 'x', content: '', createdAt: '2026-09-22T10:00:00.000Z',
  })!;
  insertAttachment(db, { messageId: m.id, discordAttachmentId: a.id, filename: a.name, contentType: '', size: r.size, sha256: r.sha256, storedName: r.storedName, skipReason: r.skipReason });
  return r;
}
const onDisk = () => (existsSync(dir) ? readdirSync(dir) : []);

describe('what is kept', () => {
  it('stores an allowed file under a random name with its hash, and nothing about it in the name', async () => {
    const body = bytes(1000);
    const a = att('Proof Of It.PNG', 1000);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: body }) });
    const r = await store.save(ticket(IDS[1]), a);
    expect(r).toMatchObject({ size: 1000, skipReason: null, sha256: createHash('sha256').update(body).digest('hex') });
    expect(r.storedName).toMatch(/^[0-9a-f]{32}$/);
    expect(onDisk()).toEqual([r.storedName]);
    expect(readFileSync(attachmentPath(dir, r.storedName!)!)).toEqual(Buffer.from(body));
  });

  it('knows its eight types by extension, whatever the case, and jpeg as jpg', () => {
    expect(['a.png', 'a.jpg', 'a.gif', 'a.webp', 'a.mp4', 'a.webm', 'a.mov', 'a.txt'].map((n) => allowedType(n)?.ext))
      .toEqual(['png', 'jpg', 'gif', 'webp', 'mp4', 'webm', 'mov', 'txt']);
    expect(allowedType('photo.JPEG')).toMatchObject({ ext: 'jpg', mime: 'image/jpeg', inline: true });
    expect(allowedType('notes.txt')).toMatchObject({ inline: false });
    for (const n of ['run.exe', 'page.html', 'pic.svg', 'archive.zip', 'noextension', 'trick.png.exe']) expect(allowedType(n)).toBeNull();
  });
});

describe('what is refused, before anything is downloaded', () => {
  it('a type that is not allowed', async () => {
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({}) });
    expect(await store.save(ticket(IDS[1]), att('payload.exe', 10))).toEqual({ size: 10, sha256: null, storedName: null, skipReason: 'type' });
    expect(calls).toEqual([]);
  });

  it('a file Discord says is too large', async () => {
    setSetting(db, 'ticket_attachment_max_mb', '1');
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({}) });
    expect((await store.save(ticket(IDS[1]), att('long.mp4', 2 * MB))).skipReason).toBe('too_large');
    expect(calls).toEqual([]);
  });

  it('everything, with the kill switch off', async () => {
    setSetting(db, 'ticket_store_attachments', '0');
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({}) });
    expect((await store.save(ticket(IDS[1]), att('fine.png', 10))).skipReason).toBe('disabled');
    expect(calls).toEqual([]);
  });

  it('a file that would take its ticket past the per ticket quota, without telling the admins', async () => {
    setSetting(db, 'ticket_attachments_ticket_mb', '1');
    const a = att('one.png', 600 * 1024);
    const b = att('two.png', 600 * 1024);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: bytes(600 * 1024), [b.url]: bytes(600 * 1024) }) });
    const id = ticket(IDS[1]);
    expect((await keep(store, id, a)).skipReason).toBeNull();
    expect((await keep(store, id, b)).skipReason).toBe('quota');
    expect(calls).toEqual([a.url]);
    expect(events).toEqual([]);
  });

  it('past the overall cap nothing new is stored, and the admins are told once, with no file named', async () => {
    setSetting(db, 'ticket_attachments_total_mb', '1');
    const a = att('one.png', 600 * 1024);
    const b = att('secret-name.png', 600 * 1024);
    const c = att('three.png', 600 * 1024);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: bytes(600 * 1024) }) });
    expect((await keep(store, ticket(IDS[1]), a)).skipReason).toBeNull();
    expect((await keep(store, ticket(IDS[2]), b)).skipReason).toBe('quota');
    expect((await keep(store, ticket(IDS[3]), c)).skipReason).toBe('quota');
    const problems = events.filter((e) => e.kind === 'problem');
    expect(problems).toHaveLength(1);
    expect(JSON.stringify(problems[0])).toMatch(/attachment/i);
    expect(JSON.stringify(problems[0])).not.toContain('secret-name');
  });
});

describe('what goes wrong while downloading', () => {
  it('a body bigger than Discord said is cut off at the cap, and nothing is left on disk', async () => {
    setSetting(db, 'ticket_attachment_max_mb', '1');
    const a = att('liar.png', 10);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: bytes(2 * MB) }) });
    expect((await store.save(ticket(IDS[1]), a)).skipReason).toBe('too_large');
    expect(onDisk()).toEqual([]);
  });

  it('a refused or broken download is fetch_failed, never a throw, and leaves nothing behind', async () => {
    const a = att('gone.png', 10);
    const b = att('dead.png', 10);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: 'fail', [b.url]: 'throw' }) });
    const id = ticket(IDS[1]);
    expect((await store.save(id, a)).skipReason).toBe('fetch_failed');
    expect((await store.save(id, b)).skipReason).toBe('fetch_failed');
    expect(onDisk()).toEqual([]);
  });
});

describe('the two guards around the file system and the network', () => {
  it('a stored name is 32 hex characters or it is not a path', () => {
    expect(attachmentPath('/srv/files', 'a'.repeat(32))).toBe('/srv/files/' + 'a'.repeat(32));
    for (const bad of ['../pug.db', 'a'.repeat(31), `${'a'.repeat(32)}/x`, '']) expect(attachmentPath('/srv/files', bad)).toBeNull();
  });

  it('the real fetcher refuses anything that is not https on Discord\'s CDN, without touching the network', async () => {
    for (const url of ['https://example.com/x.png', 'http://cdn.discordapp.com/x.png', 'https://cdn.discordapp.com.evil.test/x.png', 'file:///etc/passwd', 'nonsense']) {
      expect(await httpFetcher(url)).toEqual({ ok: false, body: null });
    }
  });
});
