import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { pollTwitch, twitchCacheStale, TWITCH_STALE_MS } from '../src/twitchPoll.js';
import { fakeTwitchApi } from './fakes/fakeTwitchApi.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
const T0 = new Date('2026-09-20T12:00:00.000Z');
let db: DB;

function link(steamid: string, twitchId: string, login: string) {
  db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?')
    .run(twitchId, login, steamid);
}

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
  upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
});

describe('pollTwitch', () => {
  it('asks about nobody when nobody has linked', async () => {
    const api = fakeTwitchApi({});
    await pollTwitch(db, api, T0);
    expect(api.calls).toBe(0);
  });

  it('records a live streamer', async () => {
    link(P1, '11', 'alicetv');
    const api = fakeTwitchApi({ live: { 11: { viewers: 18, title: 'pugs' } } });
    await pollTwitch(db, api, T0);
    const row = db.prepare('SELECT * FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.is_live).toBe(1);
    expect(row.viewers).toBe(18);
    expect(row.title).toBe('pugs');
    expect(row.last_live_at).toBe(T0.toISOString());
    expect(row.checked_at).toBe(T0.toISOString());
  });

  it('records an offline streamer without inventing a last_live_at', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({}), T0);
    const row = db.prepare('SELECT * FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.is_live).toBe(0);
    expect(row.last_live_at).toBe(null);
    expect(row.checked_at).toBe(T0.toISOString());
  });

  it('keeps last_live_at when someone goes offline', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    const later = new Date(T0.getTime() + 60_000);
    await pollTwitch(db, fakeTwitchApi({}), later);
    const row = db.prepare('SELECT * FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.is_live).toBe(0);
    expect(row.last_live_at).toBe(T0.toISOString());
    expect(row.checked_at).toBe(later.toISOString());
  });

  it('moves last_live_at forward on a later live poll', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    const later = new Date(T0.getTime() + 3_600_000);
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), later);
    const row = db.prepare('SELECT last_live_at FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.last_live_at).toBe(later.toISOString());
  });

  it('refreshes a changed twitch login', async () => {
    link(P1, '11', 'oldname');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: { userLogin: 'newname' } } }), T0);
    expect(db.prepare('SELECT twitch_name FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_name: 'newname' });
  });

  it('does not blank a login when the stream carries none', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: { userLogin: '' } } }), T0);
    expect(db.prepare('SELECT twitch_name FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_name: 'alicetv' });
  });

  it('leaves the cache untouched when the API throws', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    const later = new Date(T0.getTime() + 60_000);
    await pollTwitch(db, fakeTwitchApi({ failStreams: 'twitch down' }), later);
    const row = db.prepare('SELECT * FROM twitch_status WHERE player_id = ?').get(P1) as any;
    expect(row.is_live).toBe(1);
    // checked_at especially: writing it on a failure is the one thing that
    // would defeat the staleness check.
    expect(row.checked_at).toBe(T0.toISOString());
  });

  it('drops a status row once the player unlinks', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    db.prepare('UPDATE players SET twitch_id = NULL, twitch_name = NULL WHERE steamid = ?').run(P1);
    await pollTwitch(db, fakeTwitchApi({}), new Date(T0.getTime() + 60_000));
    expect(db.prepare('SELECT COUNT(*) AS n FROM twitch_status').get()).toEqual({ n: 0 });
  });

  it('handles two linked players at once', async () => {
    link(P1, '11', 'alicetv');
    link(P2, '22', 'bobtv');
    await pollTwitch(db, fakeTwitchApi({ live: { 11: {} } }), T0);
    const live = db.prepare('SELECT player_id FROM twitch_status WHERE is_live = 1').all();
    expect(live).toEqual([{ player_id: P1 }]);
    const n = db.prepare('SELECT COUNT(*) AS n FROM twitch_status').get() as { n: number };
    expect(n.n).toBe(2);
  });
});

describe('twitchCacheStale', () => {
  it('is stale with no rows at all', () => {
    expect(twitchCacheStale(db, T0)).toBe(true);
  });

  it('is fresh right after a poll', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({}), T0);
    expect(twitchCacheStale(db, T0)).toBe(false);
  });

  it('goes stale once the last poll is old enough', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({}), T0);
    expect(twitchCacheStale(db, new Date(T0.getTime() + TWITCH_STALE_MS - 1))).toBe(false);
    expect(twitchCacheStale(db, new Date(T0.getTime() + TWITCH_STALE_MS + 1))).toBe(true);
  });

  it('is stale when checked_at is unparseable', async () => {
    link(P1, '11', 'alicetv');
    await pollTwitch(db, fakeTwitchApi({}), T0);
    db.prepare("UPDATE twitch_status SET checked_at = 'nonsense'").run();
    expect(twitchCacheStale(db, T0)).toBe(true);
  });
});
