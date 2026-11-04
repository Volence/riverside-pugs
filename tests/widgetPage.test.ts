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
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverExec: async () => {} });
});

/* As in spaFallback.test.ts, dist/public is a build artifact this suite does
 * not produce, so the status depends on whether a build has run. The widget
 * page is told apart from the app shell by its Cache-Control: no-cache, which
 * the not-found handler sets only on widget.html, and, when a build exists,
 * by its body. */
describe('/widget page', () => {
  it('answers /widget/<steamid>/<kind> with the widget page', async () => {
    for (const url of ['/widget/76561198000000001/live', '/widget/76561198000000001/rating/', '/widget/76561198000000001/queue?style=bar&size=l']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).not.toContain('"error"');
      // With a build present, the bytes are widget.html's.
      if (res.statusCode === 200) expect(res.body).toContain('<div id="widget">');
    }
  });

  it('answers a malformed widget path with the normal app shell', async () => {
    for (const url of ['/widget/abc/live', '/widget/7656119800000000/live', '/widget/76561198000000001']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).not.toBe('no-cache');
      expect(res.body).not.toContain('<div id="widget">');
    }
  });

  it('keeps an unknown /api/widget id a JSON 404, not HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/widget/x' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toHaveProperty('error');
  });
});
