import { describe, it, expect } from 'vitest';
import { ENTITY_KIND, STATE, PLAYER_SLOTS, type Frame, type PlayerSample } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import { bearing, wrapDeg } from '../src/integrity/geometry.js';
import { trackFidelity, trackWindows, pickClips, scanPairs, visibleOthers, type TrackWindow } from '../src/integrity/ghostTrack.js';
import { pairEligible } from '../src/integrity/geometry.js';
import { occupancy } from '../src/integrity/occupancy.js';
import { analyzeRound } from '../src/integrity/round.js';
import { cellKey, cellOf, type PriorTable } from '../src/integrity/aimPrior.js';

function blank(slot: number): PlayerSample {
  return {
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
    health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
  };
}

/**
 * A round where survivor slot 0 stands at the origin and ghost slot 4 walks an
 * arc around them at `radius`, `stepDeg` of bearing per frame, starting at
 * `startDeg`. `yawOf` decides where the survivor looks.
 *
 * `stepDeg` matters: the ghost has to stay inside E_TRACK of the survivor's aim
 * for W consecutive frames or no window forms at all and a test asserting over
 * the windows passes vacuously.
 */
function round(
  n: number,
  yawOf: (i: number, trueBearing: number) => number,
  radius = 1200,
  stepDeg = 6,
  startDeg = 0,
): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const a = (startDeg + i * stepDeg) * Math.PI / 180;
    const gx = Math.cos(a) * radius;
    const gy = Math.sin(a) * radius;
    const trueB = bearing({ x: 0, y: 0 }, { x: gx, y: gy });
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE, yaw: yawOf(i, trueB) };
    players[4] = { ...blank(4), state: STATE.PRESENT | STATE.GHOST, x: gx, y: gy };
    frames.push({ tMs: TUNING.SPAWN_GRACE_MS + i * 100, offset: 0, players, entities: [] });
  }
  return frames;
}

/**
 * The occlusion guard is the binding constraint on the whole detector: a frame
 * is vetoed by anything within OCCLUDE_WINDOW of the ghost's bearing, and a
 * window needs W consecutive surviving frames. Every other fixture in this file
 * hands `visibleOthers` a frame with no entities and all-zero player states, so
 * it returns an empty list and the guard is never exercised at all. These tests
 * build the list for real.
 */
