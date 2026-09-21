import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { claimTicket, closeTicket, reopenTicket } from '../src/tickets/actions.js';
import { staffThread, threadsInState } from '../src/tickets/threads.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MOD = IDS[6];
const ADMIN = IDS[7];
const deps = { adminSteamIds: [ADMIN] };
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let matchId: number;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { sync.stop(); off(); });

const file = (reporter: string, body: object) => (fileReport(db, reporter, body, deps) as { ticketId: number }).ticketId;
const cardOf = (threadId: string) => t.byId(threadId)!.payload;
const buttons = (threadId: string) => cardOf(threadId).components.flat().map((b) => (b.kind === 'button' ? `${b.customId}=${b.label}` : `link=${b.url}`));

describe('the staff forum post', () => {
  it('makes one post for a new ticket: titled, tagged, a case card, and nobody who reported it', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'griefing', text: 'kept killing us', matchId, moment: { ordinal: 2, half: 1, tMs: 61500 } });
    await sync.idle();
    const posts = t.threadsIn('forum1');
    expect(posts).toHaveLength(1);
    expect(posts[0].name).toBe(`#${id} player5 (griefing)`);
    expect(posts[0].tags).toEqual(['open', 'griefing']);
    const row = staffThread(db, id)!;
    expect(row).toMatchObject({ thread_id: posts[0].id, surface: 'forum', channel_id: 'forum1', card_message_id: posts[0].id, locked: 0 });
    const text = JSON.stringify(cardOf(row.thread_id));
    expect(text).toContain(`https://pug.test/admin?ticket=${id}`);
    expect(text).toContain('player5');
    expect(text).toContain(`https://pug.test/match/${matchId}?ordinal=2&half=1&t=61500`);
    expect(text).not.toContain('player0');
    expect(text).not.toContain('kept killing us');
    expect(buttons(row.thread_id)).toEqual([`t:${id}:claim=Claim`, `t:${id}:close=Close`, `link=https://pug.test/admin?ticket=${id}`]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE announced_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('a further report posts one line in the thread, which bumps it, and refreshes the card and tags', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'griefing', text: '' });
    await sync.idle();
    file(IDS[1], { targetId: IDS[5], category: 'cheating', text: 'walls', matchId });
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    expect(t.threadsIn('forum1')).toHaveLength(1);
    const inThread = t.live().filter((m) => m.channelId === threadId);
    expect(inThread).toHaveLength(2);
    expect(JSON.stringify(inThread[1].payload)).toMatch(/another report/i);
    expect(JSON.stringify(inThread[1].payload)).toContain('cheating');
    expect(JSON.stringify(inThread[1].payload)).not.toContain('player1');
    expect(JSON.stringify(inThread[1].payload)).not.toContain('walls');
    expect(JSON.stringify(cardOf(threadId))).toContain('2 from 2 people');
    expect(t.threadsById.get(threadId)!.tags).toEqual(['open', 'griefing', 'cheating']);
  });

  it('attempts nothing at all while the forum is not configured', async () => {
    setSetting(db, 'discord_tickets_forum_id', '');
    sync.start();
    file(IDS[0], { targetId: IDS[5], category: 'griefing', text: '' });
    await sync.idle();
    expect(t.threadsById.size).toBe(0);
    expect(t.sends).toBe(0);
  });

  it('a ticket filed before the bot was up gets its post when it starts', async () => {
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    sync.start();
    await sync.idle();
    expect(staffThread(db, id)).toBeTruthy();
  });

  it('a failure is reported once, and the next pass makes the post', async () => {
    sync.start();
    await sync.idle();
    t.failThreadOps = 1;
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    expect(staffThread(db, id)).toBeUndefined();
    const problems = events.filter((e) => e.kind === 'problem');
    expect(problems).toHaveLength(1);
    expect(JSON.stringify(problems[0])).not.toContain('player5');
    await sync.reconcile();
    expect(staffThread(db, id)).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_threads').get()).toEqual({ n: 1 });
  });

  it('a claim changes the card, the tag and the button', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    claimTicket(db, id, MOD, true);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    expect(t.threadsById.get(threadId)!.tags).toEqual(['claimed', 'afk']);
    expect(JSON.stringify(cardOf(threadId))).toContain('claimed by player6');
    expect(buttons(threadId)[0]).toBe(`t:${id}:claim=Release`);
  });

  it('a failed card edit is retried, never remembered as done', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    const before = staffThread(db, id)!.card_hash;
    t.failEdits = 1;
    claimTicket(db, id, MOD, true);
    await sync.idle();
    expect(staffThread(db, id)!.card_hash).toBe(before);
    await sync.reconcile();
    expect(staffThread(db, id)!.card_hash).not.toBe(before);
    expect(buttons(staffThread(db, id)!.thread_id)[0]).toBe(`t:${id}:claim=Release`);
  });

  it('closing refreshes the card and then locks and archives; reopening reverses it', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    closeTicket(db, id, MOD, 'warned', 'first time');
    await sync.idle();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: true, archived: true, tags: ['closed', 'afk'] });
    expect(JSON.stringify(cardOf(threadId))).toContain('closed: warned');
    expect(JSON.stringify(cardOf(threadId))).not.toContain('first time');
    expect(buttons(threadId)).toEqual([`link=https://pug.test/admin?ticket=${id}`]);
    expect(staffThread(db, id)!.locked).toBe(1);
    // A closed and locked ticket costs nothing on later passes.
    const edits = t.edits;
    await sync.reconcile();
    expect(t.edits).toBe(edits);

    reopenTicket(db, id, MOD);
    await sync.idle();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: false, archived: false, tags: ['open', 'afk'] });
    expect(buttons(threadId)[0]).toBe(`t:${id}:claim=Claim`);
  });

  it('a post deleted by hand is made again', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    const first = staffThread(db, id)!.thread_id;
    await t.threads.deleteThread(first);
    await sync.reconcile();
    const second = staffThread(db, id)!.thread_id;
    expect(second).not.toBe(first);
    expect(threadsInState(db, 'deleted').map((r) => r.thread_id)).toEqual([first]);
  });
});
