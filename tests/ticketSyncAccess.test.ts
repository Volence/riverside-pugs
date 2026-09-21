import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { publishBanChange } from '../src/banEvents.js';
import { staffThread } from '../src/tickets/threads.js';
import { ticketDetail } from '../src/tickets/views.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MOD = IDS[6];
const ADMIN = IDS[7];
let db: DB;
let t: FakeTransport;
let sync: TicketSync;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    if (i !== 4) linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, IDS[4]);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
});
afterEach(() => sync.stop());

const access = () => [...(t.channelAccess.get('forum1') ?? [])].sort();

describe('forum access', () => {
  it('on start: every linked, active moderator and admin, and nobody else', async () => {
    sync.start();
    await sync.idle();
    // IDS[4] is a moderator with no Discord linked.
    expect(access()).toEqual(['906', '907']);
  });

  it('follows a flag change, a link, an unlink and a ban', async () => {
    sync.start();
    await sync.idle();
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[1]);
    publishTicketSignal({ kind: 'staff' });
    linkDiscord(db, IDS[4], '904', 'd4');
    await sync.idle();
    expect(access()).toEqual(['901', '904', '906', '907']);
    unlinkDiscord(db, IDS[1]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(MOD);
    publishBanChange({ kind: 'ban', steamid: MOD, reason: 'x' });
    await sync.idle();
    expect(access()).toEqual(['904', '907']);
  });

  it('keeps a new member of staff out until every post about them is really gone', async () => {
    sync.start();
    const id = (fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: '' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    // Two promotions in one signal: the accused of a forum post that is still
    // standing, and somebody with no post about them. The exact set is then
    // the proof, since it only holds if the access sync really ran.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(IDS[5], IDS[1]);
    // Discord refuses the deletion twice: once in the sweep, once for the ticket.
    t.failThreadOps = 2;
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(false);
    expect(access()).toEqual(['901', '906', '907']);
    await sync.reconcile();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(access()).toEqual(['901', '905', '906', '907']);
  });

  it('says so in the admin feed when someone who should lose the forum keeps it', async () => {
    const events: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => events.push(e));
    try {
      sync.start();
      await sync.idle();
      expect(access()).toEqual(['906', '907']);
      // Discord refuses to delete that overwrite: the demoted moderator can
      // still read the forum, which is the half of this the feed must hear.
      t.accessRemovalsRefused.add('906');
      db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(MOD);
      publishTicketSignal({ kind: 'staff' });
      await sync.idle();
      expect(access()).toEqual(['906', '907']);
      const problems = events.filter((e) => e.kind === 'problem').map((e) => (e as { text: string }).text);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/can still read it: Discord refused/);
      expect(problems[0]).not.toContain('906');
    } finally {
      off();
    }
  });

  it('goes on revoking while the orphan sweep keeps failing, but grants nobody', async () => {
    const events: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => events.push(e));
    // Overwrites Discord has been holding since before this process started.
    t.channelAccess.set('forum1', new Set(['906', '907']));
    const list = t.threads.listThreads;
    // The bot cannot read the forum's own posts, so it can never rule out a
    // post with no ticket behind it.
    t.threads.listThreads = async () => { throw new Error('Missing Access'); };
    try {
      sync.start();
      await sync.idle();
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[1]);
      publishTicketSignal({ kind: 'staff' });
      await sync.idle();
      // Nobody new is let in, because a post about them may be standing there.
      expect(access()).toEqual(['906', '907']);
      // Somebody who should lose the forum still loses it, every pass.
      db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(MOD);
      await sync.reconcile();
      expect(access()).toEqual(['907']);
      const problems = events.filter((e) => e.kind === 'problem').map((e) => (e as { text: string }).text);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/Could not list the posts in the tickets forum/);
      expect(problems[0]).toMatch(/Read Message History/);
      expect(problems[0]).not.toMatch(/90\d|player\d/);
      // And once Discord answers, the promotion takes effect on the next pass.
      t.threads.listThreads = list;
      await sync.reconcile();
      expect(access()).toEqual(['901', '907']);
    } finally {
      t.threads.listThreads = list;
      off();
    }
  });

  it('touches nothing while the forum is not configured', async () => {
    setSetting(db, 'discord_tickets_forum_id', '');
    sync.start();
    await sync.idle();
    expect(t.channelAccess.size).toBe(0);
  });
});

describe('what the ticket page is told about the discussion', () => {
  const file = (targetId: string, category = 'griefing') =>
    (fileReport(db, IDS[0], { targetId, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;

  it('ready with a link, pending, unconfigured, and about staff', async () => {
    const id = file(IDS[5]);
    expect(ticketDetail(db, id, MOD, { guildId: 'g1' })!.discussion).toEqual({ state: 'pending', surface: 'forum', url: null });
    sync.start();
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    expect(ticketDetail(db, id, MOD, { guildId: 'g1' })!.discussion).toEqual({ state: 'ready', surface: 'forum', url: `https://discord.com/channels/g1/${threadId}` });
    expect(ticketDetail(db, id, MOD)!.discussion.url).toBeNull();

    const restricted = file(IDS[3], 'unsafe');
    expect(ticketDetail(db, restricted, ADMIN, { guildId: 'g1' })!.discussion).toEqual({ state: 'unconfigured', surface: null, url: null });

    setSetting(db, 'discord_tickets_forum_id', '');
    const other = file(IDS[2]);
    expect(ticketDetail(db, other, MOD)!.discussion.state).toBe('unconfigured');
  });
});
