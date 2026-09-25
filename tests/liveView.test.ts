import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, linkDiscord } from '../src/players.js';
import { ServerReleaser } from '../src/serverRelease.js';
import {
  recordMatchStart, recordMapResult, recordHeartbeat, recordLiveStat, recordLiveEvent, getLiveMatches,
  STALE_AFTER_MS, LIVE_EVENT_LIMIT, reapOrphanedMatches, ORPHAN_AFTER_MS, mapStatsFor, eventsFor,
  recordRoundStart, recordRoundEnd, roundsFor, recordChat, recordPhase, pausesFor, readyupsFor, slowToReady,
} from '../src/liveView.js';
import { clearLive } from '../src/matchArchive.js';

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

  it('never carries the match token', () => {
    // The token seeds sv_password in orchestrator.ts and /api/live is public,
    // so anyone reading this payload would be reading their way into a
    // private ranked match. The replay viewer addresses a live match by id.
    seedLive();
    const m = getLiveMatches(db)[0];
    expect(JSON.stringify(m)).not.toContain(TOKEN);
  });

  describe('discordName gating', () => {
    // /api/live has no session at all, so this is the caller's job: pass
    // showDiscordNames only once the route has checked the viewer is a
    // signed-in player in good standing (default false, the safe one).
    it('is null for everyone by default, even a player with a differing linked discord name', () => {
      seedLive();
      linkDiscord(db, A[0], '111', 'a totally different name');
      const m = getLiveMatches(db)[0];
      expect(m.teamA.find((p) => p.steamid === A[0])!.discordName).toBeNull();
      expect(JSON.stringify(m)).not.toContain('a totally different name');
    });

    it('is filled in when the caller asks, only for a differing name, and never carries a discord id', () => {
      seedLive();
      linkDiscord(db, A[0], '111', 'a totally different name');
      linkDiscord(db, A[1], '222', 'p2'); // same name as steam ("p2", from seedLive)
      const m = getLiveMatches(db, true)[0];
      expect(m.teamA.find((p) => p.steamid === A[0])!.discordName).toBe('a totally different name');
      expect(m.teamA.find((p) => p.steamid === A[1])!.discordName).toBeNull();
      expect(JSON.stringify(m)).not.toContain('discordId');
      expect(JSON.stringify(m)).not.toContain('111');
    });
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

    const app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverExec: async () => {} });
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
    const app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverExec: async () => {} });
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

  // The end-of-map skill set arrives as several LIVESTAT lines per player
  // (EmitSkillLive splits it to fit the plugin's buffer), so lines merge: a
  // repeated key takes the newest value, a key seen once stays.
  it('merges each update over the last, newest value winning', () => {
    seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 5, sidmg: 100 });
    recordLiveStat(db, TOKEN, A[0], { ck: 9, skeets: 2 });
    recordLiveStat(db, TOKEN, A[0], { crowns: 1 });
    expect(getLiveMatches(db)[0].teamA.find((p) => p.steamid === A[0])!.stats)
      .toEqual({ ck: 9, sidmg: 100, skeets: 2, crowns: 1 });
  });

  // The live payload is public and has no per-viewer redaction step, so a
  // self-visibility stat must never be able to enter this table at all.
  // times_skeeted went public on 2026-09-18, so the live table carries it like
  // any other stat. The write-boundary filter itself is unchanged and still
  // strips anything marked self-visibility; nothing is marked that way today.
  it('carries a public stat through the write boundary', () => {
    seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 5, times_skeeted: 3 });
    const stats = getLiveMatches(db)[0].teamA.find((p) => p.steamid === A[0])!.stats;
    expect(stats).toEqual({ ck: 5, times_skeeted: 3 });
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

