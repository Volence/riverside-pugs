import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { completeMatch } from '../src/matchResult.js';
import { currentSeasonId } from '../src/players.js';
import type { Dump } from '../src/dumpParse.js';
import { computeWrapped, longestRuns, thin, wrappedTier, type WrappedPlayer } from '../src/seasonWrapped.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 9 }, (_, i) => `7656119900000000${i}`);
const ADMIN = IDS[0];
const DROPIN = IDS[8];
let db: DB;
let app: FastifyInstance;
let admin: Record<string, string>;

/** One completed PUG: `roster[0..3]` on a, the rest on b. */
function play(winner: 'a' | 'b', roster = IDS.slice(0, 8), skeets = 0): number {
  const season = currentSeasonId(db);
  const matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'live', 'dead_air')").run(season).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  roster.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  const dump: Dump = {
    matchId, maps: [{ map: 'm1', a: winner === 'a' ? 300 : 200, b: winner === 'b' ? 300 : 200 }],
    players: roster.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' : 'b', sidmg: 100 + i, sikill: 1, ck: 10, ff: 0, rev: 0 })),
    skillDetect: false, skills: [], winner, totalA: winner === 'a' ? 300 : 200, totalB: winner === 'b' ? 300 : 200,
  };
  completeMatch(db, matchId, dump);
  if (skeets) db.prepare("INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, 'skeets', ?)").run(matchId, roster[0], skeets);
  return matchId;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) authedCookie(app, db, id);
  admin = authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  // A short season: the full deck at 4 games, a final place at 2.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('standing_min_games', '4'), ('chemistry_min_games', '2')").run();
  db.prepare('UPDATE seasons SET final_min_games = 2 WHERE id = 1').run();
});
afterEach(async () => { await app.close(); });

const get = (url: string, cookies?: Record<string, string>) => app.inject({ method: 'GET', url, cookies });
const post = (url: string, cookies = admin) => app.inject({ method: 'POST', url, cookies, payload: {} });

describe('wrapped helpers', () => {
  it('longest runs, thinning and tiers', () => {
    expect(longestRuns([true, true, false, true, true, true, false, false])).toEqual({ win: 3, loss: 2 });
    expect(longestRuns([])).toEqual({ win: 0, loss: 0 });
    const t = thin(Array.from({ length: 100 }, (_, i) => i), 5);
    expect(t).toEqual([0, 25, 50, 74, 99]);
    expect(thin([1, 2], 5)).toEqual([1, 2]);
    expect([wrappedTier(1, 10), wrappedTier(3, 10), wrappedTier(9, 10), wrappedTier(10, 10)]).toEqual(['dropin', 'short', 'short', 'full']);
  });
});

