import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../../src/db.js';
import { encodeFrame, encodeHeader, STATE, VERSION, type Frame, type PlayerSample } from '../../src/replayFormat.js';
import { LiveHudStore } from '../../src/cast/liveHud.js';
import { buildWinModel, liveWinLine, matchWinLine, type HalfRow, type WinLine } from '../../src/winProb.js';
import { FORM_PARAMS } from '../../src/winForm.js';
import { insertDraft, publishCampaign } from '../../src/customCampaigns.js';
import { invalidateCampaignCache, setMissionsDirs } from '../../src/campaignRegistry.js';
import { decodeRoundReplay } from '../../src/metrics/replayRound.js';
import type { RoundKey, RoundReplay } from '../../src/metrics/types.js';
import { buildProgressMap } from '../../src/winLive/progressMap.js';
import { configureLiveWin, liveSnapshot, MAX_DECODE_BYTES } from '../../src/winLive/liveState.js';
import { WIN_POINTS_VERSION } from '../../src/winLive/modelVersion.js';
import {
  computeFinishedPoints, finishedHalfSnapshots, pendingWinPointMatches, runWinPointsPass, writeFinishedPoints, type FinishedPoint,
} from '../../src/winLive/finishedLine.js';

const TOKEN = 'd'.repeat(32);
const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000900${i}`);
const NOW = Math.floor(Date.now() / 1000) * 1000;
const START = NOW - 60_000;

function history(): HalfRow[] {
  const rows: HalfRow[] = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ map: 'm1', score: i % 3 === 0 ? 600 + (i % 7) * 20 : 40 + (i % 5) * 10, made: i % 3 === 0 });
    rows.push({ map: 'm2', score: i % 2 === 0 ? 800 + (i % 7) * 20 : 60 + (i % 5) * 10, made: i % 2 === 0 });
  }
  return rows;
}
const model = buildWinModel(history());

const ALIVE = STATE.PRESENT | STATE.ALIVE;
function player(slot: number, p: Partial<PlayerSample> = {}): PlayerSample {
  return { slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: ALIVE, health: 100, temp: 1, cls: slot < 4 ? 0 : 3, weapon: 0, clip: 0, reserve: 0, ...p };
}
/** A half every 500 ms to `toMs` and one frame past it: survivors walk +x
 *  10 units per second, slot 4 is the tank from `tankAt`, and from `downAt`
 *  survivor 0 is incapped. */
function frames(toMs: number, tankAt = 30_000, downAt = Infinity): Frame[] {
  const out: Frame[] = [];
  for (let t = 0; t <= toMs + 500; t += 500) {
    const x = Math.round(t / 100);
    out.push({
      tMs: t, offset: 0, entities: [],
      players: [
        player(0, { x, state: t >= downAt ? ALIVE | STATE.INCAP : ALIVE }), player(1, { x }), player(2, { x }), player(3, { x }),
        t >= tankAt ? player(4, { cls: 5, health: 6000 }) : player(4), player(5), player(6), player(7),
      ],
    });
  }
  return out;
}
/** A replay as decoded: the sides set on each player record. */
const replayOf = (fs: Frame[]): RoundReplay => ({
  frames: fs.map((f) => ({ ...f, players: f.players.map((p) => ({ ...p, infected: p.slot >= 4 })) })),
  durationMs: fs.at(-1)!.tMs, slots: IDS,
});

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

/** A finished match on m1 then m2: one [team, score, alive] per half. */
function seed(halves: ['a' | 'b', number, number][]): number {
  const a = halves.filter(([t]) => t === 'a').reduce((n, [, s]) => n + s, 0);
  const b = halves.filter(([t]) => t === 'b').reduce((n, [, s]) => n + s, 0);
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, winner, team_a_score, team_b_score, ended_at) VALUES (1, 'completed', 'five', ?, ?, ?, datetime('now'))",
  ).run(a > b ? 'a' : 'b', a, b).lastInsertRowid);
  for (let o = 0; o < halves.length / 2; o++) {
    const [ta, sa, aa] = halves[o * 2]!;
    const [tb, sb, ab] = halves[o * 2 + 1]!;
    db.prepare('INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)')
      .run(id, o, o % 2 ? 'm2' : 'm1', ta === 'a' ? sa : sb, ta === 'a' ? sb : sa);
    const ins = db.prepare(
      "INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, survivors_alive, reliable, ended_at) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))",
    );
    ins.run(id, o, 1, ta, sa, aa);
    ins.run(id, o, 2, tb, sb, ab);
  }
  return id;
}
const FOUR: ['a' | 'b', number, number][] = [['a', 640, 3], ['b', 100, 0], ['b', 820, 4], ['a', 90, 0]];

const point = (ordinal: number, half: 1 | 2, tMs: number, pA: number, moment: FinishedPoint['moment'] = null): FinishedPoint =>
  ({ ordinal, half, tMs, pA, pAForm: pA / 2, moment });
const inHalf = (l: WinLine) => l.points.filter((p) => p.tMs !== undefined);
const halfEnds = (l: WinLine) => l.points.filter((p) => p.tMs === undefined);

describe('matchWinLine with stored points', () => {
  it('is today\'s line exactly with no rows, and without live whatever is stored', () => {
    const id = seed(FOUR);
    const plain = matchWinLine(db, id, model)!;
    expect(matchWinLine(db, id, model, { live: true })).toEqual(plain);
    writeFinishedPoints(db, id, [point(0, 1, 0, 0.4)]);
    expect(matchWinLine(db, id, model)).toEqual(plain);
  });

  it('puts each half\'s points in order just before its half-end point, leaving the half-end points as they were', () => {
    const id = seed(FOUR);
    const plain = matchWinLine(db, id, model)!;
    writeFinishedPoints(db, id, [
      point(1, 1, 5000, 0.3), point(0, 1, 5000, 0.45, 'tank_spawn'), point(0, 1, 0, 0.5), point(1, 1, 0, 0.35, 'saferoom'),
    ]);
    const l = matchWinLine(db, id, model, { live: true })!;
    expect(halfEnds(l)).toEqual(plain.points);
    expect(l.points.map((p) => [p.ordinal, p.half, p.tMs ?? null])).toEqual([
      [null, null, null],
      [0, 1, 0], [0, 1, 5000], [0, 1, null],
      [0, 2, null],
      [1, 1, 0], [1, 1, 5000], [1, 1, null],
      [1, 2, null],
    ]);
    expect(l.points[2]).toMatchObject({ pA: 0.45, moment: 'tank_spawn', survTeam: 'a', map: 'm1', scoreA: 0, scoreB: 0 });
    // Map 2 half 1 is B's, starting from 640 to 100.
    expect(l.points[5]).toMatchObject({ pA: 0.35, moment: 'saferoom', survTeam: 'b', map: 'm2', scoreA: 640, scoreB: 100 });
    expect(l.points[1]!.moment).toBeUndefined();
    // The swing and the winner's low still name the same half-end points.
    expect(l.points[l.turning!]).toEqual(plain.points[plain.turning!]);
    expect(l.points[l.winnerLow!.index]).toEqual(plain.points[plain.winnerLow!.index]);
  });

  it('reads the form price when form is on', () => {
    const id = seed(FOUR);
    writeFinishedPoints(db, id, [point(0, 1, 0, 0.5)]);
    expect(inHalf(matchWinLine(db, id, model, { live: true })!)[0]!.pA).toBe(0.5);
    expect(inHalf(matchWinLine(db, id, model, { live: true, form: FORM_PARAMS })!)[0]!.pA).toBe(0.25);
  });

  it('ignores rows on another model version', () => {
    const id = seed(FOUR);
    const plain = matchWinLine(db, id, model)!;
    db.prepare("INSERT INTO match_win_points (match_id, ordinal, half, t_ms, p_a, p_a_form, model_version) VALUES (?, 0, 1, 0, 0.4, 0.4, 'stale')").run(id);
    expect(matchWinLine(db, id, model, { live: true })).toEqual(plain);
    writeFinishedPoints(db, id, [point(0, 2, 0, 0.6)]);
    expect(inHalf(matchWinLine(db, id, model, { live: true })!).map((p) => [p.half, p.pA])).toEqual([[2, 0.6]]);
  });
});

describe('computeFinishedPoints', () => {
  it('writes a point per 5 s for each half with a replay, on the current version, and records the run', () => {
    const id = seed(FOUR);
    const pm = buildProgressMap('m1', Array.from({ length: 120 }, (_, i) => ({ x: i * 6, y: 0, z: 0, prog: i })));
    const load = (k: RoundKey) => (k.ordinal === 0 && k.half === 1 ? replayOf(frames(60_000)) : null);
    const n = computeFinishedPoints(db, id, load, { model, progressMaps: new Map([['m1', pm]]) });
    expect(n).toBe(13);
    const rows = db.prepare('SELECT ordinal, half, t_ms, moment, model_version FROM match_win_points ORDER BY t_ms').all() as
      { ordinal: number; half: number; t_ms: number; moment: string | null; model_version: string }[];
    expect(rows.map((r) => r.t_ms)).toEqual(Array.from({ length: 13 }, (_, i) => i * 5000));
    expect(rows.every((r) => r.ordinal === 0 && r.half === 1 && r.model_version === WIN_POINTS_VERSION)).toBe(true);
    expect(rows.filter((r) => r.moment).map((r) => [r.t_ms, r.moment])).toEqual([[30_000, 'tank_spawn'], [60_000, 'saferoom']]);
    expect(db.prepare('SELECT model_version, points FROM match_win_point_runs WHERE match_id = ?').get(id))
      .toEqual({ model_version: WIN_POINTS_VERSION, points: 13 });
    // Run again: replaced, not added to.
    computeFinishedPoints(db, id, load, { model, progressMaps: new Map([['m1', pm]]) });
    expect((db.prepare('SELECT COUNT(*) AS n FROM match_win_points').get() as { n: number }).n).toBe(13);
  });

  it('a downed survivor moves the line against the surviving team', () => {
    const id = seed(FOUR);
    computeFinishedPoints(db, id, (k) => (k.ordinal === 0 && k.half === 1 ? replayOf(frames(60_000, 30_000, 40_000)) : null), { model });
    const p = (t: number) => (db.prepare('SELECT p_a FROM match_win_points WHERE t_ms = ?').get(t) as { p_a: number }).p_a;
    expect(p(40_000)).toBeLessThan(p(35_000));
  });

  it('stores a run with no points for a match whose score carries no line, or with no replays', () => {
    const id = seed(FOUR);
    expect(computeFinishedPoints(db, id, () => null, { model })).toBe(0);
    db.prepare("UPDATE matches SET team_a_score = 1 WHERE id = ?").run(id);
    expect(computeFinishedPoints(db, id, () => replayOf(frames(10_000)), { model })).toBe(0);
    expect(db.prepare('SELECT points FROM match_win_point_runs WHERE match_id = ?').get(id)).toEqual({ points: 0 });
  });
});

describe('progress on a map without a trusted progress map', () => {
  const key: RoundKey = { matchId: 0, ordinal: 0, half: 1 };
  beforeEach(() => { key.matchId = seed(FOUR); });
  const progAt = (t: number) => finishedHalfSnapshots(db, key, 'm1', replayOf(frames(60_000)), new Map())
    .find((p) => p.snap.tMs === t)!.snap.prog;

  it('reads the stored LIVEHUD samples as a backward step, made from the first', () => {
    const ins = db.prepare('INSERT INTO match_progress_samples (match_id, ordinal, half, t_ms, prog) VALUES (?, 0, 1, ?, ?)');
    ins.run(key.matchId, 1000, 5);
    ins.run(key.matchId, 22_000, 30);
    expect(progAt(20_000)).toBe(0);
    expect(progAt(25_000)).toBe(25);
  });

  it('falls back to the data feeds, then to unknown', () => {
    expect(progAt(25_000)).toBeNull();
    const ins = db.prepare("INSERT INTO match_survivor_downs (match_id, ordinal, half, t_ms, steamid, kind, cause, prog) VALUES (?, 0, 1, ?, ?, 'incap', 'x', ?)");
    ins.run(key.matchId, 0, IDS[0], 4);
    ins.run(key.matchId, 10_000, IDS[1], 10);
    ins.run(key.matchId, 30_000, IDS[2], 40);
    expect(progAt(25_000)).toBe(6);
    expect(progAt(30_000)).toBe(36);
  });
});

describe('the reaper pass', () => {
  it('picks a finished match once its replays are indexed, stores its points, and not again until the version changes', async () => {
    const id = seed(FOUR);
    // No replay rows and just ended: waiting on the pull.
    expect(pendingWinPointMatches(db, { limit: 5 })).toEqual([]);
    const rep = db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (?, ?, ?, 'x', 1, 1, 10)");
    for (const [o, h] of [[0, 1], [0, 2], [1, 1], [1, 2]]) rep.run(id, o, h);
    expect(pendingWinPointMatches(db, { limit: 5 })).toEqual([id]);
    const done = await runWinPointsPass(db, '', { limit: 5, load: (k) => (k.ordinal === 1 && k.half === 2 ? replayOf(frames(20_000)) : null) });
    expect(done).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM match_win_points').get() as { n: number }).n).toBe(5);
    expect(pendingWinPointMatches(db, { limit: 5 })).toEqual([]);
    db.prepare("UPDATE match_win_point_runs SET model_version = 'old'").run();
    expect(pendingWinPointMatches(db, { limit: 5 })).toEqual([id]);
  });

  it('picks a match with missing replays once REPLAY_WAIT_MIN has passed, and logs a failure without retrying it', async () => {
    const id = seed(FOUR);
    db.prepare("UPDATE matches SET ended_at = datetime('now', '-40 minutes') WHERE id = ?").run(id);
    expect(pendingWinPointMatches(db, { limit: 5 })).toEqual([id]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runWinPointsPass(db, '', { limit: 5, load: () => { throw new Error('boom'); } });
    // A load that throws is a half with no replay, not a failed match.
    expect(db.prepare('SELECT points FROM match_win_point_runs WHERE match_id = ?').get(id)).toEqual({ points: 0 });
    expect(pendingWinPointMatches(db, { limit: 5 })).toEqual([]);
    err.mockRestore();
  });

  it('leaves matches older than the recent window to the backfill', () => {
    const id = seed(FOUR);
    db.prepare("UPDATE matches SET ended_at = datetime('now', '-5 days') WHERE id = ?").run(id);
    expect(pendingWinPointMatches(db, { limit: 5 })).toEqual([]);
  });
});

describe('parity with the live line', () => {
  let liveDir: string;
  afterEach(() => {
    rmSync(liveDir, { recursive: true, force: true });
    setMissionsDirs([]);
    invalidateCampaignCache();
  });

  it('stores for a finished half exactly the points the Live page showed for it', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    // One map then the finale: the match is m1's two halves.
    insertDraft(db, {
      slug: 'two', name: 'Two', vpkFilename: 'two.vpk', sizeBytes: 1, sha256: 'b'.repeat(64), uploadedBy: null,
    }, [{ map: 'm1', display: null, isFinale: false }, { map: 'fin', display: null, isFinale: true }]);
    publishCampaign(db, 'two', 'Two');
    invalidateCampaignCache();
    const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'two', ?)").run(TOKEN).lastInsertRowid);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen, phase, phase_since) VALUES (?, 'm1', datetime('now'), 'live', datetime('now'))").run(id);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, reliable, started_at) VALUES (?, 0, 1, 'a', 1, datetime('now'))").run(id);

    // The half as the live side reads it, on a trusted progress map.
    liveDir = mkdtempSync(join(tmpdir(), 'winfinished-'));
    const hud = new LiveHudStore();
    const pm = buildProgressMap('m1', Array.from({ length: 120 }, (_, i) => ({ x: i * 6, y: 0, z: 0, prog: i })));
    configureLiveWin({ replayDir: '', liveDir, hud, progressMaps: new Map([['m1', pm]]), maxDecodeBytes: MAX_DECODE_BYTES });
    hud.resetReach(TOKEN, 0, 1, START);
    const path = join(liveDir, `pug_${TOKEN}_0_1.rpl`);
    writeFileSync(path, Buffer.concat([encodeHeader({
      version: VERSION, token: TOKEN, ordinal: 0, half: 1, playerHz: 10, entityHz: 2, map: 'm1',
      startedUnix: Math.floor(START / 1000), indexOffset: 0, indexCount: 0, frameCount: 0,
      slots: IDS, infectedMask: 0xf0, sidesKnown: true, losKnown: false,
    }), ...frames(60_000, 30_000, 45_000).map(encodeFrame)]));
    utimesSync(path, NOW / 1000, NOW / 1000);
    hud.record(TOKEN, { prog: 5, tank: 40, witch: 0, players: [] }, START + 1500, { ordinal: 0, half: 1 });
    expect(liveSnapshot(db, id, NOW, 0)).not.toBeNull();

    // Both halves end; the second had no live replay.
    db.prepare("UPDATE match_rounds SET score = 640, ended_at = datetime('now'), survivors_alive = 3 WHERE match_id = ?").run(id);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, survivors_alive, reliable, started_at, ended_at) VALUES (?, 0, 2, 'b', 100, 0, 1, datetime('now'), datetime('now'))").run(id);
    db.prepare("UPDATE match_live SET phase = 'ended' WHERE match_id = ?").run(id);
    const shown = (form?: typeof FORM_PARAMS) =>
      inHalf(liveWinLine(db, id, 'two', model, { live: true, nowMs: NOW + 6000, delayMs: 0, form })!);
    const live = shown();
    const liveForm = shown(FORM_PARAMS);
    expect(live.length).toBe(13);

    // The match is recorded; its points are computed from the finished file.
    db.prepare("UPDATE matches SET state = 'completed', team_a_score = 640, team_b_score = 100, ended_at = datetime('now') WHERE id = ?").run(id);
    db.prepare("INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, 'm1', 640, 100)").run(id);
    const load = (k: RoundKey) => (k.half === 1 ? decodeRoundReplay(readFileSync(path), () => null) : null);
    expect(computeFinishedPoints(db, id, load, { model, progressMaps: new Map([['m1', pm]]) })).toBe(13);

    for (const [stored, want] of [
      [inHalf(matchWinLine(db, id, model, { live: true })!), live],
      [inHalf(matchWinLine(db, id, model, { live: true, form: FORM_PARAMS })!), liveForm],
    ] as const) {
      expect(stored.map((p) => [p.ordinal, p.half, p.tMs, p.moment, p.scoreA, p.scoreB])).toEqual(
        want.map((p) => [p.ordinal, p.half, p.tMs, p.moment, p.scoreA, p.scoreB]));
      stored.forEach((p, i) => expect(p.pA).toBeCloseTo(want[i]!.pA, 12));
    }
    // The down at 45 s moved it: the points are not all the opening value.
    expect(new Set(live.map((p) => p.pA.toFixed(6))).size).toBeGreaterThan(2);
  });
});
