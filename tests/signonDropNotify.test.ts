import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { SignonDropNotifier, CONSISTENCY_HELP_PATH, CUSTOM_CAMPAIGNS_PATH, customCampaignOnServer } from '../src/signonDropNotify.js';
import { addServer } from '../src/serverPool.js';
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { invalidateCampaignCache } from '../src/campaignRegistry.js';
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

describe('SignonDropNotifier: a drop during a custom campaign match', () => {
  let serverId: number;
  const liveMatch = (campaign: string, sid = serverId) => db.prepare(
    `INSERT INTO matches (season_id, state, campaign, server_id, token, created_at, went_live_at)
     VALUES (1, 'live', ?, ?, 'tok', '2026-09-19 19:58:00', '2026-09-19 19:59:00')`,
  ).run(campaign, sid);

  beforeEach(() => {
    invalidateCampaignCache();
    serverId = addServer(db, { name: 'Dallas', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
    insertDraft(db, {
      slug: 'suicideblitz', name: 'Suicide Blitz', vpkFilename: 'suicideblitz.vpk',
      sizeBytes: 1, sha256: 'x', uploadedBy: null,
    }, [{ map: 'l4d_vs_stadium1_apartment', display: null, isFinale: false }]);
    publishCampaign(db, 'suicideblitz', 'Suicide Blitz');
  });
  afterEach(() => invalidateCampaignCache());

  it('names the campaign on the admin line when the server is live on a custom one', async () => {
    liveMatch('suicideblitz');
    await notifier.onDrop(drop(STRANGER, 'mayhem'), at(0), serverId);
    await notifier.onDrop(drop(STRANGER, 'mayhem'), at(1), serverId);
    expect(events).toEqual([{
      kind: 'signon_drop', steamid: STRANGER, name: 'mayhem', count: 2, total: 2,
      campaign: { slug: 'suicideblitz', name: 'Suicide Blitz' },
    }]);
  });

  it('sends the campaign DM, with the download page, instead of the consistency one', async () => {
    liveMatch('suicideblitz');
    await notifier.onDrop(drop(LINKED), at(0), serverId);
    const content = t.dms[0].payload.content;
    expect(content).toContain('Suicide Blitz');
    expect(content).toContain("Your string table differs from the server's.");
    expect(content).toContain(`https://pug.test${CUSTOM_CAMPAIGNS_PATH}`);
    expect(content).not.toMatch(/modified game file/);
    expect(t.dms[0].payload.components.flat()).toEqual([
      { kind: 'link', url: `https://pug.test${CUSTOM_CAMPAIGNS_PATH}`, label: 'Custom campaigns' },
    ]);
  });

  it('keeps the consistency wording on a stock campaign, with no server, or on another server', async () => {
    liveMatch('dead_air');
    const other = addServer(db, { name: 'Chicago', host: '5.6.7.8', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
    liveMatch('suicideblitz', other);
    await notifier.onDrop(drop(STRANGER), at(0), serverId);
    await notifier.onDrop(drop(STRANGER), at(1), null);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('campaign');
    await notifier.onDrop(drop(LINKED), at(0), serverId);
    expect(t.dms[0].payload.content).toMatch(/modified game file/);
  });

  it('ignores a match that is no longer live', async () => {
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, created_at)
       VALUES (1, 'completed', 'suicideblitz', ?, 'old', '2026-09-19 18:00:00')`,
    ).run(serverId);
    expect(customCampaignOnServer(db, serverId)).toBeNull();
  });
});
