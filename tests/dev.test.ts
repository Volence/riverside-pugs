import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

describe('dev routes', () => {
  it('is 404 when dev mode is off', async () => {
    const app = await buildServer({ config: loadConfig({}), db: openDb(':memory:') });
    expect((await app.inject({ method: 'GET', url: '/api/dev/enabled' })).statusCode).toBe(404);
  });

  it('drives a full match with one real user + fakes', async () => {
    const app = await buildServer({ config: loadConfig({ DEV_MODE: '1' }), db: openDb(':memory:') });

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
});
