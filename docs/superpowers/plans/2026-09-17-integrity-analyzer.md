# Integrity Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect survivors whose crosshair tracks ghost infected, scored against an empirical aim prior so map knowledge does not read as cheating, and surface the result as an admin-only review queue.

**Architecture:** Pure functions over already-recorded replay files, with all IO at the edges. The analyzer writes raw measurements to SQLite; scores are computed at read time so every threshold stays recomputable over the whole history. Nothing deploys to a game server and nothing is captured live.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, better-sqlite3, fastify, Preact.

**Spec:** `docs/superpowers/specs/2026-09-17-integrity-design.md`

## Global Constraints

- This plan covers spec sections 1, 2, 3 and the first two entries of section 6 only. Format version 4 (spec section 4) and the `l4d_integrity` plugin (spec section 5) are separate plans. Do not touch `plugin/` or `src/replayFormat.ts` in this plan.
- Nothing here deploys, restarts, or rcons the Dallas box. The whole plan runs against local files and an in-memory database.
- Imports use `.js` specifiers even for `.ts` sources (ESM, `"type": "module"`).
- Tests are vitest. Run a single file with `npx vitest run tests/<file>`.
- Pure modules take buffers and objects and return objects. No filesystem, no database, no clock. `src/integrity/run.ts` and `src/integrity/store.ts` are the only files in `src/integrity/` allowed to touch IO.
- Schema goes in `src/db.ts` as `CREATE TABLE IF NOT EXISTS`. There is no migration framework here by design.
- Every admin mutation calls `logAdmin` from `src/admin/audit.ts` in the same request.
- Never add accuracy, headshots, kills, damage per shot or skeet rate to any score. Spec section 1, "Anti-metrics".
- No em dashes in code, comments, docs or commit messages.

## File Structure

| File | Responsibility |
|---|---|
| `src/integrity/constants.ts` | The tuning constants, one exported frozen object |
| `src/integrity/geometry.ts` | Angle wrapping, bearing, aim error, distance, frame eligibility |
| `src/integrity/aimPrior.ts` | Cell grid, wedge rasterisation, prior accumulation and lookup |
| `src/integrity/ghostTrack.ts` | The three metrics and clip extraction, pure |
| `src/integrity/store.ts` | All database reads and writes for integrity tables |
| `src/integrity/run.ts` | Reads replay files, drives prior build and analysis, persists |
| `src/integrity/score.ts` | Percentile and composite scoring at read time |
| `src/admin/integrity.ts` | Query shapes the admin routes return |
| `scripts/backfill-integrity.ts` | CLI that walks every replay on disk |
| `web/src/routes/admin/AdminIntegrity.tsx` | The admin tab |

---

### Task 1: Constants and geometry primitives

**Files:**
- Create: `src/integrity/constants.ts`
- Create: `src/integrity/geometry.ts`
- Test: `tests/integrityGeometry.test.ts`

**Interfaces:**
- Consumes: `PlayerSample`, `STATE` from `src/replayFormat.js`
- Produces: `TUNING`; `wrapDeg(d: number): number`; `bearing(from: Pt, to: Pt): number`; `aimError(yaw: number, from: Pt, to: Pt): number`; `dist2d(a: Pt, b: Pt): number`; `isLiveSurvivor(p: PlayerSample): boolean`; `isGhost(p: PlayerSample): boolean`; `pairEligible(args: PairArgs): boolean`; `type Pt = { x: number; y: number }`; `interface PairArgs { survivor: PlayerSample; ghost: PlayerSample; others: Pt[]; tMs: number; roundStartMs: number }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integrityGeometry.test.ts
import { describe, it, expect } from 'vitest';
import { STATE, type PlayerSample } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import {
  wrapDeg, bearing, aimError, dist2d, isLiveSurvivor, isGhost, pairEligible,
} from '../src/integrity/geometry.js';

function p(over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...over,
  };
}

describe('wrapDeg', () => {
  it('leaves an angle already in range alone', () => {
    expect(wrapDeg(0)).toBe(0);
    expect(wrapDeg(90)).toBe(90);
    expect(wrapDeg(-90)).toBe(-90);
  });

  it('wraps past a half turn to the short way round', () => {
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(370)).toBe(10);
  });

  it('never returns a magnitude above 180', () => {
    for (const d of [359, -359, 720, -721, 180, -180]) {
      expect(Math.abs(wrapDeg(d))).toBeLessThanOrEqual(180);
    }
  });
});

describe('bearing and aimError', () => {
  it('measures east as zero and north as ninety', () => {
    expect(bearing({ x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(0);
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: 100 })).toBeCloseTo(90);
  });

  it('is zero error when the yaw points straight at the target', () => {
    expect(aimError(90, { x: 0, y: 0 }, { x: 0, y: 500 })).toBeCloseTo(0);
  });

  it('takes the short way round rather than reporting 350 degrees', () => {
    expect(aimError(-175, { x: 0, y: 0 }, { x: -100, y: 1 })).toBeCloseTo(-5, 0);
  });
});

describe('dist2d', () => {
  it('ignores height entirely', () => {
    expect(dist2d({ x: 0, y: 0 }, { x: 300, y: 400 })).toBeCloseTo(500);
  });
});

describe('player predicates', () => {
  it('accepts a present living survivor', () => {
    expect(isLiveSurvivor(p())).toBe(true);
  });

  it('rejects a survivor who is incapacitated, ledged or pinned', () => {
    expect(isLiveSurvivor(p({ state: STATE.PRESENT | STATE.ALIVE | STATE.INCAP }))).toBe(false);
    expect(isLiveSurvivor(p({ state: STATE.PRESENT | STATE.ALIVE | STATE.LEDGED }))).toBe(false);
    expect(isLiveSurvivor(p({ state: STATE.PRESENT | STATE.ALIVE | STATE.PINNED }))).toBe(false);
  });

  it('rejects a dead or absent survivor', () => {
    expect(isLiveSurvivor(p({ state: STATE.PRESENT }))).toBe(false);
    expect(isLiveSurvivor(p({ state: 0 }))).toBe(false);
  });

  it('accepts only a present ghost', () => {
    expect(isGhost(p({ state: STATE.PRESENT | STATE.GHOST }))).toBe(true);
    expect(isGhost(p({ state: STATE.PRESENT | STATE.ALIVE }))).toBe(false);
    expect(isGhost(p({ state: STATE.GHOST }))).toBe(false);
  });
});

describe('pairEligible', () => {
  const base = {
    survivor: p(),
    ghost: p({ slot: 4, x: 1000, y: 0, state: STATE.PRESENT | STATE.GHOST }),
    others: [] as { x: number; y: number }[],
    tMs: 60000,
    roundStartMs: 0,
  };

  it('accepts a clean pair', () => {
    expect(pairEligible(base)).toBe(true);
  });

  it('rejects a ghost closer than D_MIN', () => {
    expect(pairEligible({ ...base, ghost: p({ slot: 4, x: TUNING.D_MIN - 1, y: 0, state: STATE.PRESENT | STATE.GHOST }) })).toBe(false);
  });

  it('rejects frames inside the spawn grace window', () => {
    expect(pairEligible({ ...base, tMs: TUNING.SPAWN_GRACE_MS - 1 })).toBe(false);
  });

  it('rejects when something visible sits in the same direction as the ghost', () => {
    expect(pairEligible({ ...base, others: [{ x: 700, y: 20 }] })).toBe(false);
  });

  it('accepts when the visible thing is well off the ghost bearing', () => {
    expect(pairEligible({ ...base, others: [{ x: 0, y: 700 }] })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integrityGeometry.test.ts`
Expected: FAIL, cannot find module `../src/integrity/constants.js`

- [ ] **Step 3: Write the constants**

```ts
// src/integrity/constants.ts

/**
 * Every tuning number the analyzer has, in one place.
 *
 * These WILL be wrong on the first run. That is why nothing derived from them
 * is ever stored: `integrity_rounds` holds measurements, and `score.ts` turns
 * them into rankings at read time. Changing a number here and re-running the
 * backfill re-scores the entire history.
 */
export const TUNING = {
  /** Ghosts closer than this are dropped. Close coincidences are common and
   *  prove nothing. World units. */
  D_MIN: 300,
  /** Nothing in the first stretch of a round counts: everyone is looking
   *  around and the first spawns are scripted by position. */
  SPAWN_GRACE_MS: 5000,
  /** If a non-ghost target is within this many degrees of the ghost's bearing,
   *  the frame is dropped. The analyzer has no line of sight, so it cannot
   *  tell an invisible ghost from the visible thing next to it. */
  OCCLUDE_WINDOW: 15,
  /** Aim prior grid cell size, world units. */
  CELL: 256,
  /** How far out the aim wedge is rasterised when building the prior. */
  R_MAX: 2000,
  /** A map with fewer player-rounds than this gets no occupancy score at all.
   *  Scoring against a thin prior is worse than not scoring. */
  MIN_PRIOR_ROUNDS: 20,
  /** Fidelity window length in frames. 20 frames is 2 seconds at 10 Hz. */
  W: 20,
  /** A fidelity window requires the aim to stay inside this many degrees of
   *  the ghost for its whole length. */
  E_TRACK: 12,
  /** "On target" for the occupancy metric, in degrees. */
  E_DWELL: 5,
  /** Windows above this fidelity become reviewable clips. */
  CLIP_MIN: 0.7,
  /** Most clips kept per player-round. */
  CLIPS_PER_ROUND: 5,
} as const;
```

- [ ] **Step 4: Write the geometry module**

```ts
// src/integrity/geometry.ts
import { STATE, type PlayerSample } from '../replayFormat.js';
import { TUNING } from './constants.js';

export type Pt = { x: number; y: number };

/** Fold an angle into [-180, 180). Callers always take the magnitude, so the
 *  half-open end does not matter; what matters is that 190 reads as -170 and
 *  not as a big number. */
export function wrapDeg(d: number): number {
  return ((d + 180) % 360 + 360) % 360 - 180;
}

/** Compass bearing from one point to another, degrees, east is zero.
 *
 *  XY only. The replay stores entity origins rather than eye positions and
 *  carries no crouch state, so the vertical axis has an error about the size of
 *  the effect being measured. Yaw does not: it is unaffected by eye height.
 *  See "Geometry" in the spec. */
export function bearing(from: Pt, to: Pt): number {
  return Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
}

/** Signed degrees between where a player is looking and where a target is. */
export function aimError(yaw: number, from: Pt, to: Pt): number {
  return wrapDeg(yaw - bearing(from, to));
}

export function dist2d(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

const DISQUALIFYING = STATE.INCAP | STATE.LEDGED | STATE.PINNED;

/** A survivor whose view is their own. A pinned or downed player is being
 *  moved by something else, so their crosshair says nothing about intent. */
export function isLiveSurvivor(p: PlayerSample): boolean {
  if ((p.state & STATE.PRESENT) === 0) return false;
  if ((p.state & STATE.ALIVE) === 0) return false;
  return (p.state & DISQUALIFYING) === 0;
}

export function isGhost(p: PlayerSample): boolean {
  return (p.state & STATE.PRESENT) !== 0 && (p.state & STATE.GHOST) !== 0;
}

export interface PairArgs {
  survivor: PlayerSample;
  ghost: PlayerSample;
  /** Everything visible: live players, bots, world entities. Positions only. */
  others: Pt[];
  tMs: number;
  roundStartMs: number;
}

/** Whether one survivor and one ghost in one frame may contribute at all.
 *  Each clause is here because it generates false positives, not for tidiness. */
export function pairEligible(a: PairArgs): boolean {
  if (!isLiveSurvivor(a.survivor)) return false;
  if (!isGhost(a.ghost)) return false;
  if (a.tMs - a.roundStartMs < TUNING.SPAWN_GRACE_MS) return false;
  if (dist2d(a.survivor, a.ghost) <= TUNING.D_MIN) return false;
  const toGhost = bearing(a.survivor, a.ghost);
  for (const o of a.others) {
    if (Math.abs(wrapDeg(bearing(a.survivor, o) - toGhost)) < TUNING.OCCLUDE_WINDOW) return false;
  }
  return true;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integrityGeometry.test.ts`
