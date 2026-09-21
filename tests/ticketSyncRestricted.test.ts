import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, closeTicket, setRestricted } from '../src/tickets/actions.js';
import { foldTicket, restrictOpenTicketAbout } from '../src/tickets/store.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { publishBanChange } from '../src/banEvents.js';
import { staffThread, threadByDiscordId } from '../src/tickets/threads.js';
import { mergePlayers } from '../src/mergePlayers.js';
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
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { sync.stop(); off(); });

const file = (reporter: string, targetId: string, category = 'griefing') =>
  (fileReport(db, reporter, { targetId, category, text: 'details' }, deps) as { ticketId: number }).ticketId;
const members = async (threadId: string) => ((await t.threads.memberIds(threadId)) ?? []).sort();

describe('a restricted ticket in Discord', () => {
  it('gets a private thread whose members are its access list, one DM each, and nothing in the forum', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.threadsIn('forum1')).toEqual([]);
    const [thread] = t.threadsIn('chan1');
    expect(thread).toMatchObject({ surface: 'private', name: `Ticket #${id}` });
    expect(await members(thread.id)).toEqual(['907']);
    const inThread = t.live().filter((m) => m.channelId === thread.id);
    expect(inThread).toHaveLength(1);
    expect(JSON.stringify(inThread[0].payload)).toContain('Discord Administrator permission');
    expect(staffThread(db, id)).toMatchObject({ surface: 'private', channel_id: 'chan1', card_message_id: inThread[0].id });
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
    expect(JSON.stringify(t.dms[0].payload)).toContain(`https://pug.test/admin?ticket=${id}`);
    expect(JSON.stringify(t.dms[0].payload)).not.toContain('player5');
    expect(events).toEqual([]);
  });

  it('giving access adds the person to the thread and DMs them, once', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(addAccess(db, id, ADMIN, MOD).ok).toBe(true);
    await sync.idle();
    expect(await members(staffThread(db, id)!.thread_id)).toEqual(['906', '907']);
    expect(t.dms.map((d) => d.userId)).toEqual(['907', '906']);
    await sync.reconcile();
    expect(t.dms).toHaveLength(2);
  });

  it('someone who is no longer on the list, or no longer linked, is taken out of the thread', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    // A stranger added by hand in Discord goes too: the list is the membership.
    await t.threads.addMember(threadId, '555');
    unlinkDiscord(db, MOD);
    await sync.idle();
    expect(await members(threadId)).toEqual(['907']);
  });

  it('a removeMember Discord refuses is warned about, not thrown, so the rest of the ticket still syncs', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    // Raw SQL, not unlinkDiscord/claimTicket: those publish their own
    // signals, and this test wants exactly one controlled pass.
    db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(MOD);
    db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(ADMIN, id);
    // Three removals are attempted in one pass: the sweep at the top of it,
    // this ticket's own sweep, and syncMembers. All three are refused.
    t.failThreadOps = 3;
    await sync.reconcile();
    // The removal failed, but the card still picked up the claim: syncMembers
    // throwing did not abandon the rest of this ticket's pass.
    const cardId = staffThread(db, id)!.card_message_id!;
    expect(JSON.stringify(t.byId(cardId)!.payload)).toContain('claimed by');
    expect(await members(threadId)).toEqual(['906', '907']);
    t.failThreadOps = 0;
    await sync.reconcile();
    expect(await members(threadId)).toEqual(['907']);
  });

  it('a refused DM is dropped silently and never sent again', async () => {
    t.dmsClosed.add('907');
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.dms).toEqual([]);
    expect((db.prepare('SELECT notified_at FROM ticket_access WHERE ticket_id = ?').get(id) as { notified_at: string | null }).notified_at).not.toBeNull();
    t.dmsClosed.clear();
    await sync.reconcile();
    expect(t.dms).toEqual([]);
    expect(events).toEqual([]);
  });

  it('with no tickets channel there is no thread, and the access list is still told', async () => {
    setSetting(db, 'discord_tickets_channel_id', '');
    file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.threadsById.size).toBe(0);
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
  });
});

