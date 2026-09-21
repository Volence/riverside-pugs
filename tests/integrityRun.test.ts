// tests/integrityRun.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import {
  encodeFrame, encodeHeader, parseReplay, PLAYER_SLOTS, STATE, VERSION,
  type Frame, type PlayerSample, type ReplayHeader,
} from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';
import { bearing } from '../src/integrity/geometry.js';
import { buildRoundPrior, unpausedFrames } from '../src/integrity/round.js';
import { analyzeOneRound, analyzePending, backfillAll, rebuildPriors } from '../src/integrity/run.js';
import { pendingRoundCount } from '../src/integrity/job.js';

const TOKEN = 'a'.repeat(32);
let db: DB;
let dir: string;

function blank(slot: number): PlayerSample {
  return { slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0 };
}

/** One round: survivor slot 0 tracks ghost slot 4 perfectly for n frames.
 *  `paused` appends that many byte-identical copies of the last frame, tMs
 *  frozen, which is what an engine pause writes. */
function replayBytes(n: number, map = 'l4d_vs_farm01_hilltop', paused = 0): Uint8Array {
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
    if (i === n - 1) for (let k = 0; k < paused; k++) parts.push(encodeFrame(f));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Another round of match 1, on disk and indexed. */
function addRound(ordinal: number, half: number): void {
  db.prepare('INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (1, ?, ?, ?, 0, 0, 10)')
    .run(ordinal, half, `pug_${TOKEN}_${ordinal}_${half}.rpl`);
  writeFileSync(join(dir, `pug_${TOKEN}_${ordinal}_${half}.rpl`), replayBytes(60));
}

function scoredForOccupancy(): number {
  return (db.prepare('SELECT metrics FROM integrity_rounds').all() as { metrics: string }[])
    .filter((r) => JSON.parse(r.metrics).occ != null).length;
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
    expect(JSON.parse(row.metrics).occ).toBeNull();
  });
});

// 11 of 189 real replays hold a run of frames with tMs frozen, one of them
// 1197 frames long. Time did not pass, so nothing was looked at and nothing was
// tracked, but each copy used to count as a fresh sample in the aim prior and
// in metric B: match 37's occupancy of 62.8 was a single 385 frame pause.
describe('paused frames', () => {
  it('keeps them out of the aim prior', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60, undefined, 400));
    rebuildPriors(db, dir);
    expect(db.prepare('SELECT frames FROM integrity_prior').get()).toEqual({ frames: 60 });
    expect(db.prepare('SELECT frames FROM integrity_prior_rounds').get()).toEqual({ frames: 60 });
  });

  it('keeps them out of the metrics, through the same door', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60, undefined, 400));
    backfillAll(db, dir);
    const row = db.prepare('SELECT metrics FROM integrity_rounds WHERE slot = 0').get() as { metrics: string };
    expect(JSON.parse(row.metrics).eligiblePairs).toBe(60);
    expect(db.prepare('SELECT frames FROM integrity_prior_rounds').get()).toEqual({ frames: 60 });
  });

  it('drops a frame whose clock went backwards, and keeps the first frame', () => {
    const f = (tMs: number): Frame => ({ tMs, offset: 0, players: [], entities: [] });
    expect(unpausedFrames([f(0), f(100), f(100), f(100), f(200), f(150), f(300)]).map((x) => x.tMs))
      .toEqual([0, 100, 200, 300]);
  });
});

