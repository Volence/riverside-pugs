import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { completeMatch } from '../src/matchResult.js';
import { currentSeasonId } from '../src/players.js';
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

const post = (url: string, payload: object = {}, cookies = admin) => app.inject({ method: 'POST', url, cookies, payload });
const get = (url: string) => app.inject({ method: 'GET', url }).then((r) => r.json());

describe('seasons', () => {
  it('rename the current season', async () => {
    expect((await post('/api/admin/seasons/1/rename', { name: '' })).statusCode).toBe(400);
    expect((await post('/api/admin/seasons/1/rename', { name: 'Season 0' })).statusCode).toBe(200);
    expect((await get('/api/seasons')).seasons).toEqual([expect.objectContaining({ id: 1, name: 'Season 0', current: true })]);
  });

  it('starting a new season ends the old one, resets the ladder, and keeps the old ladder viewable', async () => {
    play('a'); play('a'); play('a');
    const before = await get('/api/leaderboard');
    expect(before.rows.find((r: { steamid: string }) => r.steamid === IDS[0]).wins).toBe(3);

    expect((await post('/api/admin/seasons/new', { name: 'Season 1' })).statusCode).toBe(200);
    const seasons = (await get('/api/seasons')).seasons;
    expect(seasons[0]).toMatchObject({ name: 'Season 1', current: true });
    expect(seasons[1]).toMatchObject({ current: false });
    expect(seasons[1].endedAt).toBeTruthy();

    const now = await get('/api/leaderboard');
    expect(now.season.name).toBe('Season 1');
    expect(now.rows).toEqual([]);
    play('b');
    const after = await get('/api/leaderboard');
    expect(after.rows.find((r: { steamid: string }) => r.steamid === IDS[0])).toMatchObject({ wins: 0, losses: 1, games: 1 });

    const old = await get(`/api/leaderboard?season=${seasons[1].id}`);
    expect(old.season.id).toBe(seasons[1].id);
    expect(old.rows.find((r: { steamid: string }) => r.steamid === IDS[0]).wins).toBe(3);

    const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: admin })).json();
    expect(audit.actions[0]).toMatchObject({ action: 'new_season' });
  });

  it('refuses a new season while a match is being set up or played', async () => {
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'dead_air')").run();
    const r = await post('/api/admin/seasons/new', { name: 'Season 1' });
    expect(r.statusCode).toBe(409);
  });

  it('an unknown season on the leaderboard is a 404, and non-admins cannot manage seasons', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/leaderboard?season=99' })).statusCode).toBe(404);
    const user = authedCookie(app, db, IDS[3]);
    expect((await post('/api/admin/seasons/new', { name: 'x' }, user)).statusCode).toBe(403);
    expect((await post('/api/admin/seasons/1/rename', { name: 'x' }, user)).statusCode).toBe(403);
  });
});
