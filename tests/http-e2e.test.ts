import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  app = await buildServer({ config: loadConfig({ DEV_MODE: '1' }), db: openDb(':memory:'), serverExec: async () => {} });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await app.close();
});

describe('real-fetch HTTP (frontend request shapes)', () => {
  it('POST with no body succeeds (mirrors the Join/Ready buttons)', async () => {
    // dev login (sends a JSON body)
    const login = await fetch(`${base}/api/dev/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steamid: '76561198000000001' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    // queue join with NO body and NO content-type, exactly how the frontend api() sends it
    const join = await fetch(`${base}/api/queue/join`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(join.status).toBe(200);
    expect(await join.json()).toEqual({ ok: true });
  });
});
