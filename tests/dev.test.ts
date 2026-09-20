import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { stubOrchestrator } from './helpers.js';

describe('dev routes', () => {
  it('reports dev mode off, without 404ing, when dev mode is off', async () => {
    // The probe answers in both modes on purpose: when it existed only in dev
    // mode, every production page load logged a 404 in the browser console.
    const app = await buildServer({
      config: loadConfig({}), db: openDb(':memory:'), orchestrator: stubOrchestrator(), serverExec: async () => {},
    });
    const res = await app.inject({ method: 'GET', url: '/api/dev/enabled' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });

  it('still registers no actual dev endpoint when dev mode is off', async () => {
    // The part that must never regress. /api/dev/enabled became reachable in
    // production; the endpoints that log you in as anyone and fabricate matches
    // must not have come with it.
    const app = await buildServer({
      config: loadConfig({}), db: openDb(':memory:'), orchestrator: stubOrchestrator(), serverExec: async () => {},
    });
    for (const url of ['/api/dev/login', '/api/dev/fill', '/api/dev/ready-all',
      '/api/dev/vote-all', '/api/dev/clear-matches', '/api/dev/simulate-match']) {
      const res = await app.inject({ method: 'POST', url, payload: { steamid: '76561198000000001' } });
      expect(res.statusCode, `${url} must not exist outside dev mode`).toBe(404);
    }
  });

  it('reports dev mode on when it is on', async () => {
    const app = await buildServer({ config: loadConfig({ DEV_MODE: '1' }), db: openDb(':memory:'), serverExec: async () => {} });
    const res = await app.inject({ method: 'GET', url: '/api/dev/enabled' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });

  it('drives a full match with one real user + fakes', async () => {
    const app = await buildServer({ config: loadConfig({ DEV_MODE: '1' }), db: openDb(':memory:'), serverExec: async () => {} });

    const login = await app.inject({
      method: 'POST', url: '/api/dev/login', payload: { steamid: '76561198000000001' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === 'pug_session')!;
    const cookies = { pug_session: cookie.value };

    await app.inject({ method: 'POST', url: '/api/queue/join', cookies });
    await app.inject({ method: 'POST', url: '/api/dev/fill', cookies });
    await app.inject({ method: 'POST', url: '/api/dev/ready-all', cookies });
    await app.inject({ method: 'POST', url: '/api/dev/vote-all', cookies, payload: { campaign: 'dead_air' } });

    const state = (await app.inject({ method: 'GET', url: '/api/state', cookies })).json();
    expect(state.match.campaign).toBe('dead_air');
    expect(state.match.teamA.length + state.match.teamB.length).toBe(8);
  });

  it('finish-match completes the open match with fake stats and ratings', async () => {
    const db = openDb(':memory:');
    const app = await buildServer({ config: loadConfig({ DEV_MODE: '1' }), db, serverExec: async () => {} });

    await app.inject({ method: 'POST', url: '/api/dev/fill' });
    await app.inject({ method: 'POST', url: '/api/dev/ready-all' });
    await app.inject({ method: 'POST', url: '/api/dev/vote-all' });
    const res = await app.inject({ method: 'POST', url: '/api/dev/finish-match' });
    expect(res.statusCode).toBe(200);
    const { matchId } = res.json();
    const m = db.prepare('SELECT state, winner FROM matches WHERE id = ?').get(matchId) as any;
    expect(m.state).toBe('completed');
    expect(['a', 'b', 'draw']).toContain(m.winner);
    expect((db.prepare('SELECT COUNT(*) n FROM match_maps WHERE match_id = ?').get(matchId) as any).n).toBe(4);
    expect((db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId) as any).n).toBe(8);
  });

  it('finish-match 409s with no open match', async () => {
    const db = openDb(':memory:');
    const app = await buildServer({ config: loadConfig({ DEV_MODE: '1' }), db, serverExec: async () => {} });

    const res = await app.inject({ method: 'POST', url: '/api/dev/finish-match' });
    expect(res.statusCode).toBe(409);
  });

  it('simulate-match runs a full fake match in one call', async () => {
    const db = openDb(':memory:');
    const app = await buildServer({ config: loadConfig({ DEV_MODE: '1' }), db, serverExec: async () => {} });

    const res = await app.inject({ method: 'POST', url: '/api/dev/simulate-match' });
    expect(res.statusCode).toBe(200);
    const { matchId } = res.json();
    expect((db.prepare("SELECT state FROM matches WHERE id = ?").get(matchId) as any).state).toBe('completed');
  });
});
