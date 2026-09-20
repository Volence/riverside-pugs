import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { SignonDropNotifier, CONSISTENCY_HELP_PATH } from '../src/signonDropNotify.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const LINKED = '76561198030413993';
const STRANGER = '76561198005192651';
const T0 = Date.parse('2026-09-19T20:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const drop = (steamid: string, name = 'volence') => ({ steamid, name, secs: 14, forced: 651 });

let db: DB;
let t: FakeTransport;
let notifier: SignonDropNotifier;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: LINKED, name: 'volence', avatar: null }, []);
  activatePlayer(db, LINKED);
  linkDiscord(db, LINKED, '900', 'volence_d');
  t = new FakeTransport();
  notifier = new SignonDropNotifier({ db, publicUrl: 'https://pug.test', dm: () => (id, p) => t.dm(id, p) });
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { off(); vi.restoreAllMocks(); });

describe('SignonDropNotifier: the admin feed', () => {
  it('stores the first drop and posts nothing', async () => {
    await notifier.onDrop(drop(STRANGER, 'mayhem'), at(0));
    expect(events).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signon_drops').get()).toEqual({ n: 1 });
  });

  it('posts on the second drop inside ten minutes, with the count and the total', async () => {
    await notifier.onDrop(drop(STRANGER, 'mayhem'), at(0));
    await notifier.onDrop(drop(STRANGER, 'mayhem'), at(4));
    expect(events).toEqual([{ kind: 'signon_drop', steamid: STRANGER, name: 'mayhem', count: 2, total: 2 }]);
  });

  it('posts nothing when the second drop is more than ten minutes later', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    await notifier.onDrop(drop(STRANGER), at(11));
    expect(events).toEqual([]);
  });

  it('posts nothing when the player got in between the two drops', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    notifier.onEntered(STRANGER, at(2));
    await notifier.onDrop(drop(STRANGER), at(4));
    expect(events).toEqual([]);
  });

  it('posts once per ten minutes for someone who keeps retrying', async () => {
    for (const m of [0, 1, 2, 3, 9]) await notifier.onDrop(drop(STRANGER), at(m));
    expect(events.map((e) => (e as { count: number }).count)).toEqual([2]);
    await notifier.onDrop(drop(STRANGER), at(12));
    expect(events.map((e) => (e as { count: number }).count)).toEqual([2, 3]);
  });

  it('posts again at once for a fresh streak after the player got in', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    await notifier.onDrop(drop(STRANGER), at(1));
    notifier.onEntered(STRANGER, at(2));
    await notifier.onDrop(drop(STRANGER), at(3));
    await notifier.onDrop(drop(STRANGER), at(4));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ count: 2, total: 4 });
  });

  it('ignores a duplicated datagram entirely', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    await notifier.onDrop(drop(STRANGER), new Date(T0 + 500));
    expect(events).toEqual([]);
  });
});

describe('SignonDropNotifier: the player DM', () => {
  it('DMs a linked player on the first drop, with the help page link', async () => {
    await notifier.onDrop(drop(LINKED), at(0));
    expect(t.dms).toHaveLength(1);
    expect(t.dms[0].userId).toBe('900');
    expect(t.dms[0].payload.content).toContain(`https://pug.test${CONSISTENCY_HELP_PATH}`);
    expect(t.dms[0].payload.content).toMatch(/modified game file/);
    expect(t.dms[0].payload.components.flat()).toEqual([
      { kind: 'link', url: `https://pug.test${CONSISTENCY_HELP_PATH}`, label: 'How to fix it' },
    ]);
  });

  it('never DMs someone with no linked Discord account', async () => {
    await notifier.onDrop(drop(STRANGER), at(0));
    expect(t.dms).toEqual([]);
  });

  it('sends at most one DM per steamid per hour', async () => {
    await notifier.onDrop(drop(LINKED), at(0));
    await notifier.onDrop(drop(LINKED), at(5));
    await notifier.onDrop(drop(LINKED), at(59));
    expect(t.dms).toHaveLength(1);
    await notifier.onDrop(drop(LINKED), at(61));
    expect(t.dms).toHaveLength(2);
  });

  it('logs a failed DM, does not throw, and does not retry inside the hour', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.dmsClosed.add('900');
    await expect(notifier.onDrop(drop(LINKED), at(0))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(LINKED);

    t.dmsClosed.clear();
    await notifier.onDrop(drop(LINKED), at(5));
    expect(t.dms).toEqual([]);
  });

  it('skips the DM without charging the hour while the bot is not running', async () => {
    let up = false;
    const n = new SignonDropNotifier({ db, publicUrl: 'https://pug.test', dm: () => (up ? (id, p) => t.dm(id, p) : null) });
    await n.onDrop(drop(LINKED), at(0));
    expect(t.dms).toEqual([]);
    up = true;
    await n.onDrop(drop(LINKED), at(5));
    expect(t.dms).toHaveLength(1);
  });
});
