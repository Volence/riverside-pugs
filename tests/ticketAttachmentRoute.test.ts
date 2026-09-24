import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertAttachment, insertMessage } from '../src/tickets/messages.js';
import { attachmentPath, AttachmentStore } from '../src/tickets/attachments.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 7 }, (_, i) => `7656119900000000${i}`);
const [R1, PLAYER, ACCUSED, STAFF_ACCUSED, MOD, ADMIN, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
let root: string;
let dir: string;
let seq = 0;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pug-serve-'));
  dir = join(root, 'ticket-attachments');
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({ ADMIN_STEAMIDS: OWNER, TICKET_ATTACHMENTS_DIR: dir }), db,
    orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
});
afterEach(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

const file = (targetId: string, category = 'griefing') =>
  (fileReport(db, R1, { targetId, category, text: 'x' }, { adminSteamIds: [OWNER] }) as { ticketId: number }).ticketId;
/** A mirrored message with one file, stored through the real store. */
async function seed(ticketId: number, name: string, body: Uint8Array): Promise<{ aid: number; storedName: string | null }> {
  const store = new AttachmentStore({ db, dir, fetcher: async () => ({ ok: true, body: (async function* () { yield body; })() }) });
  const r = await store.save(ticketId, { id: `a${++seq}`, name, contentType: null, size: body.byteLength, url: 'https://cdn.discordapp.com/x' });
  const m = insertMessage(db, {
    ticketId, threadId: '9001', channel: 'staff', discordMessageId: `d${++seq}`, authorDiscordId: '906', authorPlayerId: MOD,
    authorName: 'Mod on Discord', content: 'look at this', createdAt: '2026-09-22T10:00:00.000Z',
  })!;
  const aid = insertAttachment(db, { messageId: m.id, discordAttachmentId: `a${seq}`, filename: name, contentType: 'whatever/discord-said', size: r.size, sha256: r.sha256, storedName: r.storedName, skipReason: r.skipReason });
  return { aid, storedName: r.storedName };
}
const get = (as: string | null, url: string) => app.inject({ method: 'GET', url, cookies: as ? cookie[as] : undefined });

describe('GET /api/mod/tickets/:id/attachments/:aid', () => {
  it('serves an image inline, with our content type and the exact headers', async () => {
    const id = file(ACCUSED);
    const body = new Uint8Array(200).fill(9);
    const { aid } = await seed(id, 'shot.png', body);
    const r = await get(MOD, `/api/mod/tickets/${id}/attachments/${aid}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-disposition']).toBe('inline; filename="shot.png"');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(String(r.headers['content-length'])).toBe('200');
    expect(r.rawPayload).toEqual(Buffer.from(body));
  });

  it('serves a text file as a download, never inline, and never trusts the name it was given', async () => {
    const id = file(ACCUSED);
    const txt = await seed(id, 'we"ird\r\nname.txt', new Uint8Array(5).fill(65));
    const r = await get(MOD, `/api/mod/tickets/${id}/attachments/${txt.aid}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="we_ird__name.txt"');
    const mov = await seed(id, 'clip.mov', new Uint8Array(5));
    expect((await get(MOD, `/api/mod/tickets/${id}/attachments/${mov.aid}`)).headers['content-disposition']).toBe('inline; filename="clip.mov"');
  });

  it('is behind the ticket: the accused, anyone off a restricted list, and a wrong ticket id all get the same 404', async () => {
    const restricted = file(ACCUSED, 'unsafe');
    const secret = await seed(restricted, 'secret.png', new Uint8Array(10));
    const aboutStaff = file(STAFF_ACCUSED);
    // Made a moderator after the report, so the ticket is still a normal one:
    // readable by every other member of staff, and never by them.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(STAFF_ACCUSED);
    const theirs = await seed(aboutStaff, 'about-me.png', new Uint8Array(10));
    const normal = file(PLAYER);

    expect((await get(OWNER, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`)).statusCode).toBe(200);
    const missing = await get(OWNER, `/api/mod/tickets/${restricted}/attachments/99999`);
    expect(missing.statusCode).toBe(404);
    for (const r of [
      await get(ADMIN, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`),
      await get(MOD, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`),
      await get(STAFF_ACCUSED, `/api/mod/tickets/${aboutStaff}/attachments/${theirs.aid}`),
      // A real file, asked for through a ticket it does not belong to.
      await get(MOD, `/api/mod/tickets/${normal}/attachments/${secret.aid}`),
      await get(MOD, `/api/mod/tickets/9999/attachments/${secret.aid}`),
    ]) {
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe(missing.body);
    }
    // Not staff: refused as every /api/mod route refuses, before any file is looked up.
    expect((await get(PLAYER, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`)).statusCode).toBe(403);
    expect((await get(PLAYER, `/api/mod/tickets/${restricted}/attachments/99999`)).statusCode).toBe(403);
    expect((await get(null, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`)).statusCode).toBe(401);
  });

  it('404s a file that was not stored, was removed, or is no longer on disk', async () => {
    const id = file(ACCUSED);
    const refused = await seed(id, 'tool.exe', new Uint8Array(10));
    expect((await get(MOD, `/api/mod/tickets/${id}/attachments/${refused.aid}`)).statusCode).toBe(404);
    const removed = await seed(id, 'gone.png', new Uint8Array(10));
    db.prepare("UPDATE ticket_attachments SET removed_at = '2026-09-22T12:00:00.000Z' WHERE id = ?").run(removed.aid);
    expect((await get(MOD, `/api/mod/tickets/${id}/attachments/${removed.aid}`)).statusCode).toBe(404);
    const lost = await seed(id, 'lost.png', new Uint8Array(10));
    unlinkSync(attachmentPath(dir, lost.storedName!)!);
    expect((await get(MOD, `/api/mod/tickets/${id}/attachments/${lost.aid}`)).statusCode).toBe(404);
  });
});

describe('the discussion on the detail', () => {
  it('lists mirrored messages oldest first, each with its files and what became of them', async () => {
    const id = file(ACCUSED);
    const png = await seed(id, 'shot.png', new Uint8Array(10));
    await seed(id, 'tool.exe', new Uint8Array(10));
    const d = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(d.messages).toHaveLength(2);
    expect(d.messages[0]).toMatchObject({
      channel: 'staff', authorName: 'Mod on Discord', authorPlayerId: MOD, content: 'look at this', history: [],
      editedAt: null, deletedAt: null, removed: null,
    });
    expect(d.messages[0].attachments).toEqual([expect.objectContaining({ id: png.aid, filename: 'shot.png', size: 10, stored: true, skipReason: null, removed: false })]);
    expect(d.messages[1].attachments[0]).toMatchObject({ filename: 'tool.exe', stored: false, skipReason: 'type' });
    // The random name on disk is nobody's business but the server's.
    expect(JSON.stringify(d)).not.toContain(png.storedName);
  });
});
