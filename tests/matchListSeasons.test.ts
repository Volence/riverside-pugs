// tests/matchListSeasons.test.ts
// GET /api/matches by season (owner, 2026-11-03): the current season by
// default, ?season=N or ?season=all, ?before= paging with a `more` flag, and
// a header summary over the whole scope rather than the page.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';

let db: DB;
let app: FastifyInstance;
let ids: string[];
let s0: number[];
let s1: number[];
let current: number;

const lines = () => ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));

/** A completed match in `season`, `a` to `b`. */
function match(season: number, a: number, b: number, o: { campaign?: string; visibility?: 'public' | 'participants' } = {}): number {
  const id = seedMatch(db, {
    endedAt: '2026-11-01 12:00:00', a, b, winner: a >= b ? 'a' : 'b', campaign: o.campaign,
    kind: o.visibility ? 'scrim' : 'pug', visibility: o.visibility, lines: [],
  });
  db.prepare('UPDATE matches SET season_id = ? WHERE id = ?').run(season, id);
  return id;
}

beforeEach(async () => {
  db = openDb(':memory:');
  ids = seedPlayers(db, 8);
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {},
  });
  db.prepare("UPDATE seasons SET name = 'Season 0' WHERE id = 1").run();
  s0 = [match(1, 500, 400, { campaign: 'no_mercy' }), match(1, 900, 100, { campaign: 'death_toll' })];
  db.prepare("UPDATE seasons SET ended_at = '2026-11-03 00:00:00' WHERE id = 1").run();
  current = Number(db.prepare("INSERT INTO seasons (name) VALUES ('Season 1: Wrong Way')").run().lastInsertRowid);
  s1 = [match(current, 600, 590, { campaign: 'dead_air' }), match(current, 700, 500, { campaign: 'dead_air' })];
});
afterEach(async () => { await app.close(); });

const get = (url: string, who?: string) =>
  app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, db, who) : undefined });
const listed = async (url: string, who?: string) => ((await get(url, who)).json().matches as { id: number }[]).map((m) => m.id);

describe('GET /api/matches by season', () => {
  it('lists the current season by default and says which', async () => {
    const body = (await get('/api/matches')).json();
    expect(body.matches.map((m: { id: number }) => m.id)).toEqual([s1[1], s1[0]]);
    expect(body.season).toEqual({ id: current, name: 'Season 1: Wrong Way', current: true });
    expect(body.more).toBe(false);
  });

  it('lists one past season by id, and every season with season=all', async () => {
    const past = (await get('/api/matches?season=1')).json();
    expect(past.matches.map((m: { id: number }) => m.id)).toEqual([s0[1], s0[0]]);
    expect(past.season).toEqual({ id: 1, name: 'Season 0', current: false });
    const all = (await get('/api/matches?season=all')).json();
    expect(all.matches.map((m: { id: number; seasonId: number }) => [m.id, m.seasonId]))
      .toEqual([[s1[1], current], [s1[0], current], [s0[1], 1], [s0[0], 1]]);
    expect(all.season).toBeNull();
  });

  it('refuses a season that does not exist and a bad cursor', async () => {
    expect((await get('/api/matches?season=99')).statusCode).toBe(404);
    expect((await get('/api/matches?season=nope')).statusCode).toBe(404);
    expect((await get('/api/matches?before=abc')).statusCode).toBe(400);
    expect((await get('/api/matches?before=-3')).statusCode).toBe(400);
  });

  it('summarises the whole scope', async () => {
    const cur = (await get('/api/matches')).json().summary;
    expect(cur).toEqual({
      matches: 2, campaigns: 1, avgMargin: 105,
      closest: { id: s1[0], campaign: 'dead_air', teamAScore: 600, teamBScore: 590 },
      widest: { id: s1[1], campaign: 'dead_air', teamAScore: 700, teamBScore: 500 },
    });
    const all = (await get('/api/matches?season=all')).json().summary;
    expect(all).toMatchObject({ matches: 4, campaigns: 3, closest: { id: s1[0] }, widest: { id: s0[1] } });
  });

  it('has no summary for a season with no matches yet', async () => {
    db.prepare("UPDATE seasons SET ended_at = '2026-11-04 00:00:00' WHERE id = ?").run(current);
    db.prepare("INSERT INTO seasons (name) VALUES ('Season 2')").run();
    const body = (await get('/api/matches')).json();
    expect(body).toMatchObject({ matches: [], more: false, summary: null, season: { name: 'Season 2', current: true } });
  });

  it('pages 50 at a time with before= and counts every match in the summary', async () => {
    const extra = Array.from({ length: 55 }, (_, n) => match(current, 600 + n, 600));
    const first = (await get('/api/matches')).json();
    expect(first.matches).toHaveLength(50);
    expect(first.more).toBe(true);
    expect(first.summary.matches).toBe(57);
    // Both ends of the margin sit past the first page: the 600 - 600 on the
    // first extra and the 700 - 500 before it.
    expect(first.summary.closest.id).toBe(extra[0]);
    expect(first.summary.widest.id).toBe(s1[1]);
    const lowest = first.matches[49].id;
    const second = (await get(`/api/matches?before=${lowest}`)).json();
    expect(second.matches.map((m: { id: number }) => m.id)).toEqual([...extra.slice(0, 5).reverse(), s1[1], s1[0]]);
    expect(second.more).toBe(false);
    expect(second.summary.matches).toBe(57);
  });

  it('keeps the visibility filter on the list and the summary', async () => {
    const hidden = match(current, 1000, 0, { visibility: 'participants', campaign: 'blood_harvest' });
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(hidden, ids[0]);
    const outside = (await get('/api/matches')).json();
    expect(outside.matches.map((m: { id: number }) => m.id)).not.toContain(hidden);
    expect(outside.summary).toMatchObject({ matches: 2, campaigns: 1, widest: { id: s1[1] } });
    const player = (await get('/api/matches', ids[0])).json();
    expect(player.matches.map((m: { id: number }) => m.id)).toContain(hidden);
    expect(player.summary).toMatchObject({ matches: 3, campaigns: 2, widest: { id: hidden } });
    expect(await listed('/api/matches?season=all')).not.toContain(hidden);
  });
});
