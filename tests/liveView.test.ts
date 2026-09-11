import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import {
  recordMatchStart, recordMapResult, recordHeartbeat, recordLiveStat, recordLiveEvent, clearLive, getLiveMatches,
  STALE_AFTER_MS, LIVE_EVENT_LIMIT, reapOrphanedMatches, ORPHAN_AFTER_MS, mapStatsFor, eventsFor,
  recordRoundStart, recordRoundEnd, roundsFor,
} from '../src/liveView.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const A = ['76561198000000001', '76561198000000002'];
const B = ['76561198000000003', '76561198000000004'];

let db: DB;

function seedLive(state = 'live'): number {
  for (const id of [...A, ...B]) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
  const id = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, ?, 'no_mercy', ?)")
      .run(state, TOKEN).lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  for (const p of A) ins.run(id, p, 'a');
  for (const p of B) ins.run(id, p, 'b');
  return id;
}

beforeEach(() => { db = openDb(':memory:'); });

describe('liveView', () => {
  it('exposes nothing when no match is live', () => {
    expect(getLiveMatches(db)).toEqual([]);
  });

  it('shows an adopted match before any MATCH_START, with a null map', () => {
    // The backend adopts the match the moment the roster burst lands, which is
    // seconds before the first round goes live. It should read as "starting",
    // not be invisible.
    const id = seedLive();
    const live = getLiveMatches(db);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id, campaign: 'no_mercy', currentMap: null });
    expect(live[0].teamA.map((p) => p.steamid)).toEqual(A);
    expect(live[0].teamB.map((p) => p.steamid)).toEqual(B);
  });

  it('records the current map from MATCH_START', () => {
    const id = seedLive();
    recordMatchStart(db, TOKEN, 'l4d_vs_hospital01_apartment');
    expect(getLiveMatches(db)[0]).toMatchObject({
      id, currentMap: 'l4d_vs_hospital01_apartment',
    });
  });

  it('accumulates per-map scores and a running total', () => {
    seedLive();
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 250, 180);
    recordMapResult(db, TOKEN, 'l4d_vs_hospital02_subway', 300, 410);
    const m = getLiveMatches(db)[0];
    expect(m.maps).toEqual([
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment', teamAScore: 250, teamBScore: 180, stats: {} },
      { ordinal: 1, map: 'l4d_vs_hospital02_subway', teamAScore: 300, teamBScore: 410, stats: {} },
    ]);
    expect(m.teamAScore).toBe(550);
    expect(m.teamBScore).toBe(590);
  });

  it('is idempotent for a duplicated MAP_RESULT datagram', () => {
    // UDP can deliver the same datagram twice. That must not double the score.
    seedLive();
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 250, 180);
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 250, 180);
    const m = getLiveMatches(db)[0];
    expect(m.maps).toHaveLength(1);
    expect(m.teamAScore).toBe(250);
  });

  it('lets a corrected MAP_RESULT for the same map overwrite the old score', () => {
    seedLive();
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 100, 100);
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 250, 180);
    expect(getLiveMatches(db)[0].maps[0]).toMatchObject({ teamAScore: 250, teamBScore: 180 });
  });

  it('ignores events for a token that is not a live match', () => {
    seedLive('completed');
    recordMatchStart(db, TOKEN, 'l4d_vs_hospital01_apartment');
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 250, 180);
    recordHeartbeat(db, TOKEN);
    expect(getLiveMatches(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live').get()).toEqual({ n: 0 });
  });

  it('ignores an entirely unknown token', () => {
    seedLive();
    recordMapResult(db, 'f'.repeat(32), 'l4d_vs_hospital01_apartment', 999, 0);
    expect(getLiveMatches(db)[0].maps).toEqual([]);
  });

  it('marks a match stale when heartbeats stop, without hiding it', () => {
    // A crashed or abandoned match must not sit on the page looking live
    // forever, but it also should not vanish: "stale" is information.
    seedLive();
    recordHeartbeat(db, TOKEN);
    expect(getLiveMatches(db)[0].stale).toBe(false);

    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE match_live SET last_seen = ?').run(old);
    const m = getLiveMatches(db)[0];
    expect(m.stale).toBe(true);
    expect(m.id).toBeDefined();
  });

  it('a heartbeat refreshes staleness', () => {
    seedLive();
    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT INTO match_live (match_id, current_map, last_seen) SELECT id, NULL, ? FROM matches').run(old);
    expect(getLiveMatches(db)[0].stale).toBe(true);
    recordHeartbeat(db, TOKEN);
    expect(getLiveMatches(db)[0].stale).toBe(false);
  });

  it('clearLive KEEPS the per-map breakdown and the feed', () => {
    // These are the historical record, not scratch: clearing them meant
    // completing a match destroyed the only per-map player stats and the whole
    // event feed, so the match page could never show either.
    const id = seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 7 });
    recordMapResult(db, TOKEN, 'map_one', 100, 50);
    recordLiveEvent(db, TOKEN, {
      kind: 'live_event', token: TOKEN, seq: 1, event: 'dp', actor: A[0], target: B[0], value: 30,
      half: -1, tMs: -1,
    });

    clearLive(db, id);

    expect(mapStatsFor(db, id).get(0)![A[0]]).toEqual({ ck: 7 });
    expect(eventsFor(db, id)).toHaveLength(1);
    // ...while the genuinely volatile rows do go.
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_players').get()).toEqual({ n: 0 });
  });

  it('clearLive removes the scratch rows for a finished match', () => {
    const id = seedLive();
    recordMatchStart(db, TOKEN, 'l4d_vs_hospital01_apartment');
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 250, 180);

    clearLive(db, id);

    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_maps').get()).toEqual({ n: 0 });
  });

  it('never touches match_maps, the authoritative table', () => {
    seedLive();
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 250, 180);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_maps').get()).toEqual({ n: 0 });
  });
});

