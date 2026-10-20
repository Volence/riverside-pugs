import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { completeMatch } from '../src/matchResult.js';
import { currentSeasonId } from '../src/players.js';
import { recomputeSeasonRatings } from '../src/rating.js';
import { startNewSeason } from '../src/seasons.js';
import {
  DEMOTION_BUFFER, rankAfter, rankFloor, rankIndexOf, rankView, softResetRating, seasonLadder, seasonRules,
} from '../src/seasonRules.js';
import type { Dump } from '../src/dumpParse.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = IDS[0];
let db: DB;
let app: FastifyInstance;
let admin: Record<string, string>;

function play(winner: 'a' | 'b'): number {
  const season = currentSeasonId(db);
  const matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'live', 'dead_air')").run(season).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  const dump: Dump = {
    matchId, maps: [{ map: 'm1', a: winner === 'a' ? 300 : 200, b: winner === 'b' ? 300 : 200 }],
    players: IDS.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' : 'b', sidmg: 1, sikill: 1, ck: 1, ff: 0, rev: 0 })),
    skillDetect: false, skills: [], winner, totalA: winner === 'a' ? 300 : 200, totalB: winner === 'b' ? 300 : 200,
  };
  completeMatch(db, matchId, dump);
  return matchId;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) authedCookie(app, db, id);
  admin = authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});
afterEach(async () => { await app.close(); });

const get = (url: string, cookies?: Record<string, string>) => app.inject({ method: 'GET', url, cookies }).then((r) => r.json());
const row = (rows: { steamid: string }[], id: string) => rows.find((r) => r.steamid === id) as any;

describe('ranks', () => {
  it('Silver starts at 1400 and each tier is 500 wide, three divisions each', () => {
    expect(rankView(rankIndexOf(0)).name).toBe('Bronze III');
    expect(rankView(rankIndexOf(1399)).name).toBe('Bronze I');
    expect(rankView(rankIndexOf(1400)).name).toBe('Silver III');
    expect(rankView(rankIndexOf(1900)).name).toBe('Gold III');
    expect(rankView(rankIndexOf(2400)).name).toBe('Platinum III');
    expect(rankView(rankIndexOf(2900)).name).toBe('Diamond III');
    expect(rankView(rankIndexOf(3400)).name).toBe('Master III');
    expect(rankView(rankIndexOf(9999))).toMatchObject({ name: 'Master I', next: null });
    expect(rankFloor(7)).toBe(2067); // Gold II
  });

  it('ranks up at once and down only past the buffer', () => {
    const gold3 = rankIndexOf(1900);
    expect(rankAfter(null, 1950)).toBe(gold3);
    expect(rankAfter(gold3 - 1, 1900)).toBe(gold3);
    expect(rankAfter(gold3, 1900 - DEMOTION_BUFFER)).toBe(gold3);
    expect(rankAfter(gold3, 1900 - DEMOTION_BUFFER - 1)).toBe(gold3 - 1);
  });

  it('soft reset pulls mu 30% toward 25 and floors sigma at 6', () => {
    expect(softResetRating({ mu: 45, sigma: 4 })).toEqual({ mu: 39, sigma: 6 });
    expect(softResetRating({ mu: 15, sigma: 7.5 })).toEqual({ mu: 18, sigma: 7.5 });
  });
});

