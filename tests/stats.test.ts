import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { completeMatch } from '../src/matchResult.js';
import { upsertPlayer } from '../src/players.js';
import type { Dump } from '../src/dumpParse.js';
import { statDef, STAT_DEFS } from '../src/statKeys.js';
import { RANKED_MIN_GAMES } from '../src/standings.js';
import { getSetting, setSetting } from '../src/settings.js';

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
    app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverExec: async () => {} });
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

  // Was: "an anonymous reader never receives a self-only stat VALUE". No stat
  // carries self visibility any more (owner's call, 2026-09-18: getting skeeted
  // belongs in the match stats like everything else), so the redaction has
  // nothing left to redact and privateStatTotals nothing to carry. The
  // mechanism is still in place for a future stat; this pins that no stat uses
  // it, which is the thing a reader would otherwise have to go and check.
  it('has no self-visibility stats left, so nothing is redacted from anyone', async () => {
    playCompletedMatch(db, 'b');
    expect(STAT_DEFS.filter((d) => d.visibility === 'self')).toHaveLength(0);

    db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (1, ?, ?, 7)')
      .run(ME, 'times_skeeted');
    const body = (await app.inject({ method: 'GET', url: `/api/players/${ME}` })).json();
    expect(body.privateStatTotals).toBeNull();
  });

  it('shows a formerly private stat to everyone, logged in or not', async () => {
    const matchId = playCompletedMatch(db, 'b');
    seedStats(db, matchId, ME, { times_skeeted: 3 });

    for (const opts of [{ cookies }, {}]) {
      const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}`, ...opts });
      const row = res.json().players.find((p: any) => p.steamid === ME);
      expect(row.stats.times_skeeted).toBe(3);
    }
  });

  it('profile standings: a place per match among ranked players, ties shared, zeros and bad stats never ranked', async () => {
    // Three matches each, so the badge gate has to be down at three for any
    // of this to rank at all. The shipped default is higher; see the two
    // tests below for what it is and what it does.
    setSetting(db, 'standing_min_games', '3');
    const ids = [1, 2, 3].map(() => playCompletedMatch(db, 'b'));
    // Skeets per match: IDS[1] 3, ME and IDS[2..5] 2 (tied), IDS[6..7] 1.
    for (const m of ids) {
      IDS.forEach((id, i) => seedStats(db, m, id, { skeets: i === 1 ? 3 : i <= 5 ? 2 : 1, tongue_cuts: 0 }));
    }
    seedStats(db, ids[0], ME, { times_skeeted: 50, boomer_spawns: 4, boom_successes: 4 });

    const body = (await app.inject({ method: 'GET', url: `/api/players/${ME}` })).json();
    // ME is on 2 skeets a match: one player above, five level including ME,
    // two below. Midrank puts that at (2 + 5/2) / 8.
    expect(body.standings.skeets).toEqual({ rank: 2, of: 8, pct: 56 });
    // Every player has the same commons, so all eight share first. An
    // undifferentiated field is the 50th percentile, not the 100th: sharing
    // first place with everyone is not evidence of being good at it.
    expect(body.standings.ck).toEqual({ rank: 1, of: 8, pct: 50 });
    // Only ME has drawn a boomer, so the field is one player: rank 1 of 1 and
    // a percentile against nobody, which the UI suppresses rather than shows.
    expect(body.standings.boomer_rate).toEqual({ rank: 1, of: 1, pct: 50 });
    expect(body.standings).not.toHaveProperty('tongue_cuts');
    expect(body.standings).not.toHaveProperty('times_skeeted');
    expect(body.standings).not.toHaveProperty('ff');
  });

  // A badge has to rank the number it is printed beside. The tiles became
  // medians, and metricsOf was still dividing a season total by matches, so a
  // streaky player showed "SI dmg / match 693" with a #1 badge earned by a
  // mean of 1940. steady beats streaky on the median and loses on the mean,
  // which is what makes this test able to tell the two apart.
  it('ranks standings on the median, the same figure the profile tile shows', async () => {
    setSetting(db, 'standing_min_games', '3');
    const streaky = IDS[0];
    const steady = IDS[1];
    const perMatch: Record<string, number[]> = {
      [streaky]: [100, 100, 100, 100, 5000],
      [steady]: [400, 400, 400, 400, 400],
    };
    for (let i = 0; i < 5; i++) {
      const m = playCompletedMatch(db, 'b');
      for (const id of [streaky, steady]) seedStats(db, m, id, { skeets: perMatch[id][i] });
    }

    // The mean favours streaky (1080 against 400); the median favours steady.
    const standingsOf = async (id: string) =>
      (await app.inject({ method: 'GET', url: `/api/players/${id}` })).json().standings;

    expect((await standingsOf(steady)).skeets).toMatchObject({ rank: 1 });
    expect((await standingsOf(streaky)).skeets).toMatchObject({ rank: 2 });
  });

  it('separates players who share a median on the mean behind it', async () => {
    // Crowns come once or twice a season, so on the live board every player
    // but one has a median of 0 and the whole field shares a rank. The mean
    // is what tells a player who crowns in two matches of five from one who
    // has never done it, and it measures the same thing the median does.
    setSetting(db, 'standing_min_games', '3');
    const often = IDS[0];
    const once = IDS[1];
    const never = IDS[2];
    const perMatch: Record<string, number[]> = {
      [often]: [1, 0, 1, 0, 0],
      [once]: [0, 0, 1, 0, 0],
      [never]: [0, 0, 0, 0, 0],
    };
    for (let i = 0; i < 5; i++) {
      const m = playCompletedMatch(db, 'b');
      for (const id of [often, once, never]) seedStats(db, m, id, { crowns: perMatch[id][i] });
    }

    const standingsOf = async (id: string) =>
      (await app.inject({ method: 'GET', url: `/api/players/${id}` })).json().standings;

    // All three medians are 0, so without the tiebreak all three share rank 1.
    expect((await standingsOf(often)).crowns).toMatchObject({ rank: 1 });
    expect((await standingsOf(once)).crowns).toMatchObject({ rank: 2 });
    // A player who has never done it holds no place on that board at all.
    expect(await standingsOf(never)).not.toHaveProperty('crowns');
  });

  // Was: "rank 7 of 8 is outside the top five" and returned nothing at all.
  // Truncating server side meant #6 of 40 and #39 of 40 were the same absent
  // key, so a profile could not tell a near miss from a weakness. The top five
  // still gets the badge, but that is now the page's decision to make.
  it('profile standings report a place outside the top five rather than staying silent', async () => {
    setSetting(db, 'standing_min_games', '3');
    const ids = [1, 2, 3].map(() => playCompletedMatch(db, 'b'));
    for (const m of ids) {
      IDS.forEach((id, i) => seedStats(db, m, id, { skeets: i === 1 ? 3 : i <= 5 ? 2 : 1 }));
    }

    const low = (await app.inject({ method: 'GET', url: `/api/players/${IDS[7]}` })).json();
    expect(low.standings.skeets).toEqual({ rank: 7, of: 8, pct: 13 });
  });

  it('profile standings are empty for a provisional player', async () => {
    setSetting(db, 'standing_min_games', '3');
    const m = playCompletedMatch(db, 'b');
    seedStats(db, m, ME, { skeets: 9 });
    const body = (await app.inject({ method: 'GET', url: `/api/players/${ME}` })).json();
    expect(body.standings).toEqual({});
  });

  // Asked for by a player, 2026-09-19: a per-match average over three games
  // is mostly noise, so the badges kept landing on whoever had played least.
  // The gate is its own setting rather than RANKED_MIN_GAMES because the two
  // answer different questions: three games is enough for a rating to be worth
  // showing, and is not enough for "#1 in boomer pops per match" to mean
  // anything.
  it('profile standings hold badges back until the badge gate is met', async () => {
    setSetting(db, 'standing_min_games', '10');
    const ids = [1, 2, 3].map(() => playCompletedMatch(db, 'b'));
    for (const m of ids) IDS.forEach((id) => seedStats(db, m, id, { skeets: 5 }));

    const body = (await app.inject({ method: 'GET', url: `/api/players/${ME}` })).json();
    expect(body.standings).toEqual({});

    // The leaderboard's own ranked/provisional split is a separate threshold
    // and must not move with it: three games still puts someone on the board.
    const lb = (await app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    expect(lb.rows.find((r: any) => r.steamid === ME).ranked).toBe(true);
  });

  it('ships the badge gate at ten games', () => {
    expect(getSetting(db, 'standing_min_games')).toBe('10');
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

  it('leaderboard: a player is ranked from three games, and the rated-match count is real', async () => {
    // The page used to show the TOP player's game count as "Matches rated",
    // which is wrong as soon as anyone misses a night. The count is the
    // distinct matches with a rating_history row this season.
    playCompletedMatch(db, 'b');
    let body = (await app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    expect(body.matchesRated).toBe(1);
    expect(body.rows.every((r: any) => r.ranked === false)).toBe(true);

    playCompletedMatch(db, 'a');
    body = (await app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    expect(body.matchesRated).toBe(2);
    expect(body.rows.every((r: any) => r.ranked === false)).toBe(true);

    playCompletedMatch(db, 'draw');
    body = (await app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    expect(body.matchesRated).toBe(3);
    expect(body.rows.every((r: any) => r.games === 3 && r.ranked === true)).toBe(true);
  });

  it('leaderboard: the rated-match count ignores another season', async () => {
    playCompletedMatch(db, 'b');
    db.prepare("INSERT INTO seasons (name) VALUES ('old')").run();
    db.prepare(
      'INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after) VALUES (?, 999, 2, 25, 8, 26, 7)',
    ).run(ME);
    const body = (await app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    expect(body.matchesRated).toBe(1);
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

  it('lists demos only for maps the match actually has', async () => {
    // The recorder opens a demo on every map load under the match token,
    // including the post-finale map the server rolls to after the match
    // ended (2026-09-13). That file is real but it is not part of the match,
    // so a completed match lists only the ordinals present in match_maps.
    const matchId = playCompletedMatch(db, 'b');
    const ins = db.prepare('INSERT INTO match_demos (match_id, ordinal, map, filename, bytes) VALUES (?, ?, ?, ?, ?)');
    ins.run(matchId, 0, 'm1', 'pug_tok_0_m1.dem', 100);
    ins.run(matchId, 1, 'l4d_vs_farm01_hilltop', 'pug_tok_1_l4d_vs_farm01_hilltop.dem', 200);
    const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
    expect(body.maps.map((m: any) => m.ordinal)).toEqual([0]);
    expect(body.demos).toEqual([{ ordinal: 0, map: 'm1', bytes: 100 }]);
  });

  it('returns rounds with side attribution', async () => {
    const matchId = playCompletedMatch(db, 'a');
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 0, 1, 'a', 300, '2026-09-11 00:10:00')").run(matchId);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (?, 0, 2, 'b', 250)").run(matchId);
    // Cumulative end-of-map snapshot with the keys the LIVESTAT line really
    // carries: the five core counters (ck/sidmg/sikill/ff/rev) alongside the
    // registry keys, plus hp, which is a level and must be dropped. IDS[0]
    // is on team a, IDS[4] on team b (playCompletedMatch splits at index 4).
    const ins = db.prepare(
      'INSERT INTO match_live_map_stats (match_id, ordinal, player_id, stats_json) VALUES (?, 0, ?, ?)',
    );
    ins.run(matchId, IDS[0], JSON.stringify({
      hp: 100, ck: 42, sidmg: 1200, sikill: 5, ff: 33, rev: 2,
      skeets: 3, damage_as_si: 500,
    }));

    const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rounds).toHaveLength(2);
    expect(body.rounds[0]).toMatchObject({
      ordinal: 0, half: 1, survTeam: 'a', score: 300,
      endedAt: '2026-09-11 00:10:00', reliable: true,
    });
    // Team a held survivor in half 1, so every survivor-side key belongs
    // there, including the five core counters, and their SI damage does not.
    expect(body.rounds[0].byPlayer[IDS[0]]).toEqual({
      ck: 42, sidmg: 1200, sikill: 5, ff: 33, rev: 2, skeets: 3,
    });
    expect(body.rounds[1].byPlayer[IDS[0]]).toEqual({ damage_as_si: 500 });
    // Half 2 was never closed by a ROUND_END, so the API reports endedAt null
    // and a consumer must refuse to render its score as a result.
    expect(body.rounds[1].endedAt).toBeNull();
  });

  it('serves the whole event feed with round timing, not the live 40-newest window', async () => {
    // Clear latency on the match page is derived from pinned/cleared pairs
    // and needs half and tMs on every event. The route used to serve the
    // live page's 40 newest without either, so a match averaged NaN over
    // whatever happened in the last two minutes of the finale.
    const matchId = playCompletedMatch(db, 'a');
    const ins = db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );
    for (let seq = 1; seq <= 60; seq++) {
      ins.run(matchId, seq, seq % 2 ? 'pinned' : 'cleared', IDS[4], IDS[0], seq < 30 ? 0 : 1, seq < 30 ? 1 : 2, seq * 1000);
    }
    const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
    expect(body.events).toHaveLength(60);
    const first = body.events.find((e: any) => e.seq === 1);
    expect(first).toMatchObject({ kind: 'pinned', mapOrdinal: 0, half: 1, tMs: 1000 });
    const nameOf = (sid: string) => body.players.find((p: any) => p.steamid === sid).name;
    expect(first.actor).toEqual({ steamid: IDS[4], name: nameOf(IDS[4]) });
    expect(first.target).toEqual({ steamid: IDS[0], name: nameOf(IDS[0]) });
  });

  it('returns an empty rounds array for a match recorded before rounds existed', async () => {
    const matchId = playCompletedMatch(db, 'b');
    const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
    expect(body.rounds).toEqual([]);
  });

  it('serves the stat registry with the match so the page can read direction', async () => {
    const matchId = playCompletedMatch(db, 'a');
    const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
    expect(Array.isArray(body.statDefs)).toBe(true);
    const skeets = body.statDefs.find((d: { key: string }) => d.key === 'skeets');
    expect(skeets.direction).toBe('high_good');
  });

  describe('stat visibility', () => {
    it('shows another player their times skeeted, like any other stat', async () => {
      const matchId = playCompletedMatch(db);
      seedStats(db, matchId, IDS[1], { skeets: 2, times_skeeted: 5 });
      // `cookies` authenticates ME (IDS[0]), who is NOT IDS[1].
      const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}`, cookies });
      const row = res.json().players.find((p: any) => p.steamid === IDS[1]);
      expect(row.stats.skeets).toBe(2);
      expect(row.stats.times_skeeted).toBe(5);
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

    // privateStatTotals now has nothing to carry: no stat is self-visibility.
    // The field and its plumbing remain for a future one.
    it('returns privateStatTotals null on your own profile now nothing is private', async () => {
      const matchId = playCompletedMatch(db);
      seedStats(db, matchId, ME, { times_skeeted: 5 });
      const res = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
      expect(res.json().privateStatTotals).toBeNull();
    });

    it('returns privateStatTotals null (not {}) on your own profile with no private stats recorded', async () => {
      playCompletedMatch(db);
      const res = await app.inject({ method: 'GET', url: `/api/players/${ME}`, cookies });
      expect(res.json().privateStatTotals).toBeNull();
    });
  });

  describe('stat leaderboard', () => {
    // The whole point of the change: a season total ranks attendance. IDS[0]
    // turns up to twice as many matches and out-totals IDS[1] while being the
    // weaker player in every single one of them. Ordering by total puts IDS[0]
    // top, which is the bug; ordering by the per-match median puts IDS[1] top.
    it('ranks by the per-match median, so turning up more does not win the board', async () => {
      for (let i = 0; i < 6; i++) seedStats(db, playCompletedMatch(db), IDS[0], { skeets: 3 });
      for (let i = 0; i < 3; i++) seedStats(db, playCompletedMatch(db), IDS[1], { skeets: 5 });
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets', cookies });
      expect(res.statusCode).toBe(200);
      const rows = res.json().rows;
      expect(rows.map((r: any) => r.steamid)).toEqual([IDS[1], IDS[0]]);
      expect(rows[0]).toMatchObject({ median: 5, matches: 3, total: 15 });
      // The loser of the comparison still has the bigger season total, which is
      // exactly what the old ordering was rewarding.
      expect(rows[1]).toMatchObject({ median: 3, matches: 6, total: 18 });
    });

    it('breaks a tied median on the mean, not on the season total', async () => {
      // Both players' median match is one crown, so the median alone cannot
      // order them. IDS[0] is the better crowner per match; IDS[1] only
      // out-totals them by turning up to twice as many matches, which is what
      // ordering on the total would have rewarded.
      for (const v of [1, 1, 1, 5]) seedStats(db, playCompletedMatch(db), IDS[0], { crowns: v });
      for (let i = 0; i < 10; i++) seedStats(db, playCompletedMatch(db), IDS[1], { crowns: 1 });
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/crowns', cookies });
      const rows = res.json().rows;
      expect(rows.map((r: any) => r.steamid)).toEqual([IDS[0], IDS[1]]);
      // Tied on the median. The mean favours IDS[0], the total favours IDS[1],
      // so an ordering that used the total would reverse these two.
      expect(rows[0]).toMatchObject({ median: 1, mean: 2, total: 8 });
      expect(rows[1]).toMatchObject({ median: 1, mean: 1, total: 10 });
    });

    it('carries the spread beside the median so a reader can see how steady it is', async () => {
      for (const v of [1, 1, 10, 10]) seedStats(db, playCompletedMatch(db), IDS[0], { skeets: v });
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets', cookies });
      expect(res.json().rows[0]).toMatchObject({ p25: 1, median: 5.5, p75: 10, matches: 4 });
    });

    // There is no provisional section on this route to demote anyone into, the
    // way the leaderboard table has, so a one-match median has to be excluded
    // here or a single lucky night tops the board outright.
    it('leaves out a player with fewer matches than a median can rest on', async () => {
      for (let i = 0; i < 3; i++) seedStats(db, playCompletedMatch(db), IDS[0], { skeets: 2 });
      seedStats(db, playCompletedMatch(db), IDS[1], { skeets: 99 });
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets', cookies });
      expect(res.json().rows.map((r: any) => r.steamid)).toEqual([IDS[0]]);
    });

    // times_skeeted is public now, and must STILL not be rankable: a board of
    // who got skeeted most is not a leaderboard. The gate is direction, not
    // visibility, and those two stopped coinciding when this went public.
    it('refuses a stat where a high number is bad, even though it is public', async () => {
      expect(statDef('times_skeeted')!.visibility).toBe('public');
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/times_skeeted', cookies });
      expect(res.statusCode).toBe(404);
    });

    it('refuses an unknown stat key', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/wat', cookies });
      expect(res.statusCode).toBe(404);
    });

    // Three matches each, not one: a single match leaves every player under
    // RANKED_MIN_GAMES, and these would then assert a limit against an empty
    // list and pass whatever the limit parsing did.
    const seedEveryoneRankable = () => {
      for (let i = 0; i < RANKED_MIN_GAMES; i++) {
        const matchId = playCompletedMatch(db);
        IDS.forEach((id, n) => seedStats(db, matchId, id, { skeets: n + 1 }));
      }
    };

    it('truncates a fractional limit instead of passing it to SQLite unchanged', async () => {
      seedEveryoneRankable();
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets?limit=50.7', cookies });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows.length).toBe(IDS.length);
    });

    it('falls back to the default limit on a garbage limit string', async () => {
      seedEveryoneRankable();
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets?limit=abc', cookies });
      expect(res.statusCode).toBe(200);
      expect(res.json().rows.length).toBe(IDS.length);
    });

    it('applies a real limit', async () => {
      seedEveryoneRankable();
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard/stat/skeets?limit=3', cookies });
      expect(res.json().rows.length).toBe(3);
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

  describe('map recorded flag', () => {
    // A map's score in match_maps comes from the authoritative dump, but when
    // the plugin could not attribute or read a round (match 18, 2026-09-14)
    // the dump carried a 0 that was never a result. The rounds table is where
    // that shows: any round of the ordinal with reliable = 0 means the map's
    // score must be shown as "not recorded" rather than as 0 to 0.
    it('is true for a map with no round rows at all (pre round-capture match)', async () => {
      const matchId = playCompletedMatch(db, 'a');
      const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
      expect(body.maps[0].recorded).toBe(true);
    });

    it('is true when every round of the ordinal is reliable', async () => {
      const matchId = playCompletedMatch(db, 'a');
      db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 0, 1, 'a', 300, '2026-09-11 00:10:00')").run(matchId);
      db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 0, 2, 'b', 250, '2026-09-11 00:30:00')").run(matchId);
      const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
      expect(body.maps[0].recorded).toBe(true);
    });

    it('is false when any round of the ordinal is unreliable', async () => {
      const matchId = playCompletedMatch(db, 'a');
      db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, ended_at) VALUES (?, 0, 1, 'a', 300, 1, '2026-09-11 00:10:00')").run(matchId);
      db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, ended_at) VALUES (?, 0, 2, 'a', 0, 0, '2026-09-11 00:30:00')").run(matchId);
      const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
      expect(body.maps[0].recorded).toBe(false);
    });

    it('is false when the two halves fail to partition the sides, matching rounds[].reliable', async () => {
      // Both halves say team a held survivor. roundAttribution already forces
      // both rounds unreliable in its return value; the map flag must agree
      // with it rather than reading the stored column alone.
      const matchId = playCompletedMatch(db, 'a');
      db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 0, 1, 'a', 300, '2026-09-11 00:10:00')").run(matchId);
      db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 0, 2, 'a', 250, '2026-09-11 00:30:00')").run(matchId);
      const body = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}` })).json();
      expect(body.rounds.every((r: any) => r.reliable === false)).toBe(true);
      expect(body.maps[0].recorded).toBe(false);
    });
  });
});
