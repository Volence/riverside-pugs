import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { getSetting } from '../src/settings.js';
import { ensureTicketSchema } from '../src/tickets/schema.js';
import { fileReport } from '../src/tickets/filing.js';
import { foldTicket, restrictOpenTicketAbout } from '../src/tickets/store.js';
import { mergePlayers } from '../src/mergePlayers.js';
import {
  attachmentsOf, insertAttachment, insertMessage, lastMessageId, markDeleted, messageByDiscordId, messageById,
  recordEdit, storedBytes, updateAttachment,
} from '../src/tickets/messages.js';

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, ACCUSED, ALT, MOD, ADMIN] = IDS;
const deps = { adminSteamIds: [ADMIN] };
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const file = (reporter: string, targetId: string, category = 'griefing') =>
  (fileReport(db, reporter, { targetId, category, text: 'x' }, deps) as { ticketId: number }).ticketId;
const say = (ticketId: number, discordMessageId: string, content = 'hello', author: string | null = MOD) => insertMessage(db, {
  ticketId, threadId: '9001', channel: 'staff', discordMessageId, authorDiscordId: '906', authorPlayerId: author,
  authorName: 'mod on discord', content, createdAt: '2026-09-22T10:00:00.000Z',
})!;

describe('ticket_messages', () => {
  it('is idempotent, and a Discord message is stored once', () => {
    expect(() => ensureTicketSchema(db)).not.toThrow();
    const id = file(R1, ACCUSED);
    const m = say(id, '100001');
    expect(m).toMatchObject({ ticket_id: id, channel: 'staff', content: 'hello', history: '[]', deleted_at: null, removed_at: null, discord_gone: 0 });
    expect(insertMessage(db, {
      ticketId: id, threadId: '9001', channel: 'staff', discordMessageId: '100001', authorDiscordId: '906', authorPlayerId: MOD,
      authorName: 'x', content: 'again', createdAt: '2026-09-22T10:00:01.000Z',
    })).toBeNull();
    expect(messageByDiscordId(db, '100001')!.content).toBe('hello');
  });

  it('an edit pushes the previous content onto history, and an unchanged edit is nothing', () => {
    const m = say(file(R1, ACCUSED), '100001', 'first');
    expect(recordEdit(db, m.id, 'second', '2026-09-22T10:01:00.000Z')).toBe(true);
    expect(recordEdit(db, m.id, 'second', '2026-09-22T10:02:00.000Z')).toBe(false);
    expect(recordEdit(db, m.id, 'third', '2026-09-22T10:03:00.000Z')).toBe(true);
    const now = messageById(db, m.id)!;
    expect(now.content).toBe('third');
    expect(JSON.parse(now.history)).toEqual(['first', 'second']);
    expect(now.edited_at).toBe('2026-09-22T10:03:00.000Z');
  });

  it('a Discord delete is soft: marked, known gone, content kept', () => {
    const m = say(file(R1, ACCUSED), '100001', 'evidence');
    const gone = markDeleted(db, '100001', new Date('2026-09-22T11:00:00.000Z'))!;
    expect(gone).toMatchObject({ id: m.id, content: 'evidence', deleted_at: '2026-09-22T11:00:00.000Z', discord_gone: 1 });
    expect(markDeleted(db, 'nope')).toBeUndefined();
  });

  it('the last stored id is the largest snowflake, not the largest string', () => {
    const id = file(R1, ACCUSED);
    say(id, '99999');
    say(id, '100001');
    expect(lastMessageId(db, '9001')).toBe('100001');
    expect(lastMessageId(db, 'other')).toBeNull();
  });
});

