import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { stubOrchestrator } from './helpers.js';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator() });
});

/** The frontend uses real URLs rather than hash routes, so the server has to
 *  answer paths it has no route for with the app shell. The interesting half of
 *  that rule is where it must NOT apply. */
describe('SPA fallback', () => {
  /* Asserted on content type rather than status, deliberately. dist/public is a
   * build artifact this suite does not produce, so the status depends on whether
   * someone has run `npm run build`: 200 with the shell if so, 404 from
   * fastify-static if not. What is invariant either way, and what this test is
   * actually about, is that the request went down the static/page path at all:
   * it is answered as HTML and never as the JSON 404 below. */
  it('routes a deep page link to the app shell, not to the JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/player/76561198000000001' });
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).not.toContain('"error"');
  });

  it('keeps unknown API paths as JSON 404s, not HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('keeps unknown auth paths as JSON 404s', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('does not hand the shell to a non-GET request', async () => {
    const res = await app.inject({ method: 'POST', url: '/some/page' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });
});
