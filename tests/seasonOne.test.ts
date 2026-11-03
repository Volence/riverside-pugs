import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { completeMatch } from '../src/matchResult.js';
import { currentSeasonId } from '../src/players.js';
import { recomputeSeasonRatings } from '../src/rating.js';
import { startNewSeason } from '../src/seasons.js';
import { setSetting } from '../src/settings.js';
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
  it('Silver starts at 1100, Gold 1600, Plat 2100, Diamond 2700, Master 3300, three divisions each', () => {
    expect(rankView(rankIndexOf(0)).name).toBe('Bronze III');
    expect(rankView(rankIndexOf(1099)).name).toBe('Bronze I');
    expect(rankView(rankIndexOf(1100)).name).toBe('Silver III');
    expect(rankView(rankIndexOf(1600)).name).toBe('Gold III');
    expect(rankView(rankIndexOf(2100)).name).toBe('Platinum III');
    expect(rankView(rankIndexOf(2700)).name).toBe('Diamond III');
    expect(rankView(rankIndexOf(3300)).name).toBe('Master III');
    expect(rankView(rankIndexOf(9999))).toMatchObject({ name: 'Master I', next: null });
    expect(rankFloor(7)).toBe(1767); // Gold II
    expect(rankFloor(13)).toBe(2900); // Diamond II
    expect(rankFloor(17)).toBe(3700); // Master I
  });

  it('ranks up at once and down only past the buffer', () => {
    const gold3 = rankIndexOf(1600);
    expect(rankAfter(null, 1650)).toBe(gold3);
    expect(rankAfter(gold3 - 1, 1600)).toBe(gold3);
    expect(rankAfter(gold3, 1600 - DEMOTION_BUFFER)).toBe(gold3);
    expect(rankAfter(gold3, 1600 - DEMOTION_BUFFER - 1)).toBe(gold3 - 1);
  });

  it('soft reset pulls mu 30% toward 25 from below, 50% from above, and floors sigma at 6', () => {
    expect(softResetRating({ mu: 45, sigma: 4 })).toEqual({ mu: 35, sigma: 6 });
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

describe('rank-up moment', () => {
  it('celebrates finishing placement, then each move up, and stays quiet otherwise', async () => {
    const moment = async () => (await get('/api/me/rank-moment', admin)).moment;
    expect(await moment()).toBeNull(); // Season 0: nothing launches before Season 1
    startNewSeason(db, 'Season 1');
    for (let i = 0; i < 4; i++) play('a');
    expect(await moment()).toBeNull(); // still placing
    const fifth = play('a');
    expect(await moment()).toMatchObject({ kind: 'placed', matchId: fifth });
    const s1 = currentSeasonId(db);
    let up: any = null;
    for (let i = 0; i < 30 && !up; i++) {
      const before = seasonLadder(db, s1).get(ADMIN)!.rankIdx!;
      const m = play('a');
      const after = seasonLadder(db, s1).get(ADMIN)!.rankIdx!;
      const got = await moment();
      if (after > before) up = { got, m, before, after };
      else expect(got).toBeNull();
    }
    expect(up).not.toBeNull();
    expect(up.got).toMatchObject({ kind: 'up', matchId: up.m, from: rankView(up.before).name, to: rankView(up.after).name });
    expect(up.got.srAfter).toBeGreaterThanOrEqual(up.got.floor);
  });
});

describe('season-end trophies', () => {
  it('freezes the highest rank held all season, and the profile shows it as the trophy', async () => {
    startNewSeason(db, 'Season 1');
    const s1 = currentSeasonId(db);
    let maxSeen = -1;
    const results: ('a' | 'b')[] = [...Array(10).fill('a'), ...Array(14).fill('b')];
    for (const w of results) {
      play(w);
      const e = seasonLadder(db, s1).get(IDS[0]);
      if (e?.rankIdx != null) maxSeen = Math.max(maxSeen, e.rankIdx);
    }
    const endIdx = seasonLadder(db, s1).get(IDS[0])!.rankIdx!;
    expect(maxSeen).toBeGreaterThan(endIdx);
    startNewSeason(db, 'Season 2');
    const frozen = db.prepare('SELECT rank_idx, peak_rank_idx FROM season_results WHERE season_id = ? AND player_id = ?').get(s1, IDS[0]) as { rank_idx: number; peak_rank_idx: number };
    expect(frozen).toEqual({ rank_idx: endIdx, peak_rank_idx: maxSeen });
    const prof = await get(`/api/players/${IDS[0]}`);
    expect(prof.pastSeasons.find((p: any) => p.seasonId === s1)).toMatchObject({ peakRank: rankView(maxSeen).name, rank: rankView(endIdx).name });
  });

  it('a season without ranks has no peak-rank trophy', async () => {
    play('a');
    startNewSeason(db, 'Season 1');
    const prof = await get(`/api/players/${IDS[0]}`);
    expect(prof.pastSeasons[0]).toMatchObject({ peakRank: null });
  });
});

describe('season 1 review fixes', () => {
  it('a frozen season never shows the SR of a player who did not place', async () => {
    startNewSeason(db, 'Season 1');
    const s1 = currentSeasonId(db);
    play('a'); play('a');
    startNewSeason(db, 'Season 2');
    const old = await get(`/api/leaderboard?season=${s1}`);
    expect(row(old.rows, IDS[0])).toMatchObject({ sr: null, placing: { played: 2, of: 5 }, ranked: false });
    const prof = await get(`/api/players/${IDS[0]}`);
    expect(prof.pastSeasons.find((p: any) => p.seasonId === s1)).toMatchObject({ sr: null, peakSr: null, placed: false });
  });

  it('a finished season reads from its freeze: a later ban does not drop anyone', async () => {
    play('a');
    startNewSeason(db, 'Season 1');
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', ?, datetime('now'))").run(IDS[1], ADMIN);
    const old = await get('/api/leaderboard?season=1');
    expect(old.rows).toHaveLength(8);
  });

  it('a player who sits a season out keeps a soft-reset seed into the next', () => {
    play('a');
    startNewSeason(db, 'Season 1');
    const s1 = currentSeasonId(db);
    const seed1 = db.prepare('SELECT mu FROM season_seeds WHERE season_id = ? AND player_id = ?').get(s1, IDS[0]) as { mu: number };
    startNewSeason(db, 'Season 2');
    const seed2 = db.prepare('SELECT mu FROM season_seeds WHERE season_id = ? AND player_id = ?').get(currentSeasonId(db), IDS[0]) as { mu: number };
    expect(seed2.mu).toBeCloseTo(softResetRating({ mu: seed1.mu, sigma: 6 }).mu, 9);
  });

  it('Season 0 hands out no Top 10 badge', async () => {
    db.prepare('UPDATE seasons SET final_min_games = 1 WHERE id = 1').run();
    play('a');
    const lb = await get('/api/leaderboard');
    expect(lb.rows.every((r: any) => r.top10 === false)).toBe(true);
  });
});

describe('season look', () => {
  const post = (url: string, payload: object, cookies = admin) => app.inject({ method: 'POST', url, cookies, payload });

  it('a new season can start with a theme and end date, and /api/site reports them', async () => {
    expect((await get('/api/site')).season).toMatchObject({ theme: null, endsAt: null });
    const r = await post('/api/admin/seasons/new', { name: 'Season 1: Wrong Way', theme: 'wrong-way', endsAt: '2026-12-28' });
    expect(r.statusCode).toBe(200);
    expect((await get('/api/site')).season).toMatchObject({ name: 'Season 1: Wrong Way', theme: 'wrong-way', endsAt: '2026-12-28' });
    const seasons = (await get('/api/seasons')).seasons;
    expect(seasons[0]).toMatchObject({ theme: 'wrong-way', endsAt: '2026-12-28', ranks: true });
    expect(seasons[1]).toMatchObject({ theme: null, ranks: false });
  });

  it('staff can change or clear the current look; unknown themes and bad dates are refused', async () => {
    const id = currentSeasonId(db);
    expect((await post(`/api/admin/seasons/${id}/look`, { theme: 'wrong-way', endsAt: null })).statusCode).toBe(200);
    expect((await get('/api/site')).season.theme).toBe('wrong-way');
    expect((await post(`/api/admin/seasons/${id}/look`, { theme: 'neon', endsAt: null })).statusCode).toBe(400);
    expect((await post(`/api/admin/seasons/${id}/look`, { theme: null, endsAt: '28/12/2026' })).statusCode).toBe(400);
    expect((await post(`/api/admin/seasons/${id}/look`, { theme: '', endsAt: '' })).statusCode).toBe(200);
    expect((await get('/api/site')).season).toMatchObject({ theme: null, endsAt: null });
    expect((await post(`/api/admin/seasons/${id}/look`, { theme: 'wrong-way' }, authedCookie(app, db, IDS[1]))).statusCode).toBe(403);
  });

  // The site hides every duo surface (the profile's Duo queue chip) unless
  // this is true: Season 1 live and duo_queue_enabled not switched off.
  it('/api/site says whether the duo queue is on', async () => {
    expect((await get('/api/site')).duoQueue).toBe(false);
    db.prepare('UPDATE seasons SET ranks = 1').run();
    expect((await get('/api/site')).duoQueue).toBe(true);
    setSetting(db, 'duo_queue_enabled', '0');
    expect((await get('/api/site')).duoQueue).toBe(false);
  });
});
