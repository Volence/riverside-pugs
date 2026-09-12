import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { replayRoutes } from '../src/routes/replays.js';
import { openDb, type DB } from '../src/db.js';
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
let db: DB;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rplroutes-'));
  db = openDb(':memory:');
  app = Fastify();
  await app.register(replayRoutes, { db, replayDir: dir });
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

/** Insert a `matches` row and a `match_replays` row pointing at `filename`.
 *  Returns the match id. Mirrors the pattern in tests/replayPrune.test.ts. */
function seedMatchReplay(
  filename: string, ordinal: number, half: number, bytes: number, frames: number,
): number {
  db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`,
  ).run(TOKEN);
  const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
  db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
     VALUES (?, ?, ?, ?, ?, ?, 10)`,
  ).run(id, ordinal, half, filename, bytes, frames);
  return id;
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

  it('floors a fractional `since` instead of erroring', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const floored = HEADER_BYTES + frameBytes(0) * 2;
    const fractional = floored + 0.5;
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=${fractional}` });
    expect(res.statusCode).toBe(200);
    const expected = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=${floored}` });
    expect(res.rawPayload.equals(expected.rawPayload)).toBe(true);
  });

  it('does not 500 on a non-numeric `since`', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=abc` });
    expect(res.statusCode).toBe(200);
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

  // The same model under a tech pause, which is routine in ranked play. A
  // genuine engine pause stops game time while wall time runs on, so a round
  // that went live 60 seconds ago can hold only 30 seconds of frames. The
  // delay has to be measured against the game clock the frames are stamped
  // on, or every frame in the file looks 30 seconds older than it is and the
  // newest one, carrying live ghost positions, goes straight out.
  it('holds back the newest frames when the round has been paused', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 30, 60, false);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);

    const frames = (res.rawPayload.length - HEADER_BYTES) / frameBytes(0);
    // Newest is t=29000, so nothing past t=19000 may go out: 20 frames, plus
    // at most one for a second ticking over mid-test.
    expect(frames).toBeGreaterThanOrEqual(19);
    expect(frames).toBeLessThanOrEqual(21);
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

describe('GET /api/replays/match/:id/:ordinal/:half', () => {
  it('serves a closed file whole via a match_replays row', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    const res = await app.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(HEADER_BYTES + frameBytes(0) * 5);
    expect(res.headers['x-replay-closed']).toBe('1');
  });

  it('404s an unknown match id', async () => {
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/match/${id + 999}/0/1` });
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown ordinal', async () => {
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/match/${id}/9/1` });
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown half', async () => {
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/match/${id}/0/2` });
    expect(res.statusCode).toBe(404);
  });

  it('404s a row whose file is missing from disk', async () => {
    // No writeRound call: the row exists but nothing was ever written for it,
    // which is exactly what a pruned or never-flushed file looks like.
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    const res = await app.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(404);
  });

  // The row says nothing about liveness; only re-resolving by name against
  // the file on disk can. A match's current map is live too, so a row
  // pointing at a file still being written must still get the cutoff.
  it('applies the cutoff, not the whole file, when the row points at an open file', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 15, false);
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 0);
    const res = await app.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-replay-closed']).toBe('0');
    const whole = HEADER_BYTES + frameBytes(0) * 15;
    expect(res.rawPayload.length).toBeLessThan(whole);
  });
});

describe('non-numeric route parameters', () => {
  it('404s, not 500s, a non-numeric match id/ordinal/half', async () => {
    const res = await app.inject({ url: '/api/replays/match/abc/0/1' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/replays/timeline/:matchId/:ordinal/:half', () => {
  it('returns events and chat for that map and half, in sequence order', async () => {
    // Build an app with a db you can seed. Follow the same buildApp pattern
    // the rest of this file uses, keeping a handle on the db.
    const db = openDb(':memory:');
    // season_id and campaign are NOT NULL and state is CHECK-constrained, none
    // of which the brief's original one-liner satisfied; season_id 1 comes
    // from openDb's own seed(), and 'completed' is a real state a finished
    // match's timeline would be read back under.
    db.prepare(
      'INSERT INTO matches (id, season_id, campaign, token, state) VALUES (1, 1, ?, ?, ?)',
    ).run('no_mercy', 't'.repeat(32), 'completed');
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 1, 'pounce', 'A', 'B', 20, 0, 1, 5000)`,
    ).run();
    db.prepare(
      `INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message)
       VALUES (1, 2, 0, 1, 6000, 'A', 'survivor', 'nice')`,
    ).run();
    // Another map: must not appear.
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 3, 'pounce', 'A', 'B', 20, 1, 1, 7000)`,
    ).run();
    // Untimed, from before the t_ms column existed: must not appear, because
    // it cannot be placed on the timeline at all.
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 4, 'pounce', 'A', 'B', 20, 0, 1, -1)`,
    ).run();

    const app2 = Fastify();
    await app2.register(replayRoutes, { db, replayDir: dir });
    await app2.ready();

    const res = await app2.inject({ url: '/api/replays/timeline/1/0/1' });
    const body = res.json() as { entries: { seq: number; kind: string }[] };
    expect(body.entries.map((e) => [e.seq, e.kind])).toEqual([[1, 'event'], [2, 'chat']]);
    await app2.close();
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