describe('season wrapped', () => {
  function season(): void {
    play('a', undefined, 3); play('a'); play('a'); play('b'); play('a', undefined, 5);
    play('b', [DROPIN, ...IDS.slice(1, 8)]);
  }

  it('computes decks by tier with the gates applied', () => {
    season();
    const { community, players } = computeWrapped(db, 1);
    const by = (id: string) => players.find((p) => p.steamid === id) as WrappedPlayer;
    expect(community.overview.matches).toBe(6);
    expect(community.overview.players).toBe(9);
    expect(community.buckets).toEqual({ full: 8, short: 0, dropin: 1 });

    const a0 = by(IDS[0]);
    expect(a0.tier).toBe('full');
    expect(a0.numbers).toMatchObject({ matches: 5, wins: 4, losses: 1 });
    expect(a0.streaks).toEqual({ win: 3, loss: 1 });
    expect(a0.hours.reduce((s, x) => s + x, 0)).toBe(5);
    expect(a0.first.firstEver).toBe(true);
    expect(a0.bestMatchSkeets?.value).toBe(5);
    expect(a0.signature?.[0]).toMatchObject({ rank: 1 });
    // Always on team a against IDS[4..7]: every opponent is 4-1 for them.
    expect(a0.rivals.nemesis).toMatchObject({ games: 5, wins: 4 });
    expect(a0.people.mostWith?.games).toBe(5);

    const d = by(DROPIN);
    expect(d.tier).toBe('dropin');
    expect(d.signature).toBeNull();
    expect(d.rivals.nemesis).toBeNull();   // one game against anyone, gate is 2
    expect(d.first).toMatchObject({ won: false, firstEver: false });

    expect(community.leaders.skeets[0]).toMatchObject({ steamid: IDS[0], value: 8 });
    expect(community.moments.closest).toHaveLength(3);
  });

  it('banned players get no deck and leave every named list, but count in totals', () => {
    season();
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'cheating', 'x', datetime('now'))").run(IDS[0]);
    const { community, players } = computeWrapped(db, 1);
    expect(players.some((p) => p.steamid === IDS[0])).toBe(false);
    expect(community.overview.players).toBe(9);
    expect(community.totals.skeets).toBe(8);
    expect(community.leaders.skeets).toEqual([]);
    for (const p of players) {
      for (const l of [p.people.mostWith, p.people.bestDuo, p.rivals.nemesis, p.rivals.favourite, p.rivals.mostFaced, p.first.firstPartner]) {
        expect(l?.steamid).not.toBe(IDS[0]);
      }
    }
  });

  it('freezes at the season close and serves the frozen decks', async () => {
    season();
    expect((await get('/api/wrapped')).json()).toEqual({ seasons: [] });
    expect((await get('/api/wrapped/1')).statusCode).toBe(404);

    expect((await app.inject({ method: 'POST', url: '/api/admin/seasons/new', cookies: admin, payload: { name: 'Season 1' } })).statusCode).toBe(200);
    const list = (await get('/api/wrapped')).json();
    expect(list.seasons).toEqual([expect.objectContaining({ id: 1 })]);

    const mine = (await get('/api/wrapped/1', admin)).json();
    expect(mine.loggedIn).toBe(true);
    expect(mine.me).toMatchObject({ steamid: ADMIN, tier: 'full' });
    expect(mine.me.standing).toMatchObject({ finalRank: expect.any(Number), finalMinGames: 2 });
    expect(mine.community.top10.length).toBeGreaterThan(0);

    const anon = (await get('/api/wrapped/1')).json();
    expect(anon).toMatchObject({ loggedIn: false, me: null });

    const shared = await get(`/api/wrapped/1/${IDS[3]}`);
    expect(shared.statusCode).toBe(200);
    expect(shared.json().player.steamid).toBe(IDS[3]);
    expect((await get('/api/wrapped/1/76561199999999999')).statusCode).toBe(404);
    expect((await get('/api/wrapped/1/abc')).statusCode).toBe(404);

    // Frozen: a later match or rename does not move the deck.
    db.prepare("UPDATE players SET name = 'renamed' WHERE steamid = ?").run(IDS[3]);
    expect((await get(`/api/wrapped/1/${IDS[3]}`)).json().player.name).not.toBe('renamed');

    // A ban after the freeze takes the deck down.
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'cheating', 'x', datetime('now'))").run(IDS[3]);
    expect((await get(`/api/wrapped/1/${IDS[3]}`)).statusCode).toBe(404);
  });

  it('staff preview an open season; rebuild only closes seasons', async () => {
    season();
    const r = await get(`/api/admin/wrapped/1/${IDS[1]}`, admin);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ preview: true, player: { steamid: IDS[1] } });
    expect(r.json().player.standing).not.toBeNull();
    expect((await get(`/api/admin/wrapped/1/${IDS[1]}`, authedCookie(app, db, IDS[2]))).statusCode).toBe(403);
    expect((await get('/api/wrapped')).json().seasons).toEqual([]);   // a preview stores nothing

    expect((await post('/api/admin/wrapped/1/rebuild')).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: '/api/admin/seasons/new', cookies: admin, payload: { name: 'Season 1' } });
    const rb = await post('/api/admin/wrapped/1/rebuild');
    expect(rb.json()).toMatchObject({ ok: true, players: 9 });
  });
});
