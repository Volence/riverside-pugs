import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { getSetting } from '../src/settings.js';
import { ensureTicketSchema } from '../src/tickets/schema.js';
import { fileReport, openStaffTicket } from '../src/tickets/filing.js';
import { claimTicket, closeTicket } from '../src/tickets/actions.js';
import { foldTicket } from '../src/tickets/store.js';
import { forbiddenForumThreads, insertThread, staffThread, threadByDiscordId, threadsInState } from '../src/tickets/threads.js';
import { subscribeTicketSignals, type TicketSignal } from '../src/tickets/signals.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 7 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, ACCUSED, ALT, MOD, ADMIN, OWNER] = IDS;
const deps = { adminSteamIds: [OWNER] };
let db: DB;
let signals: TicketSignal[];
let off: () => void;

const seed = (d: DB) => {
  for (const id of IDS) {
    upsertPlayer(d, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(d, id);
  }
  d.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  d.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
};
const file = (reporter: string, targetId: string, category = 'griefing') =>
  (fileReport(db, reporter, { targetId, category, text: 'x' }, deps) as { ticketId: number }).ticketId;
const thread = (ticketId: number, threadId: string, surface: 'forum' | 'private' = 'forum') =>
  insertThread(db, { ticketId, kind: 'staff', surface, channelId: surface === 'forum' ? 'forum1' : 'chan1', threadId, cardMessageId: threadId, cardHash: 'h' });

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  signals = [];
  off = subscribeTicketSignals((s) => signals.push(s));
});
afterEach(() => off());

describe('schema and settings', () => {
  it('is idempotent, keeps thread ids unique, and seeds both channel ids empty', () => {
    expect(() => ensureTicketSchema(db)).not.toThrow();
    const id = file(R1, ACCUSED);
    thread(id, '9001');
    expect(() => thread(id, '9001')).toThrow(/UNIQUE/);
    expect(getSetting(db, 'discord_tickets_forum_id')).toBe('');
    expect(getSetting(db, 'discord_tickets_channel_id')).toBe('');
    expect(threadByDiscordId(db, '9001')).toMatchObject({ ticket_id: id, kind: 'staff', surface: 'forum', state: 'open', locked: 0 });
  });

  it('marks every report that predates the column as already announced, and no later one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pug-threads-'));
    try {
      const path = join(dir, 'pug.db');
      let fileDb = openDb(path);
      seed(fileDb);
      fileReport(fileDb, R1, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
      fileDb.exec('ALTER TABLE ticket_reports DROP COLUMN announced_at');
      fileDb.close();

      fileDb = openDb(path);
      const old = fileDb.prepare('SELECT announced_at, created_at FROM ticket_reports').get() as { announced_at: string | null; created_at: string };
      expect(old.announced_at).toBe(old.created_at);
      fileReport(fileDb, R2, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
      fileDb.close();

      fileDb = openDb(path);
      expect(fileDb.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE announced_at IS NULL').get()).toEqual({ n: 1 });
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('signals', () => {
  it('says which ticket changed, after the commit, for normal and restricted tickets alike', () => {
    const a = file(R1, ACCUSED);
    const b = file(R1, ACCUSED, 'unsafe');
    expect(signals).toEqual([{ kind: 'ticket', ticketId: a }, { kind: 'ticket', ticketId: b }]);
    signals.length = 0;
    expect(claimTicket(db, a, MOD, true).ok).toBe(true);
    expect(claimTicket(db, b, MOD, true).ok).toBe(false);
    expect(closeTicket(db, a, MOD, 'warned', '').ok).toBe(true);
    const opened = openStaffTicket(db, MOD, { targetId: ALT, note: 'seen in voice' }, deps) as { auditId: number };
    expect(signals).toEqual([
      { kind: 'ticket', ticketId: a }, { kind: 'ticket', ticketId: a }, { kind: 'ticket', ticketId: opened.auditId },
    ]);
  });

  it('says the staff changed on a Discord link or unlink and on a merge', () => {
    expect(linkDiscord(db, MOD, '904', 'mod').ok).toBe(true);
    unlinkDiscord(db, MOD);
    mergePlayers(db, { from: ALT, into: ACCUSED, by: ADMIN, adminSteamIds: [OWNER] });
    expect(signals).toEqual([{ kind: 'staff' }, { kind: 'staff' }, { kind: 'staff' }]);
  });
});

describe('signals from the admin routes', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('a flag change says the staff changed', async () => {
    app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = authedCookie(app, db, OWNER);
    signals.length = 0;
    await app.inject({ method: 'POST', url: `/api/admin/players/${R1}/mod`, cookies, payload: { isMod: true } });
    await app.inject({ method: 'POST', url: `/api/admin/players/${R2}/admin`, cookies, payload: { isAdmin: true } });
    expect(signals).toEqual([{ kind: 'staff' }, { kind: 'staff' }]);
  });
});

describe('threads follow a fold', () => {
  it('the emptied ticket\'s thread is marked folded when the survivor has one of its own', () => {
    const keep = file(R1, ACCUSED);
    const gone = file(R2, ALT);
    thread(keep, '9001');
    thread(gone, '9002');
    db.transaction(() => foldTicket(db, gone, keep, 'merge'))();
    expect(staffThread(db, keep)?.thread_id).toBe('9001');
    expect(threadsInState(db, 'folded').map((t) => [t.ticket_id, t.thread_id])).toEqual([[keep, '9002']]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('and simply becomes the survivor\'s thread when the survivor has none', () => {
    const keep = file(R1, ACCUSED);
    const gone = file(R2, ALT);
    thread(gone, '9002');
    db.transaction(() => foldTicket(db, gone, keep, 'merge'))();
    expect(staffThread(db, keep)?.thread_id).toBe('9002');
    expect(threadsInState(db, 'folded')).toEqual([]);
  });
});

describe('forum posts that must not exist', () => {
  it('lists the forum thread of a restricted ticket and of a ticket about staff, open or closed, and nothing else', () => {
    const normal = file(R1, ACCUSED);
    const aboutStaff = file(R1, ALT);
    // About someone else: tickets_one_open would refuse a second open
    // restricted ticket about ACCUSED once the normal one is restricted below.
    const restricted = file(R2, R1, 'unsafe');
    thread(normal, '9001');
    thread(aboutStaff, '9002');
    thread(restricted, '9003', 'private');
    expect(forbiddenForumThreads(db)).toEqual([]);
    // ALT is promoted after the post went up, and the ticket was closed.
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(aboutStaff);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ALT);
    // The normal ticket is restricted by hand.
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(normal);
    expect(forbiddenForumThreads(db).map((t) => t.thread_id).sort()).toEqual(['9001', '9002']);
    expect(forbiddenForumThreads(db, normal).map((t) => t.thread_id)).toEqual(['9001']);
  });
});
