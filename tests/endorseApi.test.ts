import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
const OUTSIDER = '76561198000000099';
let db: DB;
let app: FastifyInstance;

function seedMatch(id: number, hoursAgo = 0): void {
  db.prepare(
    `INSERT INTO matches (id, season_id, state, campaign, winner, ended_at)
     VALUES (?, 1, 'completed', 'no_mercy', 'a', datetime('now', ?))`,
  ).run(id, `-${hoursAgo} hours`);
  IDS.forEach((p, i) => {
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, p, i < 4 ? 'a' : 'b');
  });
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => IDS[0],
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    serverExec: async () => {},
  });
  [...IDS, OUTSIDER].forEach((id, i) => upsertPlayer(db, { steamid: id, name: `n${i}`, avatar: null }, []));
  seedMatch(1);
});
afterEach(async () => { await app.close(); });

describe('POST /api/matches/:id/endorse', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', payload: { to: IDS[1], kind: 'caller' } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a signed-in player who is not active', async () => {
    const cookies = authedCookie(app, db, IDS[0], { active: false });
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: IDS[1], kind: 'caller' } });
    expect(res.statusCode).toBe(403);
  });

  it('records one and hands back the fresh state', async () => {
    const cookies = authedCookie(app, db, IDS[0]);
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: IDS[5], kind: 'clutch' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.remaining).toBe(1);
    expect(body.state.given).toEqual([{ to: IDS[5], kind: 'clutch' }]);
  });

  it('takes the giver from the session and ignores one in the body', async () => {
    const cookies = authedCookie(app, db, IDS[0]);
    await app.inject({
      method: 'POST', url: '/api/matches/1/endorse', cookies,
      payload: { from: IDS[3], to: IDS[5], kind: 'clutch' },
    });
    const row = db.prepare('SELECT from_id FROM endorsements').get() as { from_id: string };
    expect(row.from_id).toBe(IDS[0]);
  });

  it('answers a refusal with the sentence and the code', async () => {
    const cookies = authedCookie(app, db, OUTSIDER);
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: IDS[5], kind: 'clutch' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'You were not in this match.', code: 'not_rostered' });
  });

  it('refuses a body that is not two strings', async () => {
    const cookies = authedCookie(app, db, IDS[0]);
    const res = await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: 5 } });
    expect(res.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM endorsements').get()).toEqual({ n: 0 });
  });
});

describe('GET /api/matches/:id/endorse and /api/endorse/pending', () => {
  it('both need a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/matches/1/endorse' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/endorse/pending' })).statusCode).toBe(401);
  });

  it('gives a rostered player their panel and an outsider the reason', async () => {
    const mine = await app.inject({ method: 'GET', url: '/api/matches/1/endorse', cookies: authedCookie(app, db, IDS[0]) });
    expect(mine.json()).toMatchObject({ eligible: true, remaining: 2, budget: 2 });
    expect(mine.json().candidates).toHaveLength(7);
    const theirs = await app.inject({ method: 'GET', url: '/api/matches/1/endorse', cookies: authedCookie(app, db, OUTSIDER) });
    expect(theirs.json()).toMatchObject({ eligible: false, reason: 'not_rostered', candidates: [] });
  });

  it('lists what is still unspent', async () => {
    const cookies = authedCookie(app, db, IDS[0]);
    const res = await app.inject({ method: 'GET', url: '/api/endorse/pending', cookies });
    expect(res.json()).toEqual({ pending: [{ matchId: 1, remaining: 2 }] });
  });
});

describe('titles and counts on the public read models', () => {
  beforeEach(async () => {
    setSetting(db, 'endorse_title_min', '1');
    setSetting(db, 'endorse_title_min_games', '1');
    const cookies = authedCookie(app, db, IDS[0]);
    await app.inject({ method: 'POST', url: '/api/matches/1/endorse', cookies, payload: { to: IDS[5], kind: 'caller' } });
  });

  it('the profile carries counts, a rate and the title, and never a giver', async () => {
    const body = (await app.inject({ method: 'GET', url: `/api/players/${IDS[5]}` })).json();
    expect(body.endorsements).toEqual({ counts: { caller: 1, clutch: 0, vibes: 0 }, total: 1, perMatch: 1, title: 'caller' });
  });

  it('the match page carries each player their title', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/matches/1' })).json();
    const byId = Object.fromEntries(body.players.map((p: { steamid: string; title: string | null }) => [p.steamid, p.title]));
    expect(byId[IDS[5]]).toBe('caller');
    expect(byId[IDS[1]]).toBeNull();
    // Anonymous: nothing on the public match payload says who gave it.
    expect(JSON.stringify(body)).not.toContain('from_id');
    expect(body.endorsements).toBeUndefined();
  });

  it('the leaderboard carries the title too', async () => {
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, 1, 25, 8)').run(IDS[5]);
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, 1, 25, 8)').run(IDS[1]);
    const body = (await app.inject({ method: 'GET', url: '/api/leaderboard' })).json();
    const byId = Object.fromEntries(body.rows.map((r: { steamid: string; title: string | null }) => [r.steamid, r.title]));
    expect(byId[IDS[5]]).toBe('caller');
    expect(byId[IDS[1]]).toBeNull();
  });
});