describe('forum posts that must not exist', () => {
  it('restricting by hand deletes the forum post and opens a private thread', async () => {
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    expect(setRestricted(db, id, MOD, true, [ADMIN]).ok).toBe(true);
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(threadByDiscordId(db, post)!.state).toBe('deleted');
    const now = staffThread(db, id)!;
    expect(now.surface).toBe('private');
    expect(await members(now.thread_id)).toEqual(['906', '907']);
  });

  it('lifting the restriction ends the private thread and posts to the forum', async () => {
    const id = file(IDS[0], IDS[5]);
    setRestricted(db, id, MOD, true, [ADMIN]);
    await sync.idle();
    const priv = staffThread(db, id)!.thread_id;
    expect(setRestricted(db, id, MOD, false, [ADMIN]).ok).toBe(true);
    await sync.idle();
    expect(t.threadsById.get(priv)).toMatchObject({ locked: true, archived: true, deleted: false });
    expect(threadByDiscordId(db, priv)!.state).toBe('ended');
    expect(staffThread(db, id)!.surface).toBe('forum');
    expect(t.threadsIn('forum1')).toHaveLength(1);
  });

  it('blanking a channel setting ends nothing: the thread that exists is kept', async () => {
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    setSetting(db, 'discord_tickets_forum_id', '');
    await sync.reconcile();
    expect(threadByDiscordId(db, post)!.state).toBe('open');
    expect(t.threadsById.get(post)).toMatchObject({ locked: false, archived: false, deleted: false });
    expect(t.live().filter((m) => m.channelId === post)).toHaveLength(1);
  });

  it('making the accused staff deletes every forum post about them, closed tickets included', async () => {
    const closed = file(IDS[0], IDS[5]);
    await sync.idle();
    closeTicket(db, closed, MOD, 'no_action', '');
    await sync.idle();
    const open = file(IDS[0], IDS[5], 'cheating');
    await sync.idle();
    const posts = [staffThread(db, closed)!.thread_id, staffThread(db, open)!.thread_id];
    // What POST /api/admin/players/:id/mod does.
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[5]);
      restrictOpenTicketAbout(db, IDS[5], [ADMIN]);
    })();
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(posts.map((p) => t.threadsById.get(p)!.deleted)).toEqual([true, true]);
    expect(t.threadsIn('forum1')).toEqual([]);
    expect(staffThread(db, open)!.surface).toBe('private');
    expect(staffThread(db, closed)).toBeUndefined();
  });

  it('a normal ticket about staff that could not be restricted has no Discord thread at all', async () => {
    // Nobody to give it to: the only admin is the accused.
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    db.prepare('UPDATE players SET is_admin = 0 WHERE steamid = ?').run(ADMIN);
    db.transaction(() => {
      db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(IDS[5]);
      expect(restrictOpenTicketAbout(db, IDS[5], [])).toBe('nobody');
    })();
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(staffThread(db, id)).toBeUndefined();
    expect(t.threadsIn('forum1')).toEqual([]);
    expect(t.threadsIn('chan1')).toEqual([]);
  });
});