describe('visibleOthers', () => {
  /** Survivor slot 0 at the origin, ghost slot 4 due east at 1200 units. */
  function occludedFrame(): Frame {
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE };
    players[1] = { ...blank(1), state: STATE.PRESENT | STATE.ALIVE, x: 0, y: 500 };    // live teammate
    players[4] = { ...blank(4), state: STATE.PRESENT | STATE.GHOST, x: 1200, y: 0 };   // the subject ghost
    players[5] = { ...blank(5), state: STATE.PRESENT | STATE.GHOST, x: 900, y: 10 };   // ANOTHER ghost
    players[6] = { ...blank(6), state: 0, x: 700, y: 0 };                              // not present
    return {
      tMs: TUNING.SPAWN_GRACE_MS, offset: 0, players,
      entities: [
        // Common ON the ghost's bearing.
        { ref: 1, kind: ENTITY_KIND.COMMON, state: STATE.PRESENT, x: 800, y: 0, z: 0, health: 50 },
        // Common well off it.
        { ref: 2, kind: ENTITY_KIND.COMMON, state: STATE.PRESENT, x: 0, y: -800, z: 0, health: 50 },
        // An AI hunter that has NOT spawned, sitting on the bearing. Invisible.
        { ref: 3, kind: ENTITY_KIND.HUNTER_AI, state: STATE.PRESENT | STATE.GHOST, x: 1000, y: 5, z: 0, health: 250 },
      ],
    };
  }

  it('returns the live teammate and the VISIBLE entities, and nothing else', () => {
    expect(visibleOthers(occludedFrame(), 0, 4)).toEqual([
      { x: 0, y: 500 },     // teammate slot 1
      { x: 800, y: 0 },     // common on the bearing
      { x: 0, y: -800 },    // common off the bearing
    ]);
  });

  it('excludes the OTHER ghost, because a ghost is invisible to everyone', () => {
    // Slot 5 sits at (900, 10), inside OCCLUDE_WINDOW of the subject ghost's
    // bearing. If ghosts were occluders, one infected shadowing another would
    // veto every frame of the thing the detector exists to catch.
    expect(visibleOthers(occludedFrame(), 0, 4)).not.toContainEqual({ x: 900, y: 10 });
  });

  it('excludes the survivor themselves and the ghost under test', () => {
    const got = visibleOthers(occludedFrame(), 0, 4);
    expect(got).not.toContainEqual({ x: 0, y: 0 });
    expect(got).not.toContainEqual({ x: 1200, y: 0 });
  });

  it('excludes a player without PRESENT', () => {
    expect(visibleOthers(occludedFrame(), 0, 4)).not.toContainEqual({ x: 700, y: 0 });
  });

  it('excludes an ENTITY carrying the ghost bit, which an AI special infected does', () => {
    // The gap this closes. AI controlled special infected are recorded as
    // entities rather than player records, because the player block is the
    // roster and a bot never joins it, and the frame writer stamps them with
    // RplClientState(c, RplIsGhost(c)) at plugin/pug-match.sp:1351: the SAME
    // ghost bit a human infected carries. A bot filling a disconnected SI's
    // slot mid-round is the ordinary way this happens. The earlier version of
    // these tests only ever built entities with kind 1 and never varied entity
    // state, so an invisible entity vetoing a frame went unnoticed.
    const f = occludedFrame();
    expect(visibleOthers(f, 0, 4)).not.toContainEqual({ x: 1000, y: 5 });
    const args = {
      survivor: f.players[0], ghost: f.players[4],
      others: visibleOthers(f, 0, 4).filter((o) => o.x !== 800), tMs: f.tMs, roundStartMs: 0,
    };
    // With the visible common removed, the unspawned hunter is the only thing
    // left on the bearing, and it must not veto: a survivor cannot see it.
    expect(pairEligible(args)).toBe(true);
  });

  it('includes that same AI special infected once it has SPAWNED, and it then occludes', () => {
    // The sibling case, and the reason the filter is on state and not on kind:
    // a spawned AI hunter is a perfectly good innocent explanation for where a
    // crosshair is pointing.
    const f = occludedFrame();
    f.entities = f.entities
      .filter((e) => e.kind === ENTITY_KIND.HUNTER_AI)
      .map((e) => ({ ...e, state: STATE.PRESENT | STATE.ALIVE }));
    expect(visibleOthers(f, 0, 4)).toContainEqual({ x: 1000, y: 5 });
    expect(pairEligible({
      survivor: f.players[0], ghost: f.players[4],
      others: visibleOthers(f, 0, 4), tMs: f.tMs, roundStartMs: 0,
    })).toBe(false);
  });

  it('feeds pairEligible an occluder that actually vetoes the frame', () => {
    // The point of the previous assertions: the list is not merely built, it is
    // load bearing. The common at (800, 0) is on the ghost's bearing exactly.
    const f = occludedFrame();
    const args = {
      survivor: f.players[0], ghost: f.players[4],
      others: visibleOthers(f, 0, 4), tMs: f.tMs, roundStartMs: 0,
    };
    expect(pairEligible(args)).toBe(false);
    // Remove only that one, and the same frame passes: nothing else in the list
    // is within OCCLUDE_WINDOW of the bearing.
    expect(pairEligible({ ...args, others: args.others.filter((o) => o.x !== 800) })).toBe(true);
  });

  it('does not let an occluder beyond OCCLUDE_MAX_DIST veto the frame', () => {
    // The deliberate half of the semantics. Commons swarm, and an unbounded
    // list let one on the far side of the map veto a frame it had nothing to do
    // with. The bound is the aim prior's own reach: past R_MAX the analyzer
    // already does not consider a cell to be looked at.
    const f = occludedFrame();
    const far = { x: TUNING.OCCLUDE_MAX_DIST + 100, y: 0 };
    const near = { x: TUNING.OCCLUDE_MAX_DIST - 100, y: 0 };
    const args = { survivor: f.players[0], ghost: f.players[4], tMs: f.tMs, roundStartMs: 0 };
    expect(pairEligible({ ...args, others: [far] })).toBe(true);
    expect(pairEligible({ ...args, others: [near] })).toBe(false);
  });
});

