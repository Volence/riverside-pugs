// tests/integrityRun.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import {
  encodeFrame, encodeHeader, PLAYER_SLOTS, STATE, VERSION,
  type Frame, type PlayerSample, type ReplayHeader,
} from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import { bearing } from '../src/integrity/geometry.js';
import { analyzeOneRound, backfillAll } from '../src/integrity/run.js';

const TOKEN = 'a'.repeat(32);
let db: DB;
let dir: string;

function blank(slot: number): PlayerSample {
  return { slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0 };
}

/** One round: survivor slot 0 tracks ghost slot 4 perfectly for n frames. */
function replayBytes(n: number, map = 'l4d_vs_farm01_hilltop'): Uint8Array {
  const header: ReplayHeader = {
    version: VERSION, token: TOKEN, ordinal: 1, half: 1, playerHz: 10, entityHz: 10,
    map, startedUnix: 1785956274, indexOffset: 0, indexCount: 0, frameCount: n,
    slots: ['76561198000000001', '', '', '', '76561198000000005', '', '', ''],
    infectedMask: 0b00010000, sidesKnown: true,
  };
  const parts: Uint8Array[] = [encodeHeader(header)];
  for (let i = 0; i < n; i++) {
    const a = (i * 6) * Math.PI / 180;
    const gx = Math.cos(a) * 1200, gy = Math.sin(a) * 1200;
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE, yaw: bearing({ x: 0, y: 0 }, { x: gx, y: gy }) };
    players[4] = { ...blank(4), state: STATE.PRESENT | STATE.GHOST, x: Math.round(gx), y: Math.round(gy) };
    const f: Frame = { tMs: TUNING.SPAWN_GRACE_MS + i * 100, offset: 0, players, entities: [] };
    parts.push(encodeFrame(f));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'itg-'));
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'farm')").run();
  db.prepare('INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (1, 1, 1, ?, 0, 0, 10)')
    .run(`pug_${TOKEN}_1_1.rpl`);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('analyzeOneRound', () => {
  it('writes a row per survivor slot with a high fidelity', () => {
    expect(analyzeOneRound(db, { matchId: 1, ordinal: 1, half: 1 }, replayBytes(60))).toBe(true);
    const row = db.prepare('SELECT steamid, metrics FROM integrity_rounds WHERE slot = 0').get() as { steamid: string; metrics: string };
    expect(row.steamid).toBe('76561198000000001');
    expect(JSON.parse(row.metrics).fidMax).toBeGreaterThan(0.9);
  });

  it('writes clips for a tracked ghost', () => {
    analyzeOneRound(db, { matchId: 1, ordinal: 1, half: 1 }, replayBytes(60));
    const clip = db.prepare('SELECT kind, score FROM integrity_clips').get() as { kind: string; score: number };
    expect(clip.kind).toBe('ghost_track');
    expect(clip.score).toBeGreaterThan(TUNING.CLIP_MIN);
  });

  it('refuses a buffer that is not a replay', () => {
    expect(analyzeOneRound(db, { matchId: 1, ordinal: 1, half: 1 }, new Uint8Array(16))).toBe(false);
  });

  it('leaves occupancy null while the map is under MIN_PRIOR_ROUNDS', () => {
    analyzeOneRound(db, { matchId: 1, ordinal: 1, half: 1 }, replayBytes(60));
    const row = db.prepare('SELECT metrics FROM integrity_rounds WHERE slot = 0').get() as { metrics: string };
    expect(JSON.parse(row.metrics).occZ).toBeNull();
  });
});

describe('backfillAll', () => {
  it('analyses every replay it finds and reports the count', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    const got = backfillAll(db, dir);
    expect(got.rounds).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_rounds').get()).toEqual({ c: 1 });
  });

  it('stores the map prior it accumulated', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    backfillAll(db, dir);
    const p = db.prepare('SELECT rounds, frames FROM integrity_prior').get() as { rounds: number; frames: number };
    expect(p.rounds).toBe(1);
    expect(p.frames).toBe(60);
  });

  it('is idempotent: running twice leaves one row per player-round', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    backfillAll(db, dir);
    backfillAll(db, dir);
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_rounds').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT rounds FROM integrity_prior').get()).toEqual({ rounds: 1 });
  });
});
