import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { completeMatch } from '../src/matchResult.js';
import { currentSeasonId } from '../src/players.js';
import { startNewSeason } from '../src/seasons.js';
import { parseProfileScope, profileData } from '../src/playerQueries.js';
import { playerWeeklyAwards } from '../src/weeklyStore.js';
import { handleCommand } from '../src/discord/commands.js';
import { buildMatchView } from '../src/cast/matchView.js';
import type { Dump } from '../src/dumpParse.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

/** Owner 2026-10-23: every number on a profile follows the selected season,
 *  with a Career view for all-time numbers, and Discord and the cast lineup
 *  card say which scope they show. */

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ME = IDS[0];
let db: DB;
let app: FastifyInstance;

/** One completed PUG; ME (team a) gets `skeets` and an endorsement-free line. */
function play(winner: 'a' | 'b', skeets = 0): number {
  const season = currentSeasonId(db);
  const matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'live', 'dead_air')").run(season).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  const dump: Dump = {
    matchId, maps: [{ map: 'l4d_vs_airport01_greenhouse', a: winner === 'a' ? 300 : 200, b: winner === 'b' ? 300 : 200 }],
    players: IDS.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' : 'b', sidmg: 100, sikill: 1, ck: 10, ff: 0, rev: 0 })),
    skillDetect: false, skills: [], winner, totalA: winner === 'a' ? 300 : 200, totalB: winner === 'b' ? 300 : 200,
  };
  completeMatch(db, matchId, dump);
  if (skeets) db.prepare("INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, 'skeets', ?)").run(matchId, ME, skeets);
  return matchId;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) authedCookie(app, db, id);
});
afterEach(async () => { await app.close(); });

/** Season 0: three wins and a loss for ME, 6 skeets. Then Season 1 opens. */
function seasonZeroThenOne(): number {
  // A fresh database's first season is named 'Season 1'; production's is
  // Season 0, and the tests read better with the real names.
  db.prepare("UPDATE seasons SET name = 'Season 0', started_at = '2026-01-01 00:00:00' WHERE id = 1").run();
  play('a', 2); play('a', 2); play('a', 2); play('b');
  expect(startNewSeason(db, 'Season 1').ok).toBe(true);
  return currentSeasonId(db);
}

describe('parseProfileScope', () => {
  it('reads nothing as the current season, career, or a season id', () => {
    expect(parseProfileScope(undefined)).toEqual({ kind: 'season' });
    expect(parseProfileScope('career')).toEqual({ kind: 'career' });
    expect(parseProfileScope('3')).toEqual({ kind: 'season', seasonId: 3 });
    expect(parseProfileScope('x')).toBeNull();
    expect(parseProfileScope('-1')).toBeNull();
  });
});