// ---- route level ----
describe('GET /api/live', () => {
  it('is public and reports the running match', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { buildServer } = await import('../src/server.js');
    const { stubOrchestrator } = await import('./helpers.js');

    const id = seedLive();
    recordMatchStart(db, TOKEN, 'l4d_vs_hospital01_apartment');
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 250, 180);

    const app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/live' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.matches).toHaveLength(1);
      expect(body.matches[0]).toMatchObject({
        id, campaign: 'no_mercy', currentMap: 'l4d_vs_hospital01_apartment',
        teamAScore: 250, teamBScore: 180,
      });
    } finally {
      await app.close();
    }
  });

  it('returns an empty list when nothing is being played', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { buildServer } = await import('../src/server.js');
    const { stubOrchestrator } = await import('./helpers.js');
    const app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator() });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/live' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ matches: [] });
    } finally {
      await app.close();
    }
  });
});

describe('liveView: per-player live stats', () => {
  it('stores counters and exposes them on the right player', () => {
    seedLive();
    recordLiveStat(db, TOKEN, A[0], { hp: 88, ck: 142, sidmg: 930, tank_damage: 2400 });
    const m = getLiveMatches(db)[0];
    expect(m.teamA.find((p) => p.steamid === A[0])!.stats)
      .toEqual({ hp: 88, ck: 142, sidmg: 930, tank_damage: 2400 });
    // Everyone else stays empty rather than zeroed.
    expect(m.teamB[0].stats).toEqual({});
  });

  it('replaces rather than merges on each update', () => {
    seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 5 });
    recordLiveStat(db, TOKEN, A[0], { ck: 9, skeets: 2 });
    expect(getLiveMatches(db)[0].teamA.find((p) => p.steamid === A[0])!.stats)
      .toEqual({ ck: 9, skeets: 2 });
  });

  // The live payload is public and has no per-viewer redaction step, so a
  // self-visibility stat must never be able to enter this table at all.
  it('strips self-visibility stats at the write boundary', () => {
    seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 5, times_skeeted: 3, times_deadstopped: 1 });
    const stats = getLiveMatches(db)[0].teamA.find((p) => p.steamid === A[0])!.stats;
    expect(stats).toEqual({ ck: 5 });
    // and not merely hidden on read
    const raw = db.prepare('SELECT stats_json FROM match_live_players').get() as { stats_json: string };
    expect(raw.stats_json).not.toContain('times_skeeted');
  });

  it('ignores live stats for a token that is not a live match', () => {
    seedLive('completed');
    recordLiveStat(db, TOKEN, A[0], { ck: 5 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_players').get()).toEqual({ n: 0 });
  });

  it('clearLive drops the per-player scratch rows too', () => {
    const id = seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 5 });
    clearLive(db, id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_players').get()).toEqual({ n: 0 });
  });
});