describe('two tickets folded into one', () => {
  it('the survivor keeps its post and says where the other was; the other is locked and archived', async () => {
    const keep = file(IDS[0], IDS[5]);
    const gone = file(IDS[1], IDS[4], 'cheating');
    await sync.idle();
    const keepThread = staffThread(db, keep)!.thread_id;
    const goneThread = staffThread(db, gone)!.thread_id;
    mergePlayers(db, { from: IDS[4], into: IDS[5], by: ADMIN, adminSteamIds: [ADMIN] });
    await sync.idle();
    expect(staffThread(db, keep)!.thread_id).toBe(keepThread);
    expect(threadByDiscordId(db, goneThread)).toMatchObject({ ticket_id: keep, state: 'ended', locked: 1 });
    expect(t.threadsById.get(goneThread)).toMatchObject({ locked: true, archived: true, deleted: false });
    const said = t.live().filter((m) => m.channelId === keepThread).map((m) => JSON.stringify(m.payload)).join('\n');
    expect(said).toContain(`<#${goneThread}>`);
    expect(JSON.stringify(t.byId(keepThread)!.payload)).toContain('2 from 2 people');
    await sync.reconcile();
    expect(t.live().filter((m) => m.channelId === keepThread && JSON.stringify(m.payload).includes(`<#${goneThread}>`))).toHaveLength(1);
  });
});

describe('retireFolded and a closed, locked survivor', () => {
  it('unarchives to send the fold line, then restores the closed lock', async () => {
    const keep = file(IDS[0], IDS[5]);
    const gone = file(IDS[1], IDS[4], 'cheating');
    await sync.idle();
    const keepThread = staffThread(db, keep)!.thread_id;
    const goneThread = staffThread(db, gone)!.thread_id;
    closeTicket(db, keep, MOD, 'no_action', '');
    await sync.idle();
    expect(t.threadsById.get(keepThread)).toMatchObject({ locked: true, archived: true });
    // foldTicket marks the gone thread 'folded' onto keep: keepHasThread
    // only checks the thread row's own state ('open', unaffected by the
    // ticket's own closedness), so a fold can land on an already-closed
    // survivor whenever a previous pass raced ahead of this one.
    foldTicket(db, gone, keep, 'drop');
    await sync.reconcile();
    const said = t.live().filter((m) => m.channelId === keepThread).map((m) => JSON.stringify(m.payload)).join('\n');
    expect(said).toContain(`<#${goneThread}>`);
    expect(t.threadsById.get(keepThread)).toMatchObject({ locked: true, archived: true, deleted: false });
    expect(threadByDiscordId(db, goneThread)).toMatchObject({ state: 'ended', locked: 1 });
    expect(t.threadsById.get(goneThread)).toMatchObject({ locked: true, archived: true, deleted: false });
  });

  it('one folded thread failing does not stop another in the same pass', async () => {
    const keep = file(IDS[0], IDS[5]);
    const goneA = file(IDS[1], IDS[4], 'cheating');
    const goneB = file(IDS[2], IDS[3], 'toxicity');
    await sync.idle();
    const keepThread = staffThread(db, keep)!.thread_id;
    const goneAThread = staffThread(db, goneA)!.thread_id;
    const goneBThread = staffThread(db, goneB)!.thread_id;
    // keep is closed and locked, so it is left out of the per-ticket half of
    // a pass: only the once-per-reconcile stage below ever touches these,
    // which is what makes one failure here actually able to strand the other.
    closeTicket(db, keep, MOD, 'no_action', '');
    await sync.idle();
    foldTicket(db, goneA, keep, 'drop');
    foldTicket(db, goneB, keep, 'drop');
    // goneA is processed first (lower id): make its very first Discord call
    // throw, and confirm goneB still gets the full treatment.
    t.failThreadOps = 1;
    await sync.reconcile();
    expect(threadByDiscordId(db, goneAThread)!.state).toBe('folded');
    expect(threadByDiscordId(db, goneBThread)).toMatchObject({ state: 'ended', locked: 1 });
    expect(t.threadsById.get(goneBThread)).toMatchObject({ locked: true, archived: true, deleted: false });
    const said = t.live().filter((m) => m.channelId === keepThread).map((m) => JSON.stringify(m.payload)).join('\n');
    expect(said).toContain(`<#${goneBThread}>`);
    // The next pass finishes what the failure left behind.
    await sync.reconcile();
    expect(threadByDiscordId(db, goneAThread)!.state).toBe('ended');
  });
});