describe('ticket_attachments', () => {
  it('counts only bytes that are on disk, per ticket and overall', () => {
    const a = file(R1, ACCUSED);
    const b = file(R1, ALT);
    const ma = say(a, '100001');
    const mb = say(b, '100002');
    const first = insertAttachment(db, { messageId: ma.id, discordAttachmentId: 'a1', filename: 'one.png', contentType: 'image/png', size: 100, sha256: 'h1', storedName: 'f'.repeat(32), skipReason: null });
    insertAttachment(db, { messageId: ma.id, discordAttachmentId: 'a2', filename: 'big.exe', contentType: 'application/x-msdownload', size: 5000, sha256: null, storedName: null, skipReason: 'type' });
    insertAttachment(db, { messageId: mb.id, discordAttachmentId: 'a3', filename: 'two.png', contentType: 'image/png', size: 30, sha256: 'h3', storedName: 'e'.repeat(32), skipReason: null });
    expect(storedBytes(db, a)).toBe(100);
    expect(storedBytes(db)).toBe(130);
    updateAttachment(db, first, { size: 0, sha256: null, storedName: null, skipReason: 'fetch_failed' });
    expect(attachmentsOf(db, ma.id).map((r) => [r.filename, r.skip_reason])).toEqual([['one.png', 'fetch_failed'], ['big.exe', 'type']]);
    expect(storedBytes(db)).toBe(30);
  });
});

describe('rows follow their ticket', () => {
  it('a fold moves the messages onto the survivor', () => {
    const keep = file(R1, ACCUSED);
    const gone = file(R2, ALT);
    const m = say(gone, '100001');
    insertAttachment(db, { messageId: m.id, discordAttachmentId: 'a1', filename: 'one.png', contentType: 'image/png', size: 1, sha256: 'h', storedName: 'f'.repeat(32), skipReason: null });
    db.transaction(() => foldTicket(db, gone, keep, 'merge'))();
    expect(messageById(db, m.id)!.ticket_id).toBe(keep);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('so does the fold into a restricted sibling when the accused becomes staff', () => {
    const normal = file(R1, ACCUSED);
    const sibling = file(R2, ACCUSED, 'unsafe');
    const m = say(normal, '100001');
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ACCUSED);
      expect(restrictOpenTicketAbout(db, ACCUSED, [ADMIN])).toBe('folded');
    })();
    expect(messageById(db, m.id)!.ticket_id).toBe(sibling);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('a player merge rewrites the author and the remover, and folds the tickets under the messages', () => {
    const main = file(R1, ACCUSED);
    const alt = file(R2, ALT);
    const m = say(alt, '100001', 'hello', R2);
    db.prepare("UPDATE ticket_messages SET removed_by = ?, removed_at = '2026-09-22T12:00:00.000Z' WHERE id = ?").run(R2, m.id);
    mergePlayers(db, { from: ALT, into: ACCUSED, by: ADMIN, adminSteamIds: [ADMIN] });
    expect(messageById(db, m.id)!.ticket_id).toBe(main);
    mergePlayers(db, { from: R2, into: R1, by: ADMIN, adminSteamIds: [ADMIN] });
    expect(messageById(db, m.id)).toMatchObject({ author_player_id: R1, removed_by: R1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('settings and config', () => {
  it('seeds the four attachment settings with the exact defaults', () => {
    expect(getSetting(db, 'ticket_store_attachments')).toBe('1');
    expect(getSetting(db, 'ticket_attachment_max_mb')).toBe('25');
    expect(getSetting(db, 'ticket_attachments_ticket_mb')).toBe('200');
    expect(getSetting(db, 'ticket_attachments_total_mb')).toBe('2048');
  });

  it('keeps attachments beside the database unless told otherwise', () => {
    expect(loadConfig({ DB_PATH: '/srv/pug/data/pug.db' }).ticketAttachmentsDir).toBe('/srv/pug/data/ticket-attachments');
    expect(loadConfig({ DB_PATH: '/srv/pug/data/pug.db', TICKET_ATTACHMENTS_DIR: '/mnt/files' }).ticketAttachmentsDir).toBe('/mnt/files');
  });
});