describe('liveView: event feed', () => {
  const ev = (
    seq: number,
    over: Partial<{ event: string; actor: string; target: string | null; value: number }> = {},
  ) => ({
    kind: 'live_event' as const, token: TOKEN,
    seq, event: 'dp', actor: A[0], target: B[0], value: 34, half: -1, tMs: -1, ...over,
  });

  it('records an event and resolves both names from the roster', () => {
    seedLive();
    recordLiveEvent(db, TOKEN, ev(1));
    const feed = getLiveMatches(db)[0].events;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      seq: 1, kind: 'dp', value: 34,
      actor: { steamid: A[0], name: 'p1' },
      target: { steamid: B[0], name: 'p3' },
    });
  });

  it('stores the EVENT TYPE, never the parser discriminator', () => {
    // Regression: the LogEvent's `kind` is always the literal 'live_event';
    // the thing that happened is in `event`. Storing the former made every
    // feed entry read "live_event" instead of "dp".
    seedLive();
    recordLiveEvent(db, TOKEN, ev(1));
    expect(getLiveMatches(db)[0].events[0].kind).toBe('dp');
    const raw = db.prepare('SELECT kind FROM match_live_events').get() as { kind: string };
    expect(raw.kind).toBe('dp');
  });

  it('is idempotent for a duplicated datagram', () => {
    seedLive();
    recordLiveEvent(db, TOKEN, ev(1));
    recordLiveEvent(db, TOKEN, ev(1));
    expect(getLiveMatches(db)[0].events).toHaveLength(1);
  });

  it('returns most recent first and caps the list', () => {
    seedLive();
    for (let i = 1; i <= LIVE_EVENT_LIMIT + 10; i++) recordLiveEvent(db, TOKEN, ev(i, { value: i }));
    const feed = getLiveMatches(db)[0].events;
    expect(feed).toHaveLength(LIVE_EVENT_LIMIT);
    expect(feed[0].seq).toBe(LIVE_EVENT_LIMIT + 10);
    expect(feed[1].seq).toBe(LIVE_EVENT_LIMIT + 9);
  });

  it('handles an event with no second party', () => {
    seedLive();
    recordLiveEvent(db, TOKEN, ev(1, { event: 'crown', target: null, value: 0 }));
    expect(getLiveMatches(db)[0].events[0].target).toBeNull();
  });

  it('ignores events for a token that is not live, and clearLive drops them', () => {
    seedLive('completed');
    recordLiveEvent(db, TOKEN, ev(1));
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_events').get()).toEqual({ n: 0 });
  });

  it('clearLive KEEPS the feed for the match page', () => {
    const id = seedLive();
    recordLiveEvent(db, TOKEN, ev(1));
    clearLive(db, id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_events').get()).toEqual({ n: 1 });
  });
});