describe('a fold that lands a forum thread on a restricted ticket', () => {
  it('deletes the forum post instead of retiring it, and never mentions it anywhere', async () => {
    const normal = file(IDS[0], IDS[5], 'griefing');
    const restricted = file(IDS[1], IDS[5], 'unsafe');
    await sync.idle();
    const forumThread = staffThread(db, normal)!.thread_id;
    db.transaction(() => { expect(restrictOpenTicketAbout(db, IDS[5], [ADMIN])).toBe('folded'); })();
    await sync.reconcile();
    expect(threadByDiscordId(db, forumThread)!.state).toBe('deleted');
    expect(t.threadsIn('forum1')).toEqual([]);
    expect(t.threadsById.get(forumThread)!.deleted).toBe(true);
    // Rule 2 wins outright over rule 3 here: a forbidden forum thread simply
    // vanishes, with no "folded into this one, see <#...>" announcement
    // anywhere (not even in the survivor's own private thread), because that
    // announcement would itself be the one thing about the restricted ticket
    // that must never surface.
    expect(t.messages.some((m) => JSON.stringify(m.payload).includes(`<#${forumThread}>`))).toBe(false);
    expect(staffThread(db, restricted)!.thread_id).not.toBe(forumThread);
  });
});

describe('a forbidden forum post that Discord refuses to delete', () => {
  it('stays open and undeleted until a later pass succeeds, never marked done early', async () => {
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    expect(setRestricted(db, id, MOD, true, [ADMIN]).ok).toBe(true);
    t.failThreadOps = 1;
    await sync.idle();
    expect(threadByDiscordId(db, post)).toMatchObject({ state: 'open', surface: 'forum' });
    expect(t.threadsById.get(post)!.deleted).toBe(false);
    await sync.reconcile();
    expect(threadByDiscordId(db, post)!.state).toBe('deleted');
    expect(t.threadsById.get(post)!.deleted).toBe(true);
  });
});

describe('blanking the tickets channel setting ends nothing, on the private side too', () => {
  it('leaves a live private thread unlocked and unarchived, with members and card still syncing', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    expect(await members(threadId)).toEqual(['906', '907']);
    setSetting(db, 'discord_tickets_channel_id', '');
    // A further report, so there is something new for the card and the
    // announce-a-report line to pick up on this pass.
    file(IDS[2], IDS[5], 'unsafe');
    await sync.reconcile();
    expect(threadByDiscordId(db, threadId)!.state).toBe('open');
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: false, archived: false, deleted: false });
    // No farewell, and no other message that was not already going to be
    // sent anyway (the further-report line).
    const said = t.live().filter((m) => m.channelId === threadId).map((m) => JSON.stringify(m.payload));
    expect(said.some((s) => s.includes('no longer restricted'))).toBe(false);
    expect(await members(threadId)).toEqual(['906', '907']);
    const cardId = staffThread(db, id)!.card_message_id!;
    expect(JSON.stringify(t.byId(cardId)!.payload)).toContain('2 from 2 people');
  });
});

