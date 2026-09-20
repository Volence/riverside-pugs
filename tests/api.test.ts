import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverExec: async () => {} });
  cookies = {};
  for (const id of IDS) cookies[id] = authedCookie(app, db, id);
});

async function post(url: string, steamid: string, payload?: object) {
  return app.inject({ method: 'POST', url, cookies: cookies[steamid], payload });
}

describe('match pipeline over HTTP', () => {
  it('rejects unauthenticated and inactive players', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/queue/join' })).statusCode).toBe(401);
    const invited = authedCookie(app, db, '76561198000000099', { active: false });
    const res = await app.inject({ method: 'POST', url: '/api/queue/join', cookies: invited });
    expect(res.statusCode).toBe(403);
  });

  it('drives queue -> ready -> vote -> match via the API', async () => {
    for (const id of IDS) expect((await post('/api/queue/join', id)).statusCode).toBe(200);

    let state = (await app.inject({ method: 'GET', url: '/api/state', cookies: cookies[IDS[0]] })).json();
    expect(state.lobby.phase).toBe('ready_check');

    for (const id of IDS) expect((await post('/api/lobby/ready', id)).statusCode).toBe(200);
    // The vote ends the moment the winner cannot be caught, so with everyone
    // picking the same campaign it is settled on the FIFTH vote: 5 beats the 3
    // still outstanding. The last three arrive after the lobby has become a
    // match and are refused, which is the correct answer to a vote in a vote
    // that is over.
    for (const id of IDS.slice(0, 5)) {
      expect((await post('/api/lobby/vote', id, { campaign: 'no_mercy' })).statusCode).toBe(200);
    }
    for (const id of IDS.slice(5)) {
      expect((await post('/api/lobby/vote', id, { campaign: 'no_mercy' })).statusCode).toBe(409);
    }

    state = (await app.inject({ method: 'GET', url: '/api/state', cookies: cookies[IDS[0]] })).json();
    expect(state.lobby).toBeNull();
    expect(state.match.campaign).toBe('no_mercy');
    expect(state.match.state).toBe('configuring');
    expect(state.match.teamA).toHaveLength(4);
    expect(state.match.teamB).toHaveLength(4);
  });

  it('queue leave works and rejects bad votes', async () => {
    await post('/api/queue/join', IDS[0]);
    expect((await post('/api/queue/leave', IDS[0])).statusCode).toBe(200);
    expect((await post('/api/lobby/vote', IDS[0], { campaign: 'no_mercy' })).statusCode).toBe(409);
  });
});