describe('the current map on /live', () => {
  const mapOf = (id: number) => (db.prepare('SELECT current_map FROM match_live WHERE match_id = ?')
    .get(id) as { current_map: string | null } | undefined)?.current_map ?? null;

  // The bug this replaces, watched live on 2026-09-21: MATCH_START fires once
  // per match, so the label froze on map 1. It was patched by reading the
  // newest demo FILE on disk, which is current only on a box the web app
  // shares a filesystem with. On Chicago the demos arrive over FTP after a map
  // has FINISHED, so match 96's page read l4d_vs_airport01_greenhouse while
  // the match was on airport03. ROUND_START carries the name on the wire.
  it('follows the map ROUND_START names, with no file on disk anywhere', () => {
    const id = seedLive();
    recordMatchStart(db, TOKEN, 'l4d_vs_airport01_greenhouse');
    expect(mapOf(id)).toBe('l4d_vs_airport01_greenhouse');

    recordRoundStart(db, TOKEN, {
      kind: 'round_start', token: TOKEN, half: 1, map: 'l4d_vs_airport02_offices', surv: 'a',
    });

    expect(mapOf(id)).toBe('l4d_vs_airport02_offices');
  });

  it('keeps the map a heartbeat does not carry', () => {
    const id = seedLive();
    recordRoundStart(db, TOKEN, {
      kind: 'round_start', token: TOKEN, half: 1, map: 'l4d_vs_airport02_offices', surv: 'a',
    });
    recordHeartbeat(db, TOKEN);
    expect(mapOf(id)).toBe('l4d_vs_airport02_offices');
  });

  it('advances on the second half too, so a lost datagram self-corrects', () => {
    const id = seedLive();
    recordMatchStart(db, TOKEN, 'l4d_vs_airport01_greenhouse');
    // Half 1's ROUND_START never arrived; half 2's still names the map.
    recordRoundStart(db, TOKEN, {
      kind: 'round_start', token: TOKEN, half: 2, map: 'l4d_vs_airport02_offices', surv: 'b',
    });
    expect(mapOf(id)).toBe('l4d_vs_airport02_offices');
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

    const releaser = new ServerReleaser(db, async () => {});
    expect(reapOrphanedMatches(db, releaser)).toEqual([id]);
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(id)).toEqual({ state: 'aborted' });
    expect(db.prepare('SELECT status FROM servers WHERE id = 1').get()).toEqual({ status: 'idle' });
    expect(getLiveMatches(db)).toEqual([]);
  });

  it('leaves a match that is merely stale but still within the window', () => {
    seedLive();
    recordHeartbeat(db, TOKEN);
    db.prepare('UPDATE match_live SET last_seen = ?').run(stamp(ORPHAN_AFTER_MS - 60_000));
    expect(reapOrphanedMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
    expect(getLiveMatches(db)).toHaveLength(1);
  });

  it('leaves a freshly adopted match that has not reported in yet', () => {
    // No match_live row at all: adopted seconds ago, no heartbeat due yet.
    // Reaping this would kill matches the moment they start.
    seedLive();
    expect(reapOrphanedMatches(db, new ServerReleaser(db, async () => {}))).toEqual([]);
    expect(getLiveMatches(db)).toHaveLength(1);
  });

  it('archives what it reaps into the permanent tables, then clears the scratch', () => {
    const id = seedLive();
    recordLiveStat(db, TOKEN, A[0], { ck: 5 });
    recordLiveEvent(db, TOKEN, {
      kind: 'live_event', token: TOKEN, seq: 1, event: 'dp', actor: A[0], target: B[0], value: 20,
      half: -1, tMs: -1,
    });
    recordMapResult(db, TOKEN, 'l4d_vs_hospital01_apartment', 100, 50);
    db.prepare('UPDATE match_live SET last_seen = ?').run(stamp(ORPHAN_AFTER_MS + 60_000));

    reapOrphanedMatches(db, new ServerReleaser(db, async () => {}));
    for (const t of ['match_live', 'match_live_players', 'match_live_maps']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    }
    // A reaped match never gets a dump, so the scratch it had IS its record:
    // archiveAborted promotes it rather than letting clearLive destroy it.
    expect(db.prepare('SELECT ordinal, map, team_a_score AS a, team_b_score AS b FROM match_maps WHERE match_id = ?').all(id))
      .toEqual([{ ordinal: 0, map: 'l4d_vs_hospital01_apartment', a: 100, b: 50 }]);
    expect(db.prepare('SELECT common_kills FROM match_players WHERE match_id = ? AND player_id = ?').get(id, A[0]))
      .toEqual({ common_kills: 5 });
    expect(db.prepare('SELECT team_a_score AS a, team_b_score AS b, winner FROM matches WHERE id = ?').get(id))
      .toEqual({ a: 100, b: 50, winner: null });
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
    const app = await buildServer({
      config: { ...loadConfig({}), devMode: false, logListenPort: 0 }, db, serverExec: async () => {},
    });
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
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 300, alive: null });
    const [row] = roundsFor(db, 1);
    expect(row).toMatchObject({ ordinal: 0, half: 1, survTeam: 'a', score: 300, reliable: true });
    expect(row.endedAt).not.toBeNull();
  });

  it('stores the surviving-survivor count from ROUND_END', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 300, alive: 2,
    });
    const row = db.prepare('SELECT survivors_alive FROM match_rounds WHERE match_id = 1').get() as
      { survivors_alive: number | null };
    expect(row.survivors_alive).toBe(2);
  });

  it('stores a wipe as 0 rather than as no reading', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 50, alive: 0,
    });
    const row = db.prepare('SELECT survivors_alive FROM match_rounds WHERE match_id = 1').get() as
      { survivors_alive: number | null };
    expect(row.survivors_alive).toBe(0);
  });

  it('leaves survivors_alive null for a round an older plugin closed', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 300, alive: null,
    });
    const row = db.prepare('SELECT survivors_alive FROM match_rounds WHERE match_id = 1').get() as
      { survivors_alive: number | null };
    expect(row.survivors_alive).toBeNull();
  });

  it('does not let a later ROUND_END blank a survival reading it lacks', () => {
    // The row is upserted, and a duplicate ROUND_END from an older plugin (or
    // a retry that lost the field) must not erase a count already observed.
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 300, alive: 3,
    });
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 300, alive: null,
    });
    const row = db.prepare('SELECT survivors_alive FROM match_rounds WHERE match_id = 1').get() as
      { survivors_alive: number | null };
    expect(row.survivors_alive).toBe(3);
  });

  it('stores a failed score read (score=-1) as an unreliable zero, not a result', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: -1, alive: null });
    const [row] = roundsFor(db, 1);
    expect(row).toMatchObject({ half: 1, survTeam: 'a', score: 0, reliable: false });
    expect(row.endedAt).not.toBeNull();
  });

  it('leaves endedAt null for a round that never ended', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    // score reads 0 here only because the column defaults to it. endedAt is
    // the field that says nothing was ever reported.
    expect(roundsFor(db, 1)[0]).toMatchObject({ score: 0, endedAt: null });
  });

  it('is idempotent across a duplicated datagram', () => {
    const db = liveMatchForRounds();
    const ev = { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' } as const;
    recordRoundStart(db, ROUND_TOKEN, ev);
    const first = db.prepare('SELECT started_at FROM match_rounds').get() as { started_at: string };
    recordRoundStart(db, ROUND_TOKEN, ev);
    expect(roundsFor(db, 1)).toHaveLength(1);
    // The point of DO NOTHING over DO UPDATE: every event's t_ms is measured
    // from the ORIGINAL start, so a duplicate must not move the origin.
    const second = db.prepare('SELECT started_at FROM match_rounds').get() as { started_at: string };
    expect(second.started_at).toBe(first.started_at);
  });

  it('stores the demo sync from round start, and round end fills or refreshes it', () => {
    const db = liveMatchForRounds();
    const demoOf = (half: number) => db.prepare(
      'SELECT demo_tick AS tick, demo_hz AS hz FROM match_rounds WHERE half = ?',
    ).get(half) as { tick: number | null; hz: number | null };
    recordRoundStart(db, ROUND_TOKEN, {
      kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', demo: { tick: 900, hz: 100 },
    });
    expect(demoOf(1)).toEqual({ tick: 900, hz: 100 });
    // An older plugin's round end has no sync and must not erase it.
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 1, alive: null });
    expect(demoOf(1)).toEqual({ tick: 900, hz: 100 });
    // A half that went live again restarts its clock: the newest start wins.
    recordRoundStart(db, ROUND_TOKEN, {
      kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', demo: { tick: 5000, hz: 100 },
    });
    expect(demoOf(1)).toEqual({ tick: 5000, hz: 100 });
    // A lost ROUND_START: the end line alone supplies it.
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 2, surv: 'b', score: 1, alive: null, demo: { tick: 31000, hz: 100 },
    });
    expect(demoOf(2)).toEqual({ tick: 31000, hz: 100 });
  });

  it('stores the pauses from round end, and a new go-live clears them', () => {
    const db = liveMatchForRounds();
    const shiftsOf = (half: number) => (db.prepare(
      'SELECT demo_shifts AS s FROM match_rounds WHERE half = ?',
    ).get(half) as { s: string | null }).s;
    const shifts = [{ tMs: 10000, ticks: 6600 }];
    recordRoundStart(db, ROUND_TOKEN, {
      kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', demo: { tick: 900, hz: 100 },
    });
    expect(shiftsOf(1)).toBeNull();
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 1, alive: null,
      demo: { tick: 900, hz: 100, shifts },
    });
    expect(JSON.parse(shiftsOf(1)!)).toEqual(shifts);
    // An older plugin's round end has no sync and must not erase them.
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 1, alive: null });
    expect(JSON.parse(shiftsOf(1)!)).toEqual(shifts);
    // A round end with a sync and no shifts says there were none.
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 1, alive: null, demo: { tick: 900, hz: 100 },
    });
    expect(shiftsOf(1)).toBeNull();
    recordRoundEnd(db, ROUND_TOKEN, {
      kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', score: 1, alive: null,
      demo: { tick: 900, hz: 100, shifts },
    });
    // The half went live again: its clock restarted, so the old pauses no
    // longer sit where they did.
    recordRoundStart(db, ROUND_TOKEN, {
      kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a', demo: { tick: 5000, hz: 100 },
    });
    expect(shiftsOf(1)).toBeNull();
  });

  it('trusts the round-end side when start and end disagree', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'a' });
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'b', score: 120, alive: null });
    expect(roundsFor(db, 1)[0].survTeam).toBe('b');
  });

  it('stamps the ordinal from how many maps have finished', () => {
    const db = liveMatchForRounds();
    db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (1, 'm0', 0, 1, 2)").run();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm1', half: 1, surv: 'a' });
    expect(roundsFor(db, 1)[0].ordinal).toBe(1);
  });

  it('records a sideless round start as unreliable rather than inventing a side', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: null });
    const [row] = roundsFor(db, 1);
    // The row exists so started_at survives, which every event's t_ms is
    // measured against, but reliable = 0 says its side is a placeholder.
    expect(row.reliable).toBe(false);
    expect(row.endedAt).toBeNull();
  });

  it('promotes a sideless round to reliable when round end supplies the side', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm', half: 1, surv: null });
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, map: 'm', half: 1, surv: 'b', score: 175, alive: null });
    expect(roundsFor(db, 1)[0]).toMatchObject({ survTeam: 'b', score: 175, reliable: true });
  });

  it('files a round end under the map it names, not the map count', () => {
    const db = liveMatchForRounds();
    recordRoundStart(db, ROUND_TOKEN, { kind: 'round_start', token: ROUND_TOKEN, map: 'm0', half: 2, surv: 'b' });
    // MAP_RESULT for m0 lands first, so the naive COUNT(match_live_maps)
    // derivation would now put m0's own round end on ordinal 1.
    recordMapResult(db, ROUND_TOKEN, 'm0', 300, 250);
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, map: 'm0', half: 2, surv: 'b', score: 250, alive: null });
    const rows = roundsFor(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ordinal: 0, half: 2, score: 250 });
  });

  it('falls back to the map count when a round end carries no map', () => {
    const db = liveMatchForRounds();
    db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (1, 'm0', 0, 1, 2)").run();
    recordRoundEnd(db, ROUND_TOKEN, { kind: 'round_end', token: ROUND_TOKEN, map: null, half: 1, surv: 'a', score: 50, alive: null });
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

describe('liveView: event timing reaches the API', () => {
  const ev = (
    seq: number,
    over: Partial<{ event: string; actor: string; target: string | null; value: number; half: number; tMs: number }> = {},
  ) => ({
    kind: 'live_event' as const, token: TOKEN,
    seq, event: 'pinned', actor: A[0], target: B[0], value: 0, half: 1, tMs: 152800, ...over,
  });

  it('serves half and tMs on each event', () => {
    // They were stored but never selected, so nothing downstream could compute
    // a clear latency or line events up on a timeline.
    seedLive();
    recordLiveEvent(db, TOKEN, ev(1));
    expect(eventsFor(db, getLiveMatches(db)[0].id)[0]).toMatchObject({ half: 1, tMs: 152800 });
  });

  it('serves them on the live payload too', () => {
    seedLive();
    recordLiveEvent(db, TOKEN, ev(1, { half: 2, tMs: 4321 }));
    expect(getLiveMatches(db)[0].events[0]).toMatchObject({ half: 2, tMs: 4321 });
  });
});

describe('recordChat', () => {
  const chat = (over: Record<string, unknown> = {}) => ({
    kind: 'chat' as const, token: TOKEN, seq: 3, half: 1, tMs: 5000,
    steamid: '76561198000000001', team: 'a' as const, message: 'rushing left',
    ...over,
  });

  it('stores a message against the map in progress', () => {
    seedLive();
    recordChat(db, TOKEN, chat());
    const row = db.prepare('SELECT seq, half, t_ms, steamid, team, message, map_ordinal FROM match_chat').get();
    expect(row).toEqual({
      seq: 3, half: 1, t_ms: 5000, steamid: '76561198000000001',
      team: 'a', message: 'rushing left', map_ordinal: 0,
    });
  });

  it('upserts a duplicated datagram instead of storing it twice', () => {
    seedLive();
    recordChat(db, TOKEN, chat());
    recordChat(db, TOKEN, chat());
    const n = db.prepare('SELECT COUNT(*) AS n FROM match_chat').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('stores a message sent outside a live round, which carries half and t of -1', () => {
    // Chat is deliberately not gated on StatsActive, so this is the common
    // case between rounds and during ready-up, not an error.
    seedLive();
    recordChat(db, TOKEN, chat({ half: -1, tMs: -1 }));
    const row = db.prepare('SELECT half, t_ms FROM match_chat').get();
    expect(row).toEqual({ half: -1, t_ms: -1 });
  });

  it('ignores a token that is not a live match', () => {
    seedLive();
    recordChat(db, 'f'.repeat(32), chat({ token: 'f'.repeat(32), seq: 99 }));
    const n = db.prepare('SELECT COUNT(*) AS n FROM match_chat').get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('liveView: match phase', () => {
  const paused = { state: 'paused' as const, team: 'a' as const, limit: 120, leave: false, unready: [] };
  const live = { state: 'live' as const, team: null, limit: 0, leave: false, unready: [] };

  it('exposes the reported phase, with when it began, on the live match', () => {
    seedLive();
    recordPhase(db, TOKEN, paused);
    const m = getLiveMatches(db)[0];
    expect(m.phase).toMatchObject({ state: 'paused', team: 'a', limit: 120, leave: false });
    expect(Math.abs(m.phase!.sinceMs - Date.now())).toBeLessThan(5000);
  });

  it('reports no phase before the plugin has said anything', () => {
    seedLive();
    recordHeartbeat(db, TOKEN);
    expect(getLiveMatches(db)[0].phase).toBeNull();
  });

  it('keeps the original start when the same phase is reported again', () => {
    // The heartbeat repeats the phase every thirty seconds; a repeat is a
    // confirmation, not a new pause, and the countdown must not restart.
    seedLive();
    recordPhase(db, TOKEN, paused);
    const old = new Date(Date.now() - 40_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE match_live SET phase_since = ?').run(old);
    recordPhase(db, TOKEN, paused);
    expect(Date.now() - getLiveMatches(db)[0].phase!.sinceMs).toBeGreaterThan(30_000);
  });

  it('restarts the clock when the phase changes', () => {
    seedLive();
    recordPhase(db, TOKEN, paused);
    const old = new Date(Date.now() - 40_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE match_live SET phase_since = ?').run(old);
    recordPhase(db, TOKEN, live);
    const m = getLiveMatches(db)[0];
    expect(m.phase!.state).toBe('live');
    expect(Date.now() - m.phase!.sinceMs).toBeLessThan(5000);
  });

  it('records each pause for the match: who, when, on which map and half, and for how long', () => {
    const id = seedLive();
    recordMatchStart(db, TOKEN, 'l4d_hospital01_apartment');
    recordMapResult(db, TOKEN, 'l4d_hospital01_apartment', 100, 200);
    recordRoundStart(db, TOKEN, { kind: 'round_start', token: TOKEN, map: 'l4d_hospital02_subway', half: 2, surv: 'a' });
    recordPhase(db, TOKEN, paused);
    expect(pausesFor(db, id)).toMatchObject([
      { team: 'a', leave: false, mapOrdinal: 1, half: 2, endedAt: null, seconds: null },
    ]);
    const old = new Date(Date.now() - 90_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE match_pauses SET started_at = ?').run(old);
    recordPhase(db, TOKEN, live);
    const [p] = pausesFor(db, id);
    expect(p.endedAt).not.toBeNull();
    expect(p.seconds).toBeGreaterThanOrEqual(89);
    expect(p.seconds).toBeLessThanOrEqual(92);
  });

  it('does not open a second pause row when the pause is reported again', () => {
    const id = seedLive();
    recordPhase(db, TOKEN, paused);
    recordPhase(db, TOKEN, paused);
    expect(pausesFor(db, id)).toHaveLength(1);
  });

  it('records who called a pause when the plugin says, and nobody when it does not', () => {
    const id = seedLive();
    const CALLER = '76561198000000042';
    recordPhase(db, TOKEN, { ...paused, by: CALLER });
    recordPhase(db, TOKEN, live);
    recordPhase(db, TOKEN, paused);
    expect(pausesFor(db, id).map((p) => p.calledBy)).toEqual([CALLER, null]);
  });

  // The PHASE line that opened the pause can be lost; the heartbeat repeats
  // the same fields thirty seconds later and must be able to fill the caller.
  it('fills in the caller from a repeat when the line that opened the pause lacked it', () => {
    const id = seedLive();
    recordPhase(db, TOKEN, paused);
    recordPhase(db, TOKEN, { ...paused, by: '76561198000000042' });
    recordPhase(db, TOKEN, { ...paused, by: '76561198000000099' });
    expect(pausesFor(db, id).map((p) => p.calledBy)).toEqual(['76561198000000042']);
  });

  it('records a disconnect pause as nobody\'s', () => {
    const id = seedLive();
    recordPhase(db, TOKEN, { state: 'paused', team: null, limit: 0, leave: true, unready: [] });
    expect(pausesFor(db, id)).toMatchObject([{ team: null, leave: true }]);
  });

  it('ignores a phase for a token that is not a live match', () => {
    const id = seedLive('completed');
    recordPhase(db, TOKEN, paused);
    expect(pausesFor(db, id)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live').get()).toEqual({ n: 0 });
  });

  it('clearLive keeps the pause record, which is the point of it', () => {
    const id = seedLive();
    recordPhase(db, TOKEN, paused);
    recordPhase(db, TOKEN, live);
    clearLive(db, id);
    expect(pausesFor(db, id)).toHaveLength(1);
  });
});

describe('liveView: ready-up ledger', () => {
  const ready = (unready: string[]) => ({ state: 'readyup' as const, team: null, limit: 0, leave: false, unready });
  const live = { state: 'live' as const, team: null, limit: 0, leave: false, unready: [] as string[] };
  const backdate = (table: string, col: string, secs: number, where = '1=1') => {
    const t = new Date(Date.now() - secs * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${where}`).run(t);
  };

  it('records how long a ready-up took and who readied last', () => {
    const id = seedLive();
    recordPhase(db, TOKEN, ready([A[0], B[1]]));
    expect(readyupsFor(db, id)).toMatchObject([{ mapOrdinal: 0, endedAt: null, seconds: null, lastUnready: [A[0], B[1]] }]);
    backdate('match_readyups', 'started_at', 100);
    recordPhase(db, TOKEN, ready([B[1]]));
    recordPhase(db, TOKEN, ready([]));
    recordPhase(db, TOKEN, live);
    const [r] = readyupsFor(db, id);
    expect(r.endedAt).not.toBeNull();
    expect(r.seconds).toBeGreaterThanOrEqual(99);
    // The last set that still held anyone: the empty set at the end is the
    // countdown, not a person.
    expect(r.lastUnready).toEqual([B[1]]);
    expect(r.lastUnreadyNames).toEqual([`p${B[1].slice(-1)}`]);
  });

  it('charges each player the seconds they spent not ready', () => {
    const id = seedLive();
    recordPhase(db, TOKEN, ready([A[0], B[1]]));
    // Forty seconds with both unready, then sixty more with only B[1].
    backdate('match_live', 'phase_unready_at', 40);
    backdate('match_readyups', 'started_at', 40);
    recordPhase(db, TOKEN, ready([B[1]]));
    backdate('match_live', 'phase_unready_at', 60);
    backdate('match_readyups', 'started_at', 100);
    recordPhase(db, TOKEN, live);
    const [r] = readyupsFor(db, id);
    const by = Object.fromEntries(r.players.map((p) => [p.steamid, p.seconds]));
    expect(by[A[0]]).toBeGreaterThanOrEqual(39);
    expect(by[A[0]]).toBeLessThanOrEqual(42);
    expect(by[B[1]]).toBeGreaterThanOrEqual(99);
    expect(by[B[1]]).toBeLessThanOrEqual(102);
  });

  it('treats a repeated identical roster as confirmation, not a new ready-up', () => {
    const id = seedLive();
    recordPhase(db, TOKEN, ready([A[0]]));
    recordPhase(db, TOKEN, ready([A[0]]));
    recordPhase(db, TOKEN, live);
    expect(readyupsFor(db, id)).toHaveLength(1);
  });

  it('exposes the not-ready roster on the live phase', () => {
    seedLive();
    recordPhase(db, TOKEN, ready([A[1]]));
    expect(getLiveMatches(db)[0].phase).toMatchObject({ state: 'readyup', unready: [A[1]] });
  });

  it('ranks players across matches by how slow they are to ready', () => {
    const id = seedLive();
    recordPhase(db, TOKEN, ready([A[0], A[1]]));
    backdate('match_live', 'phase_unready_at', 30);
    backdate('match_readyups', 'started_at', 30);
    recordPhase(db, TOKEN, ready([A[0]]));
    backdate('match_live', 'phase_unready_at', 90);
    backdate('match_readyups', 'started_at', 120);
    recordPhase(db, TOKEN, live);
    recordPhase(db, TOKEN, ready([A[0]]));
    backdate('match_live', 'phase_unready_at', 20, 'phase = \'readyup\'');
    backdate('match_readyups', 'started_at', 20, 'ended_at IS NULL');
    recordPhase(db, TOKEN, live);
    clearLive(db, id);

    const rows = slowToReady(db);
    expect(rows[0]).toMatchObject({ steamid: A[0], name: `p${A[0].slice(-1)}`, readyups: 2, timesLast: 2 });
    expect(rows[0].totalSeconds).toBeGreaterThanOrEqual(138);
    expect(rows[0].avgSeconds).toBeGreaterThanOrEqual(69);
    expect(rows[1]).toMatchObject({ steamid: A[1], readyups: 1, timesLast: 0 });
    expect(rows[1].totalSeconds).toBeGreaterThanOrEqual(29);
    expect(rows[1].totalSeconds).toBeLessThanOrEqual(32);
  });

  // The admin table sorts in the browser (share of ready-ups they were last
  // for, average, total), so the server must not pre-cut the list to the top
  // few by one of those orders: the slowest average may never have been last.
  it('returns everybody, not the top of one ordering', () => {
    const id = seedLive();
    clearLive(db, id);
    const ru = Number(db.prepare(
      "INSERT INTO match_readyups (match_id, map_ordinal, half, started_at, ended_at, last_unready) VALUES (?, 1, 1, datetime('now', '-60 seconds'), datetime('now'), '[]')",
    ).run(id).lastInsertRowid);
    const ins = db.prepare('INSERT INTO match_readyup_players (readyup_id, match_id, player_id, seconds) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 40; i++) ins.run(ru, id, `7656119800009${String(i).padStart(4, '0')}`, i);
    expect(slowToReady(db)).toHaveLength(40);
  });
});