describe('season 1', () => {
  it('Season 0 keeps its rules: mu - 2 sigma, no placement, no ranks', async () => {
    play('a');
    expect(seasonRules(db, 1)).toEqual({ srSigmaK: 2, placementGames: 0, ranks: false, finalMinGames: 20 });
    const lb = await get('/api/leaderboard');
    expect(row(lb.rows, IDS[0])).toMatchObject({ placing: null, rank: null });
    expect(typeof row(lb.rows, IDS[0]).sr).toBe('number');
  });

  it('a new season freezes the old standings, seeds a soft reset, and places everyone again', async () => {
    for (let i = 0; i < 6; i++) play('a');
    const muBefore = (db.prepare('SELECT mu, sigma FROM player_ratings WHERE player_id = ? AND season_id = 1').get(IDS[0]) as { mu: number; sigma: number });

    const preview = await get('/api/admin/seasons/preview', admin);
    expect(preview.rows).toHaveLength(8);
    expect(row(preview.rows, IDS[0])).toMatchObject({ games: 6, newMu: softResetRating(muBefore).mu });

    const r = startNewSeason(db, 'Season 1');
    expect(r.ok).toBe(true);
    const s1 = currentSeasonId(db);
    expect(seasonRules(db, s1)).toEqual({ srSigmaK: 1, placementGames: 5, ranks: true, finalMinGames: 20 });

    // Frozen: 6 games is under the 20 a final place needs, so nobody holds one.
    const frozen = db.prepare('SELECT * FROM season_results WHERE season_id = 1 AND player_id = ?').get(IDS[0]) as any;
    expect(frozen).toMatchObject({ games: 6, wins: 6, losses: 0, final_rank: null });

    // Seeded but unplayed: off the new ladder.
    expect((await get('/api/leaderboard')).rows).toEqual([]);
    const seeded = db.prepare('SELECT mu, sigma, wins, losses FROM player_ratings WHERE player_id = ? AND season_id = ?').get(IDS[0], s1);
    expect(seeded).toMatchObject({ ...softResetRating(muBefore), wins: 0, losses: 0 });

    // Placing: no SR, no rank, no SR change anywhere.
    const m = play('a');
    let lb = await get('/api/leaderboard');
    expect(row(lb.rows, IDS[0])).toMatchObject({ sr: null, rank: null, ranked: false, placing: { played: 1, of: 5 } });
    const prof = await get(`/api/players/${IDS[0]}`);
    expect(prof.rating.sr).toBeNull();
    expect(prof.rating.mu).toBeUndefined();
    expect(prof.season).toMatchObject({ placing: { played: 1, of: 5 }, sr: null });
    expect(prof.history).toEqual([]);
    expect(prof.matches[0]).toMatchObject({ srDelta: null, placement: { kind: 'placing', played: 1, of: 5 } });
    const match = await get(`/api/matches/${m}`);
    expect(row(match.players, IDS[0])).toMatchObject({ srDelta: null });

    // The fifth game places them and shows the rank, the sixth a change.
    for (let i = 0; i < 3; i++) play('a');
    const fifth = play('a');
    const sixth = play('b');
    lb = await get('/api/leaderboard');
    const me = row(lb.rows, IDS[0]);
    expect(me.placing).toBeNull();
    expect(me.ranked).toBe(true);
    expect(typeof me.sr).toBe('number');
    expect(me.rank.name).toMatch(/^(Bronze|Silver|Gold|Platinum|Diamond|Master) (III|II|I)$/);
    expect(row((await get(`/api/matches/${fifth}`)).players, IDS[0]).placedRank).toMatch(/ (III|II|I)$/);
    expect(typeof row((await get(`/api/matches/${sixth}`)).players, IDS[0]).srDelta).toBe('number');

    // Past seasons on the profile.
    const prof2 = await get(`/api/players/${IDS[0]}`);
    expect(prof2.pastSeasons).toEqual([expect.objectContaining({ seasonId: 1, games: 6, wins: 6, finalRank: null })]);
  });

  it('a recompute replays a soft-reset season from its seeds', () => {
    for (let i = 0; i < 3; i++) play('a');
    startNewSeason(db, 'Season 1');
    const s1 = currentSeasonId(db);
    play('b'); play('a');
    const before = seasonLadder(db, s1).get(IDS[0])!;
    recomputeSeasonRatings(db, s1);
    const after = seasonLadder(db, s1).get(IDS[0])!;
    expect(after.mu).toBeCloseTo(before.mu, 9);
    expect(after.sigma).toBeCloseTo(before.sigma, 9);
  });

  it('the final standings need the season minimum of games', () => {
    db.prepare('UPDATE seasons SET final_min_games = 2 WHERE id = 1').run();
    play('a'); play('a');
    startNewSeason(db, 'Season 1');
    const ranks = db.prepare('SELECT player_id, final_rank FROM season_results WHERE season_id = 1 ORDER BY final_rank').all() as { player_id: string; final_rank: number }[];
    expect(ranks.map((r) => r.final_rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Winners above losers.
    expect(IDS.slice(0, 4)).toContain(ranks[0].player_id);
  });
});