Expected: PASS, all cases green

- [ ] **Step 6: Commit**

```bash
git add src/integrity/constants.ts src/integrity/geometry.ts tests/integrityGeometry.test.ts
git commit -m "Integrity: tuning constants and geometry primitives"
```

---

### Task 2: The aim prior

**Files:**
- Create: `src/integrity/aimPrior.ts`
- Test: `tests/integrityAimPrior.test.ts`

**Interfaces:**
- Consumes: `TUNING` from `./constants.js`, `wrapDeg`/`bearing` from `./geometry.js`
- Produces: `cellKey(cx: number, cy: number): string`; `cellOf(x: number, y: number): { cx: number; cy: number }`; `cellCenter(cx: number, cy: number): Pt`; `wedgeCells(from: Pt, yaw: number): string[]`; `class PriorBuilder` with `addSurvivorFrame(from: Pt, yaw: number): void`, `frames: number`, `counts: Map<string, number>`; `interface PriorTable { frames: number; counts: Map<string, number> }`; `priorAt(table: PriorTable, key: string): number`; `subtractRound(pool: PriorTable, round: PriorTable): PriorTable`

**Why a round is subtracted rather than a player.** The spec says the prior must exclude the subject's own frames so a cheater cannot inflate their own baseline. Storing per-player counts means maps times cells times players rows, which is millions. Subtracting the whole round the player is being scored in is cheaper, exact, and a stronger control: it removes the subject and their teammates and anything round-specific the director did. Leave-one-round-out, not leave-one-player-out.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integrityAimPrior.test.ts
import { describe, it, expect } from 'vitest';
import { TUNING } from '../src/integrity/constants.js';
import {
  cellKey, cellOf, cellCenter, wedgeCells, PriorBuilder, priorAt, subtractRound,
} from '../src/integrity/aimPrior.js';

describe('cells', () => {
  it('floors a position into a grid cell', () => {
    expect(cellOf(0, 0)).toEqual({ cx: 0, cy: 0 });
    expect(cellOf(TUNING.CELL - 1, 0)).toEqual({ cx: 0, cy: 0 });
    expect(cellOf(TUNING.CELL, 0)).toEqual({ cx: 1, cy: 0 });
  });

  it('floors negatives downward rather than toward zero', () => {
    expect(cellOf(-1, -1)).toEqual({ cx: -1, cy: -1 });
  });

  it('round-trips a cell through its centre', () => {
    const c = cellOf(900, -400);
    const mid = cellCenter(c.cx, c.cy);
    expect(cellOf(mid.x, mid.y)).toEqual(c);
  });
});

