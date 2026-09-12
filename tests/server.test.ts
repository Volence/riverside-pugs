import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { stubOrchestrator } from './helpers.js';

// Fastify's default error handler, which this app would otherwise fall back
// to because it builds with `logger: false` and no setErrorHandler, puts
// err.message straight into the 500 body. An ENOENT while reading a replay
// carries the absolute path, and for a ranked match that filename contains
// the token that seeds the game server's sv_password. This is the one
// remaining way such a path could cross the wire, so buildServer registers
// its own handler; this test proves an arbitrary thrown error never reaches
// the response body, regardless of what it says.
describe('server error handler', () => {
  it('masks a non-HTTP error behind a fixed 500 message', async () => {
    const app = await buildServer({
      config: loadConfig({}),
      db: openDb(':memory:'),
      orchestrator: stubOrchestrator(),
    });

    const secret = '/srv/pug/replays/pug_deadbeefdeadbeefdeadbeefdeadbeef_0_1.rpl';
    app.get('/__test/throw', async () => {
      throw new Error(`ENOENT: no such file or directory, open '${secret}'`);
    });

    const res = await app.inject({ url: '/__test/throw' });
    expect(res.statusCode).toBe(500);
    expect(res.payload).not.toContain(secret);
    expect(res.payload).not.toContain('deadbeef');
    expect(res.payload).not.toContain('ENOENT');
    expect(res.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'internal server error',
    });

    await app.close();
  });

  // The other half of the same handler: a deliberate HTTP error, the kind
  // Fastify itself raises with a statusCode already set (a malformed request
  // body, for instance), still reaches the client with its own message and
  // status. Modelled here with a route that throws one directly, since that
  // is exactly what a statusCode-bearing error looks like to the handler.
  it('keeps the message and status for an error that carries an explicit statusCode', async () => {
    const app = await buildServer({
      config: loadConfig({}),
      db: openDb(':memory:'),
      orchestrator: stubOrchestrator(),
    });

    app.get('/__test/bad-request', async () => {
      const err = new Error('bad input') as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    });

    const res = await app.inject({ url: '/__test/bad-request' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'bad input',
    });

    await app.close();
  });
});
