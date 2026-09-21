import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { setRestricted } from '../src/tickets/actions.js';
import { restrictOpenTicketAbout } from '../src/tickets/store.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = IDS[7];
let db: DB;
let t: FakeTransport;
let feed: AdminFeedPoster;
let sync: TicketSync;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_admin_channel_id', 'admins');
  t = new FakeTransport();
  feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
  feed.start();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
});
afterEach(() => { sync.stop(); feed.stop(); });

/** The reconciler publishes, then the poster delivers: wait for both, in that order. */
const settled = async () => { await sync.idle(); await feed.idle(); };
const inFeed = () => t.live().filter((m) => m.channelId === 'admins');
const text = (i: number) => JSON.stringify(inFeed()[i]?.payload);

describe('a report held from the feed by its history', () => {
  it('T1: a report filed on a restricted ticket is never announced, even after the ticket becomes normal', async () => {
    const a = fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'threat' }, { adminSteamIds: [] }) as { ticketId: number };
    await settled();
    expect(inFeed()).toEqual([]);
    // Bypassing setRestricted(false), which a safety report keeps blocked:
    // the point is what the feed does once the ticket IS normal, however
    // that came to be.
    db.prepare('UPDATE tickets SET restricted = 0 WHERE id = ?').run(a.ticketId);
    await sync.reconcile();
    await feed.idle();
    expect(inFeed()).toEqual([]);
    const row = db.prepare('SELECT announced_at, feed_held FROM ticket_reports WHERE ticket_id = ?').get(a.ticketId) as
      { announced_at: string | null; feed_held: number };
    expect(row.announced_at).not.toBeNull();
    expect(row.feed_held).toBe(1);
  });

  it('T2: a report pending while a normal ticket passes through being restricted is never announced', async () => {
    const a = fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: '' }, { adminSteamIds: [ADMIN] }) as { ticketId: number };
    await settled();
    expect(inFeed()).toHaveLength(1);
    sync.stop();
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'cheating', text: '' }, { adminSteamIds: [ADMIN] });
    expect(setRestricted(db, a.ticketId, ADMIN, true, [ADMIN]).ok).toBe(true);
    expect(setRestricted(db, a.ticketId, ADMIN, false, [ADMIN]).ok).toBe(true);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toHaveLength(1);
  });

  it('T3: promoting the accused then demoting and un-restricting never announces a report pending across it', async () => {
    sync.stop();
    fileReport(db, IDS[1], { targetId: IDS[3], category: 'afk', text: '' }, { adminSteamIds: [ADMIN] });
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[3]);
      expect(restrictOpenTicketAbout(db, IDS[3], [ADMIN])).toBe('restricted');
    })();
    const id = (db.prepare("SELECT id FROM tickets WHERE target_id = ?").get(IDS[3]) as { id: number }).id;
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(IDS[3]);
    expect(setRestricted(db, id, ADMIN, false, [ADMIN]).ok).toBe(true);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toEqual([]);
  });

  it('T4: a report filed on a restricted ticket with no bot running is never announced, even un-restricted before the bot returns', async () => {
    sync.stop();
    const a = fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'threat' }, { adminSteamIds: [] }) as { ticketId: number };
    db.prepare('UPDATE tickets SET restricted = 0 WHERE id = ?').run(a.ticketId);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toEqual([]);
  });

  it('T5: a held report and a later one filed after the ticket turns normal: only the later is announced, as a new ticket', async () => {
    sync.stop();
    const a = fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'threat' }, { adminSteamIds: [] }) as { ticketId: number };
    db.prepare('UPDATE tickets SET restricted = 0 WHERE id = ?').run(a.ticketId);
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'griefing', text: '' }, { adminSteamIds: [] });
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toHaveLength(1);
    expect(text(0)).toMatch(/new ticket/i);
    expect(text(0)).toContain('player5');
    expect(text(0)).not.toContain('player0');
    expect(text(0)).not.toContain('player1');
    expect(text(0)).not.toContain('threat');
  });

  it('T6: the backfill sets feed_held for a restricted ticket\'s reports, and running it again changes nothing', () => {
    const ticketId = Number(db.prepare(
      "INSERT INTO tickets (target_id, restricted, opened_by, created_at) VALUES (?, 1, NULL, datetime('now'))",
    ).run(IDS[5]).lastInsertRowid);
    const reportId = Number(db.prepare(
      "INSERT INTO ticket_reports (ticket_id, reporter_id, category, text, created_at, feed_held) VALUES (?, ?, 'griefing', '', datetime('now'), 0)",
    ).run(ticketId, IDS[0]).lastInsertRowid);
    const backfill = () => db.exec('UPDATE ticket_reports SET feed_held = 1 WHERE ticket_id IN (SELECT id FROM tickets WHERE restricted = 1)');
    const heldValue = () => (db.prepare('SELECT feed_held FROM ticket_reports WHERE id = ?').get(reportId) as { feed_held: number }).feed_held;
    backfill();
    expect(heldValue()).toBe(1);
    backfill();
    expect(heldValue()).toBe(1);
  });

  it('T7: a restricted ticket with the tickets channel configured still gets an another-report line in its thread for a held report', async () => {
    setSetting(db, 'discord_tickets_channel_id', 'chan1');
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'first' }, { adminSteamIds: [ADMIN] });
    await settled();
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'unsafe', text: 'second' }, { adminSteamIds: [ADMIN] });
    await settled();
    const [thread] = t.threadsIn('chan1');
    const inThread = t.live().filter((m) => m.channelId === thread.id);
    expect(inThread.some((m) => /another report/i.test(JSON.stringify(m.payload)))).toBe(true);
    expect(inFeed()).toEqual([]);
  });
});