describe('wedgeCells', () => {
  const origin = { x: 0, y: 0 };

  it('covers cells ahead of the player', () => {
    const keys = wedgeCells(origin, 0);
    expect(keys).toContain(cellKey(...Object.values(cellOf(1000, 0)) as [number, number]));
  });

  it('does not cover cells behind the player', () => {
    const keys = wedgeCells(origin, 0);
    const behind = cellOf(-1000, 0);
    expect(keys).not.toContain(cellKey(behind.cx, behind.cy));
  });

  it('does not reach past R_MAX', () => {
    const keys = wedgeCells(origin, 0);
    const far = cellOf(TUNING.R_MAX * 2, 0);
    expect(keys).not.toContain(cellKey(far.cx, far.cy));
  });

  it('turns with the yaw', () => {
    const north = wedgeCells(origin, 90);
    const target = cellOf(0, 1000);
    expect(north).toContain(cellKey(target.cx, target.cy));
  });

  it('returns no duplicates', () => {
    const keys = wedgeCells(origin, 33);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('PriorBuilder and priorAt', () => {
  it('reports the fraction of frames whose wedge covered a cell', () => {
    const b = new PriorBuilder();
    b.addSurvivorFrame({ x: 0, y: 0 }, 0);   // looks east
    b.addSurvivorFrame({ x: 0, y: 0 }, 180); // looks west
    const east = cellOf(1000, 0);
    expect(b.frames).toBe(2);
    expect(priorAt(b, cellKey(east.cx, east.cy))).toBeCloseTo(0.5);
  });

  it('reports zero for a cell nobody ever looked at', () => {
    const b = new PriorBuilder();
    b.addSurvivorFrame({ x: 0, y: 0 }, 0);
    expect(priorAt(b, cellKey(999, 999))).toBe(0);
  });

  it('reports zero rather than dividing by zero on an empty table', () => {
    expect(priorAt(new PriorBuilder(), cellKey(0, 0))).toBe(0);
  });
});

describe('subtractRound', () => {
  it('removes a round contribution from the pool', () => {
    const pool = new PriorBuilder();
    const round = new PriorBuilder();
    pool.addSurvivorFrame({ x: 0, y: 0 }, 0);
    pool.addSurvivorFrame({ x: 0, y: 0 }, 180);
    round.addSurvivorFrame({ x: 0, y: 0 }, 0);

    const left = subtractRound(pool, round);
    const east = cellOf(1000, 0);
    expect(left.frames).toBe(1);
    expect(priorAt(left, cellKey(east.cx, east.cy))).toBe(0);
  });

  it('never produces a negative count or frame total', () => {
    const pool = new PriorBuilder();
    const round = new PriorBuilder();
    round.addSurvivorFrame({ x: 0, y: 0 }, 0);
    round.addSurvivorFrame({ x: 0, y: 0 }, 0);
    const left = subtractRound(pool, round);
    expect(left.frames).toBe(0);
    for (const v of left.counts.values()) expect(v).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integrityAimPrior.test.ts`
Expected: FAIL, cannot find module `../src/integrity/aimPrior.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/integrity/aimPrior.ts
import { TUNING } from './constants.js';
import type { Pt } from './geometry.js';

/**
 * The aim prior: how often survivors on this map look at each patch of it.
 *
 * This is the whole answer to "he was just watching the obvious spawn". Spawns
 * are not uniform, players learn the good spots, and so a raw count of "aims
 * where SI actually are" partly measures map knowledge. The prior is built from
 * behaviour rather than hand-labelled, so it already contains every place people
 * stare, and occupancy is then scored as excess over it. Someone exploiting only
 * map knowledge scores zero excess by construction.
 */

export function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function cellOf(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / TUNING.CELL), cy: Math.floor(y / TUNING.CELL) };
}

export function cellCenter(cx: number, cy: number): Pt {
  return { x: cx * TUNING.CELL + TUNING.CELL / 2, y: cy * TUNING.CELL + TUNING.CELL / 2 };
}

/**
 * Every cell inside the aim wedge: within E_DWELL degrees of `yaw`, out to
 * R_MAX.
 *
 * Walked outward rather than tested cell by cell. Testing every cell of a map
 * against every frame is frames times cells, which is hundreds of millions per
 * map; the wedge is under a hundred cells, so walking it is the difference
 * between a backfill that finishes and one that does not.
 *
 * The wedge does not stop at walls, because the analyzer has no geometry. That
 * inflates the prior AND the observation equally, so it costs sensitivity
 * rather than producing false positives.
 */
export function wedgeCells(from: Pt, yaw: number): string[] {
  const seen = new Set<string>();
  const half = TUNING.E_DWELL * Math.PI / 180;
  const step = TUNING.CELL / 2;
  for (let r = step; r <= TUNING.R_MAX; r += step) {
    // Enough angular samples that neighbouring rays stay within half a cell of
    // each other at this radius, so the wedge has no gaps as it widens.
    const arc = 2 * half * r;
    const n = Math.max(3, Math.ceil(arc / step));
    for (let i = 0; i <= n; i++) {
      const a = (yaw * Math.PI / 180) - half + (2 * half * i) / n;
      const c = cellOf(from.x + Math.cos(a) * r, from.y + Math.sin(a) * r);
      seen.add(cellKey(c.cx, c.cy));
    }
  }
  return [...seen];
}

export interface PriorTable {
  frames: number;
  counts: Map<string, number>;
}

export class PriorBuilder implements PriorTable {
  frames = 0;
  counts = new Map<string, number>();

  addSurvivorFrame(from: Pt, yaw: number): void {
    this.frames++;
    for (const k of wedgeCells(from, yaw)) {
      this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    }
  }
}

/** Probability a survivor on this map is looking at this cell. Zero for an
 *  empty table, which is what an unseen map must read as. */
export function priorAt(table: PriorTable, key: string): number {
  if (table.frames <= 0) return 0;
  return (table.counts.get(key) ?? 0) / table.frames;
}

/** Leave-one-round-out. Subtracting the round being scored removes the
 *  subject's own frames from their baseline, and their teammates' too, so a
 *  cheater cannot inflate the prior they are measured against and nothing
 *  round-specific leaks into it. Clamped at zero: a caller may hand in a round
 *  that was never pooled. */
export function subtractRound(pool: PriorTable, round: PriorTable): PriorTable {
  const counts = new Map(pool.counts);
  for (const [k, v] of round.counts) {
    counts.set(k, Math.max(0, (counts.get(k) ?? 0) - v));
  }
  return { frames: Math.max(0, pool.frames - round.frames), counts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integrityAimPrior.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/integrity/aimPrior.ts tests/integrityAimPrior.test.ts
git commit -m "Integrity: empirical aim prior over a map cell grid"
```

---

### Task 3: Tracking fidelity and clips

**Files:**
- Create: `src/integrity/ghostTrack.ts`
- Test: `tests/integrityGhostTrack.test.ts`

**Interfaces:**
- Consumes: `TUNING`; `aimError`, `bearing`, `wrapDeg`, `dist2d`, `pairEligible`, `isLiveSurvivor`, `isGhost` from `./geometry.js`; `Frame`, `PlayerSample` from `../replayFormat.js`
- Produces: `trackFidelity(dYaw: number[], dBearing: number[]): number`; `interface TrackWindow { startMs: number; endMs: number; ghostSlot: number; fidelity: number; meanErr: number; meanDist: number }`; `trackWindows(frames: Frame[], slot: number): TrackWindow[]`; `pickClips(windows: TrackWindow[]): TrackWindow[]`

**Why fidelity and not Pearson correlation.** The spec originally specified Pearson
correlation between the survivor's yaw deltas and the bearing deltas. That has a degenerate
case which fails at the detector's primary job: when a ghost moves at a constant angular
rate and the survivor tracks it perfectly, BOTH delta series are constant, so neither has
any variance and Pearson is undefined. The most blatant possible cheat scores zero. Pearson
is also scale invariant, so a crosshair moving at half the required rate but perfectly
proportionally would score a perfect 1.

Tracking fidelity has neither flaw. It asks directly: how much of the motion needed to
follow this target did the crosshair actually produce? Perfect tracking scores 1, a held
angle scores 0, and moving at the wrong rate is penalised in proportion.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integrityGhostTrack.test.ts
import { describe, it, expect } from 'vitest';
import { STATE, PLAYER_SLOTS, type Frame, type PlayerSample } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import { bearing } from '../src/integrity/geometry.js';
import { trackFidelity, trackWindows, pickClips } from '../src/integrity/ghostTrack.js';

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
```

Add `import type { TrackWindow } from '../src/integrity/ghostTrack.js';` alongside the other
import from that module so the `win` helper can be typed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integrityGhostTrack.test.ts`
Expected: FAIL, cannot find module `../src/integrity/ghostTrack.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/integrity/ghostTrack.ts
import type { Frame } from '../replayFormat.js';
import { TUNING } from './constants.js';
import {
  aimError, bearing, dist2d, isGhost, isLiveSurvivor, pairEligible, wrapDeg, type Pt,
} from './geometry.js';

/**
 * Metric A, the backbone: did the crosshair MOVE with an invisible target.
 *
 * Proximity alone is not evidence, because the good spawn spots are known and
 * people pre-aim them. A held angle produces none of the motion needed to
 * follow a moving target, so it scores zero however well chosen the spot was.
 * Producing that motion, against something you cannot see, is what has no
 * innocent explanation, and the more the ghost moves the harder it is to do by
 * accident.
 */

/**
 * How much of the motion needed to follow the target the crosshair actually
 * produced. 1 is exact, 0 is none of it.
 *
 * This replaces the Pearson correlation the design spec first called for.
 * Pearson has a degenerate case that fails at precisely the wrong moment: a
 * ghost moving at a constant angular rate, tracked perfectly, gives two
 * CONSTANT delta series, neither of which has any variance, so the correlation
 * is undefined and the most blatant possible cheat scores zero. Pearson is also
 * scale invariant, so half the required motion, perfectly proportioned, would
 * score a perfect 1. A normalised residual has neither problem.
 */
export function trackFidelity(dYaw: number[], dBearing: number[]): number {
  const n = Math.min(dYaw.length, dBearing.length);
  if (n < 1) return 0;
  let residual = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const d = dYaw[i] - dBearing[i];
    residual += d * d;
    total += dBearing[i] * dBearing[i];
  }
  // The target never moved, so following it required nothing and holding still
  // proves nothing. No evidence, not perfect evidence.
  if (total <= 1e-9) return 0;
  // Clamped: moving opposite to the target is not worse than useless evidence,
  // it is simply no evidence of tracking.
  return Math.max(0, 1 - Math.sqrt(residual / total));
}

export interface TrackWindow {
  startMs: number;
  endMs: number;
  ghostSlot: number;
  fidelity: number;
  meanErr: number;
  meanDist: number;
}

/** Positions of everything that is not this ghost and not the survivor: what
 *  the occlusion guard checks against. */
function visibleOthers(f: Frame, survivorSlot: number, ghostSlot: number): Pt[] {
  const out: Pt[] = [];
  for (const p of f.players) {
    if (p.slot === survivorSlot || p.slot === ghostSlot) continue;
    if (isGhost(p)) continue;
    if ((p.state & 1) === 0) continue; // not present
    out.push({ x: p.x, y: p.y });
  }
  for (const e of f.entities) out.push({ x: e.x, y: e.y });
  return out;
}

/** Every window in which this survivor held aim on one ghost for W frames,
 *  with how much of the motion needed to follow it they actually produced. */
export function trackWindows(frames: Frame[], slot: number): TrackWindow[] {
  if (frames.length === 0) return [];
  // Zero, not frames[0].tMs: tMs is BY DEFINITION milliseconds since the replay
  // opened, and the replay opens at round start, so the round starts at zero.
  // Using the first sampled frame instead shifts the spawn grace window by one
  // sample interval and, for a fixture whose first frame is already at
  // SPAWN_GRACE_MS, swallows the whole round.
  const roundStartMs = 0;
  const out: TrackWindow[] = [];

  const ghostSlots = new Set<number>();
  for (const f of frames) for (const p of f.players) if (isGhost(p)) ghostSlots.add(p.slot);

  for (const gs of ghostSlots) {
    // A run is consecutive frames where this pair is eligible AND on target.
    // Windows never straddle a break, because a break means the pair stopped
    // being comparable, not that nothing happened.
    let run: { tMs: number; yaw: number; bear: number; err: number; dist: number }[] = [];

    const flush = () => {
      for (let i = 0; i + TUNING.W <= run.length; i++) {
        const w = run.slice(i, i + TUNING.W);
        const dy: number[] = [], db: number[] = [];
        for (let k = 1; k < w.length; k++) {
          dy.push(wrapDeg(w[k].yaw - w[k - 1].yaw));
          db.push(wrapDeg(w[k].bear - w[k - 1].bear));
        }
        out.push({
          startMs: w[0].tMs,
          endMs: w[w.length - 1].tMs,
          ghostSlot: gs,
          fidelity: trackFidelity(dy, db),
          meanErr: w.reduce((s, x) => s + Math.abs(x.err), 0) / w.length,
          meanDist: w.reduce((s, x) => s + x.dist, 0) / w.length,
        });
      }
      run = [];
    };

    for (const f of frames) {
      const s = f.players.find((p) => p.slot === slot);
      const g = f.players.find((p) => p.slot === gs);
      if (!s || !g || !isLiveSurvivor(s) || !isGhost(g)) { flush(); continue; }
      if (!pairEligible({ survivor: s, ghost: g, others: visibleOthers(f, slot, gs), tMs: f.tMs, roundStartMs })) {
        flush(); continue;
      }
      const err = aimError(s.yaw, s, g);
      if (Math.abs(err) > TUNING.E_TRACK) { flush(); continue; }
      run.push({ tMs: f.tMs, yaw: s.yaw, bear: bearing(s, g), err, dist: dist2d(s, g) });
    }
    flush();
  }
  return out;
}

/** The reviewable moments: strongest first, never overlapping, capped. A
 *  reviewer's time is the scarce resource, so five separate moments beat fifty
 *  slices of the same one. */
export function pickClips(windows: TrackWindow[]): TrackWindow[] {
  const kept: TrackWindow[] = [];
  for (const w of [...windows].filter((x) => x.fidelity >= TUNING.CLIP_MIN).sort((a, b) => b.fidelity - a.fidelity)) {
    if (kept.length >= TUNING.CLIPS_PER_ROUND) break;
    if (kept.some((k) => w.startMs <= k.endMs && k.startMs <= w.endMs)) continue;
    kept.push(w);
  }
  return kept;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integrityGhostTrack.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/integrity/ghostTrack.ts tests/integrityGhostTrack.test.ts
git commit -m "Integrity: ghost tracking fidelity and clip selection"
```

---

### Task 4: Prior-corrected occupancy and the round analysis

**Files:**
- Modify: `src/integrity/ghostTrack.ts` (append)
- Test: `tests/integrityGhostTrack.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 3, plus `PriorTable`, `priorAt`, `cellOf`, `cellKey`, `PriorBuilder` from `./aimPrior.js`
- Produces: `interface OccResult { z: number; observed: number; expected: number; pairs: number }`; `occupancy(frames: Frame[], slot: number, prior: PriorTable | null): OccResult | null`; `interface RoundMetrics { fidMax: number; fidP95: number; occZ: number | null; teamRank: number | null; teamGap: number | null; eligiblePairs: number }`; `analyzeRound(frames: Frame[], survivorSlots: number[], prior: PriorTable | null): { metrics: Map<number, RoundMetrics>; clips: Map<number, TrackWindow[]>; roundPrior: PriorBuilder }`

- [ ] **Step 1: Write the failing test (append to the same file)**

```ts
// appended to tests/integrityGhostTrack.test.ts
import { occupancy, analyzeRound } from '../src/integrity/ghostTrack.js';
import { PriorBuilder, cellKey, cellOf, type PriorTable } from '../src/integrity/aimPrior.js';

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

  it('builds a round prior from the survivors it saw, for leave-one-round-out', () => {
    const { roundPrior } = analyzeRound(round(40, (_i, b) => b), [0], null);
    expect(roundPrior.frames).toBe(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integrityGhostTrack.test.ts`
Expected: FAIL, `occupancy is not a function`

- [ ] **Step 3: Append the implementation**

```ts
// appended to src/integrity/ghostTrack.ts
import { PriorBuilder, cellKey, cellOf, priorAt, type PriorTable } from './aimPrior.js';

export interface OccResult {
  z: number;
  observed: number;
  expected: number;
  pairs: number;
}

/**
 * Metric B: how much more often this player was on a ghost than the map's own
 * looking habits predict.
 *
 * `expected` is what map knowledge alone accounts for, summed cell by cell from
 * the prior. `observed` is what they actually did. Only the excess counts, as a
 * z-score against the binomial spread, so a player whose whole edge is knowing
 * where SI spawn scores zero by construction: the prior already contains that
 * knowledge. Rare cells carry most of the signal because their prior is low,
 * which is the behaviour we want without a second mechanism for it.
 */
export function occupancy(frames: Frame[], slot: number, prior: PriorTable | null): OccResult | null {
  if (!prior || prior.frames <= 0) return null;
  if (frames.length === 0) return null;
  // Zero, not frames[0].tMs: tMs is BY DEFINITION milliseconds since the replay
  // opened, and the replay opens at round start, so the round starts at zero.
  // Using the first sampled frame instead shifts the spawn grace window by one
  // sample interval and, for a fixture whose first frame is already at
  // SPAWN_GRACE_MS, swallows the whole round.
  const roundStartMs = 0;
  let observed = 0, expected = 0, variance = 0, pairs = 0;

  for (const f of frames) {
    const s = f.players.find((p) => p.slot === slot);
    if (!s || !isLiveSurvivor(s)) continue;
    for (const g of f.players) {
      if (!isGhost(g)) continue;
      if (!pairEligible({ survivor: s, ghost: g, others: visibleOthers(f, slot, g.slot), tMs: f.tMs, roundStartMs })) continue;
      const c = cellOf(g.x, g.y);
      const p = priorAt(prior, cellKey(c.cx, c.cy));
      pairs++;
      expected += p;
      variance += p * (1 - p);
      if (Math.abs(aimError(s.yaw, s, g)) <= TUNING.E_DWELL) observed++;
    }
  }
  if (pairs === 0 || variance <= 1e-9) return null;
  return { z: (observed - expected) / Math.sqrt(variance), observed, expected, pairs };
}

export interface RoundMetrics {
  fidMax: number;
  fidP95: number;
  occZ: number | null;
  /** 1 is the highest occupancy z on this side this round. Null without a prior. */
  teamRank: number | null;
  /** This player's z minus the mean of their teammates'. Null without a prior. */
  teamGap: number | null;
  eligiblePairs: number;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/**
 * One round, every survivor.
 *
 * Also returns the round's own contribution to the aim prior, which the caller
 * subtracts before scoring so nobody is measured against a baseline they helped
 * build. See `subtractRound`.
 */
export function analyzeRound(
  frames: Frame[], survivorSlots: number[], prior: PriorTable | null,
): { metrics: Map<number, RoundMetrics>; clips: Map<number, TrackWindow[]>; roundPrior: PriorBuilder } {
  const metrics = new Map<number, RoundMetrics>();
  const clips = new Map<number, TrackWindow[]>();
  const occ = new Map<number, OccResult | null>();
  const roundPrior = new PriorBuilder();

  for (const f of frames) {
    for (const s of f.players) {
      if (survivorSlots.includes(s.slot) && isLiveSurvivor(s)) roundPrior.addSurvivorFrame(s, s.yaw);
    }
  }

  for (const slot of survivorSlots) {
    const windows = trackWindows(frames, slot);
    clips.set(slot, pickClips(windows));
    occ.set(slot, occupancy(frames, slot, prior));
    const fids = windows.map((w) => w.fidelity);
    metrics.set(slot, {
      fidMax: fids.length ? Math.max(...fids) : 0,
      fidP95: p95(fids),
      occZ: occ.get(slot)?.z ?? null,
      teamRank: null,
      teamGap: null,
      eligiblePairs: occ.get(slot)?.pairs ?? 0,
    });
  }

  // Metric C. A second control on a different axis from the prior: the prior
  // removes what is normal for this MAP across all history, this removes what
  // was normal for this ROUND, including whatever the director happened to do.
  const scored = survivorSlots.filter((s) => occ.get(s) != null);
  if (scored.length > 1) {
    const byZ = [...scored].sort((a, b) => (occ.get(b)!.z) - (occ.get(a)!.z));
    for (const slot of scored) {
      const mine = occ.get(slot)!.z;
      const others = scored.filter((s) => s !== slot).map((s) => occ.get(s)!.z);
      const m = metrics.get(slot)!;
      m.teamRank = byZ.indexOf(slot) + 1;
      m.teamGap = mine - others.reduce((a, b) => a + b, 0) / others.length;
    }
  }
  return { metrics, clips, roundPrior };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integrityGhostTrack.test.ts`
Expected: PASS, including the "famous spawn spot earns almost nothing" case

- [ ] **Step 5: Commit**

```bash
git add src/integrity/ghostTrack.ts tests/integrityGhostTrack.test.ts
git commit -m "Integrity: prior-corrected occupancy and per-round analysis"
```

---

### Task 5: Schema and store

**Files:**
- Modify: `src/db.ts` (append to the schema string, next to `match_replays`)
- Create: `src/integrity/store.ts`
- Test: `tests/integrityStore.test.ts`

**Interfaces:**
- Consumes: `DB` from `../db.js`; `RoundMetrics`, `TrackWindow` from `./ghostTrack.js`; `PriorTable` from `./aimPrior.js`
- Produces: `ANALYZER_VERSION: number`; `saveRound(db, key: RoundKey, rows: SaveRow[]): void`; `savePrior(db, map: string, pool: PriorTable, rounds: number): void`; `loadPrior(db, map: string): { table: PriorTable; rounds: number } | null`; `saveRoundPrior(db, key: RoundKey, p: PriorTable): void`; `loadRoundPrior(db, key: RoundKey): PriorTable | null`; `setReview(db, key: RoundKey, slot: number, state: string, note: string, adminId: string): void`; `interface RoundKey { matchId: number; ordinal: number; half: number }`; `interface SaveRow { slot: number; steamid: string; metrics: RoundMetrics; clips: TrackWindow[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integrityStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  ANALYZER_VERSION, saveRound, savePrior, loadPrior, saveRoundPrior, loadRoundPrior, setReview,
} from '../src/integrity/store.js';
import type { RoundMetrics } from '../src/integrity/ghostTrack.js';

let db: DB;
const KEY = { matchId: 1, ordinal: 1, half: 1 };
const M: RoundMetrics = { fidMax: 0.9, fidP95: 0.5, occZ: 2.5, teamRank: 1, teamGap: 1.2, eligiblePairs: 300 };
const clip = { startMs: 1000, endMs: 3000, ghostSlot: 4, fidelity: 0.9, meanErr: 2, meanDist: 900 };

beforeEach(() => {
  db = openDb(':memory:');
  // Foreign keys are ON, so insert a match to satisfy integrity_rounds/clips/reviews constraints
  db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run();
});

describe('saveRound', () => {
  it('stores metrics and clips for a slot', () => {
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip] }]);
    const r = db.prepare('SELECT * FROM integrity_rounds').get() as { metrics: string; analyzer_version: number };
    expect(JSON.parse(r.metrics).fidMax).toBeCloseTo(0.9);
    expect(r.analyzer_version).toBe(ANALYZER_VERSION);
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_clips').get()).toEqual({ c: 1 });
  });

  it('replaces a previous analysis rather than accumulating duplicates', () => {
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip, { ...clip, startMs: 9000, endMs: 11000 }] }]);
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip] }]);
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_rounds').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_clips').get()).toEqual({ c: 1 });
  });

  it('keeps review state across a re-analysis', () => {
    // The whole point of storing measurements rather than verdicts is that
    // thresholds can change. A retune must not wipe what an admin already
    // looked at, which is why review lives on the player-round and not the clip.
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip] }]);
    setReview(db, KEY, 0, 'dismissed', 'watched it, he heard the spawn', 'admin1');
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [] }]);
    const rev = db.prepare('SELECT state, note FROM integrity_reviews').get();
    expect(rev).toEqual({ state: 'dismissed', note: 'watched it, he heard the spawn' });
  });
});

describe('priors', () => {
  it('round-trips a pooled prior', () => {
    savePrior(db, 'l4d_vs_farm01_hilltop', { frames: 500, counts: new Map([['1,2', 10]]) }, 25);
    const got = loadPrior(db, 'l4d_vs_farm01_hilltop');
    expect(got!.rounds).toBe(25);
    expect(got!.table.frames).toBe(500);
    expect(got!.table.counts.get('1,2')).toBe(10);
  });

  it('returns null for a map never analysed', () => {
    expect(loadPrior(db, 'nope')).toBeNull();
  });

  it('replaces a map prior wholesale rather than merging', () => {
    savePrior(db, 'm', { frames: 500, counts: new Map([['1,2', 10]]) }, 25);
    savePrior(db, 'm', { frames: 100, counts: new Map([['3,4', 1]]) }, 5);
    const got = loadPrior(db, 'm')!;
    expect(got.table.counts.has('1,2')).toBe(false);
    expect(got.table.frames).toBe(100);
  });

  it('round-trips a per-round prior contribution', () => {
    saveRoundPrior(db, KEY, { frames: 40, counts: new Map([['0,0', 40]]) });
    expect(loadRoundPrior(db, KEY)!.counts.get('0,0')).toBe(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integrityStore.test.ts`
Expected: FAIL, cannot find module `../src/integrity/store.js`

- [ ] **Step 3: Add the schema**

Add to the schema string in `src/db.ts`, immediately after the `match_replays` block:

```sql
-- Integrity measurements. Written by the analyzer, never by the game server.
-- These hold MEASUREMENTS, not verdicts: rankings are computed at read time in
-- src/integrity/score.ts so a threshold change re-scores the whole history
-- without a migration.
CREATE TABLE IF NOT EXISTS integrity_rounds (
  match_id         INTEGER NOT NULL REFERENCES matches(id),
  ordinal          INTEGER NOT NULL,
  half             INTEGER NOT NULL,
  slot             INTEGER NOT NULL,
  steamid          TEXT    NOT NULL,
  analyzer_version INTEGER NOT NULL,
  metrics          TEXT    NOT NULL,
  computed_at      TEXT    NOT NULL,
  PRIMARY KEY (match_id, ordinal, half, slot)
);

-- Derived and disposable: a re-analysis deletes and rewrites these. Nothing an
-- admin types may live here, which is why integrity_reviews is separate.
CREATE TABLE IF NOT EXISTS integrity_clips (
  id               INTEGER PRIMARY KEY,
  match_id         INTEGER NOT NULL REFERENCES matches(id),
  ordinal          INTEGER NOT NULL,
  half             INTEGER NOT NULL,
  slot             INTEGER NOT NULL,
  steamid          TEXT    NOT NULL,
  start_ms         INTEGER NOT NULL,
  end_ms           INTEGER NOT NULL,
  kind             TEXT    NOT NULL,
  score            REAL    NOT NULL,
  detail           TEXT    NOT NULL,
  analyzer_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS integrity_clips_player ON integrity_clips (steamid);

-- Survives every re-analysis. Keyed by the player-round because that is stable
-- no matter how the clips inside it are recomputed.
CREATE TABLE IF NOT EXISTS integrity_reviews (
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  ordinal     INTEGER NOT NULL,
  half        INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'new',
  note        TEXT    NOT NULL DEFAULT '',
  reviewed_by TEXT,
  reviewed_at TEXT,
  PRIMARY KEY (match_id, ordinal, half, slot)
);

-- The pooled aim prior per map, and each round's own contribution to it so a
-- round can be subtracted before it is scored (leave-one-round-out).
CREATE TABLE IF NOT EXISTS integrity_prior (
  map              TEXT PRIMARY KEY,
  frames           INTEGER NOT NULL,
  rounds           INTEGER NOT NULL,
  counts           TEXT    NOT NULL,
  analyzer_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS integrity_prior_rounds (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  ordinal  INTEGER NOT NULL,
  half     INTEGER NOT NULL,
  frames   INTEGER NOT NULL,
  counts   TEXT    NOT NULL,
  PRIMARY KEY (match_id, ordinal, half)
);
```

- [ ] **Step 4: Write the store**

```ts
// src/integrity/store.ts
import type { DB } from '../db.js';
import type { PriorTable } from './aimPrior.js';
import type { RoundMetrics, TrackWindow } from './ghostTrack.js';

/** Bump whenever a metric changes MEANING, so stale rows are identifiable
 *  without guessing from computed_at. */
export const ANALYZER_VERSION = 1;

export interface RoundKey { matchId: number; ordinal: number; half: number }
export interface SaveRow { slot: number; steamid: string; metrics: RoundMetrics; clips: TrackWindow[] }

const countsToJson = (m: Map<string, number>): string => JSON.stringify([...m]);
const countsFromJson = (s: string): Map<string, number> => new Map(JSON.parse(s) as [string, number][]);

/** Write one round's analysis, replacing any previous one.
 *
 *  Deliberately does NOT touch integrity_reviews. An admin's judgement outlives
 *  the numbers that prompted it. */
export function saveRound(db: DB, key: RoundKey, rows: SaveRow[]): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM integrity_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(key.matchId, key.ordinal, key.half);
    db.prepare('DELETE FROM integrity_clips WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(key.matchId, key.ordinal, key.half);
    const insRound = db.prepare(
      `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insClip = db.prepare(
      `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insRound.run(key.matchId, key.ordinal, key.half, r.slot, r.steamid, ANALYZER_VERSION, JSON.stringify(r.metrics), now);
      for (const c of r.clips) {
        insClip.run(
          key.matchId, key.ordinal, key.half, r.slot, r.steamid, c.startMs, c.endMs,
          'ghost_track', c.fidelity, JSON.stringify({ ghostSlot: c.ghostSlot, meanErr: c.meanErr, meanDist: c.meanDist }),
          ANALYZER_VERSION,
        );
      }
    }
  });
  tx();
}

export function savePrior(db: DB, map: string, pool: PriorTable, rounds: number): void {
  db.prepare(
    `INSERT INTO integrity_prior (map, frames, rounds, counts, analyzer_version) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(map) DO UPDATE SET frames = excluded.frames, rounds = excluded.rounds,
       counts = excluded.counts, analyzer_version = excluded.analyzer_version`,
  ).run(map, pool.frames, rounds, countsToJson(pool.counts), ANALYZER_VERSION);
}

export function loadPrior(db: DB, map: string): { table: PriorTable; rounds: number } | null {
  const row = db.prepare('SELECT frames, rounds, counts FROM integrity_prior WHERE map = ?').get(map) as
    { frames: number; rounds: number; counts: string } | undefined;
  if (!row) return null;
  return { table: { frames: row.frames, counts: countsFromJson(row.counts) }, rounds: row.rounds };
}

export function saveRoundPrior(db: DB, key: RoundKey, p: PriorTable): void {
  db.prepare(
    `INSERT INTO integrity_prior_rounds (match_id, ordinal, half, frames, counts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(match_id, ordinal, half) DO UPDATE SET frames = excluded.frames, counts = excluded.counts`,
  ).run(key.matchId, key.ordinal, key.half, p.frames, countsToJson(p.counts));
}

export function loadRoundPrior(db: DB, key: RoundKey): PriorTable | null {
  const row = db.prepare('SELECT frames, counts FROM integrity_prior_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
    .get(key.matchId, key.ordinal, key.half) as { frames: number; counts: string } | undefined;
  if (!row) return null;
  return { frames: row.frames, counts: countsFromJson(row.counts) };
}

export function setReview(db: DB, key: RoundKey, slot: number, state: string, note: string, adminId: string): void {
  db.prepare(
    `INSERT INTO integrity_reviews (match_id, ordinal, half, slot, state, note, reviewed_by, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id, ordinal, half, slot) DO UPDATE SET state = excluded.state, note = excluded.note,
       reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
  ).run(key.matchId, key.ordinal, key.half, slot, state, note, adminId, new Date().toISOString());
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integrityStore.test.ts tests/db.test.ts`
Expected: PASS, and the existing db test still green

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/integrity/store.ts tests/integrityStore.test.ts
git commit -m "Integrity: schema and store, with review state outliving re-analysis"
```

---

### Task 6: Scoring at read time

**Files:**
- Create: `src/integrity/score.ts`
- Test: `tests/integrityScore.test.ts`

**Interfaces:**
- Consumes: `RoundMetrics` from `./ghostTrack.js`
- Produces: `percentile(values: number[], v: number): number`; `interface PlayerAgg { steamid: string; rounds: number; fidMax: number; fidP95: number; occZ: number | null; teamGap: number | null }`; `aggregate(rows: { steamid: string; metrics: RoundMetrics }[]): PlayerAgg[]`; `interface ScoredPlayer extends PlayerAgg { pFid: number; pOcc: number | null; pGap: number | null; composite: number }`; `scorePlayers(aggs: PlayerAgg[]): ScoredPlayer[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integrityScore.test.ts
import { describe, it, expect } from 'vitest';
import { percentile, aggregate, scorePlayers } from '../src/integrity/score.js';
import type { RoundMetrics } from '../src/integrity/ghostTrack.js';

const m = (over: Partial<RoundMetrics> = {}): RoundMetrics => ({
  fidMax: 0.2, fidP95: 0.1, occZ: 0, teamRank: 2, teamGap: 0, eligiblePairs: 100, ...over,
});

describe('percentile', () => {
  it('is 0 for the lowest value and 1 for the highest', () => {
    expect(percentile([1, 2, 3], 1)).toBe(0);
    expect(percentile([1, 2, 3], 3)).toBe(1);
  });

  it('is the fraction of the population at or below the value', () => {
    expect(percentile([1, 2, 3, 4], 3)).toBeCloseTo(2 / 3);
  });

  it('is 0 for an empty or single-member population rather than NaN', () => {
    expect(percentile([], 5)).toBe(0);
    expect(percentile([5], 5)).toBe(0);
  });
});

describe('aggregate', () => {
  it('takes a player worst round for fidMax and their mean for the rest', () => {
    const got = aggregate([
      { steamid: 'a', metrics: m({ fidMax: 0.4, occZ: 1 }) },
      { steamid: 'a', metrics: m({ fidMax: 0.9, occZ: 3 }) },
    ]);
    expect(got[0].rounds).toBe(2);
    expect(got[0].fidMax).toBeCloseTo(0.9);
    expect(got[0].occZ).toBeCloseTo(2);
  });

  it('leaves occZ null for a player whose rounds were all on unscored maps', () => {
    expect(aggregate([{ steamid: 'a', metrics: m({ occZ: null, teamGap: null }) }])[0].occZ).toBeNull();
  });
});

describe('scorePlayers', () => {
  it('composites only the metrics a player actually has', () => {
    const [a] = scorePlayers([
      { steamid: 'a', rounds: 3, fidMax: 0.9, fidP95: 0.5, occZ: null, teamGap: null },
      { steamid: 'b', rounds: 3, fidMax: 0.1, fidP95: 0.05, occZ: null, teamGap: null },
    ]);
    expect(a.pOcc).toBeNull();
    expect(a.composite).toBeCloseTo(1);
  });

  it('ranks the tracking player above the rest', () => {
    const got = scorePlayers([
      { steamid: 'clean1', rounds: 5, fidMax: 0.2, fidP95: 0.1, occZ: 0.1, teamGap: 0 },
      { steamid: 'clean2', rounds: 5, fidMax: 0.3, fidP95: 0.12, occZ: -0.2, teamGap: -0.1 },
      { steamid: 'sus', rounds: 5, fidMax: 0.95, fidP95: 0.8, occZ: 4.2, teamGap: 3.9 },
    ]);
    expect(got[0].steamid).toBe('sus');
    expect(got[0].composite).toBeGreaterThan(got[1].composite);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integrityScore.test.ts`
Expected: FAIL, cannot find module `../src/integrity/score.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/integrity/score.ts
import type { RoundMetrics } from './ghostTrack.js';

/**
 * Rankings, computed fresh on every read.
 *
 * Nothing here is ever stored. That is what lets a threshold be wrong: change
 * a constant, re-run the backfill, and the whole history re-scores. A stored
 * score would have to be migrated, and in practice would quietly go stale.
 *
 * Note what is absent: accuracy, kills, headshots, skeet rate. Those measure
 * SKILL, and a list sorted by any of them is a list of the best players. See
 * "Anti-metrics" in the spec. They may sit beside a clip as context. They must
 * never enter the composite.
 */

/** Fraction of the population strictly below this value. */
export function percentile(values: number[], v: number): number {
  if (values.length < 2) return 0;
  const below = values.filter((x) => x < v).length;
  return below / (values.length - 1);
}

export interface PlayerAgg {
  steamid: string;
  rounds: number;
  fidMax: number;
  fidP95: number;
  occZ: number | null;
  teamGap: number | null;
}

function meanOrNull(xs: (number | null)[]): number | null {
  const ns = xs.filter((x): x is number => x != null);
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

/** Roll a player's rounds into one row.
 *
 *  fidMax is a MAXIMUM across rounds, not a mean: one round of following an
 *  invisible target is the thing worth looking at, and averaging it away with
 *  twenty clean rounds is how a detector misses. The rest are means, because a
 *  single high occupancy round really can be luck. */
export function aggregate(rows: { steamid: string; metrics: RoundMetrics }[]): PlayerAgg[] {
  const by = new Map<string, { steamid: string; metrics: RoundMetrics }[]>();
  for (const r of rows) {
    const list = by.get(r.steamid) ?? [];
    list.push(r);
    by.set(r.steamid, list);
  }
  return [...by.values()].map((list) => ({
    steamid: list[0].steamid,
    rounds: list.length,
    fidMax: Math.max(...list.map((r) => r.metrics.fidMax)),
    fidP95: meanOrNull(list.map((r) => r.metrics.fidP95)) ?? 0,
    occZ: meanOrNull(list.map((r) => r.metrics.occZ)),
    teamGap: meanOrNull(list.map((r) => r.metrics.teamGap)),
  }));
}

export interface ScoredPlayer extends PlayerAgg {
  pFid: number;
  pOcc: number | null;
  pGap: number | null;
  /** Mean of whichever percentiles this player has. A sort key, not a claim. */
  composite: number;
}

export function scorePlayers(aggs: PlayerAgg[]): ScoredPlayer[] {
  const fids = aggs.map((a) => a.fidMax);
  const occs = aggs.map((a) => a.occZ).filter((x): x is number => x != null);
  const gaps = aggs.map((a) => a.teamGap).filter((x): x is number => x != null);

  return aggs.map((a) => {
    const pFid = percentile(fids, a.fidMax);
    const pOcc = a.occZ == null ? null : percentile(occs, a.occZ);
    const pGap = a.teamGap == null ? null : percentile(gaps, a.teamGap);
    const parts = [pFid, pOcc, pGap].filter((x): x is number => x != null);
    return { ...a, pFid, pOcc, pGap, composite: parts.reduce((x, y) => x + y, 0) / parts.length };
  }).sort((x, y) => y.composite - x.composite);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integrityScore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/integrity/score.ts tests/integrityScore.test.ts
git commit -m "Integrity: percentile scoring computed at read time"
```

---

### Task 7: The runner and the backfill script

**Files:**
- Create: `src/integrity/run.ts`
- Create: `scripts/backfill-integrity.ts`
- Test: `tests/integrityRun.test.ts`

**Interfaces:**
- Consumes: `parseReplay`, `slotInfected` from `../replayFormat.js`; `resolveReplayPath` from `../replays.js`; everything from Tasks 2, 4, 5
- Produces: `analyzeOneRound(db, key: RoundKey, buf: Uint8Array): boolean`; `rebuildPriors(db, dir: string): Map<string, number>`; `backfillAll(db, dir: string): { rounds: number; skipped: number }`

**Ordering, which is load-bearing.** Priors must be rebuilt before any round is scored against one, because scoring subtracts the round's own contribution from the pool and that subtraction is meaningless if the pool does not contain it yet. `backfillAll` therefore runs two passes over the files: pass one accumulates priors and stores each round's contribution, pass two scores.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integrityRun.test.ts`
Expected: FAIL, cannot find module `../src/integrity/run.js`

- [ ] **Step 3: Write the runner**

```ts
// src/integrity/run.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.js';
import { parseReplay, slotInfected } from '../replayFormat.js';
import { PriorBuilder, subtractRound, type PriorTable } from './aimPrior.js';
import { TUNING } from './constants.js';
import { isLiveSurvivor } from './geometry.js';
import { analyzeRound } from './ghostTrack.js';
import {
  loadPrior, loadRoundPrior, saveRound, saveRoundPrior, savePrior, type RoundKey,
} from './store.js';

const NAME_RE = /^pug_([0-9a-f]{32})_(\d+)_([12])\.rpl$/;

/** Which roster slots were survivors this round, from the header's side mask. */
function survivorSlots(header: ReturnType<typeof parseReplay> extends null ? never : NonNullable<ReturnType<typeof parseReplay>>['header']): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < header.slots.length; slot++) {
    if (!header.slots[slot]) continue;
    if (!slotInfected(header, slot)) out.push(slot);
  }
  return out;
}

/**
 * Analyse one round from its bytes and persist the result.
 *
 * The prior handed to the metrics is the map pool MINUS this round, so nobody
 * is measured against a baseline they helped build. A map that has not yet
 * reached MIN_PRIOR_ROUNDS gets no prior at all and therefore no occupancy
 * score, only fidelity. That is the honest answer for a thin map and it is
 * reported rather than papered over.
 */
export function analyzeOneRound(db: DB, key: RoundKey, buf: Uint8Array): boolean {
  const replay = parseReplay(buf);
  if (!replay) return false;
  const slots = survivorSlots(replay.header);
  if (slots.length === 0) return false;

  const pooled = loadPrior(db, replay.header.map);
  let prior: PriorTable | null = null;
  if (pooled && pooled.rounds >= TUNING.MIN_PRIOR_ROUNDS) {
    const own = loadRoundPrior(db, key);
    prior = own ? subtractRound(pooled.table, own) : pooled.table;
  }

  const { metrics, clips, roundPrior } = analyzeRound(replay.frames, slots, prior);
  saveRoundPrior(db, key, roundPrior);
  saveRound(db, key, slots.map((slot) => ({
    slot,
    steamid: replay.header.slots[slot],
    metrics: metrics.get(slot)!,
    clips: clips.get(slot) ?? [],
  })));
  return true;
}

interface Found { key: RoundKey; path: string }

/** Every replay file on disk that maps to a known match, by filename. Discovery
 *  is by name for the same reason `discoverMatchReplays` does it: the link
 *  between a file and its match is a property of the filename, so it survives
 *  anything happening to the backend. */
function findReplays(db: DB, dir: string): Found[] {
  const byToken = new Map<string, number>();
  for (const r of db.prepare('SELECT match_id, filename FROM match_replays').all() as { match_id: number; filename: string }[]) {
    const m = NAME_RE.exec(r.filename);
    if (m) byToken.set(m[1], r.match_id);
  }
  const out: Found[] = [];
  for (const name of readdirSync(dir)) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const matchId = byToken.get(m[1]);
    if (matchId == null) continue;
    out.push({ key: { matchId, ordinal: Number(m[2]), half: Number(m[3]) }, path: join(dir, name) });
  }
  return out;
}

/** Pass one: pool the aim prior per map and remember each round's share.
 *  Returns rounds pooled per map. */
export function rebuildPriors(db: DB, dir: string): Map<string, number> {
  const pools = new Map<string, { builder: PriorBuilder; rounds: number }>();
  for (const f of findReplays(db, dir)) {
    const replay = parseReplay(readFileSync(f.path));
    if (!replay) continue;
    const slots = survivorSlots(replay.header);
    const entry = pools.get(replay.header.map) ?? { builder: new PriorBuilder(), rounds: 0 };
    const own = new PriorBuilder();
    for (const frame of replay.frames) {
      for (const p of frame.players) {
        if (!slots.includes(p.slot) || !isLiveSurvivor(p)) continue;
        entry.builder.addSurvivorFrame(p, p.yaw);
        own.addSurvivorFrame(p, p.yaw);
      }
    }
    entry.rounds++;
    pools.set(replay.header.map, entry);
    saveRoundPrior(db, f.key, own);
  }
  const counts = new Map<string, number>();
  for (const [map, e] of pools) {
    savePrior(db, map, e.builder, e.rounds);
    counts.set(map, e.rounds);
  }
  return counts;
}

/**
 * The whole history, in two passes.
 *
 * Priors first, scoring second, because scoring subtracts a round's own
 * contribution from the pool and that subtraction is nonsense if the pool does
 * not contain it yet. Two passes over the files is the price of getting
 * leave-one-round-out right.
 */
export function backfillAll(db: DB, dir: string): { rounds: number; skipped: number } {
  rebuildPriors(db, dir);
  let rounds = 0, skipped = 0;
  for (const f of findReplays(db, dir)) {
    if (analyzeOneRound(db, f.key, readFileSync(f.path))) rounds++;
    else skipped++;
  }
  return { rounds, skipped };
}
```

- [ ] **Step 4: Write the CLI**

```ts
// scripts/backfill-integrity.ts
/**
 * Re-analyse every replay on disk.
 *
 * Run after changing anything in src/integrity/constants.ts: the stored rows
 * are measurements, so a threshold change means re-measuring, and nothing else
 * has to be migrated.
 *
 *   npx tsx scripts/backfill-integrity.ts
 */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { backfillAll, rebuildPriors } from '../src/integrity/run.js';
import { TUNING } from '../src/integrity/constants.js';

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const dir = config.replayDir;
if (!dir) {
  console.error('No REPLAY_DIR configured; nothing to analyse.');
  process.exit(1);
}

const perMap = rebuildPriors(db, dir);
const usable = [...perMap.entries()].filter(([, n]) => n >= TUNING.MIN_PRIOR_ROUNDS);
console.log(`Priors: ${perMap.size} maps seen, ${usable.length} at or above MIN_PRIOR_ROUNDS (${TUNING.MIN_PRIOR_ROUNDS}).`);
for (const [map, n] of [...perMap.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n >= TUNING.MIN_PRIOR_ROUNDS ? 'scored ' : 'skipped'} ${map}: ${n} rounds`);
}

const { rounds, skipped } = backfillAll(db, dir);
console.log(`Analysed ${rounds} rounds, skipped ${skipped}.`);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integrityRun.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/integrity/run.ts scripts/backfill-integrity.ts tests/integrityRun.test.ts
git commit -m "Integrity: two-pass runner and backfill over existing replays"
```

---

### Task 8: Admin queries and routes

**Files:**
- Create: `src/admin/integrity.ts`
- Modify: `src/routes/admin.ts` (add three routes next to the reports routes)
- Test: `tests/integrityRoutes.test.ts`

**Interfaces:**
- Consumes: `scorePlayers`, `aggregate` from `../integrity/score.js`; `setReview` from `../integrity/store.js`; `logAdmin` from `./audit.js`
- Produces: `integrityBoard(db, seasonId: number | null): ScoredPlayer[]`; `integrityPlayer(db, steamid: string): { rounds: IntegrityRoundRow[]; clips: IntegrityClipRow[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integrityRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';

const ADMIN = '76561198000000009';
const SUS = '76561198000000001';
const CLEAN = '76561198000000002';
let db: DB;
let app: FastifyInstance;
let adminCookie: Record<string, string>;
let userCookie: Record<string, string>;

const metrics = (fidMax: number, occZ: number | null) =>
  JSON.stringify({ fidMax, fidP95: fidMax / 2, occZ, teamRank: 1, teamGap: occZ, eligiblePairs: 200 });

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {} });
  adminCookie = authedCookie(app, db, ADMIN);
  userCookie = authedCookie(app, db, CLEAN);
  authedCookie(app, db, SUS);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'farm')").run();
  const ins = db.prepare(
    `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
     VALUES (1, 1, 1, ?, ?, ?, ?, datetime('now'))`,
  );
  ins.run(0, SUS, ANALYZER_VERSION, metrics(0.95, 4.2));
  ins.run(1, CLEAN, ANALYZER_VERSION, metrics(0.2, 0.1));
  db.prepare(
    `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
     VALUES (1, 1, 1, 0, ?, 12000, 14000, 'ghost_track', 0.95, '{"ghostSlot":4}', ?)`,
  ).run(SUS, ANALYZER_VERSION);
});
afterEach(async () => { await app.close(); });

describe('GET /api/admin/integrity', () => {
  it('refuses a non-admin', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity', cookies: userCookie });
    expect(r.statusCode).toBe(403);
  });

  it('returns players ranked by composite', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity', cookies: adminCookie });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { players: { steamid: string; composite: number }[] };
    expect(body.players[0].steamid).toBe(SUS);
    expect(body.players[0].composite).toBeGreaterThan(body.players[1].composite);
  });
});

describe('GET /api/admin/integrity/:steamid', () => {
  it('returns that player rounds and clips', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/admin/integrity/${SUS}`, cookies: adminCookie });
    const body = r.json() as { rounds: unknown[]; clips: { startMs: number }[] };
    expect(body.rounds).toHaveLength(1);
    expect(body.clips[0].startMs).toBe(12000);
  });
});

describe('POST review', () => {
  it('records the state, the note and an audit entry', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: adminCookie,
      payload: { state: 'dismissed', note: 'heard the spawn' },
    });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT state, note FROM integrity_reviews').get()).toEqual({ state: 'dismissed', note: 'heard the spawn' });
    expect(db.prepare("SELECT COUNT(*) c FROM admin_actions WHERE action = 'integrity_review'").get()).toEqual({ c: 1 });
  });

  it('rejects a state outside the allowed set', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: adminCookie,
      payload: { state: 'banned', note: '' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('refuses a non-admin', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: userCookie,
      payload: { state: 'reviewed', note: '' },
    });
    expect(r.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integrityRoutes.test.ts`
Expected: FAIL, 404 on every integrity URL

- [ ] **Step 3: Write the query module**

```ts
// src/admin/integrity.ts
import type { DB } from '../db.js';
import type { RoundMetrics } from '../integrity/ghostTrack.js';
import { aggregate, scorePlayers, type ScoredPlayer } from '../integrity/score.js';

export interface IntegrityRoundRow {
  matchId: number;
  ordinal: number;
  half: number;
  slot: number;
  campaign: string | null;
  metrics: RoundMetrics;
  computedAt: string;
  reviewState: string;
  reviewNote: string;
}

export interface IntegrityClipRow {
  id: number;
  matchId: number;
  ordinal: number;
  half: number;
  slot: number;
  startMs: number;
  endMs: number;
  kind: string;
  score: number;
  detail: Record<string, unknown>;
}

/** The board: one row per player, ranked. Scores are computed here, never read
 *  from a column, so changing a threshold changes the page and nothing else. */
export function integrityBoard(db: DB, seasonId: number | null): ScoredPlayer[] {
  const rows = db.prepare(
    `SELECT r.steamid, r.metrics
     FROM integrity_rounds r JOIN matches m ON m.id = r.match_id
     WHERE (? IS NULL OR m.season_id = ?)`,
  ).all(seasonId, seasonId) as { steamid: string; metrics: string }[];
  return scorePlayers(aggregate(rows.map((r) => ({ steamid: r.steamid, metrics: JSON.parse(r.metrics) as RoundMetrics }))));
}

export function integrityPlayer(db: DB, steamid: string): { rounds: IntegrityRoundRow[]; clips: IntegrityClipRow[] } {
  const rounds = (db.prepare(
    `SELECT r.match_id, r.ordinal, r.half, r.slot, m.campaign, r.metrics, r.computed_at,
            COALESCE(v.state, 'new') AS state, COALESCE(v.note, '') AS note
     FROM integrity_rounds r
     JOIN matches m ON m.id = r.match_id
     LEFT JOIN integrity_reviews v
       ON v.match_id = r.match_id AND v.ordinal = r.ordinal AND v.half = r.half AND v.slot = r.slot
     WHERE r.steamid = ?
     ORDER BY r.match_id DESC, r.ordinal, r.half`,
  ).all(steamid) as {
    match_id: number; ordinal: number; half: number; slot: number; campaign: string | null;
    metrics: string; computed_at: string; state: string; note: string;
  }[]).map((r) => ({
    matchId: r.match_id, ordinal: r.ordinal, half: r.half, slot: r.slot, campaign: r.campaign,
    metrics: JSON.parse(r.metrics) as RoundMetrics, computedAt: r.computed_at,
    reviewState: r.state, reviewNote: r.note,
  }));

  const clips = (db.prepare(
    `SELECT id, match_id, ordinal, half, slot, start_ms, end_ms, kind, score, detail
     FROM integrity_clips WHERE steamid = ? ORDER BY score DESC`,
  ).all(steamid) as {
    id: number; match_id: number; ordinal: number; half: number; slot: number;
    start_ms: number; end_ms: number; kind: string; score: number; detail: string;
  }[]).map((c) => ({
    id: c.id, matchId: c.match_id, ordinal: c.ordinal, half: c.half, slot: c.slot,
    startMs: c.start_ms, endMs: c.end_ms, kind: c.kind, score: c.score,
    detail: JSON.parse(c.detail) as Record<string, unknown>,
  }));

  return { rounds, clips };
}
```

- [ ] **Step 4: Add the routes**

Add these imports at the top of `src/routes/admin.ts`:

```ts
import { integrityBoard, integrityPlayer } from '../admin/integrity.js';
import { setReview } from '../integrity/store.js';
```

Add these routes inside `adminRoutes`, immediately after the reports routes:

```ts
  const REVIEW_STATES = new Set(['new', 'reviewed', 'dismissed']);

  app.get('/api/admin/integrity', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const raw = (req.query as { season?: string }).season;
    const seasonId = raw === undefined || raw === '' ? null : Number(raw);
    if (seasonId !== null && !Number.isInteger(seasonId)) return reply.code(400).send({ error: 'bad season' });
    return { players: integrityBoard(db, seasonId) };
  });

  app.get('/api/admin/integrity/:steamid', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { steamid } = req.params as { steamid: string };
    return integrityPlayer(db, steamid);
  });

  app.post('/api/admin/integrity/:matchId/:ordinal/:half/:slot/review', async (req, reply) => {
    // requireAdmin RETURNS the acting admin steamid (src/routes/guards.ts:47), or
    // null having already sent the 401/403. That id is what the audit log needs.
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const p = req.params as { matchId: string; ordinal: string; half: string; slot: string };
    const body = (req.body ?? {}) as { state?: string; note?: string };
    const state = String(body.state ?? '');
    if (!REVIEW_STATES.has(state)) return reply.code(400).send({ error: 'unknown review state' });
    const key = { matchId: Number(p.matchId), ordinal: Number(p.ordinal), half: Number(p.half) };
    const slot = Number(p.slot);
    if (![key.matchId, key.ordinal, key.half, slot].every(Number.isInteger)) {
      return reply.code(400).send({ error: 'bad round' });
    }
    const note = String(body.note ?? '').slice(0, 500);
    setReview(db, key, slot, state, note, adminId);
    logAdmin(db, adminId, 'integrity_review', `${key.matchId}/${key.ordinal}/${key.half}/${slot}`, { state, note });
    return { ok: true };
  });