describe('a ticket folded away while Discord was still making its forum post', () => {
  /** Fold the accused's normal ticket into its restricted sibling from inside
   *  createForumPost: the REST call has landed, and the row for it can no
   *  longer be written. What a promotion in a request handler does. */
  const foldWhileCreating = (andThen: () => void = () => {}) => {
    const create = t.threads.createForumPost;
    t.threads.createForumPost = async (forumId, p) => {
      const made = await create(forumId, p);
      db.transaction(() => {
        db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[5]);
        expect(restrictOpenTicketAbout(db, IDS[5], [ADMIN])).toBe('folded');
      })();
      andThen();
      return made;
    };
    return () => { t.threads.createForumPost = create; };
  };

  it('deletes the post it could not remember, so nothing about the accused is left in the forum', async () => {
    file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    file(IDS[1], IDS[5], 'griefing');
    const restore = foldWhileCreating();
    try {
      await sync.idle();
    } finally {
      restore();
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_threads WHERE surface = 'forum'").get()).toEqual({ n: 0 });
    expect(t.threadsIn('forum1')).toEqual([]);
    await sync.reconcile();
    expect(t.threadsIn('forum1')).toEqual([]);
  });

  it('keeps the accused out of the forum while a post it could not delete is still standing', async () => {
    file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect([...(t.channelAccess.get('forum1') ?? [])].sort()).toEqual(['906', '907']);
    file(IDS[1], IDS[5], 'griefing');
    // Discord refuses the deletion that follows the failed insert too.
    const restore = foldWhileCreating(() => { t.failThreadOps = 1; });
    try {
      await sync.idle();
    } finally {
      restore();
    }
    const stranded = t.threadsIn('forum1');
    expect(stranded).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_threads WHERE surface = 'forum'").get()).toEqual({ n: 0 });
    // The accused is staff now, and a post about them is standing that
    // nothing in the database can see, so the forum's access list is left
    // exactly as it was rather than letting them in to read it.
    expect([...(t.channelAccess.get('forum1') ?? [])].sort()).toEqual(['906', '907']);
    // The next pass sweeps the post up, and only then does the forum grow.
    await sync.reconcile();
    expect(t.threadsById.get(stranded[0].id)!.deleted).toBe(true);
    expect([...(t.channelAccess.get('forum1') ?? [])].sort()).toEqual(['905', '906', '907']);
  });
});

describe('a thread member who is no longer entitled to be there', () => {
  it('goes from an open thread and from a closed, locked one, which ends locked and archived', async () => {
    const open = file(IDS[0], IDS[5], 'unsafe');
    const closed = file(IDS[0], IDS[4], 'unsafe');
    addAccess(db, open, ADMIN, MOD);
    addAccess(db, closed, ADMIN, MOD);
    await sync.idle();
    const openThread = staffThread(db, open)!.thread_id;
    const closedThread = staffThread(db, closed)!.thread_id;
    expect(await members(openThread)).toEqual(['906', '907']);
    closeTicket(db, closed, ADMIN, 'no_action', '');
    await sync.idle();
    expect(t.threadsById.get(closedThread)).toMatchObject({ locked: true, archived: true });
    // Demoted and banned. Nothing deletes their access rows, and the site
    // refuses them from here on, so the threads must too.
    db.prepare("UPDATE players SET is_mod = 0, status = 'banned' WHERE steamid = ?").run(MOD);
    publishBanChange({ kind: 'ban', steamid: MOD, reason: 'x' });
    await sync.idle();
    expect(await members(openThread)).toEqual(['907']);
    expect(await members(closedThread)).toEqual(['907']);
    expect(t.threadsById.get(closedThread)).toMatchObject({ locked: true, archived: true, deleted: false });
  });

  it('is never added and never DMed when the demotion came first', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    addAccess(db, id, ADMIN, MOD);
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(MOD);
    await sync.idle();
    expect(await members(staffThread(db, id)!.thread_id)).toEqual(['907']);
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
    // And nothing changes its mind about them on a later pass.
    await sync.reconcile();
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
  });
});