describe('trackFidelity', () => {
  it('is 1 when the crosshair moved exactly as needed to follow the target', () => {
    expect(trackFidelity([2, 3, 4], [2, 3, 4])).toBeCloseTo(1);
  });

  it('is 1 for perfect tracking of a target moving at a CONSTANT rate', () => {
    // The case that defeats Pearson: constant deltas have no variance, so a
    // correlation is undefined exactly when the tracking is most blatant.
    expect(trackFidelity([6, 6, 6, 6], [6, 6, 6, 6])).toBeCloseTo(1);
  });

  it('is 0 for a crosshair that never moved while the target did', () => {
    expect(trackFidelity([0, 0, 0], [5, 5, 5])).toBeCloseTo(0);
  });

  it('is 0, not negative, for a crosshair moving opposite to the target', () => {
    expect(trackFidelity([-5, -5, -5], [5, 5, 5])).toBe(0);
  });

  it('penalises moving at the wrong rate in proportion', () => {
    const half = trackFidelity([3, 3, 3], [6, 6, 6]);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
  });

  it('is 0 when the target never moved, so there was nothing to track', () => {
    expect(trackFidelity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  // The third series is the share of the bearing change the GHOST caused. The
  // residual is measured against whichever innocent explanation fits better.
  it('is 0 when the ghost caused none of the bearing change, however well the yaw matched it', () => {
    expect(trackFidelity([2, 2, 2], [2, 2, 2], [0, 0, 0])).toBe(0);
  });

  it('is 0 for a held angle when the two causes cancel and the bearing never changed', () => {
    expect(trackFidelity([0, 0, 0], [0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it('is normalised by the smaller of the two, so a partly self-made bearing change earns less', () => {
    // Residual 0.5 throughout. Against the whole bearing change (4) that is
    // 0.875; against the ghost's share (1) it is 0.5.
    expect(trackFidelity([3.5, 3.5], [4, 4], [1, 1])).toBeCloseTo(0.5, 10);
    expect(trackFidelity([3.5, 3.5], [4, 4])).toBeCloseTo(0.875, 10);
  });

  it('is 0 for series shorter than one delta', () => {
    expect(trackFidelity([], [])).toBe(0);
  });
});

describe('trackWindows', () => {
  it('scores near 1 when the crosshair follows the ghost exactly', () => {
    const w = trackWindows(round(40, (_i, b) => b), 0);
    expect(w.length).toBeGreaterThan(0);
    expect(Math.max(...w.map((x) => x.fidelity))).toBeGreaterThan(0.9);
  });

  it('scores near 0 for a held angle, which is what pre-aiming a spawn looks like', () => {
    // The ghost drifts slowly across a held crosshair: slow enough that a window
    // DOES form (a quarter degree per frame keeps it inside E_TRACK for all 40),
    // so this asserts over real windows rather than passing vacuously.
    const frames = round(40, () => 0, 1200, 0.25, -5);
    const windows = trackWindows(frames, 0);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) expect(w.fidelity).toBeLessThan(0.2);
  });

  it('produces no window when the aim never stays inside E_TRACK', () => {
    expect(trackWindows(round(40, (_i, b) => b + 90), 0)).toEqual([]);
  });

  it('produces no window for a ghost closer than D_MIN', () => {
    expect(trackWindows(round(40, (_i, b) => b, TUNING.D_MIN - 50), 0)).toEqual([]);
  });

  it('ignores frames inside the spawn grace window', () => {
    const frames = round(40, (_i, b) => b);
    for (const f of frames) f.tMs -= TUNING.SPAWN_GRACE_MS;
    expect(trackWindows(frames, 0)).toEqual([]);
  });

  it('reports the window bounds and the ghost slot', () => {
    const w = trackWindows(round(40, (_i, b) => b), 0);
    expect(w[0].ghostSlot).toBe(4);
    expect(w[0].endMs).toBeGreaterThan(w[0].startMs);
  });
});

/** A free scene: both players go wherever `at` says, t in seconds at 10 Hz.
 *  Positions are rounded to whole units because the file stores them as int16
 *  and the quantisation is part of what the metric has to survive. */
interface Pose { sx: number; sy: number; yaw: number; gx: number; gy: number }
function scene(n: number, at: (t: number) => Pose): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const p = at(i / 10);
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE, x: Math.round(p.sx), y: Math.round(p.sy), yaw: wrapDeg(p.yaw) };
    players[4] = { ...blank(4), state: STATE.PRESENT | STATE.GHOST, x: Math.round(p.gx), y: Math.round(p.gy) };
    frames.push({ tMs: TUNING.SPAWN_GRACE_MS + i * 100, offset: 0, players, entities: [] });
  }
  return frames;
}

/** Seeded gaussian noise, so a threshold that passes today passes tomorrow. */
function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 1) / 4294967297; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const deg = (rad: number) => rad * 180 / Math.PI;
const best = (frames: Frame[]) => {
  const w = trackWindows(frames, 0);
  // Every one of these asserts over real windows. A scene that forms none
  // would pass any upper bound vacuously.
  expect(w.length).toBeGreaterThan(0);
  return Math.max(...w.map((x) => x.fidelity));
};

/** What version 3 scored: all of the bearing change, the survivor's own
 *  movement included. Rebuilt here so the new numbers sit next to the old. */
function uncompensated(frames: Frame[]): number {
  let top = 0;
  for (let i = 0; i + TUNING.W <= frames.length; i++) {
    const w = frames.slice(i, i + TUNING.W);
    const dy: number[] = [], db: number[] = [];
    for (let k = 1; k < w.length; k++) {
      dy.push(wrapDeg(w[k].players[0].yaw - w[k - 1].players[0].yaw));
      db.push(wrapDeg(bearing(w[k].players[0], w[k].players[4]) - bearing(w[k - 1].players[0], w[k - 1].players[4])));
    }
    top = Math.max(top, trackFidelity(dy, db));
  }
  return top;
}

/**
 * The survivor's own movement is not tracking.
 *
 * The bearing to a ghost changes when the GHOST moves and when the SURVIVOR
 * does. Version 3 asked the crosshair to reproduce all of it, so a survivor who
 * held a door while running past it was credited with following whatever stood
 * behind the door. The highest score in real history, 0.622, was against a
 * ghost that moved 0 units.
 */
describe('trackWindows and the survivor\'s own movement', () => {
  it('scores a door held while running past a STATIONARY ghost as nothing', () => {
    const n = gaussian(1);
    // Looking at the door frame at (700, 600) the whole way. The ghost stands
    // just behind it.
    const frames = scene(40, (t) => {
      const sx = 220 * t;
      return { sx, sy: 0, yaw: deg(Math.atan2(600, 700 - sx)) + 0.3 * n(), gx: 740, gy: 630 };
    });
    expect(uncompensated(frames)).toBeGreaterThan(0.7);
    expect(best(frames)).toBeLessThan(0.1);
  });

  it('scores an A-D strafe on a corner, ghost still behind it, as nothing', () => {
    const n = gaussian(2);
    const frames = scene(40, (t) => {
      const sy = 150 * Math.sin(2 * t);
      return { sx: 0, sy, yaw: deg(Math.atan2(-sy, 500)) + 0.3 * n(), gx: 560, gy: 10 };
    });
    expect(uncompensated(frames)).toBeGreaterThan(0.7);
    expect(best(frames)).toBeLessThan(0.1);
  });

  it('scores a door held while the ghost behind it paces slowly as nothing', () => {
    const n = gaussian(3);
    const frames = scene(40, (t) => {
      const sx = 220 * t;
      return { sx, sy: 0, yaw: deg(Math.atan2(600, 700 - sx)) + 0.3 * n(), gx: 740, gy: 630 + 40 * t };
    });
    expect(best(frames)).toBeLessThan(0.1);
  });

  // Found in real history while checking the fix above, not before it:
  // pug_777fde4d..._1_2 at 56.2 s. The survivor sidesteps with the crosshair
  // dead still and the ghost happens to sidestep the same way, so the bearing
  // hardly changes. Subtracting the survivor's movement ALONE turns that into
  // "the ghost moved 3 degrees and the crosshair followed", 0.51 for a held
  // angle. A held angle scores zero, whoever is moving.
  it('scores a held angle as nothing when survivor and ghost move in parallel', () => {
    const frames = scene(40, (t) => ({ sx: 0, sy: 60 * t, yaw: 3.35, gx: 405, gy: -23 + 60 * t }));
    expect(best(frames)).toBe(0);
  });

  it('still scores true tracking of a moving ghost, survivor standing still, exactly as before', () => {
    const n = gaussian(4);
    const frames = scene(40, (t) => {
      const gy = -300 + 250 * t;
      return { sx: 0, sy: 0, yaw: deg(Math.atan2(gy, 600)) + 0.3 * n(), gx: 600, gy };
    });
    // Nothing to compensate for, so the number must not move at all.
    expect(best(frames)).toBeCloseTo(uncompensated(frames), 10);
    expect(best(frames)).toBeGreaterThan(0.7);
  });

  it('still scores true tracking of a moving ghost while the survivor runs', () => {
    const n = gaussian(5);
    const frames = scene(40, (t) => {
      const sx = 220 * t, gy = -300 + 250 * t;
      return { sx, sy: 0, yaw: deg(Math.atan2(gy, 900 - sx)) + 0.3 * n(), gx: 900, gy };
    });
    expect(best(frames)).toBeGreaterThan(0.7);
    // The ghost-caused share of the motion is smaller than the whole, so the
    // same noise costs a little more than it used to. A little.
    expect(best(frames)).toBeGreaterThan(uncompensated(frames) - 0.1);
  });

  it('is not thrown by yaw and bearing wrapping across 180', () => {
    const n = gaussian(6);
    // Ghost due west, crossing the -180/180 seam, survivor walking the other way.
    const frames = scene(40, (t) => {
      const sy = -100 * t, gy = -400 + 250 * t;
      return { sx: 0, sy, yaw: deg(Math.atan2(gy - sy, -900)) + 0.3 * n(), gx: -900, gy };
    });
    const yaws = frames.map((f) => f.players[0].yaw);
    expect(Math.max(...yaws)).toBeGreaterThan(170);
    expect(Math.min(...yaws)).toBeLessThan(-170);
    expect(best(frames)).toBeGreaterThan(0.7);
  });
});

/**
 * Coverage, which is the difference between "four hundred clean chances and
 * never a tracking window" and "the gates dropped every frame and the detector
 * never ran". The first backfill over real history could not tell those apart.
 */
describe('scanPairs', () => {
  it('counts every pair that cleared every gate', () => {
    const t = scanPairs(round(40, (_i, b) => b), 0);
    expect(t.considered).toBe(40);
    expect(t.passed).toBe(40);
    expect(t.notLive + t.notGhost + t.inGrace + t.tooClose + t.occluded).toBe(0);
  });

  it('counts pairs even when the player never tracked anything, which is the whole point', () => {
    // Looking 90 degrees away produces no window at all, and the old
    // eligiblePairs read 0 here as well, so a clean player and a blind
    // detector looked identical.
    const t = scanPairs(round(40, (_i, b) => b + 90), 0);
    expect(trackWindows(round(40, (_i, b) => b + 90), 0)).toEqual([]);
    expect(t.passed).toBe(40);
  });

  it('attributes the spawn grace window', () => {
    const frames = round(40, (_i, b) => b);
    for (const f of frames) f.tMs -= TUNING.SPAWN_GRACE_MS;
    const t = scanPairs(frames, 0);
    expect(t.inGrace).toBe(40);
    expect(t.passed).toBe(0);
  });

  it('attributes a ghost that is too close', () => {
    const t = scanPairs(round(40, (_i, b) => b, TUNING.D_MIN - 50), 0);
    expect(t.tooClose).toBe(40);
    expect(t.passed).toBe(0);
  });

  it('attributes a survivor who is down', () => {
    const frames = round(40, (_i, b) => b);
    for (let i = 0; i < 10; i++) frames[i].players[0] = { ...frames[i].players[0], state: STATE.PRESENT };
    const t = scanPairs(frames, 0);
    expect(t.notLive).toBe(10);
    expect(t.passed).toBe(30);
  });

  it('attributes an infected that has already spawned', () => {
    const frames = round(40, (_i, b) => b);
    for (let i = 0; i < 10; i++) {
      frames[i].players[4] = { ...frames[i].players[4], state: STATE.PRESENT | STATE.ALIVE };
    }
    const t = scanPairs(frames, 0);
    expect(t.notGhost).toBe(10);
    expect(t.passed).toBe(30);
  });

  it('attributes occlusion, which is what makes the guard reviewable against evidence', () => {
    const frames = round(40, (_i, b) => b);
    for (const f of frames) {
      const g = f.players[4];
      // A common sitting between the survivor and the ghost, on the bearing.
      f.entities = [{ ref: 1, kind: 1, state: 1, x: Math.round(g.x / 2), y: Math.round(g.y / 2), z: 0, health: 50 }];
    }
    const t = scanPairs(frames, 0);
    expect(t.occluded).toBe(40);
    expect(t.passed).toBe(0);
  });

  it('ignores teammates when counting notGhost, so the number is not buried', () => {
    const frames = round(40, (_i, b) => b);
    for (const f of frames) {
      f.players[1] = { ...f.players[1], state: STATE.PRESENT | STATE.ALIVE, x: 0, y: 3000 };
    }
    // One infected slot ever went ghost, so one pair per frame and no more.
    expect(scanPairs(frames, 0).considered).toBe(40);
    expect(scanPairs(frames, 0).notGhost).toBe(0);
  });
});

describe('pickClips', () => {
  const win = (startMs: number, endMs: number, fidelity: number): TrackWindow =>
    ({ startMs, endMs, ghostSlot: 4, fidelity, meanErr: 1, meanDist: 900 });

  it('drops anything under CLIP_MIN', () => {
    expect(pickClips([win(0, 2000, TUNING.CLIP_MIN - 0.01)])).toEqual([]);
  });

  it('keeps the highest scoring window and drops ones overlapping it', () => {
    const got = pickClips([win(0, 2000, 0.8), win(1000, 3000, 0.95)]);
    expect(got).toHaveLength(1);
    expect(got[0].fidelity).toBeCloseTo(0.95);
  });

  it('keeps non-overlapping windows, best first', () => {
    const got = pickClips([win(0, 2000, 0.8), win(5000, 7000, 0.95)]);
    expect(got.map((g) => g.fidelity)).toEqual([0.95, 0.8]);
  });

  it('keeps at most CLIPS_PER_ROUND', () => {
    const many = Array.from({ length: TUNING.CLIPS_PER_ROUND + 4 }, (_, i) => win(i * 5000, i * 5000 + 2000, 0.9));
    expect(pickClips(many)).toHaveLength(TUNING.CLIPS_PER_ROUND);
  });
});

/** A prior in which every cell the ghost passes through is stared at `p` of the
 *  time.
 *
 *  It must cover the ghost's WHOLE path, not just its starting cell. Seed only
 *  frame 0 and any test whose early frames get dropped (the occlusion guard
 *  drops them whenever a teammate stands on the ghost's bearing) leaves every
 *  surviving pair with a prior of 0, which collapses the variance to 0 and
 *  makes `occupancy` correctly return null, failing the assertion for a reason
 *  that has nothing to do with the behaviour under test. */
function priorWhereGhostIs(frames: Frame[], p: number): PriorTable {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const g = f.players[4];
    const c = cellOf(g.x, g.y);
    counts.set(cellKey(c.cx, c.cy), Math.round(1000 * p));
  }
  return { frames: 1000, counts };
}

describe('occupancy', () => {
  it('returns null when there is no usable prior', () => {
    expect(occupancy(round(40, (_i, b) => b), 0, null)).toBeNull();
  });

  it('is strongly positive when the player is on a ghost nobody normally looks at', () => {
    const frames = round(40, (_i, b) => b);
    const r = occupancy(frames, 0, priorWhereGhostIs(frames, 0.01));
    expect(r).not.toBeNull();
    expect(r!.z).toBeGreaterThan(3);
  });

  it('is near zero when the player is on a ghost that sits where everyone stares', () => {
    // This is the owner's objection made into a test: a famous spawn spot must
    // earn almost nothing, because the prior already contains it.
    // 0.99, not 1.0. A prior of exactly 1 asserts the cell is stared at with
    // CERTAINTY, which has zero variance, and `occupancy` correctly returns null
    // rather than dividing by it. Near-certainty is what a famous doorway
    // actually looks like in real data, and it leaves the variance real.
    const frames = round(40, (_i, b) => b);
    const r = occupancy(frames, 0, priorWhereGhostIs(frames, 0.99));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.z)).toBeLessThan(1);
  });

  it('counts no observation when the player looks away from the ghost', () => {
    const frames = round(40, (_i, b) => b + 90);
    const r = occupancy(frames, 0, priorWhereGhostIs(frames, 0.01));
    expect(r!.observed).toBe(0);
  });
});