```

Note: the audit row must carry the real admin steamid, not an empty string. Verify after implementing: `SELECT admin_id FROM admin_actions` in the test should be the admin's id.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integrityRoutes.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/admin/integrity.ts src/routes/admin.ts tests/integrityRoutes.test.ts
git commit -m "Integrity: admin board, player detail and review routes"
```

---

### Task 9: The admin tab

**Files:**
- Modify: `web/src/api.ts` (add to `adminApi` and its types)
- Create: `web/src/routes/admin/AdminIntegrity.tsx`
- Modify: `web/src/routes/Admin.tsx` (register the tab)
- Test: `tests/../web/src/routes/admin.test.tsx` (extend the existing admin route test)

**Interfaces:**
- Consumes: `adminApi.integrity`, `adminApi.integrityPlayer`, `adminApi.integrityReview`; `useFetch`, `useAction`
- Produces: `AdminIntegrity` component

- [ ] **Step 1: Write the failing test**

Append to `web/src/routes/admin.test.tsx`, following the file's existing render and mock patterns:

```tsx
describe('AdminIntegrity', () => {
  it('shows players ranked with the composite labelled as theoretical', async () => {
    // Mock adminApi.integrity to resolve with two players, the first composite 0.98.
    // Assert the first row renders the higher composite and that the panel text
    // contains the word "theoretical", because the number must never read as a
    // verdict.
  });

  it('opens a player to their clips with a link into the replay viewer', async () => {
    // Mock adminApi.integrityPlayer with one clip at startMs 12000, match 1,
    // ordinal 1, half 1. Assert an anchor to /match/1 and that the row shows the
    // start time as text, so a reviewer knows which moment to scrub to. There is
    // deliberately no /replay/ URL here: the viewer is a component inside the
    // match page and Task 11 adds the deep link.
  });
});
```

