import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../../src/db.js';
import { runMetricsPass } from '../../src/metrics/job.js';
import { recomputeFromR2, roundsToRecomputeFromR2 } from '../../src/metrics/r2Recompute.js';
import { ENGINE } from '../../src/metrics/registry.js';
import { encodeFrame, encodeHeader, STATE, type Frame, type ReplayHeader } from '../../src/replayFormat.js';

const TOKEN = 'd'.repeat(32);
const NOW = '2026-09-24 10:00:00';
let dir: string;
let db: DB;

const fileOf = (ordinal: number, half: number) => `pug_${TOKEN}_${ordinal}_${half}.rpl`;

/** A small, valid replay: one survivor, one hunter, 30 s at 10 Hz. */
function replayBytes(): Buffer {
  const h: ReplayHeader = {
    version: 3, token: TOKEN, ordinal: 0, half: 1, playerHz: 10, entityHz: 10,
    map: 'l4d_vs_hospital01_apartment', startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 300,
    slots: ['76561198000000001', '76561198000000002', '', '', '', '', '', ''], infectedMask: 0b10, sidesKnown: true, losKnown: false,
  };
  const idle = (slot: number) => ({ slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0 });
  const frames: Frame[] = [];
  for (let t = 0; t < 30_000; t += 100) {
    const players = Array.from({ length: 8 }, (_, s) => idle(s));
    players[0] = { ...idle(0), state: STATE.PRESENT | STATE.ALIVE, health: 100, weapon: 3 };
    players[1] = { ...idle(1), state: STATE.PRESENT | STATE.ALIVE, health: 250, cls: 3 };
    frames.push({ tMs: t, players, entities: [], offset: 0 });
  }
  return Buffer.concat([encodeHeader(h), ...frames.map(encodeFrame)]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r2recompute-'));
  db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare(`INSERT INTO matches (id, season_id, state, campaign, token, ended_at, voided_at) VALUES
    (1, 1, 'completed', 'x', ?, '2026-09-24 08:00:00', NULL),
    (2, 1, 'completed', 'x', ?, '2026-09-24 08:00:00', '2026-09-24 09:00:00')`).run(TOKEN, TOKEN);
  const round = db.prepare(`INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, started_at, ended_at, survivors_alive)
    VALUES (?, 0, ?, 'a', 100, '2026-09-24 07:00:00', '2026-09-24 07:10:00', 1)`);
  const rp = db.prepare(`INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz, pruned_at, r2_key)
    VALUES (?, 0, ?, ?, 1, 300, 10, ?, ?)`);
  for (const m of [1, 2]) for (const half of [1, 2]) {
    round.run(m, half);
    rp.run(m, half, fileOf(0, half), '2026-09-24 09:00:00', `replays/${m}/0_${half}.rpl`);
  }
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = (m: number, half: number) => db.prepare(
  'SELECT has_replay, replay_seen, engine FROM round_metric_context WHERE match_id = ? AND ordinal = 0 AND half = ?',
).get(m, half) as { has_replay: number; replay_seen: number; engine: string } | undefined;

describe('roundsToRecomputeFromR2', () => {
  it('lists counted rounds computed without their replay, whose only copy is in R2', () => {
    runMetricsPass(db, dir, { limit: 10, now: NOW, replayWaitMin: 0 });
    expect(ctx(1, 1)).toMatchObject({ has_replay: 0, replay_seen: 0 });
    expect(roundsToRecomputeFromR2(db, dir).map((r) => `${r.matchId}/${r.half}`)).toEqual(['1/1', '1/2']);
  });

  it('lists rounds on an older or frozen engine, and skips rounds already current with a replay', () => {
    runMetricsPass(db, dir, { limit: 10, now: NOW, replayWaitMin: 0 });
    db.prepare("UPDATE round_metric_context SET has_replay = 1, replay_seen = 1, engine = ? WHERE half = 1").run(ENGINE + '!frozen');
    db.prepare("UPDATE round_metric_context SET has_replay = 1, replay_seen = 1 WHERE half = 2").run();
    expect(roundsToRecomputeFromR2(db, dir).map((r) => `${r.matchId}/${r.half}`)).toEqual(['1/1']);
  });

  it('leaves a round alone while its file is still on disk: the job will read it', () => {
    runMetricsPass(db, dir, { limit: 10, now: NOW, replayWaitMin: 0 });
    writeFileSync(join(dir, fileOf(0, 1)), replayBytes());
    expect(roundsToRecomputeFromR2(db, dir).map((r) => `${r.matchId}/${r.half}`)).toEqual(['1/2']);
  });
});

describe('recomputeFromR2', () => {
  it('computes replay metrics from the R2 copy and stores them on the current engine', async () => {
    runMetricsPass(db, dir, { limit: 10, now: NOW, replayWaitMin: 0 });
    const fetched: string[] = [];
    const res = await recomputeFromR2(db, dir, {
      apply: true, now: NOW, fetch: async (key) => { fetched.push(key); return replayBytes(); },
    });
    expect(fetched).toEqual(['replays/1/0_1.rpl', 'replays/1/0_2.rpl']);
    expect(res).toMatchObject({ recomputed: 2, missing: 0, undecodable: 0, failed: 0 });
    expect(ctx(1, 1)).toEqual({ has_replay: 1, replay_seen: 1, engine: ENGINE });
    const len = db.prepare("SELECT num FROM round_metrics WHERE match_id = 1 AND half = 1 AND metric = 'round.length_min' AND phase = 'all'")
      .get() as { num: number };
    expect(len.num).toBeCloseTo(0.5, 5);
    expect(roundsToRecomputeFromR2(db, dir)).toEqual([]);
  });

  it('changes nothing in a dry run', async () => {
    runMetricsPass(db, dir, { limit: 10, now: NOW, replayWaitMin: 0 });
    const res = await recomputeFromR2(db, dir, { apply: false, now: NOW, fetch: async () => replayBytes() });
    expect(res.recomputed).toBe(2);
    expect(ctx(1, 1)).toMatchObject({ has_replay: 0 });
  });

  it('keeps the stored metrics when the copy is missing or unreadable', async () => {
    runMetricsPass(db, dir, { limit: 10, now: NOW, replayWaitMin: 0 });
    const before = db.prepare('SELECT COUNT(*) AS n FROM round_metrics').get();
    const res = await recomputeFromR2(db, dir, {
      apply: true, now: NOW, fetch: async (key) => (key.endsWith('0_1.rpl') ? null : Buffer.alloc(10)),
    });
    expect(res).toMatchObject({ recomputed: 0, missing: 1, undecodable: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM round_metrics').get()).toEqual(before);
    expect(ctx(1, 1)).toMatchObject({ has_replay: 0, replay_seen: 0 });
  });

  it('counts a fetch that throws as failed and carries on', async () => {
    runMetricsPass(db, dir, { limit: 10, now: NOW, replayWaitMin: 0 });
    const res = await recomputeFromR2(db, dir, {
      apply: true, now: NOW, fetch: async (key) => { if (key.endsWith('0_1.rpl')) throw new Error('503'); return replayBytes(); },
    });
    expect(res).toMatchObject({ recomputed: 1, failed: 1 });
  });
});
