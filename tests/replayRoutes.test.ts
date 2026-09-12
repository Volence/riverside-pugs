import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { replayRoutes } from '../src/routes/replays.js';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { stubOrchestrator } from './helpers.js';
import {
  encodeHeader, encodeFrame, decodeHeader, VERSION, HEADER_BYTES,
  PLAYER_SLOTS, frameBytes, type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const TOKEN = 'a'.repeat(32);

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: Math.floor(Date.now() / 1000) - 600,
    indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  };
}

let dir: string;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rplroutes-'));
  app = Fastify();
  await app.register(replayRoutes, { db: openDb(':memory:'), replayDir: dir });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Write a file whose frames run from t=0 at `startedSecondsAgo` seconds ago,
 *  one frame per second, so the delay cutoff is easy to reason about. */
function writeRound(name: string, frames: number, startedSecondsAgo: number, closed: boolean): void {
  const parts: Uint8Array[] = [
    encodeHeader(header({
      startedUnix: Math.floor(Date.now() / 1000) - startedSecondsAgo,
      frameCount: closed ? frames : 0,
    })),
  ];
  for (let i = 0; i < frames; i++) parts.push(encodeFrame(emptyFrame(i * 1000)));
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat(parts));
  const secs = Date.now() / 1000;
  utimesSync(path, secs, secs);
}

describe('GET /api/replays/sessions', () => {
  it('lists sessions grouped by token', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: '/api/replays/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: { token: string; files: unknown[] }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].token).toBe(TOKEN);
  });
});

describe('GET /api/replays/file/:name', () => {
  it('serves a closed file whole', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(HEADER_BYTES + frameBytes(0) * 5);
    expect(res.headers['x-replay-closed']).toBe('1');
  });

  it('serves only the bytes after `since`', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const since = HEADER_BYTES + frameBytes(0) * 2;
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=${since}` });
    expect(res.rawPayload.length).toBe(frameBytes(0) * 3);
    expect(res.headers['x-replay-next']).toBe(String(HEADER_BYTES + frameBytes(0) * 5));
  });

  // THE test. Everything else in this file is plumbing; this is the security
  // model of a public live page. The round started 15 seconds ago and has 15
  // frames at one per second, so frames t=0..4 are older than the 10 second
  // delay and frames t=5..14 are not.
  it('never serves a byte past the cutoff for an open file', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 15, false);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-replay-closed']).toBe('0');

    const served = res.rawPayload.length;
    const whole = HEADER_BYTES + frameBytes(0) * 15;
    expect(served).toBeLessThan(whole);
    // At most six frames: the five certainly outside the window, plus one for
    // the second that may have ticked over between writing and serving.
    const frames = (served - HEADER_BYTES) / frameBytes(0);
    expect(frames).toBeGreaterThanOrEqual(4);
    expect(frames).toBeLessThanOrEqual(6);
  });

  it('serves the header alone when no frame is old enough yet', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 3, 2, false);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.rawPayload.length).toBe(HEADER_BYTES);
    expect(decodeHeader(res.rawPayload)?.token).toBe(TOKEN);
  });

  it('404s a traversal attempt', async () => {
    const res = await app.inject({ url: '/api/replays/file/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown file', async () => {
    const res = await app.inject({ url: `/api/replays/file/pug_${'b'.repeat(32)}_0_1.rpl` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/replays/live/:token', () => {
  it('names the newest file for the token', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    writeRound(`pug_${TOKEN}_1_1.rpl`, 5, 60, false);
    const res = await app.inject({ url: `/api/replays/live/${TOKEN}` });
    expect(res.json()).toEqual({ filename: `pug_${TOKEN}_1_1.rpl`, closed: false });
  });

  it('404s an unknown token', async () => {
    const res = await app.inject({ url: `/api/replays/live/${'c'.repeat(32)}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('replayRoutes registration on the real server', () => {
  it('is registered on the real server', async () => {
    // Every other test in this file registers replayRoutes directly onto a bare
    // Fastify instance, which is the right harness for exercising the cutoff but
    // proves nothing about src/server.ts. This one test exists so that deleting
    // the register line there fails something.
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const real = await buildServer({
      config: loadConfig({ REPLAY_DIR: dir }),
      db: openDb(':memory:'),
      orchestrator: stubOrchestrator(),
    });
    const res = await real.inject({ url: '/api/replays/sessions' });
    expect(res.statusCode).toBe(200);
    await real.close();
  });
});