Replace each comment with the concrete arrange/act/assert in the style already used in that file. Read the file first: it establishes how `adminApi` is mocked and how components are rendered with `@testing-library/preact`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/routes/admin.test.tsx`
Expected: FAIL, `AdminIntegrity` is not exported

- [ ] **Step 3: Add the API client**

In `web/src/api.ts`, add these types near the other admin types and the three methods to `adminApi`:

```ts
export interface IntegrityPlayerRow {
  steamid: string;
  rounds: number;
  fidMax: number;
  fidP95: number;
  occZ: number | null;
  teamGap: number | null;
  pFid: number;
  pOcc: number | null;
  pGap: number | null;
  composite: number;
}

export interface IntegrityClip {
  id: number;
  matchId: number;
  ordinal: number;
  half: number;
  slot: number;
  startMs: number;
  endMs: number;
  kind: string;
  score: number;
  detail: Record<string, unknown>;
}

export interface IntegrityRound {
  matchId: number;
  ordinal: number;
  half: number;
  slot: number;
  campaign: string | null;
  metrics: { fidMax: number; fidP95: number; occZ: number | null; teamRank: number | null; teamGap: number | null; eligiblePairs: number };
  computedAt: string;
  reviewState: string;
  reviewNote: string;
}
```

```ts
  integrity: (season: string, signal?: AbortSignal) =>
    get<{ players: IntegrityPlayerRow[] }>(`/api/admin/integrity?season=${encodeURIComponent(season)}`, signal),
  integrityPlayer: (steamid: string, signal?: AbortSignal) =>
    get<{ rounds: IntegrityRound[]; clips: IntegrityClip[] }>(`/api/admin/integrity/${steamid}`, signal),
  integrityReview: (matchId: number, ordinal: number, half: number, slot: number, state: string, note: string) =>
    post(`/api/admin/integrity/${matchId}/${ordinal}/${half}/${slot}/review`, { state, note }),
