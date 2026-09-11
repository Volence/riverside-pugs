import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { completeMatch } from '../src/matchResult.js';
import { upsertPlayer } from '../src/players.js';
import type { Dump } from '../src/dumpParse.js';
import { STAT_DEFS } from '../src/statKeys.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ME = IDS[0];

function playCompletedMatch(db: DB, winner: 'a' | 'b' | 'draw' = 'b'): number {
  const matchId = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  const totalA = winner === 'a' ? 300 : winner === 'b' ? 200 : 250;
  const totalB = winner === 'b' ? 300 : winner === 'a' ? 200 : 250;
  const dump: Dump = {
    matchId,
    maps: [{ map: 'm1', a: totalA, b: totalB }],
    players: IDS.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' : 'b', sidmg: 500, sikill: 5, ck: 100, ff: 20, rev: 1 })),
    skillDetect: false,
    skills: [],
    winner,
    totalA, totalB,
  };
  completeMatch(db, matchId, dump);
  return matchId;
}

function seedStats(db: DB, matchId: number, steamid: string, stats: Record<string, number>): void {
  const ins = db.prepare(
    'INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)',
  );
  for (const [stat, value] of Object.entries(stats)) ins.run(matchId, steamid, stat, value);
}

describe('stats routes', () => {
  let db: DB;
  let app: FastifyInstance;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    db = openDb(':memory:');
    app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator() });
    for (const id of IDS) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    cookies = authedCookie(app, db, ME);
  });
  afterEach(async () => { await app.close(); });

  it('read routes are public: no session still gets a 200', async () => {
    // Deliberate, 2026-09-11: results and the ladder are readable by anyone so
    // they can be linked to people who have not signed up. Everything that
    // mutates state stays authed (see api.test.ts).
    playCompletedMatch(db, 'b');
    for (const url of ['/api/leaderboard', '/api/leaderboard/stat/skeets', `/api/players/${ME}`, '/api/matches', '/api/matches/1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('an anonymous reader never receives a self-only stat VALUE', async () => {
    // The redaction must hold for a viewer with no session at all, not just
    // for a logged-in non-subject. Asserting on values, not on a string search
    // of the response: statDefs legitimately carries every stat KEY as schema,
    // so a substring check would be testing the wrong thing.
    playCompletedMatch(db, 'b');
    const selfKeys = STAT_DEFS.filter((d) => d.visibility === 'self').map((d) => d.key);
    expect(selfKeys.length).toBeGreaterThan(0);
    for (const k of selfKeys) {
      db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (1, ?, ?, 7)')
        .run(ME, k);
    }

    const body = (await app.inject({ method: 'GET', url: `/api/players/${ME}` })).json();
    expect(body.privateStatTotals).toBeNull();
    for (const k of selfKeys) expect(Object.keys(body.statTotals)).not.toContain(k);

    const detail = (await app.inject({ method: 'GET', url: '/api/matches/1' })).json();
    for (const p of detail.players ?? []) {
      for (const k of selfKeys) expect(Object.keys(p.stats ?? {})).not.toContain(k);
    }
  });

  it('the subject still sees their own self-only stats when logged in', async () => {
    // Guards against "fix the leak by deleting the feature". privateStats is
    // deliberately absent when there are none, so seed one to have something
    // to see.
    playCompletedMatch(db, 'b');
    const selfKey = STAT_DEFS.find((d) => d.visibility === 'self')!.key;
    db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (1, ?, ?, 3)')
      .run(ME, selfKey);

    const mine = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
    expect(mine.json().privateStatTotals).toMatchObject({ [selfKey]: 3 });

    // ...and the same request without a session must not carry the value.
    const anon = await app.inject({ method: 'GET', url: `/api/players/${ME}` });
    expect(anon.json().privateStatTotals).toBeNull();
    expect(Object.keys(anon.json().statTotals)).not.toContain(selfKey);
  });

  it('leaderboard: SR-sorted current-season rows with games count', async () => {
    playCompletedMatch(db, 'b');
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard', cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.season.id).toBe(1);
    expect(body.rows).toHaveLength(8);
    expect(body.rows[0].sr).toBeGreaterThanOrEqual(body.rows[7].sr);
    const winner = body.rows.find((r: any) => r.steamid === IDS[4]);
    expect(winner.wins).toBe(1);
    expect(winner.games).toBe(1);
    expect(typeof winner.sr).toBe('number');
    expect(winner.name).toBe('p4');
  });

  it('profile: rating, totals, recent matches with SR delta, history', async () => {
    playCompletedMatch(db, 'a');
    const res = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.player.steamid).toBe(ME);
    expect(body.rating.wins).toBe(1);
    expect(body.totals.games).toBe(1);
    expect(body.totals.siDamage).toBe(500);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].result).toBe('win');
    expect(typeof body.matches[0].srDelta).toBe('number');
    // ME is on the winning team ('a'), so SR should have gone up.
    expect(body.matches[0].srDelta).toBeGreaterThan(0);
    expect(body.history).toHaveLength(1);
    expect(typeof body.history[0].sr).toBe('number');
    expect(await (await app.inject({ method: 'GET', url: '/api/players/76561190000000000', cookies })).statusCode).toBe(404);

    // a losing player (team 'b') should show a negative SR delta and a loss.
    const loserCookies = authedCookie(app, db, IDS[4]);
    const loserRes = await app.inject({ method: 'GET', url: `/api/players/${IDS[4]}`, cookies: loserCookies });
    const loserBody = loserRes.json();
    expect(loserBody.matches[0].result).toBe('loss');
    expect(loserBody.matches[0].srDelta).toBeLessThan(0);
  });

  it('profile: draw counts as a game but not a win or loss', async () => {
    playCompletedMatch(db, 'draw');
    const res = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
    const body = res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].result).toBe('draw');
    expect(body.rating.wins).toBe(0);
    expect(body.rating.losses).toBe(0);

    const lb = (await app.inject({ method: 'GET', url: '/api/leaderboard', cookies })).json();
    const me = lb.rows.find((r: any) => r.steamid === ME);
    expect(me.games).toBe(1);
    expect(me.wins).toBe(0);
    expect(me.losses).toBe(0);
  });

  it('match list and detail', async () => {
    const matchId = playCompletedMatch(db, 'b');
    const list = (await app.inject({ method: 'GET', url: '/api/matches', cookies })).json();
    expect(list.matches).toHaveLength(1);
    expect(list.matches[0]).toMatchObject({ id: matchId, campaign: 'no_mercy', winner: 'b' });
    const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}`, cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match.id).toBe(matchId);
    expect(body.maps).toHaveLength(1);
    expect(body.players).toHaveLength(8);
    const p = body.players.find((x: any) => x.steamid === ME);
    expect(p.team).toBe('a');
    expect(p.siDamage).toBe(500);
    expect(typeof p.srDelta).toBe('number');
    // match was won by team 'b', so team 'a' (ME) lost SR and team 'b' gained SR.
    expect(p.srDelta).toBeLessThan(0);
    const winnerPlayer = body.players.find((x: any) => x.steamid === IDS[4]);
    expect(winnerPlayer.team).toBe('b');
    expect(winnerPlayer.srDelta).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/matches/999', cookies })).statusCode).toBe(404);
  });

  it('returns rounds with side attribution', async () => {
    const matchId = playCompletedMatch(db, 'a');
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (?, 0, 1, 'a', 300)").run(matchId);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (?, 0, 2, 'b', 250)").run(matchId);
    // Cumulative end-of-map snapshot, as the live pipeline writes it. IDS[0]
    // is on team a, IDS[4] on team b (playCompletedMatch splits at index 4).
    const ins = db.prepare(
      'INSERT INTO match_live_map_stats (match_id, ordinal, player_id, stats_json) VALUES (?, 0, ?, ?)',
    );
    ins.run(matchId, IDS[0], JSON.stringify({ skeets: 3, damage_as_si: 500 }));

    const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rounds).toHaveLength(2);
    expect(body.rounds[0]).toMatchObject({ ordinal: 0, half: 1, survTeam: 'a', score: 300, reliable: true });
    // Team a held survivor in half 1, so their skeets belong there and their
    // SI damage does not.
    expect(body.rounds[0].byPlayer[IDS[0]]).toEqual({ skeets: 3 });
    expect(body.rounds[1].byPlayer[IDS[0]]).toEqual({ damage_as_si: 500 });
  });

  it('returns an empty rounds array for a match recorded before rounds existed', async () => {
    const matchId = playCompletedMatch(db, 'b');
    const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
    expect(body.rounds).toEqual([]);
  });

  describe('stat visibility', () => {
    it('hides self-only stats from other viewers on a match page', async () => {
      const matchId = playCompletedMatch(db);
      seedStats(db, matchId, IDS[1], { skeets: 2, times_skeeted: 5 });
      // `cookies` authenticates ME (IDS[0]), who is NOT IDS[1].
      const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}`, cookies });
      const row = res.json().players.find((p: any) => p.steamid === IDS[1]);
      expect(row.stats.skeets).toBe(2);
      expect(row.stats).not.toHaveProperty('times_skeeted');
    });

    it('shows self-only stats in your own row', async () => {
      const matchId = playCompletedMatch(db);
      seedStats(db, matchId, ME, { skeets: 2, times_skeeted: 5 });
      const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}`, cookies });
      const row = res.json().players.find((p: any) => p.steamid === ME);
      expect(row.stats.times_skeeted).toBe(5);
    });

    it('returns privateStatTotals null on someone else profile', async () => {
      const matchId = playCompletedMatch(db);
      seedStats(db, matchId, IDS[1], { times_skeeted: 5 });
      const res = await app.inject({ method: 'GET', url: `/api/players/${IDS[1]}`, cookies });
      expect(res.json().privateStatTotals).toBeNull();
    });

    it('returns privateStatTotals on your own profile', async () => {
      const matchId = playCompletedMatch(db);
      seedStats(db, matchId, ME, { times_skeeted: 5 });
      const res = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
      expect(res.json().privateStatTotals.times_skeeted).toBe(5);
    });

    it('returns privateStatTotals null (not {}) on your own profile with no private stats recorded', async () => {
      playCompletedMatch(db);
      const res = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
      expect(res.json().privateStatTotals).toBeNull();
    });
  });

  describe('stat leaderboard', () => {
    it('ranks players by summed stat across completed matches in a season', async () => {
      const matchId = playCompletedMatch(db);
      seedStats(db, matchId, IDS[0], { skeets: 5 });
      seedStats(db, matchId, IDS[1], { skeets: 9 });
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets', cookies });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows.map((r: any) => r.steamid)).toEqual([IDS[1], IDS[0]]);
      expect(res.json().rows[0].total).toBe(9);
    });

    it('refuses a self-only stat even though the key is valid', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/times_skeeted', cookies });
      expect(res.statusCode).toBe(404);
    });

    it('refuses an unknown stat key', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/wat', cookies });
      expect(res.statusCode).toBe(404);
    });

    it('truncates a fractional limit instead of passing it to SQLite unchanged', async () => {
      const matchId = playCompletedMatch(db);
      IDS.forEach((id, i) => seedStats(db, matchId, id, { skeets: i + 1 }));
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets?limit=50.7', cookies });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows.length).toBeLessThanOrEqual(50);
    });

    it('falls back to the default limit on a garbage limit string', async () => {
      const matchId = playCompletedMatch(db);
      IDS.forEach((id, i) => seedStats(db, matchId, id, { skeets: i + 1 }));
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets?limit=abc', cookies });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows.length).toBeLessThanOrEqual(25);
    });
  });
  it('carries per-player season totals so the table can sort by any column', async () => {
    playCompletedMatch(db, 'b');
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard' });
    expect(res.statusCode).toBe(200);
    const row = res.json().rows.find((r: any) => r.steamid === ME);
    expect(row.stats).toBeDefined();
    // Fixed columns are always present, even at zero.
    for (const k of ['sidmg', 'sikill', 'ck', 'ff', 'rev']) {
      expect(Object.keys(row.stats)).toContain(k);
    }
  });

  it('never puts a self-visibility stat on the public leaderboard', async () => {
    // These are not rankable by design. Dropped server side rather than
    // filtered in the UI, so they cannot leak via the payload.
    playCompletedMatch(db, 'b');
    const selfKeys = STAT_DEFS.filter((d) => d.visibility === 'self').map((d) => d.key);
    for (const k of selfKeys) {
      db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (1, ?, ?, 9)')
        .run(ME, k);
    }
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard' });
    const row = res.json().rows.find((r: any) => r.steamid === ME);
    for (const k of selfKeys) expect(Object.keys(row.stats)).not.toContain(k);
  });
});
