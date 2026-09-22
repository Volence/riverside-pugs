import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { activatePlayer, upsertPlayer } from '../src/players.js';
import { banPlayer, liftExpiredBans } from '../src/admin/players.js';
import { OFFLINE_CAP, streamsView } from '../src/streamsView.js';

const T0 = new Date('2026-09-20T12:00:00.000Z');
let db: DB;

/** An active member, which is who the Streams page is for. */
function player(id: string, name: string) {
  upsertPlayer(db, { steamid: id, name, avatar: null }, []);
  activatePlayer(db, id);
}

function linked(id: string, twitchId: string, login: string) {
  db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?')
    .run(twitchId, login, id);
}

/** What a completed poll records besides the rows. Staleness is measured from
 *  this, not from the newest row, so a test that fabricates status rows has to
 *  fabricate the heartbeat too or the view reports everyone offline. */
function polled(at: Date = T0) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('twitch_polled_at', ?) "
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(at.toISOString());
}

function status(id: string, live: boolean, over: Record<string, unknown> = {}) {
  polled(new Date(String(over.checked_at ?? T0.toISOString())));
  db.prepare(
    `INSERT INTO twitch_status
       (player_id, is_live, title, game_name, viewers, thumbnail, started_at, last_live_at, checked_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, live ? 1 : 0,
    over.title ?? 'streaming', over.game_name ?? 'Left 4 Dead',
    over.viewers ?? 10, over.thumbnail ?? 'https://t/{width}x{height}.jpg',
    over.started_at ?? T0.toISOString(),
    'last_live_at' in over ? over.last_live_at : (live ? T0.toISOString() : null),
    over.checked_at ?? T0.toISOString(),
  );
}

function liveMatch(matchId: number, campaign: string, map: string | null, roster: string[]) {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (?,1,'live',?)")
    .run(matchId, campaign);
  if (map !== null) {
    db.prepare('INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?,?,?)')
      .run(matchId, map, T0.toISOString());
  }
  for (const [i, p] of roster.entries()) {
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?,?,?)')
      .run(matchId, p, i < 4 ? 'a' : 'b');
  }
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('streamsView', () => {
  it('is empty and stale before anything has polled', () => {
    expect(streamsView(db, { engaged: [], now: T0 }))
      .toEqual({ stale: true, inPug: [], live: [], offline: [], offlineTotal: 0 });
  });

  it('puts a live streamer who is in queue in the top tier', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    const v = streamsView(db, { engaged: ['1'], now: T0 });
    expect(v.inPug.map((s) => s.steamid)).toEqual(['1']);
    expect(v.live).toEqual([]);
    expect(v.inPug[0].match).toBe(null);
  });

  it('puts a live streamer on a live roster in the top tier, with the match', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    liveMatch(7, 'blood_harvest', 'l4d_farm01_hilltop', ['1']);
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.inPug[0].match).toEqual({ id: 7, campaign: 'blood_harvest', map: 'l4d_farm01_hilltop' });
  });

  it('tolerates a live match with no current map yet', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    liveMatch(7, 'blood_harvest', null, ['1']);
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.inPug[0].match).toEqual({ id: 7, campaign: 'blood_harvest', map: null });
  });

  it('puts a live streamer doing neither in the second tier', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.inPug).toEqual([]);
    expect(v.live.map((s) => s.steamid)).toEqual(['1']);
  });

  it('sorts each live tier by viewers, descending', () => {
    for (const [id, viewers] of [['1', 5], ['2', 50], ['3', 20]] as const) {
      player(id, `p${id}`);
      linked(id, `t${id}`, `login${id}`);
      status(id, true, { viewers });
    }
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.live.map((s) => s.viewers)).toEqual([50, 20, 5]);
  });

  it('lists offline streamers most recently live first, never-seen last', () => {
    player('1', 'a'); linked('1', 't1', 'l1');
    status('1', false, { last_live_at: '2026-09-18T00:00:00.000Z' });
    player('2', 'b'); linked('2', 't2', 'l2');
    status('2', false, { last_live_at: '2026-09-19T00:00:00.000Z' });
    player('3', 'c'); linked('3', 't3', 'l3');
    status('3', false, { last_live_at: null });
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.offline.map((o) => o.steamid)).toEqual(['2', '1', '3']);
  });

  it('caps the offline tier and reports the true total', () => {
    for (let i = 0; i < OFFLINE_CAP + 5; i += 1) {
      const id = String(1000 + i);
      player(id, `p${i}`);
      linked(id, `t${i}`, `l${i}`);
      status(id, false, { last_live_at: `2026-09-${String(10 + (i % 10)).padStart(2, '0')}T00:00:00.000Z` });
    }
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.offline.length).toBe(OFFLINE_CAP);
    expect(v.offlineTotal).toBe(OFFLINE_CAP + 5);
  });

  it('returns them all when asked', () => {
    for (let i = 0; i < OFFLINE_CAP + 5; i += 1) {
      const id = String(1000 + i);
      player(id, `p${i}`);
      linked(id, `t${i}`, `l${i}`);
      status(id, false);
    }
    const v = streamsView(db, { engaged: [], all: true, now: T0 });
    expect(v.offline.length).toBe(OFFLINE_CAP + 5);
    expect(v.offlineTotal).toBe(OFFLINE_CAP + 5);
  });

  it('reports nobody live once the cache is stale, and says so', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    const late = new Date(T0.getTime() + 11 * 60_000);
    const v = streamsView(db, { engaged: ['1'], now: late });
    expect(v.stale).toBe(true);
    expect(v.inPug).toEqual([]);
    expect(v.live).toEqual([]);
    // Still listed, because "we do not know" is not "offline forever", and
    // dropping the rows would blank the page every time the poller hiccups.
    expect(v.offline.map((o) => o.steamid)).toEqual(['1']);
  });

  it('ignores a player who never linked', () => {
    player('1', 'alice');
    expect(streamsView(db, { engaged: ['1'], now: T0 }).offline).toEqual([]);
  });

  it('lists a linked player who has never been polled, as offline', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    player('2', 'bob');
    linked('2', '22', 'bobtv');
    status('2', false);
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.offline.map((o) => o.steamid).sort()).toEqual(['1', '2']);
  });

  it('ignores a roster on a match that is not live', () => {
    player('1', 'alice');
    linked('1', '11', 'alicetv');
    status('1', true);
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (9,1,'completed','blood_harvest')").run();
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (9,'1','a')").run();
    const v = streamsView(db, { engaged: [], now: T0 });
    expect(v.inPug).toEqual([]);
    expect(v.live.map((s) => s.steamid)).toEqual(['1']);
  });

  it('never carries a twitch id on any card', () => {
    player('1', 'alice');
    linked('1', '123456', 'alicetv');
    status('1', true);
    player('2', 'bob');
    linked('2', '654321', 'bobtv');
    status('2', false);
    const v = streamsView(db, { engaged: [], now: T0 });
    const json = JSON.stringify(v);
    expect(json).not.toContain('123456');
    expect(json).not.toContain('654321');
    expect(json).toContain('alicetv');
  });
  // Linking Twitch needed nothing but a Steam login, so an account nobody had
  // let in, or one that had been banned, could put a stream title and
  // thumbnail of its choosing on a public page.
  describe('who may appear', () => {
    const A = '76561198000000071';

    it('an account that was never let in is on no tier', () => {
      upsertPlayer(db, { steamid: A, name: 'stranger', avatar: null }, []);
      linked(A, '71', 'strangertv');
      status(A, true);
      const v = streamsView(db, { engaged: [], now: T0 });
      expect([...v.inPug, ...v.live, ...v.offline]).toEqual([]);
      expect(v.offlineTotal).toBe(0);
    });

    it('a banned account disappears, live or offline, and comes back when the ban ends', () => {
      player(A, 'alice');
      linked(A, '71', 'alicetv');
      status(A, true);
      expect(streamsView(db, { engaged: [], now: T0 }).live).toHaveLength(1);
      banPlayer(db, A, 'admin', 'toxic', 60, T0);
      const banned = streamsView(db, { engaged: [], now: T0 });
      expect([...banned.inPug, ...banned.live, ...banned.offline]).toEqual([]);
      const later = new Date(T0.getTime() + 2 * 60 * 60 * 1000);
      liftExpiredBans(db, later);
      polled(later);
      expect(streamsView(db, { engaged: [], now: later }).live).toHaveLength(1);
    });

    it('asks the bans table too, not only the cached status', () => {
      player(A, 'alice');
      linked(A, '71', 'alicetv');
      status(A, true);
      banPlayer(db, A, 'admin', 'toxic', 60, T0);
      // The shape a merge leaves: the ban row is there, the status is not.
      db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(A);
      expect(streamsView(db, { engaged: [], now: T0 }).live).toEqual([]);
    });
  });
});