```

Use whatever `get` and `post` helpers the file already defines rather than inventing new ones.

- [ ] **Step 4: Write the component**

```tsx
// web/src/routes/admin/AdminIntegrity.tsx
import { useState } from 'preact/hooks';
import { adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { useAction } from './useAction';

const pct = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
const num = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(2));

/**
 * Admin-only integrity board.
 *
 * The composite is a SORT KEY, not an accusation, and the copy says so. What it
 * opens is evidence: each clip links into the replay viewer at the moment that
 * flagged it, because the unit of review is a clip and not a player.
 */
export function AdminIntegrity() {
  const [steamid, setSteamid] = useState<string | null>(null);
  const { data, reload } = useFetch((s) => adminApi.integrity('', s), []);
  const detail = useFetch((s) => (steamid ? adminApi.integrityPlayer(steamid, s) : Promise.resolve(null)), [steamid]);
  const { busy, error, run } = useAction(() => { reload(); detail.reload(); });
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (steamid && detail.data) {
    return (
      <Panel>
        <button class="chip" onClick={() => setSteamid(null)}>Back to board</button>
        {error && <p class="error">{error}</p>}
        {detail.data.clips.length === 0 && <Empty>No flagged moments for this player.</Empty>}
        <ul class="admin-clips">
          {detail.data.clips.map((c) => {
            const key = `${c.matchId}/${c.ordinal}/${c.half}/${c.slot}`;
            return (
              <li key={c.id}>
                <p>
                  <a href={`/match/${c.matchId}`}>Match #{c.matchId}</a>
                  {' '}map {c.ordinal} round {c.half}
                  {' '}at <strong>{(c.startMs / 1000).toFixed(1)}s</strong>
                  <span class="muted"> · fidelity {c.score.toFixed(2)} · {(c.endMs - c.startMs) / 1000}s</span>
                </p>
                <div class="admin-form">
                  <input value={notes[key] ?? ''} placeholder="Review note" aria-label="Review note"
                    onInput={(e) => setNotes({ ...notes, [key]: (e.target as HTMLInputElement).value })} />
                  <button class="btn" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(c.matchId, c.ordinal, c.half, c.slot, 'reviewed', notes[key] ?? ''))}>
                    Reviewed
                  </button>
                  <button class="chip" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(c.matchId, c.ordinal, c.half, c.slot, 'dismissed', notes[key] ?? ''))}>
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>
    );
  }

  return (
    <Panel>
      <p class="muted">
        Theoretical only. These numbers rank who is worth watching a clip of; they are not
        evidence of anything on their own, and nothing here is visible outside this panel.
      </p>
      {data && data.players.length === 0 && <Empty>Nothing analysed yet. Run the backfill.</Empty>}
      <table class="admin-table">
        <thead>
          <tr>
            <th>Player</th><th>Rounds</th><th>Composite</th>
            <th>Tracking</th><th>Occupancy</th><th>Team gap</th>
          </tr>
        </thead>
        <tbody>
          {data?.players.map((p) => (
            <tr key={p.steamid}>
              <td><button class="linklike" onClick={() => setSteamid(p.steamid)}>{p.steamid}</button></td>
              <td>{p.rounds}</td>
              <td>{pct(p.composite)}</td>
              <td>{num(p.fidMax)} <span class="muted">({pct(p.pFid)})</span></td>
              <td>{num(p.occZ)} <span class="muted">({pct(p.pOcc)})</span></td>
              <td>{num(p.teamGap)} <span class="muted">({pct(p.pGap)})</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
```

- [ ] **Step 5: Register the tab**

In `web/src/routes/Admin.tsx`, add the import, add `{ key: 'integrity', label: 'Integrity' }` to `TABS` after `reports`, and add `{tab === 'integrity' && <AdminIntegrity />}` to the body.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run web/src/routes/admin.test.tsx && npm run typecheck`
Expected: PASS, and typecheck clean

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/AdminIntegrity.tsx web/src/routes/Admin.tsx web/src/routes/admin.test.tsx
git commit -m "Integrity: admin tab with clip review"
```

---

### Task 10: Full suite, then the first real run

**Files:** none changed unless the suite finds something.

- [ ] **Step 1: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. If an existing test broke, the schema addition is the likely cause; fix it before continuing.

- [ ] **Step 2: Run the backfill against real replays**

Run: `REPLAY_DIR=<path to the replay files> npx tsx scripts/backfill-integrity.ts`
Expected: a per-map line saying how many rounds each map has and whether it cleared `MIN_PRIOR_ROUNDS`, then a count of rounds analysed.

- [ ] **Step 3: Answer the question the spec asks in section 7**

Open the Integrity tab and look at the top of the board. **Does the top of the list look like the best players rather than a suspicious one?** If it does, the metric is measuring aim quality and not information, and the fix goes in the prior and in metric C, not in the thresholds. Write down what you saw and stop. Do not tune constants to make the list look better.

Also record how many maps cleared `MIN_PRIOR_ROUNDS`. If it is only two or three, occupancy is not yet usable and fidelity carries the retrospective pass alone. That is an acceptable outcome and it gets reported, not worked around by lowering the threshold.

- [ ] **Step 4: Commit any fixes and report**

```bash
git add -A
git commit -m "Integrity: fixes from the first backfill"
```

---

---

### Task 11: Deep link a clip into the viewer

Added during the pre-flight scan. The original Task 9 linked to
`/replay/${matchId}/${ordinal}/${half}?t=`, which is not a route: the real routes are
`/match/:id` and `/replay/file/:name`, and the viewer is a component inside MatchDetail that
takes `spec={{ kind: 'match', matchId, ordinal, half }}` as a prop. Task 9 therefore links to
the match page with the round and timestamp as text, and this task adds the real deep link.

**Files:**
- Modify: `web/src/routes/MatchDetail.tsx`
- Modify: `web/src/replay/Viewer.tsx`
- Modify: `web/src/routes/admin/AdminIntegrity.tsx` (use the deep link once it exists)
- Test: the nearest existing viewer test file (`web/src/replay/renderRate.test.tsx` shows the render patterns)

**Interfaces:**
- Consumes: `playback.seek(t: number)` from `usePlayback` (`web/src/replay/playback.ts:84`); `AdminIntegrity` from Task 9
- Produces: `Viewer` gains an optional prop `seekMs?: number`

- [ ] **Step 1: Write the failing test**

Add to the viewer test file, following its existing render patterns:

```tsx
it('seeks once to seekMs when the frames arrive, and not again on later renders', () => {
  // Render Viewer with a stub source whose frames span 0..20000 and seekMs 12000.
  // Assert the playhead lands at 12000. Re-render with the same props and assert
  // no second seek: a viewer the user has since scrubbed must not be yanked back.
});
```

Replace the comment with the concrete arrange/act/assert in the style the file already uses.
Read the file first: `renderRate.test.tsx` and `usePlaybackLoop.test.ts` show how playback is
driven in tests and how a stub replay source is supplied.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/replay/`
Expected: FAIL, `seekMs` is not a prop of `Viewer`

- [ ] **Step 3: Add the prop to Viewer**

In `web/src/replay/Viewer.tsx`, add `seekMs` to the props type and the destructuring, then
after `const playback = usePlayback(endMs, { live });` add:

```tsx
  /** A deep link lands on a moment, not the start of the round. Fires once, when
   *  the frames first arrive: a viewer the user has since scrubbed must not be
   *  yanked back to the link's timestamp on every later render. */
  const seeked = useRef(false);
  useEffect(() => {
    if (seeked.current || seekMs == null || frames.length === 0) return;
    seeked.current = true;
    playback.seek(seekMs);
  }, [seekMs, frames.length, playback]);
```

Import `useEffect` and `useRef` from `preact/hooks` if the file does not already.

- [ ] **Step 4: Read the query params in MatchDetail**

`MatchDetail` already owns the ordinal and half state for its round switch. Give that state an
initial value from the URL when present, and pass `seekMs` through to `Viewer`:

```tsx
const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
const qOrdinal = Number(params.get('ordinal'));
const qHalf = Number(params.get('half'));
const qT = Number(params.get('t'));
```

Use `qOrdinal` and `qHalf` as the initial round selection only when both are integers matching
a map and round the page actually has, and pass `seekMs={Number.isFinite(qT) ? qT : undefined}`.
A malformed or out-of-range param must fall back to the existing default, never render an empty
page.

- [ ] **Step 5: Point the admin clips at it**

In `AdminIntegrity.tsx`, change the clip link to
`` `/match/${c.matchId}?ordinal=${c.ordinal}&half=${c.half}&t=${c.startMs}` `` and drop the
now-redundant "map N round N at Xs" text, keeping the fidelity and the duration.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run web/src && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/replay/Viewer.tsx web/src/routes/MatchDetail.tsx web/src/routes/admin/AdminIntegrity.tsx
git commit -m "Integrity: deep link a flagged clip to its moment in the viewer"
```

## Self-Review

**Spec coverage.** Section 1 geometry maps to Task 1; the aim prior to Task 2; metric A and clips to Task 3; metrics B and C to Task 4; anti-metrics are enforced by a comment in `score.ts` and the absence of those fields anywhere; section 2 storage and scoring to Tasks 5 and 6; section 3 admin tab to Tasks 8 and 9; section 6 order of work is the task order; section 7's first and second verification items are Task 10. Section 4 (format v4) and section 5 (the plugin) are explicitly out of this plan and get their own. The third and fourth verification items in section 7 belong to the plugin plan.

**Deviation to note.** The spec says the prior excludes "the subject player's own frames". This plan excludes the whole round instead, because per-player counts would be maps times cells times players rows. Round-level exclusion is cheaper and strictly stronger: it removes the subject, their teammates, and anything round-specific. Task 2 documents the reasoning in the module.

**Constants.** The spec lists ten; this plan adds `R_MAX`, the wedge rasterisation range, which the spec's prior section implies but does not name. Eleven total.

**Type consistency.** `RoundKey`, `PriorTable`, `TrackWindow`, `RoundMetrics`, `OccResult`, `PlayerAgg` and `ScoredPlayer` are each defined once and imported everywhere else. `priorAt` takes a `PriorTable` and a key string in every call site. `analyzeRound` returns `{ metrics, clips, roundPrior }` and Task 7 destructures exactly those three.

## Amendments after the whole-branch review, 2026-09-17

The eleven tasks above were each built and reviewed on their own. A review of the finished
branch then found defects that no per-task review could see, and the fixes changed things
the code blocks above still show in their pre-fix form. Read those blocks as the record of
what each task was asked to build, and this section as what the branch actually holds.

- **`src/integrity/ghostTrack.ts` was split into three modules.** `ghostTrack.ts` keeps
  metric A and the shared frame-eligibility primitives, `occupancy.ts` holds metric B and
  is now the only module that depends on `aimPrior.ts`, and `round.ts` holds `analyzeRound`,
  `RoundMetrics` and metric C. Every exported name is unchanged. Import lines in the blocks
  above that say `./ghostTrack.js` for `RoundMetrics` or `analyzeRound` now say
  `./round.js`, and `occupancy` comes from `./occupancy.js`.
- **`RoundMetrics` gained a `gates` tally** (`considered`, `notLive`, `notGhost`,
  `inGrace`, `tooClose`, `occluded`, `passed`), and `eligiblePairs` is now `gates.passed`.
  It used to be read off the occupancy result, which is null on every map under
  `MIN_PRIOR_ROUNDS`, so every row the first backfill wrote read 0 and "zero clips" could
  not be told from "the detector never ran". Every `RoundMetrics` literal in the blocks
  above therefore needs a `gates` field to compile.
- **`TUNING.OCCLUDE_MAX_DIST` (2000) was added**, bounding the occlusion guard at the aim
  prior's own reach. Twelve constants now, not eleven. The reasoning is on the constant and
  in the spec's frame eligibility section.
- **`ANALYZER_VERSION` is 2.** Version 1 rows are not comparable.
- **`buildRoundPrior` in `round.ts` is the single producer** of a round's contribution to
  the map prior. Task 7's `rebuildPriors` used to compute it a second time inline.
- **`integrityBoard` returns `name` and `clips`** alongside the scored fields, and the admin
  board renders a rank rather than a percentage and dims itself when nothing is flagged.
