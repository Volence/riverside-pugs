import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { closeTicket, reopenTicket, setRestricted } from '../src/tickets/actions.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { forbiddenForumThreads, forumAudience, staffThread, surfaceFor } from '../src/tickets/threads.js';
import { getTicketRow } from '../src/tickets/store.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000031${i}`);
const [R1, R2, , , , STAFFER, MOD, ADMIN] = IDS;
const D = (id: string) => `91${IDS.indexOf(id)}`;
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let events: AdminEvent[];
let off: () => void;

beforeEach(async () => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `91${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, STAFFER);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
  await sync.idle();
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { sync.stop(); off(); });

const access = () => [...(t.channelAccess.get('forum1') ?? [])].sort();
const file = (target: string, category = 'toxicity', by = R1) =>
  (fileReport(db, by, { targetId: target, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;

describe('a ticket about a member of staff in Discord', () => {
  it('starts with the whole staff forum, the accused included', () => {
    expect(access()).toEqual([D(STAFFER), D(MOD), D(ADMIN)].sort());
  });

  it('gets a forum post, made only after the accused is out of the forum', async () => {
    const create = t.threads.createForumPost;
    let atCreate: string[] | null = null;
    t.threads.createForumPost = async (forumId, p) => { atCreate = access(); return create(forumId, p); };
    const id = file(STAFFER);
    await sync.idle();
    t.threads.createForumPost = create;
    expect(staffThread(db, id)).toMatchObject({ surface: 'forum' });
    expect(atCreate).toEqual([D(MOD), D(ADMIN)].sort());
    expect(access()).toEqual([D(MOD), D(ADMIN)].sort());
    await sync.reconcile();
    expect(access()).toEqual([D(MOD), D(ADMIN)].sort());
  });

  it('makes no post while Discord will not take the accused out, and says so without naming anyone', async () => {
    t.accessRemovalsRefused.add(D(STAFFER));
    const id = file(STAFFER);
    await sync.idle();
    expect(staffThread(db, id)).toBeUndefined();
    expect(t.threadsIn('forum1')).toEqual([]);
    const problems = events.filter((e) => e.kind === 'problem').map((e) => (e as { text: string }).text);
    expect(problems.length).toBeGreaterThan(0);
    for (const p of problems) {
      expect(p).not.toContain(STAFFER);
      expect(p).not.toContain(D(STAFFER));
      expect(p).not.toContain('player5');
    }
    t.accessRemovalsRefused.clear();
    await sync.reconcile();
    expect(staffThread(db, id)).toMatchObject({ surface: 'forum' });
    expect(access()).not.toContain(D(STAFFER));
  });

  it('deletes the post when the ticket closes, and lets the accused back in on the next full pass', async () => {
    const id = file(STAFFER);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    closeTicket(db, id, MOD, 'warned', '');
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    await sync.reconcile();
    expect(access()).toContain(D(STAFFER));
  });

  it('a reopen takes the accused out again before a new post is made', async () => {
    const id = file(STAFFER);
    await sync.idle();
    closeTicket(db, id, MOD, 'warned', '');
    await sync.idle();
    await sync.reconcile();
    expect(access()).toContain(D(STAFFER));
    expect(reopenTicket(db, id, MOD).ok).toBe(true);
    await sync.idle();
    const now = staffThread(db, id)!;
    expect(now.surface).toBe('forum');
    expect(t.threadsById.get(now.thread_id)!.deleted).toBe(false);
    expect(access()).not.toContain(D(STAFFER));
  });

  it('promotion mid-case: the open post stays, a closed one goes, and the new moderator waits outside', async () => {
    const closed = file(R2, 'griefing');
    await sync.idle();
    closeTicket(db, closed, MOD, 'no_action', '');
    await sync.idle();
    const open = file(R2, 'cheating', R1);
    await sync.idle();
    const closedPost = db.prepare('SELECT thread_id FROM ticket_threads WHERE ticket_id = ?').get(closed) as { thread_id: string };
    const openPost = staffThread(db, open)!.thread_id;
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(R2);
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(closedPost.thread_id)!.deleted).toBe(true);
    expect(t.threadsById.get(openPost)!.deleted).toBe(false);
    expect(access()).not.toContain(D(R2));
  });

  it('un-restricting a ticket about staff posts it to the forum with the accused kept out', async () => {
    const id = file(STAFFER);
    setRestricted(db, id, ADMIN, true, [ADMIN]);
    await sync.idle();
    expect(t.threadsIn('forum1').filter((th) => !th.deleted)).toEqual([]);
    setRestricted(db, id, ADMIN, false, [ADMIN]);
    await sync.idle();
    expect(staffThread(db, id)).toMatchObject({ surface: 'forum' });
    expect(access()).not.toContain(D(STAFFER));
  });

  it('a merge or relink that hands the subject a forum overwrite loses it at once, before step 5', async () => {
    // An open ordinary ticket, with its post already up, about someone who is
    // not yet staff.
    const id = file(R2);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    // They become staff (a merge into a staff main, or a Discord relink) and
    // the fake stands in for Discord already holding the overwrite: the post
    // existed before this happened, so keepSubjectOut (which only runs at
    // post creation) never ran for it.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(R2);
    t.channelAccess.get('forum1')!.add(D(R2));
    const order: string[] = [];
    const syncMemberAccess = t.threads.syncMemberAccess;
    t.threads.syncMemberAccess = async (channelId, ids, opts) => {
      order.push('revoke');
      return syncMemberAccess(channelId, ids, opts);
    };
    const exists = t.threads.exists;
    t.threads.exists = async (tid) => {
      if (tid === threadId) order.push('ticket-call');
      return exists(tid);
    };
    try {
      await sync.reconcile();
    } finally {
      t.threads.syncMemberAccess = syncMemberAccess;
      t.threads.exists = exists;
    }
    expect(access()).not.toContain(D(R2));
    expect(order).toContain('revoke');
    expect(order).toContain('ticket-call');
    expect(order.indexOf('revoke')).toBeLessThan(order.indexOf('ticket-call'));
  });
});

describe('the rules as functions', () => {
  it('surfaceFor sends a ticket about staff to the forum', () => {
    const id = file(STAFFER);
    expect(surfaceFor(db, getTicketRow(db, id)!)).toEqual({ surface: 'forum', why: 'ok' });
  });

  it('forumAudience leaves out whoever an open ordinary ticket is about, post or no post', () => {
    setSetting(db, 'discord_tickets_forum_id', '');
    const id = file(STAFFER);
    expect(forumAudience(db)).not.toContain(D(STAFFER));
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(id);
    expect(forumAudience(db)).toContain(D(STAFFER));
    // A restricted one has no post and never will: it keeps nobody out.
    file(STAFFER, 'unsafe');
    expect(forumAudience(db)).toContain(D(STAFFER));
  });

  it('forbiddenForumThreads lists a closed ticket\'s post about staff, and never an open one\'s', async () => {
    const id = file(STAFFER);
    await sync.idle();
    expect(forbiddenForumThreads(db)).toEqual([]);
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(id);
    expect(forbiddenForumThreads(db).map((th) => th.ticket_id)).toEqual([id]);
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(STAFFER);
    expect(forbiddenForumThreads(db)).toEqual([]);
  });
});
