import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { replayRoutes } from '../src/routes/replays.js';
import { openDb, type DB } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { stubOrchestrator } from './helpers.js';
import { liveFileName } from '../src/replayPush.js';
import {
  encodeHeader, encodeFrame, decodeHeader, VERSION, PLAYER_SLOTS,
  type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const TOKEN = 'a'.repeat(32);
const STARTED = 1_785_956_274;

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: STARTED, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    infectedMask: 0,
    sidesKnown: false,
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

const WHOLE = Buffer.concat([
  encodeHeader(header()),
  ...Array.from({ length: 20 }, (_, i) => encodeFrame(emptyFrame(i * 100))),
]); // 3520 bytes

let dir: string;
let liveDir: string;
let db: DB;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rplpushroute-'));
  liveDir = join(dir, 'live');
  db = openDb(':memory:');
  app = Fastify();
  await app.register(replayRoutes, { db, replayDir: join(dir, 'replays'), liveDir });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedMatch(state: string, token = TOKEN): void {
  db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, ?, 'no_mercy', ?)`)
    .run(state, token);
}

// Every batch also carries `started`, the round header's own startedUnix
// (see src/replayPush.ts). It must match WHOLE's header so applyPush treats
// every push in a test as the same round.
function body(offset: number, data: Buffer, over: Record<string, unknown> = {}) {
  return {
    token: TOKEN, ordinal: 0, half: 1, offset, started: STARTED, closed: false,
    data: data.toString('base64'), ...over,
  };
}

const push = (payload: object) => app.inject({ method: 'POST', url: '/api/replays/push', payload });
const livePath = () => join(liveDir, liveFileName(TOKEN, 0, 1));

describe('POST /api/replays/push', () => {
  it('writes a live match\'s batch and answers with the new length', async () => {
    seedMatch('live');
    const res = await push(body(0, WHOLE.subarray(0, 1000)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ length: 1000 });
    expect(readFileSync(livePath()).equals(WHOLE.subarray(0, 1000))).toBe(true);
    // Neither the token nor a filename comes back.
    expect(res.payload).not.toContain(TOKEN);
    expect(res.payload).not.toContain('.rpl');
  });

  it('refuses an unknown, finished or aborted match with the same 404, writing nothing', async () => {
    const unknown = await push(body(0, WHOLE));
    expect(unknown.statusCode).toBe(404);
    for (const state of ['completed', 'aborted', 'configuring']) {
      db.prepare('DELETE FROM matches').run();
      seedMatch(state);
      const res = await push(body(0, WHOLE));
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(unknown.json());
    }
    expect(existsSync(livePath())).toBe(false);
  });

  it('refuses a gap with 409 and the length, and accepts the resume', async () => {
    seedMatch('live');
    await push(body(0, WHOLE.subarray(0, 1000)));
    const gap = await push(body(2500, WHOLE.subarray(2500)));
    expect(gap.statusCode).toBe(409);
    expect(gap.json()).toEqual({ length: 1000 });
    const resume = await push(body(1000, WHOLE.subarray(1000)));
    expect(resume.json()).toEqual({ length: 3520 });
    expect(readFileSync(livePath()).equals(WHOLE)).toBe(true);
  });

  it('says why when it refuses a stale round with 409', async () => {
    seedMatch('live');
    await push(body(0, WHOLE));
    // An older round under the same file name: its header's startedUnix is
    // earlier than the one the live copy already holds.
    const older = Buffer.concat([encodeHeader(header({ startedUnix: STARTED - 60 })), WHOLE.subarray(encodeHeader(header()).length)]);
    const res = await push(body(0, older, { started: STARTED - 60 }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ length: 3520, error: 'stale round' });
  });

  it('refuses a malformed batch with 400', async () => {
    seedMatch('live');
    const res = await push(body(0, WHOLE, { half: 3 }));
    expect(res.statusCode).toBe(400);
  });

  it('refuses a body over the cap with 413 before reading it', async () => {
    seedMatch('live');
    const res = await push({ ...body(0, WHOLE), data: 'A'.repeat(140_000) });
    expect(res.statusCode).toBe(413);
    expect(existsSync(livePath())).toBe(false);
  });

  it('patches the header of a closed round', async () => {
    seedMatch('live');
    await push(body(0, WHOLE));
    const res = await push(body(3520, Buffer.alloc(0), {
      closed: true, final: { indexOffset: 0, indexCount: 0, frameCount: 20 },
    }));
    expect(res.json()).toEqual({ length: 3520 });
    expect(decodeHeader(readFileSync(livePath()))?.frameCount).toBe(20);
  });

  it('is off when no live directory is configured', async () => {
    const off = Fastify();
    await off.register(replayRoutes, { db, replayDir: join(dir, 'replays') });
    await off.ready();
    seedMatch('live');
    const res = await off.inject({ method: 'POST', url: '/api/replays/push', payload: body(0, WHOLE) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'live push is not configured' });
    await off.close();
  });

  it('answers a fixed error and never logs the token when the live directory cannot be created', async () => {
    seedMatch('live');
    // A regular file where the live directory should be: mkdirSync inside
    // applyPush throws EEXIST, and the path in that error's own message
    // contains the match token (pug_<token>_0_1.rpl's parent).
    const blockedPath = join(dir, 'blocked-live');
    writeFileSync(blockedPath, 'not a directory');
    const blocked = Fastify();
    await blocked.register(replayRoutes, { db, replayDir: join(dir, 'replays'), liveDir: blockedPath });
    await blocked.ready();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await blocked.inject({ method: 'POST', url: '/api/replays/push', payload: body(0, WHOLE) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'live push is unavailable right now' });
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          const text = typeof arg === 'string' ? arg : JSON.stringify(arg);
          expect(text).not.toContain(TOKEN);
          expect(text).not.toContain(blockedPath);
        }
      }
    } finally {
      spy.mockRestore();
      await blocked.close();
    }
  });

  it('is registered on the real server with the configured live directory', async () => {
    const real = await buildServer({
      config: loadConfig({ REPLAY_DIR: join(dir, 'replays'), REPLAY_LIVE_DIR: liveDir }),
      db: openDb(':memory:'),
      orchestrator: stubOrchestrator(),
      serverExec: async () => {},
    });
    const res = await real.inject({ method: 'POST', url: '/api/replays/push', payload: body(0, WHOLE) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no live match for that token' });
    await real.close();
  });
});