describe('analyzeRound', () => {
  it('returns metrics and clips per survivor slot', () => {
    const frames = round(40, (_i, b) => b);
    const { metrics, clips } = analyzeRound(frames, [0], priorWhereGhostIs(frames, 0.01));
    expect(metrics.get(0)!.fidMax).toBeGreaterThan(0.9);
    expect(clips.get(0)!.length).toBeGreaterThan(0);
  });

  it('ranks a tracking survivor above a teammate who is not', () => {
    const frames = round(40, (_i, b) => b);
    for (const f of frames) {
      f.players[1] = { ...f.players[1], slot: 1, state: STATE.PRESENT | STATE.ALIVE, yaw: 0 };
    }
    const { metrics } = analyzeRound(frames, [0, 1], priorWhereGhostIs(frames, 0.01));
    expect(metrics.get(0)!.teamRank).toBe(1);
    expect(metrics.get(0)!.teamGap!).toBeGreaterThan(0);
  });

  it('leaves occupancy null and still reports fidelity when there is no prior', () => {
    const { metrics } = analyzeRound(round(40, (_i, b) => b), [0], null);
    expect(metrics.get(0)!.occZ).toBeNull();
    expect(metrics.get(0)!.fidMax).toBeGreaterThan(0.9);
  });

  it('reports eligiblePairs and the gate tally even with no prior at all', () => {
    // The defect this closes: eligiblePairs was read off the occupancy result,
    // occupancy returns null without a prior, and no map in the real history
    // had reached MIN_PRIOR_ROUNDS, so all 724 stored rows read 0 and "zero
    // clips" was unreadable.
    const { metrics } = analyzeRound(round(40, (_i, b) => b), [0], null);
    const m = metrics.get(0)!;
    expect(m.occZ).toBeNull();
    expect(m.eligiblePairs).toBe(40);
    expect(m.gates.passed).toBe(40);
    expect(m.gates.considered).toBe(40);
  });

  it('builds a round prior from the survivors it saw, for leave-one-round-out', () => {
    const { roundPrior } = analyzeRound(round(40, (_i, b) => b), [0], null);
    expect(roundPrior.frames).toBe(40);
  });
});