describe('reapOrphanedMatches', () => {
  const stamp = (agoMs: number) =>
    new Date(Date.now() - agoMs).toISOString().replace('T', ' ').slice(0, 19);

  it('aborts a match whose heartbeats stopped long ago and frees its server', () => {
    db.prepare(
      "INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('t','127.0.0.1',27015,27015,'x','live')",
    ).run();
    const id = seedLive();
    db.prepare('UPDATE matches SET server_id = 1 WHERE id = ?').run(id);
    recordHeartbeat(db, TOKEN);
    db.prepare('UPDATE match_live SET last_seen = ?').run(stamp(ORPHAN_AFTER_MS + 60_000));

    expect(reapOrphanedMatches(db)).toEqual([id]);
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(id)).toEqual({ state: 'aborted' });
    expect(db.prepare('SELECT status FROM servers WHERE id = 1').get()).toEqual({ status: 'idle' });
    expect(getLiveMatches(db)).toEqual([]);
  });

  it('leaves a match that is merely stale but still within the window', () => {
    seedLive();
    recordHeartbeat(db, TOKEN);
    db.prepare('UPDATE match_live SET last_seen = ?').run(stamp(ORPHAN_AFTER_MS - 60_000));
    expect(reapOrphanedMatches(db)).toEqual([]);
    expect(getLiveMatches(db)).toHaveLength(1);
  });

  it('leaves a freshly adopted match that has not reported in yet', () => {
    // No match_live row at all: adopted seconds ago, no heartbeat due yet.
    // Reaping this would kill matches the moment they start.
    seedLive();
    expect(reapOrphanedMatches(db)).toEqual([]);
    expect(getLiveMatches(db)).toHaveLength(1);
  });

  it('clears the scratch tables for what it reaps', () => {
    const id = seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 5 });
    recordLiveEvent(db, TOKEN, {
      kind: 'live_event', token: TOKEN, seq: 1, event: 'dp', actor: A[0], target: B[0], value: 20,
      half: -1, tMs: -1,
    });
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 100, 50);
    db.prepare('UPDATE match_live SET last_seen = ?').run(stamp(ORPHAN_AFTER_MS + 60_000));

    reapOrphanedMatches(db);
    for (const t of ['match_live', 'match_live_players', 'match_live_maps']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_maps').get()).toEqual({ n: 0 });
  });
});

describe('restart resilience', () => {
  it('re-registers in-flight match tokens when the server starts', async () => {
    // Registered tokens are in-memory only. Without re-arming on boot, any
    // deploy or crash leaves the backend deaf to a match that is still being
    // played: the feed freezes and the match is eventually reaped as orphaned.
    const { loadConfig } = await import('../src/config.js');
    const { buildServer } = await import('../src/server.js');

    seedLive();
    db.prepare(
      "INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('t','127.0.0.1',27015,27015,'x','live')",
    ).run();

    // devMode:false is what builds the real listener; port 0 so it binds free.
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: 0 }, db });
    try {
      // The live match's token must be accepted after a cold start.
      recordHeartbeat(db, TOKEN);
      expect(getLiveMatches(db)[0].stale).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('liveView: per-map stat split', () => {
  it('gives each map its own stats as the difference between snapshots', () => {
    seedLive();
    // Map 1: 10 commons, 100 SI damage.
    recordLiveStat(db, TOKEN, A[0], { ck: 10, sidmg: 100 });
    recordMapResult(db, TOKEN, 'map_one', 200, 150);
    // Map 2 adds 5 more commons and 40 more damage, reported cumulatively.
    recordLiveStat(db, TOKEN, A[0], { ck: 15, sidmg: 140 });
    recordMapResult(db, TOKEN, 'map_two', 100, 300);

    const maps = getLiveMatches(db)[0].maps;
    expect(maps[0].stats[A[0]]).toEqual({ ck: 10, sidmg: 100 });
    expect(maps[1].stats[A[0]]).toEqual({ ck: 5, sidmg: 40 });
  });

  it('keeps the player totals cumulative', () => {
    seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 10 });
    recordMapResult(db, TOKEN, 'map_one', 200, 150);
    recordLiveStat(db, TOKEN, A[0], { ck: 15 });

    const m = getLiveMatches(db)[0];
    expect(m.teamA.find((p) => p.steamid === A[0])!.stats.ck).toBe(15);
    expect(m.maps[0].stats[A[0]].ck).toBe(10);
  });

  it('carries hp through as the level at map end, not a difference', () => {
    // "what did you finish that map on" is the meaningful number; subtracting
    // the previous map's ending health from it would be noise.
    seedLive();
    recordLiveStat(db, TOKEN, A[0], { hp: 80, ck: 3 });
    recordMapResult(db, TOKEN, 'map_one', 100, 100);
    recordLiveStat(db, TOKEN, A[0], { hp: 45, ck: 9 });
    recordMapResult(db, TOKEN, 'map_two', 100, 100);

    const maps = getLiveMatches(db)[0].maps;
    expect(maps[0].stats[A[0]]).toEqual({ hp: 80, ck: 3 });
    expect(maps[1].stats[A[0]]).toEqual({ hp: 45, ck: 6 });
  });

  it('never produces a negative, even if a counter appears to go backwards', () => {
    seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 10 });
    recordMapResult(db, TOKEN, 'map_one', 100, 100);
    recordLiveStat(db, TOKEN, A[0], { ck: 4 });
    recordMapResult(db, TOKEN, 'map_two', 100, 100);
    expect(getLiveMatches(db)[0].maps[1].stats[A[0]].ck).toBe(0);
  });

  it('clearLive keeps the snapshots so the match page can use them', () => {
    const id = seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 1 });
    recordMapResult(db, TOKEN, 'map_one', 1, 1);
    clearLive(db, id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_map_stats').get()).toEqual({ n: 1 });
  });
});