describe('analyzePending', () => {
  it('analyses a round nothing has looked at yet', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    expect(analyzePending(db, dir)).toEqual({ rounds: 1, skipped: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_rounds').get()).toEqual({ c: 1 });
  });

  it('leaves a round alone the second time, so it is cheap to run often', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    analyzePending(db, dir);
    const before = db.prepare('SELECT computed_at FROM integrity_rounds WHERE slot = 0').get();
    expect(analyzePending(db, dir)).toEqual({ rounds: 0, skipped: 0 });
    expect(db.prepare('SELECT computed_at FROM integrity_rounds WHERE slot = 0').get()).toEqual(before);
  });

  // The measurements carry the version of the analyzer that produced them, so
  // a round measured by an older one is not done: leaving it would mix two
  // analyzers' numbers on one board, which is worse than either alone.
  it('re-analyses a round measured by an older analyzer', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    analyzePending(db, dir);
    db.prepare('UPDATE integrity_rounds SET analyzer_version = ? WHERE match_id = 1').run(ANALYZER_VERSION - 1);
    expect(analyzePending(db, dir)).toEqual({ rounds: 1, skipped: 0 });
    const v = db.prepare('SELECT DISTINCT analyzer_version v FROM integrity_rounds').all();
    expect(v).toEqual([{ v: ANALYZER_VERSION }]);
  });

  // This used to be the opposite test. The pending pass never touched the
  // priors, so a map only ever crossed MIN_PRIOR_ROUNDS when somebody ran a
  // full backfill by hand, and on a quiet week that is nobody.
  it('pools the rounds it measures into the map prior', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    analyzePending(db, dir);
    expect(db.prepare('SELECT rounds, frames FROM integrity_prior').get()).toEqual({ rounds: 1, frames: 60 });
    addRound(1, 2);
    analyzePending(db, dir);
    expect(db.prepare('SELECT rounds, frames FROM integrity_prior').get()).toEqual({ rounds: 2, frames: 120 });
  });

  // What keeps it cheap: it runs after every match and must not re-read 250 MB.
  it('never reads a replay it is not going to measure', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    analyzePending(db, dir);
    // If the pass opened this file again it would fail to decode it.
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), new Uint8Array(16));
    addRound(1, 2);
    expect(analyzePending(db, dir)).toEqual({ rounds: 1, skipped: 0 });
    expect(db.prepare('SELECT rounds FROM integrity_prior').get()).toEqual({ rounds: 2 });
  });

  it('carries a map over MIN_PRIOR_ROUNDS by itself, and goes back for the rounds that were waiting', () => {
    for (let ordinal = 2; ordinal < TUNING.MIN_PRIOR_ROUNDS; ordinal++) addRound(ordinal, 1);
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    expect(analyzePending(db, dir).rounds).toBe(TUNING.MIN_PRIOR_ROUNDS - 1);
    expect(scoredForOccupancy()).toBe(0);
    addRound(TUNING.MIN_PRIOR_ROUNDS, 1);
    // The one new round, and the 19 that had been measured without a prior.
    expect(analyzePending(db, dir).rounds).toBe(TUNING.MIN_PRIOR_ROUNDS);
    expect(scoredForOccupancy()).toBe(TUNING.MIN_PRIOR_ROUNDS);
  });

  it('keeps the pool equal to the sum of the shares it would subtract', () => {
    for (let i = 2; i <= 4; i++) addRound(i, 1);
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    analyzePending(db, dir);
    addRound(5, 1);
    analyzePending(db, dir);
    const pool = db.prepare('SELECT frames, rounds FROM integrity_prior').get();
    const shares = db.prepare('SELECT SUM(frames) AS frames, COUNT(*) AS rounds FROM integrity_prior_rounds').get();
    expect(pool).toEqual(shares);
  });

  // The bug this replaces: after an ANALYZER_VERSION bump the pending pass
  // subtracted each round's share from a pool built by the OLD analyzer, which
  // had never contained it, and subtractRound clamped the nonsense to zero.
  it('after a version bump, rebuilds the pool from what it measures instead of reusing the old one', () => {
    for (let i = 2; i <= 3; i++) addRound(i, 1);
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    analyzePending(db, dir);
    db.prepare('UPDATE integrity_rounds SET analyzer_version = ?').run(ANALYZER_VERSION - 1);
    db.prepare('UPDATE integrity_prior_rounds SET analyzer_version = ?, frames = 999').run(ANALYZER_VERSION - 1);
    db.prepare('UPDATE integrity_prior SET analyzer_version = ?, frames = 999').run(ANALYZER_VERSION - 1);
    analyzePending(db, dir);
    expect(db.prepare('SELECT frames, rounds, analyzer_version AS v FROM integrity_prior').get())
      .toEqual({ frames: 180, rounds: 3, v: ANALYZER_VERSION });
  });
});

