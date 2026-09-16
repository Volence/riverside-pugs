import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator() });
});

describe('GET /api/queue', () => {
  it('is public and lists who is queued', async () => {
    const steamid = '76561198000000001';
    const cookie = authedCookie(app, db, steamid);
    expect((await app.inject({ method: 'POST', url: '/api/queue/join', cookies: cookie })).statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/queue' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.players[0].steamid).toBe(steamid);
  });

  it('never exposes connect details', async () => {
    const body = await app.inject({ method: 'GET', url: '/api/queue' }).then((r) => r.json());
    // A concrete equality check, not a substring match: it proves no extra
    // field (connect, a password, anything) sneaks into the shape at all.
    expect(body).toEqual({ count: 0, players: [], phase: null });
  });

  it('does not leak a live match token or its derived password through the public queue', async () => {
    const steamid = '76561198000000001';
    const cookie = authedCookie(app, db, steamid);
    expect((await app.inject({ method: 'POST', url: '/api/queue/join', cookies: cookie })).statusCode).toBe(200);

    // Seed a live match directly into the same db, the way
    // tests/matchmaker.test.ts does it, with a token that cannot occur by
    // accident so its presence or absence in the response is unambiguous.
    const serverId = addServer(db, {
      name: 's1',
      host: '10.0.0.1',
      port: 27015,
      rconPort: 27115,
      rconPassword: 'rconpw',
      status: 'live',
    });
    const season = db.prepare('SELECT id FROM seasons ORDER BY id LIMIT 1').get() as { id: number };
    const token = 'deadbeefcafe0000deadbeefcafe0000';
    const matchId = Number(
      db
        .prepare(
          `INSERT INTO matches (season_id, state, campaign, server_id, token)
           VALUES (?, 'live', 'dead_air', ?, ?)`,
        )
        .run(season.id, serverId, token).lastInsertRowid,
    );
    const rostered = '76561198000000099';
    upsertPlayer(db, { steamid: rostered, name: 'rostered', avatar: null }, []);
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(
      matchId, rostered, 'a',
    );

    const res = await app.inject({ method: 'GET', url: '/api/queue' });
    const body = res.json();
    const raw = JSON.stringify(body);

    // The property that matters: not the word "password" (the token itself
    // contains no such word, so that check would pass even on a raw leak),
    // but the actual secret values a real client would need to connect.
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('pug_deadbeef');
    expect(body.connect).toBeUndefined();
  });
});
