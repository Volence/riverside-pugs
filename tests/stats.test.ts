import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { completeMatch } from '../src/matchResult.js';
import { upsertPlayer } from '../src/players.js';
import type { Dump } from '../src/dumpParse.js';

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
    winner,
    totalA, totalB,
  };
  completeMatch(db, matchId, dump);
  return matchId;
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

  it('requires auth', async () => {
    for (const url of ['/api/leaderboard', `/api/players/${ME}`, '/api/matches', '/api/matches/1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
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
    // ME is on the winning team ('a') — SR should have gone up.
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
    // match was won by team 'b' — team 'a' (ME) lost SR, team 'b' gained SR.
    expect(p.srDelta).toBeLessThan(0);
    const winnerPlayer = body.players.find((x: any) => x.steamid === IDS[4]);
    expect(winnerPlayer.team).toBe('b');
    expect(winnerPlayer.srDelta).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/matches/999', cookies })).statusCode).toBe(404);
  });
});