// A round that cannot be analysed used to be pending for ever. pendingRoundCount
// kept counting it, and the server started a fresh analysis process for it
// every sixty seconds, which decoded nothing and exited, until the row was
// removed by hand.
describe('a round that cannot be analysed', () => {
  const failures = () => db.prepare('SELECT ordinal, half, reason, analyzer_version AS v FROM integrity_unanalysable ORDER BY ordinal').all();

  it('is marked with the reason when the file will not decode, and leaves the pending set', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), new Uint8Array(16));
    expect(pendingRoundCount(db)).toBe(1);
    expect(analyzePending(db, dir)).toEqual({ rounds: 0, skipped: 1 });
    expect(failures()).toEqual([{ ordinal: 1, half: 1, reason: 'unreadable', v: ANALYZER_VERSION }]);
    expect(pendingRoundCount(db)).toBe(0);
  });

  it('is marked when the file is not on disk at all', () => {
    expect(analyzePending(db, dir)).toEqual({ rounds: 0, skipped: 1 });
    expect(failures()).toEqual([{ ordinal: 1, half: 1, reason: 'missing', v: ANALYZER_VERSION }]);
    expect(pendingRoundCount(db)).toBe(0);
  });

  // Not a decode failure but a THROW, which used to end the whole process
  // with the round still pending, to be started again a minute later.
  it('is marked when reading it throws, instead of taking the pass down', () => {
    mkdirSync(join(dir, `pug_${TOKEN}_1_1.rpl`));
    addRound(2, 1);
    expect(analyzePending(db, dir)).toEqual({ rounds: 1, skipped: 1 });
    expect(failures()).toEqual([{ ordinal: 1, half: 1, reason: 'unreadable', v: ANALYZER_VERSION }]);
  });

  it('does not stop the rounds around it being measured', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), new Uint8Array(16));
    addRound(2, 1);
    expect(analyzePending(db, dir)).toEqual({ rounds: 1, skipped: 1 });
    expect(db.prepare('SELECT rounds FROM integrity_prior').get()).toEqual({ rounds: 1 });
  });

  it('is not pending once its replay has been pruned, which is nobody\'s failure', () => {
    db.prepare("UPDATE match_replays SET pruned_at = datetime('now')").run();
    expect(pendingRoundCount(db)).toBe(0);
    expect(analyzePending(db, dir)).toEqual({ rounds: 0, skipped: 0 });
    expect(failures()).toEqual([]);
  });

  it('is tried again by a newer analyzer, which may be able to read it', () => {
    analyzePending(db, dir);
    db.prepare('UPDATE integrity_unanalysable SET analyzer_version = ?').run(ANALYZER_VERSION - 1);
    expect(pendingRoundCount(db)).toBe(1);
  });

  it('loses the mark as soon as it is measured', () => {
    analyzePending(db, dir);
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    backfillAll(db, dir);
    expect(failures()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_rounds').get()).toEqual({ c: 1 });
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

  it('pools exactly what the scoring pass would subtract back out', () => {
    // The two passes used to build a round's prior contribution independently,
    // and the scoring pass overwrote what the pooling pass wrote. Byte for byte
    // identical, but a drift would be SILENT: subtractRound clamps a mismatch
    // to zero, so the pool and the subtraction would disagree, every occupancy
    // z-score would shift, and nothing would fail. This asserts they agree.
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    rebuildPriors(db, dir);
    const pooled = db.prepare('SELECT frames, counts FROM integrity_prior_rounds').get() as { frames: number; counts: string };
    const map = db.prepare('SELECT frames FROM integrity_prior').get() as { frames: number };
    // One round, so the pool IS that round.
    expect(map.frames).toBe(pooled.frames);

    // Scoring reads the share and must leave it exactly as pooled.
    analyzeOneRound(db, { matchId: 1, ordinal: 1, half: 1 }, readFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`)));
    const after = db.prepare('SELECT frames, counts FROM integrity_prior_rounds').get() as { frames: number; counts: string };
    expect(after).toEqual(pooled);

    // And directly: the builder both callers use is one function.
    const replay = parseReplay(readFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`)))!;
    const built = buildRoundPrior(replay.frames, [0]);
    expect(built.frames).toBe(pooled.frames);
    expect(JSON.stringify([...built.counts])).toBe(pooled.counts);
  });

  it('is idempotent: running twice leaves one row per player-round', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.rpl`), replayBytes(60));
    backfillAll(db, dir);
    backfillAll(db, dir);
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_rounds').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT rounds FROM integrity_prior').get()).toEqual({ rounds: 1 });
  });
});