describe('profile scope', () => {
  it('on a new season\'s first day: zero games this season, placing, and the career still there', () => {
    const s1 = seasonZeroThenOne();
    const p = profileData(db, ME, null)!;
    expect(p.scope).toEqual({ kind: 'season', seasonId: s1, name: 'Season 1', current: true });
    expect(p.totals.games).toBe(0);
    expect(p.record).toEqual({ wins: 0, losses: 0 });
    expect(p.season?.placing).toEqual({ played: 0, of: 5 });
    expect(p.matches).toEqual([]);
    expect(p.statTotals).toEqual({});
    expect(p.byMap).toEqual([]);
    expect(p.chemistry.mostPlayedWith).toBeNull();
    // The picker: the current season first, then the one they played.
    expect(p.seasonsPlayed.map((s) => [s.name, s.current, s.games])).toEqual([['Season 1', true, 0], ['Season 0', false, 4]]);
  });

  it('a season view counts that season only; every figure from the same match set', () => {
    seasonZeroThenOne();
    play('b', 5);
    const p = profileData(db, ME, null)!;
    expect(p.totals.games).toBe(1);
    expect(p.record).toEqual({ wins: 0, losses: 1 });
    expect(p.statTotals.skeets).toBe(5);
    expect(p.matches).toHaveLength(1);
    expect(p.byMap.reduce((n, r) => n + r.games, 0)).toBe(1);
    expect(p.chemistry.mostPlayedWith?.games).toBe(1);
    expect(p.endorsements.total).toBe(0);
  });

  it('a past season reads its frozen result and its own numbers', () => {
    seasonZeroThenOne();
    play('b', 5);
    const p = profileData(db, ME, null, { kind: 'season', seasonId: 1 })!;
    expect(p.scope).toMatchObject({ kind: 'season', seasonId: 1, current: false });
    expect(p.totals.games).toBe(4);
    expect(p.record).toEqual({ wins: 3, losses: 1 });
    expect(p.statTotals.skeets).toBe(6);
    expect(p.season).toMatchObject({ id: 1, current: false, games: 4 });
    expect(typeof p.season?.sr).toBe('number');
    // No hidden-rating detail for a frozen season.
    expect(p.rating).not.toHaveProperty('mu');
  });

  it('the career view sums every season and carries no SR, rank or badges', () => {
    seasonZeroThenOne();
    play('b', 5);
    const p = profileData(db, ME, null, { kind: 'career' })!;
    expect(p.scope).toEqual({ kind: 'career' });
    expect(p.totals.games).toBe(5);
    expect(p.record).toEqual({ wins: 3, losses: 2 });
    expect(p.statTotals.skeets).toBe(11);
    expect(p.matches).toHaveLength(5);
    expect(p.rating).toBeNull();
    expect(p.season).toBeNull();
    expect(p.history).toEqual([]);
    expect(p.standings).toEqual({});
  });

  it('serves ?season= on the route: career, an id, 400 for junk and 404 for no such season', async () => {
    seasonZeroThenOne();
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/players/${ME}${q}` });
    expect((await get('?season=career')).json().scope).toEqual({ kind: 'career' });
    expect((await get('?season=1')).json().totals.games).toBe(4);
    expect((await get('')).json().totals.games).toBe(0);
    expect((await get('?season=junk')).statusCode).toBe(400);
    expect((await get('?season=99')).statusCode).toBe(404);
  });

  it('keeps a weekly award with the season in play when its week closed', () => {
    seasonZeroThenOne();
    const s1Start = (db.prepare('SELECT started_at FROM seasons WHERE id = 2').get() as { started_at: string }).started_at;
    // A week that closed long before Season 1, and one that closes after it started.
    const ins = db.prepare("INSERT INTO weekly_awards (week_start, award, kind, player_id, value, games) VALUES (?, 'skeets', 'total', ?, 5, 3)");
    ins.run('2026-01-05', ME);
    const monday = new Date(Date.parse(`${s1Start.slice(0, 10)}T00:00:00Z`));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    ins.run(monday.toISOString().slice(0, 10), ME);
    expect(playerWeeklyAwards(db, ME).find((a) => a.award === 'skeets')?.count).toBe(2);
    expect(playerWeeklyAwards(db, ME, 1).find((a) => a.award === 'skeets')?.weeks).toEqual(['2026-01-05']);
    expect(playerWeeklyAwards(db, ME, 2).find((a) => a.award === 'skeets')?.weeks).toEqual([monday.toISOString().slice(0, 10)]);
  });
});

describe('scope outside the site', () => {
  it('the cast lineup card shows this season, or the career labelled Career before a first PUG of it', () => {
    const s1 = seasonZeroThenOne();
    // ME has no Season 1 PUG yet: career numbers, labelled so, not zeros.
    const live = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'live', 'dead_air')").run(s1).lastInsertRowid);
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(live, ME, 'a');
    expect(buildMatchView(db, live, { overrides: { a: {}, b: {} } })!.teams.a.players[0].career)
      .toMatchObject({ scope: 'Career', matches: 4, wins: 3, losses: 1 });
    // After a Season 1 PUG: that season's numbers, named. (IDS[1], since the
    // card caches ME's numbers for a minute.)
    db.prepare('DELETE FROM match_players WHERE match_id = ?').run(live);
    db.prepare('DELETE FROM matches WHERE id = ?').run(live);
    const m = play('a');
    expect(buildMatchView(db, m, { overrides: { a: {}, b: {} } })!.teams.a.players.find((p) => p.steamid === IDS[1])!.career)
      .toMatchObject({ scope: 'Season 1', matches: 1, wins: 1, losses: 0 });
  });

  it('Discord /profile names the season, and on day one says no matches yet', async () => {
    seasonZeroThenOne();
    db.prepare("UPDATE players SET discord_id = 'd1' WHERE steamid = ?").run(ME);
    const deps = { db, publicUrl: 'https://x.test' } as unknown as Parameters<typeof handleCommand>[0];
    const run = async () => (await handleCommand(deps, {
      kind: 'command', name: 'profile', userId: 'd1', userName: 'me', options: {}, picked: {}, presserTimedOutUntil: null,
    } as never) as any).payload;
    let desc = (await run()).embeds[0].description as string;
    expect(desc).toContain('**Season 1:** no matches yet. Placing 0/5.');
    expect(desc).toContain('4 career matches');
    play('a');
    desc = (await run()).embeds[0].description as string;
    expect(desc).toMatch(/^\*\*Season 1:\*\* \*\*Placing 1\/5\*\* · 1W 0L \(100%\) · 1 matches/);
  });
});

// Owner 2026-10-23: "Skeets" is the solo stat wherever players compare
// themselves; team skeets are their own stat and are not added in.
describe('Skeets on the cast lineup card', () => {
  it('counts solo skeets only', () => {
    const m = play('a', 3);
    db.prepare("INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, 'team_skeets', 2)").run(m, ME);
    const me = buildMatchView(db, m, { overrides: { a: {}, b: {} } })!.teams.a.players.find((p) => p.steamid === ME)!;
    expect(me.career?.skeets).toBe(3);
    // The box score keeps both stats, each under its own key.
    expect(me.stats).toMatchObject({ skeets: 3, team_skeets: 2 });
  });
});