describe('liveView: events know their map', () => {
  const ev = (seq: number) => ({
    kind: 'live_event' as const, token: TOKEN,
    seq, event: 'dp', actor: A[0], target: B[0], value: 20, half: -1, tMs: -1,
  });

  it('stamps the map in progress at write time', () => {
    seedLive();
    recordLiveEvent(db, TOKEN, ev(1));                       // during map 1
    recordMapResult(db, TOKEN, 'map_one', 100, 50);
    recordLiveEvent(db, TOKEN, ev(2));                       // during map 2
    recordMapResult(db, TOKEN, 'map_two', 100, 50);
    recordLiveEvent(db, TOKEN, ev(3));                       // during map 3

    const feed = getLiveMatches(db)[0].events;
    const bySeq = Object.fromEntries(feed.map((e) => [e.seq, e.mapOrdinal]));
    expect(bySeq).toEqual({ 1: 0, 2: 1, 3: 2 });
  });

  it('does not re-stamp an event that arrives twice', () => {
    // A duplicate datagram must not move an old event onto the current map.
    seedLive();
    recordLiveEvent(db, TOKEN, ev(1));
    recordMapResult(db, TOKEN, 'map_one', 100, 50);
    recordLiveEvent(db, TOKEN, ev(1));

    const feed = getLiveMatches(db)[0].events;
    expect(feed).toHaveLength(1);
    // Still map 1 (ordinal 0), where it actually happened, not the map that
    // happened to be in progress when the duplicate turned up.
    expect(feed[0].mapOrdinal).toBe(0);
  });
});

const ROUND_TOKEN = 'b'.repeat(32);

function liveMatchForRounds() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)").run(ROUND_TOKEN);
  db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();
  return db;
}

describe('round persistence', () => {
  it('records a round and closes it with the score', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, half: 1, surv: 'a', score: 300 });
    expect(roundsFor(db, 1)).toEqual([
      { ordinal: 0, half: 1, survTeam: 'a', score: 300, reliable: true },
    ]);
  });

  it('is idempotent across a duplicated datagram', () => {
    const db = liveMatchForRounds();
    const ev = { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' } as const;
    recordRoundStart(db, ROUND_TOKEN, ev);
    recordRoundStart(db, ROUND_TOKEN, ev);
    expect(roundsFor(db, 1)).toHaveLength(1);
  });

  it('trusts the round-end side when start and end disagree', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, half: 1, surv: 'b', score: 120 });
    expect(roundsFor(db, 1)[0].survTeam).toBe('b');
  });

  it('stamps the ordinal from how many maps have finished', () => {
    const db = liveMatchForRounds();
    db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (1, 'm0', 0, 1, 2)").run();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm1', half: 1, surv: 'a' });
    expect(roundsFor(db, 1)[0].ordinal).toBe(1);
  });

  it('ignores a round for an unknown token rather than throwing', () => {
    const db = liveMatchForRounds();
    expect(() => recordRoundStart(db, 'c'.repeat(32), {
      kind: 'round_start', token: 'c'.repeat(32), map: 'm', half: 1, surv: 'a',
    })).not.toThrow();
    expect(roundsFor(db, 1)).toEqual([]);
  });
});