describe('the accused must never be a member of their own thread', () => {
  it('a merge that repoints a locked, archived thread onto one of its own members ejects them and keeps it locked', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    expect(await members(threadId)).toEqual(['906', '907']);
    closeTicket(db, id, MOD, 'no_action', '');
    await sync.idle();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: true, archived: true });
    // What a merge does to a ticket whose target becomes one of its own
    // access-list members: target_id is repointed, and the tidy-up drops
    // their now-self-referential access row. Nothing else touches Discord
    // for a locked, archived thread.
    db.prepare('UPDATE tickets SET target_id = ? WHERE id = ?').run(MOD, id);
    db.prepare('DELETE FROM ticket_access WHERE ticket_id = ? AND steamid = ?').run(id, MOD);
    await sync.reconcile();
    expect(await members(threadId)).toEqual(['907']);
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: true, archived: true, deleted: false });
  });

  it('is ejected from a thread Discord archived on its own, which stays open for business', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    // Discord archived it after a quiet week: the row still says unlocked, and
    // an archived thread refuses a removal until something undoes that.
    t.threadsById.get(threadId)!.archived = true;
    db.prepare('UPDATE tickets SET target_id = ? WHERE id = ?').run(MOD, id);
    db.prepare('DELETE FROM ticket_access WHERE ticket_id = ? AND steamid = ?').run(id, MOD);
    await sync.reconcile();
    expect(await members(threadId)).toEqual(['907']);
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: false, archived: false, deleted: false });
  });

  it('one thread Discord refuses does not stop the next thread in the same pass', async () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[4]);
    const a = file(IDS[0], IDS[1], 'unsafe');
    const b = file(IDS[0], IDS[2], 'unsafe');
    addAccess(db, a, ADMIN, MOD);
    addAccess(db, b, ADMIN, IDS[4]);
    await sync.idle();
    const tha = staffThread(db, a)!.thread_id;
    const thb = staffThread(db, b)!.thread_id;
    expect(await members(tha)).toEqual(['906', '907']);
    expect(await members(thb)).toEqual(['904', '907']);
    // Closed and locked, so only the once-per-pass stage ever touches these:
    // that is what makes one failure able to strand the other.
    closeTicket(db, a, ADMIN, 'no_action', '');
    closeTicket(db, b, ADMIN, 'no_action', '');
    await sync.idle();
    for (const [ticket, who] of [[a, MOD], [b, IDS[4]]] as const) {
      db.prepare('UPDATE tickets SET target_id = ? WHERE id = ?').run(who, ticket);
      db.prepare('DELETE FROM ticket_access WHERE ticket_id = ? AND steamid = ?').run(ticket, who);
    }
    // The first thread's unarchive throws; the second must still be cleaned.
    t.failThreadOps = 1;
    await sync.reconcile();
    expect(await members(thb)).toEqual(['907']);
    expect(t.threadsById.get(thb)).toMatchObject({ locked: true, archived: true, deleted: false });
    expect(await members(tha)).toEqual(['906', '907']);
    // And the next pass finishes what the failure left behind.
    await sync.reconcile();
    expect(await members(tha)).toEqual(['907']);
    expect(t.threadsById.get(tha)).toMatchObject({ locked: true, archived: true, deleted: false });
  });

  it('a thread the ejection cannot clean still loses its forbidden forum post in the same pass', async () => {
    const restricted = file(IDS[0], IDS[5], 'unsafe');
    const normal = file(IDS[1], IDS[5], 'griefing');
    await sync.idle();
    const priv = staffThread(db, restricted)!.thread_id;
    const post = staffThread(db, normal)!.thread_id;
    // Someone added to the private thread by hand in Discord: the sweep has
    // to take them out, and Discord is about to refuse.
    await t.threads.addMember(priv, '555');
    // The accused is promoted: the normal ticket folds into the restricted
    // one, so its forum post is now a post about a restricted case.
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[5]);
      expect(restrictOpenTicketAbout(db, IDS[5], [ADMIN])).toBe('folded');
    })();
    t.failThreadOps = 1;
    publishTicketSignal({ kind: 'ticket', ticketId: restricted });
    await sync.idle();
    // The ejection failed and said so, and the post about the restricted
    // ticket still went, which is the one that must not wait for a retry.
    const problems = events.filter((e) => e.kind === 'problem').map((e) => (e as { text: string }).text);
    expect(problems.some((p) => p.startsWith("Could not take someone out of a ticket's Discord thread"))).toBe(true);
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(threadByDiscordId(db, post)!.state).toBe('deleted');
    await sync.reconcile();
    expect(await members(priv)).toEqual(['907']);
  });
});
