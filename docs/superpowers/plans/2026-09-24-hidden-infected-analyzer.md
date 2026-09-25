# Hidden-Infected Analyzer (Analyzer Version 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score survivors on tracking, pre-aiming and reveal reaction against spawned infected that were hidden behind walls from the whole survivor team, using the line-of-sight bits plan 1 records, and show the results to admins only.

**Architecture:** A new `los.ts` turns the replay header into a cached line-of-sight lookup. A new `hidden.ts` holds the hidden-pair gate and metrics D (hidden tracking), E (hidden pre-aim) and F (reveal reaction), reusing the tracking and occupancy machinery, which is generalized with a lag search. `analyzeRound` gains a line-of-sight argument, `RoundMetrics` gains optional fields so version 4 rows still read, `ANALYZER_VERSION` goes to 5, and `score.ts` adds the new columns at read time without changing the composite rank. The admin board, player file and timeline show the new numbers and the new clip kind.

**Tech Stack:** TypeScript, Node 22, vitest, better-sqlite3, Fastify, Preact (web), `npx tsx` scripts.

**Spec:** `docs/superpowers/specs/2026-09-23-spawned-infected-los-design.md` (sections 3, 4, 6, 7 and Testing). Plan 1, which recorded the data, is `docs/superpowers/plans/2026-09-23-los-recording.md`.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/hidden-analyzer` on branch `worktree-hidden-analyzer`. Other sessions rewrite pug `master`; never commit there directly.
- Never use em dashes in code, comments, docs, test names or commit messages. Replace by meaning (colon, comma, period, parentheses).
- Match the surrounding comment style: comments explain WHY, with evidence, as the existing `src/integrity/` files do.
- Gates (unchanged values): `D_MIN` 300, `SPAWN_GRACE_MS` 5000, `R_MAX` 2000, `E_TRACK` 12, `E_DWELL` 5, `PITCH_TOL` 20, `MIN_TRAVEL` 4, `W` 20, `CLIP_MIN` 0.4, `MIN_BOARD_ROUNDS` 8, `MIN_TRACK_WINDOWS` 20.
- New tuning values, exactly: lags 0, 100, 200, 300, 400 ms (`LAG_MAX_FRAMES: 4` at 10 Hz); metric F minimum 30 reveals (`MIN_REVEALS: 30`).
- Scored classes are `m_zombieClass` 1 smoker, 2 boomer, 3 hunter (`ZOMBIE_CLASSES` in `src/replayFormat.ts`). Witch (4) and tank (5) are never targets.
- A line-of-sight bit of 0 means "hidden" only when the header's `losKnown` is true; otherwise it is unknown, never "saw nothing".
- No automatic action and no Discord post comes from any score (spec section 4).
- Run the full suite with `npm test` and the type check with `npm run typecheck` from the worktree root.

## Decisions this plan makes that the spec left open (owner review)

1. **The composite rank does not change.** D, E and F get their own columns and percentiles but stay out of the composite until the calibration session (spec section 6) has set their thresholds. Putting uncalibrated metrics into the rank would reorder the Needs a look list on untested numbers.
2. **The lag-tolerant ghost score is stored but not ranked.** Spec section 6 says it replaces the current ghost score only after calibration. Every ghost window keeps its lag 0 `fidelity` (ranked, clipped as today) and also carries `lagFidelity` and `lagMs`; rounds store `fidLagSum`.
3. **The Discord toggle is not built.** Spec section 4 adds a setting that defaults off, but no integrity Discord poster exists, so the toggle would control nothing. It ships with the poster after calibration.
4. **Metric F's "hidden before the reveal" also requires hidden from the whole team.** Spec section 3 says every metric shares the team gate; applying it to the frame before a reveal is how a callout is kept out of "already on target".
5. **The lag search holds the yaw window fixed and moves the target back.** A window's yaw frames are `i .. i+W-1` at every lag, compared against where the target was `lag` frames earlier, so every lag scores the same crosshair motion and the window count does not change.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/integrity/los.ts` | create | `losView(header)`: cached "could this survivor see this infected" and "could any other survivor see it"; `classOf`, `isSpawnedTarget` |
| `src/integrity/constants.ts` | modify | add `LAG_MAX_FRAMES`, `MIN_REVEALS` |
| `src/integrity/ghostTrack.ts` | modify | generic `trackWindowsFor` with the lag search; `TrackWindow` gains `lagFidelity`, `lagMs`, `targetCls`; `pickClips` takes a score accessor |
| `src/integrity/occupancy.ts` | modify | extract `occFromBlocks` so metric E reuses the block arithmetic |
| `src/integrity/hidden.ts` | create | hidden-pair gate and tally, metrics D, E, F, per-class sums, `hiddenMetrics` |
| `src/integrity/round.ts` | modify | `analyzeRound(frames, slots, prior, los)`; `RoundMetrics` optional `losKnown`, `fidLagSum`, `hidden`; returns `hiddenClips` |
| `src/integrity/store.ts` | modify | `ANALYZER_VERSION = 5`; `saveRound` writes `hidden_track` clips |
| `src/integrity/run.ts` | modify | pass `losView(header)` into `analyzeRound`, save hidden clips |
| `src/integrity/score.ts` | modify | `calibrate` takes a picker; `PlayerAgg` and `ScoredPlayer` gain the hidden columns |
| `src/admin/analyzerRanks.ts` | modify | carry the new columns |
| `src/admin/timeline/analyzer.ts` | modify | kind-aware clip summary |
| `src/integrity/synthetic.ts` | modify | `injectTracker` can follow a spawned infected |
| `scripts/inject-synthetic-tracker.ts` | modify | `--hidden` mode |
| `scripts/lag-inflation.ts` | create | how much the lag search lifts honest scores, from real replays |
| `web/src/api.ts` | modify | `AnalyzerRank` mirror |
| `web/src/routes/admin/NeedsALook.tsx` | modify | three new columns |
| `web/src/routes/admin/file/EvidenceDetail.tsx` | modify | new line, class split, column key, clip kind label |
| `tests/integrityLos.test.ts`, `tests/integrityHidden.test.ts` | create | unit tests for the two new modules |
| existing tests | modify | fixtures gain the new required fields |

---

### Task 1: Line-of-sight view and infected classes

**Files:**
- Create: `src/integrity/los.ts`
- Test: `tests/integrityLos.test.ts`

**Interfaces:**
- Consumes: `sideRanks`, `PLAYER_SLOTS`, `STATE`, `Frame`, `PlayerSample`, `ReplayHeader` from `src/replayFormat.ts`.
- Produces:
  - `type InfectedClass = 'smoker' | 'boomer' | 'hunter'`
  - `const TRACKED_CLASSES: readonly InfectedClass[]`
  - `classOf(cls: number): InfectedClass | null`
  - `isSpawnedTarget(p: PlayerSample): boolean`
  - `interface LosView { known: boolean; sees(f: Frame, survivorSlot: number, infectedSlot: number): boolean | null; othersSee(f: Frame, infectedSlot: number, exceptSurvivorSlot: number): boolean | null }`
  - `losView(h: ReplayHeader): LosView`
  - `const NO_LOS: LosView`

- [ ] **Step 1: Write the failing test**

Create `tests/integrityLos.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PLAYER_SLOTS, STATE, canSee, type Frame, type PlayerSample, type ReplayHeader } from '../src/replayFormat.js';
import { NO_LOS, classOf, isSpawnedTarget, losView } from '../src/integrity/los.js';

/** Survivors in slots 0 and 3, infected in 1 and 2, the layout of the first
 *  real file checked (survivor ranks 0,-1,-1,1 and infected -1,0,1,-1). */
function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: 3, token: '0'.repeat(32), ordinal: 1, half: 1, playerHz: 10, entityHz: 10,
    map: 'l4d_vs_hospital01_apartment', startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['1', '2', '3', '4', '', '', '', ''], infectedMask: 0b0110, sidesKnown: true, losKnown: true,
    ...over,
  };
}
const frame = (los: number): Frame => ({ tMs: 0, offset: 0, players: [], entities: [], los });
const sample = (over: Partial<PlayerSample>): PlayerSample => ({
  slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0, ...over,
});

describe('losView', () => {
  it('agrees with canSee for every survivor and infected pair', () => {
    const h = header();
    const v = losView(h);
    for (const los of [0, 0b1, 0b10, 1 << 4, 1 << 5, 0xffff]) {
      const f = frame(los);
      for (let s = 0; s < PLAYER_SLOTS; s++) {
        for (let i = 0; i < PLAYER_SLOTS; i++) expect(v.sees(f, s, i)).toBe(canSee(h, f, s, i));
      }
    }
  });

  it('is unknown, never false, when the file does not record line of sight', () => {
    const v = losView(header({ losKnown: false }));
    expect(v.known).toBe(false);
    expect(v.sees(frame(0), 0, 1)).toBeNull();
    expect(v.othersSee(frame(0), 1, 0)).toBeNull();
    expect(NO_LOS.sees(frame(0xffff), 0, 1)).toBeNull();
  });

  it('asks the other survivors, never the one being measured', () => {
    const v = losView(header());
    // Survivor slot 3 is rank 1 and infected slot 2 is rank 1: bit 1*4+1.
    expect(v.othersSee(frame(1 << 5), 2, 0)).toBe(true);
    // Only survivor slot 0 (rank 0) sees infected slot 2 (rank 1): bit 0*4+1.
    expect(v.othersSee(frame(1 << 1), 2, 0)).toBe(false);
    expect(v.othersSee(frame(1 << 1), 2, 3)).toBe(true);
  });

  it('has no answer for a slot with no rank on the side asked about', () => {
    const v = losView(header());
    expect(v.sees(frame(0xffff), 1, 2)).toBeNull();
    expect(v.othersSee(frame(0xffff), 0, 3)).toBeNull();
  });
});

describe('classOf and isSpawnedTarget', () => {
  it('scores smokers, boomers and hunters only', () => {
    expect([0, 1, 2, 3, 4, 5].map(classOf)).toEqual([null, 'smoker', 'boomer', 'hunter', null, null]);
  });

  it('is a living, spawned, scored infected', () => {
    const live = STATE.PRESENT | STATE.ALIVE;
    expect(isSpawnedTarget(sample({ state: live, cls: 3 }))).toBe(true);
    expect(isSpawnedTarget(sample({ state: live | STATE.GHOST, cls: 3 }))).toBe(false);
    expect(isSpawnedTarget(sample({ state: STATE.PRESENT, cls: 3 }))).toBe(false);
    expect(isSpawnedTarget(sample({ state: live, cls: 5 }))).toBe(false);
    expect(isSpawnedTarget(sample({ state: 0, cls: 3 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integrityLos.test.ts`
Expected: FAIL, "Failed to resolve import ../src/integrity/los.js".

- [ ] **Step 3: Write the implementation**

Create `src/integrity/los.ts`:

```ts
import { PLAYER_SLOTS, STATE, sideRanks, type Frame, type PlayerSample, type ReplayHeader } from '../replayFormat.js';

/**
 * Line of sight as the analyzer reads it.
 *
 * `canSee` in replayFormat.ts answers the same question, but recomputes the
 * side ranks on every call, and the analyzer asks it for every survivor, every
 * infected and every frame of every round in history. This computes the ranks
 * once per round. The answers are identical, which a test holds it to.
 *
 * Unknown is never "could not see". A file written before plan 1 has no bits
 * at all, so every question about it answers null and the hidden metrics do
 * not run on it.
 */

/** The special infected the hidden metrics score. A witch cannot move and a
 *  tank is loud and enormous, so knowing where either is gives nothing a
 *  survivor could not have heard. */
export type InfectedClass = 'smoker' | 'boomer' | 'hunter';
export const TRACKED_CLASSES: readonly InfectedClass[] = ['smoker', 'boomer', 'hunter'];

/** `m_zombieClass` (ZOMBIE_CLASSES in replayFormat.ts) to a scored class. */
export function classOf(cls: number): InfectedClass | null {
  if (cls === 1) return 'smoker';
  if (cls === 2) return 'boomer';
  if (cls === 3) return 'hunter';
  return null;
}

/** An infected the hidden metrics can be about: present, alive, spawned, and
 *  of a scored class. A ghost is metric A's business, not these. */
export function isSpawnedTarget(p: PlayerSample): boolean {
  if ((p.state & STATE.PRESENT) === 0) return false;
  if ((p.state & STATE.ALIVE) === 0) return false;
  if ((p.state & STATE.GHOST) !== 0) return false;
  return classOf(p.cls) !== null;
}

export interface LosView {
  /** Whether the file records line of sight at all (header byte 158). */
  known: boolean;
  /** Could this survivor see this infected in this frame. Null when unknown. */
  sees(f: Frame, survivorSlot: number, infectedSlot: number): boolean | null;
  /** Could any survivor OTHER than `exceptSurvivorSlot` see this infected. A
   *  teammate who can see it may have called it out, so this is the voice
   *  confound the "hidden from the whole team" gate removes. Null when
   *  unknown. */
  othersSee(f: Frame, infectedSlot: number, exceptSurvivorSlot: number): boolean | null;
}

export const NO_LOS: LosView = { known: false, sees: () => null, othersSee: () => null };

export function losView(h: ReplayHeader): LosView {
  if (!h.losKnown) return NO_LOS;
  const { survivor, infected } = sideRanks(h);
  const bit = (f: Frame, sr: number, ir: number): boolean => (((f.los ?? 0) >> (sr * 4 + ir)) & 1) === 1;
  return {
    known: true,
    sees(f, survivorSlot, infectedSlot) {
      const sr = survivor[survivorSlot] ?? -1, ir = infected[infectedSlot] ?? -1;
      if (sr < 0 || ir < 0) return null;
      return bit(f, sr, ir);
    },
    othersSee(f, infectedSlot, exceptSurvivorSlot) {
      const ir = infected[infectedSlot] ?? -1;
      if (ir < 0) return null;
      for (let s = 0; s < PLAYER_SLOTS; s++) {
        if (s === exceptSurvivorSlot) continue;
        const sr = survivor[s];
        if (sr >= 0 && bit(f, sr, ir)) return true;
      }
      return false;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integrityLos.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/integrity/los.ts tests/integrityLos.test.ts
git commit -m "Integrity: a cached line-of-sight view and the scored infected classes"
```

---

### Task 2: Generic tracking windows with a lag search

**Files:**
- Modify: `src/integrity/constants.ts` (add two constants before `CLIP_MIN`'s doc comment)
- Modify: `src/integrity/ghostTrack.ts:100-195` (`TrackWindow`, `trackWindows`) and `:267-278` (`pickClips`)
- Modify: `tests/integrityGhostTrack.test.ts:550-551` (`win` helper), `tests/integrityStore.test.ts:14` (`clip` fixture)
- Test: `tests/integrityGhostTrack.test.ts` (new `describe` block at the end)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `TUNING.LAG_MAX_FRAMES = 4`, `TUNING.MIN_REVEALS = 30`
  - `TrackWindow` gains required `lagFidelity: number`, `lagMs: number`, `targetCls: number`
  - `trackWindowsFor(frames: Frame[], slot: number, targets: Iterable<number>, eligible: (f: Frame, s: PlayerSample, g: PlayerSample) => boolean): TrackWindow[]`
  - `pickClips(windows: TrackWindow[], score?: (w: TrackWindow) => number): TrackWindow[]` (default `w => w.fidelity`)
  - `trackWindows(frames, slot)` unchanged in signature and in every existing result field.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integrityGhostTrack.test.ts`:

```ts
/**
 * A ghost swinging back and forth on an arc around survivor slot 0, so its
 * bearing changes at a CHANGING rate. A constant rate would make a late
 * crosshair's frame-to-frame changes identical to the bearing's and hide the
 * lag entirely. Amplitude 15 moves at most 5 degrees a frame, so a crosshair
 * two frames late stays inside E_TRACK.
 */
function wobble(n: number, yawOf: (i: number, angle: (k: number) => number) => number, amp = 15): Frame[] {
  const angle = (i: number) => amp * Math.sin(i / 3);
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const a = angle(i) * Math.PI / 180;
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE, yaw: yawOf(i, angle) };
    players[4] = { ...blank(4), state: STATE.PRESENT | STATE.GHOST, cls: 3, x: Math.cos(a) * 1200, y: Math.sin(a) * 1200 };
    frames.push({ tMs: TUNING.SPAWN_GRACE_MS + i * 100, offset: 0, players, entities: [] });
  }
  return frames;
}

describe('the lag search', () => {
  it('scores a crosshair two frames late at full fidelity and records the lag', () => {
    const frames = wobble(40, (i, angle) => angle(i - 2));
    const late = trackWindows(frames, 0).filter((w) => w.startMs >= frames[2].tMs);
    expect(late.length).toBeGreaterThan(0);
    for (const w of late) {
      expect(w.lagFidelity).toBeGreaterThan(0.99);
      expect(w.lagMs).toBe(200);
      // The lag 0 score, which is what the board still ranks, is untouched.
      expect(w.fidelity).toBeLessThan(0.9);
    }
  });

  it('keeps lag 0 when the crosshair is on time', () => {
    const ws = trackWindows(wobble(40, (i, angle) => angle(i)), 0);
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) {
      expect(w.lagMs).toBe(0);
      expect(w.lagFidelity).toBe(w.fidelity);
    }
  });

  it('gives a held angle nothing at any lag', () => {
    const ws = trackWindows(wobble(40, () => 0, 10), 0);
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) expect(w.lagFidelity).toBe(0);
  });

  it('records the class of the infected being followed', () => {
    for (const w of trackWindows(wobble(40, (i, angle) => angle(i)), 0)) expect(w.targetCls).toBe(3);
  });

  it('picks clips by whichever score it is handed', () => {
    const w = (startMs: number, fidelity: number, lagFidelity: number): TrackWindow =>
      ({ startMs, endMs: startMs + 2000, ghostSlot: 4, targetCls: 3, fidelity, lagFidelity, lagMs: 200, travel: 20, meanErr: 1, meanDist: 900 });
    const both = [w(0, 0.1, 0.9), w(5000, 0.9, 0.1)];
    expect(pickClips(both).map((c) => c.startMs)).toEqual([5000]);
    expect(pickClips(both, (c) => c.lagFidelity).map((c) => c.startMs)).toEqual([0]);
  });
});
```

Update the two fixtures that build whole windows, so they satisfy the new required fields:

`tests/integrityGhostTrack.test.ts` line 550-551, replace the `win` helper with:

```ts
  const win = (startMs: number, endMs: number, fidelity: number): TrackWindow =>
    ({ startMs, endMs, ghostSlot: 4, targetCls: 3, fidelity, lagFidelity: fidelity, lagMs: 0, travel: 20, meanErr: 1, meanDist: 900 });
```

`tests/integrityStore.test.ts` line 14, replace the `clip` fixture with:

```ts
const clip = { startMs: 1000, endMs: 3000, ghostSlot: 4, targetCls: 3, fidelity: 0.9, lagFidelity: 0.9, lagMs: 0, travel: 20, meanErr: 2, meanDist: 900 };
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integrityGhostTrack.test.ts`
Expected: FAIL in "the lag search" (`lagFidelity` and `lagMs` are undefined); every older test in the file still passes.

- [ ] **Step 3: Add the constants**

In `src/integrity/constants.ts`, insert immediately above the `/** Windows above this fidelity become reviewable clips.` comment:

```ts
  /** The tracking metrics are scored at every whole-frame lag from 0 up to
   *  this many frames, 0 to 400 ms at 10 Hz, and the best is kept. A person
   *  following a moving thing is always a little behind it, and 150 ms of lag
   *  took a synthetic tracker's share of windows at or over 0.7 from 0.74 to
   *  0.17 (see CLIP_MIN). Searching lags makes a chance match easier too, which
   *  is why the league is scored with the identical search and why the lag 0
   *  ghost score stays the ranked one until calibration (spec section 6). */
  LAG_MAX_FRAMES: 4,
  /** Metric F reads n/a under this many reveals. "Already on target when it
   *  came into view" is a share, and under 30 events a share is one or two
   *  lucky flicks (spec section 3). */
  MIN_REVEALS: 30,
```

- [ ] **Step 4: Generalize the windows and add the lag search**

In `src/integrity/ghostTrack.ts`, replace the whole `TrackWindow` interface (lines 100-112) with:

```ts
export interface TrackWindow {
  startMs: number;
  endMs: number;
  /** The infected being followed: a ghost for metric A, a spawned infected
   *  for metric D. Named for its first use; the slot is the same kind of
   *  number either way. */
  ghostSlot: number;
  /** Its `m_zombieClass` at the window's first frame, for the per-class split.
   *  Taken per window because a slot can die and come back as another class
   *  in the same round. */
  targetCls: number;
  /** At lag 0. Zero when `travel` is under MIN_TRAVEL: the window formed, and
   *  is counted as having formed, but held nothing to follow. */
  fidelity: number;
  /** The best fidelity over lags 0 to LAG_MAX_FRAMES, and the lag it came at,
   *  in milliseconds. Equal to `fidelity` and 0 when lag 0 is best. */
  lagFidelity: number;
  lagMs: number;
  /** Degrees of required motion in the window at lag 0, summed frame to
   *  frame. See MIN_TRAVEL. */
  travel: number;
  meanErr: number;
  meanDist: number;
}
```

Then replace the whole `trackWindows` function (lines 139-195) with:

```ts
/** One frame of a run: the pair eligible and the aim on target. */
interface RunFrame { tMs: number; yaw: number; bear: number; err: number; dist: number; cls: number; s: Pt; g: Pt }

/**
 * The three series for the window of YAW frames i .. i+W-1, against where the
 * target was `lag` frames earlier, each seen from where the survivor stands in
 * the yaw frame.
 *
 * The yaw window is the same at every lag and only the target moves back, so
 * every lag scores the same crosshair motion and the number of windows does
 * not depend on the search. At lag 0 this is exactly version 4's window: the
 * bearing change, and the target's own share of it (where it is now against
 * where it was, from where the survivor now stands).
 */
function seriesAtLag(run: RunFrame[], i: number, lag: number): { dy: number[]; db: number[]; dg: number[] } {
  const bearAt = (j: number): number => (lag === 0 ? run[j].bear : bearing(run[j].s, run[j - lag].g));
  const dy: number[] = [], db: number[] = [], dg: number[] = [];
  for (let k = 1; k < TUNING.W; k++) {
    const j = i + k;
    dy.push(wrapDeg(run[j].yaw - run[j - 1].yaw));
    db.push(wrapDeg(bearAt(j) - bearAt(j - 1)));
    dg.push(wrapDeg(bearAt(j) - bearing(run[j].s, run[j - 1 - lag].g)));
  }
  return { dy, db, dg };
}

function scoreAt(run: RunFrame[], i: number, lag: number): { fidelity: number; travel: number } {
  const { dy, db, dg } = seriesAtLag(run, i, lag);
  const travel = requiredMotion(db, dg).reduce((a, x) => a + Math.abs(x), 0);
  return { fidelity: travel >= TUNING.MIN_TRAVEL ? trackFidelity(dy, db, dg) : 0, travel };
}

function windowAt(run: RunFrame[], i: number, targetSlot: number): TrackWindow {
  const w = run.slice(i, i + TUNING.W);
  const at0 = scoreAt(run, i, 0);
  // A lag needs the target's position that many frames before the window,
  // which must itself be in the run: a break means the pair stopped being
  // comparable, and reaching across one would compare incomparable frames.
  let best = { fidelity: at0.fidelity, lag: 0 };
  for (let lag = 1; lag <= TUNING.LAG_MAX_FRAMES && i - lag >= 0; lag++) {
    const s = scoreAt(run, i, lag);
    if (s.fidelity > best.fidelity) best = { fidelity: s.fidelity, lag };
  }
  return {
    startMs: w[0].tMs,
    endMs: w[w.length - 1].tMs,
    ghostSlot: targetSlot,
    targetCls: w[0].cls,
    fidelity: at0.fidelity,
    lagFidelity: best.fidelity,
    lagMs: run[i].tMs - run[i - best.lag].tMs,
    travel: at0.travel,
    meanErr: w.reduce((s, x) => s + Math.abs(x.err), 0) / w.length,
    meanDist: w.reduce((s, x) => s + x.dist, 0) / w.length,
  };
}

/**
 * Every window in which this survivor held aim on one target for W frames,
 * with how much of the motion needed to follow it they actually produced.
 *
 * Generic over what counts as a target and when a pair counts, so metric A
 * (ghosts) and metric D (spawned infected hidden from the team) are the same
 * arithmetic with different gates. A run is consecutive frames where the pair
 * is eligible AND on target; windows never straddle a break, because a break
 * means the pair stopped being comparable, not that nothing happened.
 */
export function trackWindowsFor(
  frames: Frame[], slot: number, targets: Iterable<number>,
  eligible: (f: Frame, s: PlayerSample, g: PlayerSample) => boolean,
): TrackWindow[] {
  const out: TrackWindow[] = [];
  for (const ts of targets) {
    let run: RunFrame[] = [];
    const flush = () => {
      for (let i = 0; i + TUNING.W <= run.length; i++) out.push(windowAt(run, i, ts));
      run = [];
    };
    for (const f of frames) {
      const s = f.players.find((p) => p.slot === slot);
      const g = f.players.find((p) => p.slot === ts);
      if (!s || !g || !eligible(f, s, g)) { flush(); continue; }
      // Yaw and pitch both. A target two floors up shares a bearing with the
      // doorway under it, and following that doorway is not following it.
      if (!onTarget(s, g, TUNING.E_TRACK)) { flush(); continue; }
      run.push({
        tMs: f.tMs, yaw: s.yaw, bear: bearing(s, g), err: aimError(s.yaw, s, g), dist: dist2d(s, g), cls: g.cls,
        s: { x: s.x, y: s.y }, g: { x: g.x, y: g.y },
      });
    }
    flush();
  }
  return out;
}

/** Metric A: windows against ghosts, under the ghost gates. */
export function trackWindows(frames: Frame[], slot: number): TrackWindow[] {
  return trackWindowsFor(frames, slot, ghostSlotsOf(frames), (f, s, g) =>
    pairEligible({ survivor: s, ghost: g, others: visibleOthers(f, slot, g.slot), tMs: f.tMs, roundStartMs: 0 }));
}
```

Then replace `pickClips` (lines 267-278) with:

```ts
/** The reviewable moments: strongest first, never overlapping, capped. A
 *  reviewer's time is the scarce resource, so five separate moments beat fifty
 *  slices of the same one. `score` is which fidelity decides: lag 0 for ghost
 *  clips, the lag search for hidden ones. */
export function pickClips(windows: TrackWindow[], score: (w: TrackWindow) => number = (w) => w.fidelity): TrackWindow[] {
  const kept: TrackWindow[] = [];
  for (const w of [...windows].filter((x) => score(x) >= TUNING.CLIP_MIN).sort((a, b) => score(b) - score(a))) {
    if (kept.length >= TUNING.CLIPS_PER_ROUND) break;
    if (kept.some((k) => w.startMs <= k.endMs && k.startMs <= w.endMs)) continue;
    kept.push(w);
  }
  return kept;
}
```

`isGhost` and `isLiveSurvivor` stay imported (used by `ghostSlotsOf` and `scanPairs`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/integrityGhostTrack.test.ts tests/integrityStore.test.ts tests/integritySynthetic.test.ts`
Expected: PASS, including every pre-existing test (the lag 0 numbers are unchanged).

- [ ] **Step 6: Type check and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/integrity/constants.ts src/integrity/ghostTrack.ts tests/integrityGhostTrack.test.ts tests/integrityStore.test.ts
git commit -m "Integrity: generic tracking windows with a 0 to 400 ms lag search; lag 0 stays the ranked ghost score"
```

---

### Task 3: The hidden-pair gate and metric D (hidden tracking)

**Files:**
- Create: `src/integrity/hidden.ts`
- Create: `tests/hiddenFixtures.ts` (shared fixtures; a plain module, because importing one `*.test.ts` file from another registers its tests twice)
- Test: `tests/integrityHidden.test.ts`

**Interfaces:**
- Consumes: `LosView`, `isSpawnedTarget`, `classOf` (Task 1); `trackWindowsFor`, `TrackWindow` (Task 2); `isLiveSurvivor`, `isGhost`, `bearing`, `dist2d`, `wrapDeg`, `Pt` from `geometry.ts`.
- Produces:
  - `type HiddenGate = 'notLive' | 'notTarget' | 'inGrace' | 'tooClose' | 'losUnknown' | 'seen' | 'teamSees' | 'occluded' | 'pass'`
  - `interface HiddenTally { considered; notLive; notTarget; inGrace; tooClose; losUnknown; seen; teamSees; occluded; passed: number }`
  - `hiddenGate(f: Frame, s: PlayerSample, t: PlayerSample, los: LosView): HiddenGate`
  - `scanHidden(frames: Frame[], slot: number, los: LosView, onPass?: (s: PlayerSample, t: PlayerSample, f: Frame) => void): HiddenTally`
  - `hiddenTrackWindows(frames: Frame[], slot: number, los: LosView): TrackWindow[]`

- [ ] **Step 1: Write the fixtures and the failing test**

Create `tests/hiddenFixtures.ts`:

```ts
import { PLAYER_SLOTS, STATE, type Frame, type PlayerSample, type ReplayHeader } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';

/** Survivors in slots 0 and 1, infected in 4 and 5. Ranks: survivor 0 and 1,
 *  infected 0 and 1. Bits: (s0, i4) = 0, (s1, i4) = 4, (s0, i5) = 1, (s1, i5) = 5. */
export function header(losKnown = true): ReplayHeader {
  return {
    version: 3, token: '0'.repeat(32), ordinal: 1, half: 1, playerHz: 10, entityHz: 10, map: 'l4d_vs_hospital02_subway',
    startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['s0', 's1', '', '', 'i4', 'i5', '', ''], infectedMask: 0b110000, sidesKnown: true, losKnown,
  };
}

export function blank(slot: number): PlayerSample {
  return { slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0 };
}

export interface SceneOpts {
  n?: number;
  /** Frames the crosshair runs behind the hunter. */
  lagFrames?: number;
  amp?: number;
  /** Frame bytes 6-7 for frame i. Default 0: hidden from everyone. */
  los?: (i: number) => number;
  hunterCls?: number;
  yaw?: (i: number, angle: (k: number) => number) => number;
  extra?: (i: number, players: PlayerSample[]) => void;
}

/**
 * Survivor slot 0 at the origin; teammate slot 1 alive well off to the side
 * (bearing -90, never on the hunter's bearing); hunter slot 4 spawned and
 * swinging on an arc at 1200 units, so its bearing changes at a changing rate.
 */
export function scene(o: SceneOpts = {}): Frame[] {
  const n = o.n ?? 40, amp = o.amp ?? 15, lag = o.lagFrames ?? 2;
  const angle = (i: number) => amp * Math.sin(i / 3);
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const a = angle(i) * Math.PI / 180;
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE, yaw: o.yaw ? o.yaw(i, angle) : angle(i - lag) };
    players[1] = { ...blank(1), state: STATE.PRESENT | STATE.ALIVE, x: 0, y: -500 };
    players[4] = { ...blank(4), state: STATE.PRESENT | STATE.ALIVE, cls: o.hunterCls ?? 3, x: Math.cos(a) * 1200, y: Math.sin(a) * 1200 };
    o.extra?.(i, players);
    frames.push({ tMs: TUNING.SPAWN_GRACE_MS + i * 100, offset: 0, players, entities: [], los: o.los ? o.los(i) : 0 });
  }
  return frames;
}
```

Create `tests/integrityHidden.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { STATE, type Frame } from '../src/replayFormat.js';
import { losView } from '../src/integrity/los.js';
import { pickClips } from '../src/integrity/ghostTrack.js';
import { hiddenGate, hiddenTrackWindows, scanHidden } from '../src/integrity/hidden.js';
import { blank, header, scene } from './hiddenFixtures.js';

const LOS = losView(header());

describe('hiddenGate', () => {
  const f = scene()[10];
  const s = f.players[0], t = f.players[4];

  it('passes a spawned hunter nobody on the team can see', () => {
    expect(hiddenGate(f, s, t, LOS)).toBe('pass');
  });

  it('drops a hunter the survivor can see, or a teammate can', () => {
    expect(hiddenGate({ ...f, los: 1 << 0 }, s, t, LOS)).toBe('seen');
    expect(hiddenGate({ ...f, los: 1 << 4 }, s, t, LOS)).toBe('teamSees');
  });

  it('says unknown rather than hidden for a file without line of sight', () => {
    expect(hiddenGate(f, s, t, losView(header(false)))).toBe('losUnknown');
  });

  it('only scores living, spawned smokers, boomers and hunters', () => {
    expect(hiddenGate(f, s, { ...t, cls: 5 }, LOS)).toBe('notTarget');
    expect(hiddenGate(f, s, { ...t, state: t.state | STATE.GHOST }, LOS)).toBe('notTarget');
    expect(hiddenGate(f, { ...s, state: s.state | STATE.INCAP }, t, LOS)).toBe('notLive');
  });

  it('keeps the grace period and the minimum distance', () => {
    expect(hiddenGate({ ...f, tMs: 0 }, s, t, LOS)).toBe('inGrace');
    expect(hiddenGate(f, s, { ...t, x: 100, y: 0 }, LOS)).toBe('tooClose');
  });

  it('lets only something the survivor could see stand in the way', () => {
    // A spawned smoker (slot 5) on the hunter's bearing, 1000 units out.
    const smoker = { ...blank(5), state: STATE.PRESENT | STATE.ALIVE, cls: 1, x: 1000, y: 0 };
    const withSmoker = { ...f, players: f.players.map((p) => (p.slot === 5 ? smoker : p)) };
    // The survivor cannot see the smoker either (bit 1 clear): it explains nothing.
    expect(hiddenGate(withSmoker, s, t, LOS)).toBe('pass');
    // The survivor can see the smoker (bit 1 set): the crosshair has an innocent target.
    expect(hiddenGate({ ...withSmoker, los: 1 << 1 }, s, t, LOS)).toBe('occluded');
  });
});

describe('scanHidden', () => {
  it('tallies where every pair fell and passes the rest', () => {
    const frames = scene({ los: (i) => (i < 10 ? 1 << 0 : 0) });
    let passed = 0;
    const t = scanHidden(frames, 0, LOS, () => passed++);
    expect(t.considered).toBe(40);
    expect(t.seen).toBe(10);
    expect(t.passed).toBe(30);
    expect(passed).toBe(30);
  });
});

describe('metric D, hidden tracking', () => {
  it('finds a crosshair following a hidden hunter two frames late', () => {
    const frames = scene();
    const ws = hiddenTrackWindows(frames, 0, LOS).filter((w) => w.startMs >= frames[2].tMs);
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) {
      expect(w.lagFidelity).toBeGreaterThan(0.99);
      expect(w.targetCls).toBe(3);
    }
    expect(pickClips(ws, (w) => w.lagFidelity).length).toBeGreaterThan(0);
  });

  it('finds nothing when the survivor or a teammate could see the hunter', () => {
    expect(hiddenTrackWindows(scene({ los: () => 1 << 0 }), 0, LOS)).toEqual([]);
    expect(hiddenTrackWindows(scene({ los: () => 1 << 4 }), 0, LOS)).toEqual([]);
  });

  it('finds nothing in a file that does not record line of sight', () => {
    expect(hiddenTrackWindows(scene(), 0, losView(header(false)))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integrityHidden.test.ts`
Expected: FAIL, "Failed to resolve import ../src/integrity/hidden.js".

- [ ] **Step 3: Write the implementation**

Create `src/integrity/hidden.ts`:

```ts
import { STATE, type Frame, type PlayerSample } from '../replayFormat.js';
import { TUNING } from './constants.js';
import { bearing, dist2d, isGhost, isLiveSurvivor, wrapDeg, type Pt } from './geometry.js';
import { trackWindowsFor, type TrackWindow } from './ghostTrack.js';
import { isSpawnedTarget, type LosView } from './los.js';

/**
 * Metrics D, E and F: the same questions metrics A and B ask about ghosts,
 * asked about SPAWNED infected at the moments no survivor could see them.
 *
 * A ghost is invisible whatever the geometry, so the ghost metrics need no
 * walls. A spawned hunter crouched behind a wall is where a wallhack actually
 * pays, and whether a crosshair was on it THROUGH the wall is a question only
 * the line-of-sight bits (plan 1) can answer. See the design spec, section 3.
 */

/** Why a hidden pair did or did not contribute, in evaluation order. Named
 *  for the same reason as PairGate: "no windows" and "no eligible frames" are
 *  indistinguishable without it. */
export type HiddenGate =
  | 'notLive' | 'notTarget' | 'inGrace' | 'tooClose' | 'losUnknown' | 'seen' | 'teamSees' | 'occluded' | 'pass';

export interface HiddenTally {
  considered: number;
  notLive: number;
  notTarget: number;
  inGrace: number;
  tooClose: number;
  /** The file records no line of sight, or a slot has no rank. */
  losUnknown: number;
  /** The survivor could see it: not a wallhack question at all. */
  seen: number;
  /** A teammate could see it, so a callout explains a crosshair on it. The
   *  biggest legitimate source of information about hidden infected. */
  teamSees: number;
  occluded: number;
  passed: number;
}

export const emptyTally = (): HiddenTally => ({
  considered: 0, notLive: 0, notTarget: 0, inGrace: 0, tooClose: 0, losUnknown: 0, seen: 0, teamSees: 0, occluded: 0, passed: 0,
});

/**
 * Things the survivor could plausibly have been aiming at instead. As in the
 * ghost path (see OCCLUDE_MAX_DIST), bounded and not filtered by kind, with
 * one addition line of sight makes possible: another infected this survivor
 * could NOT see explains nothing about where they aimed, so it never vetoes.
 */
function occluders(f: Frame, survivorSlot: number, targetSlot: number, los: LosView): Pt[] {
  const out: Pt[] = [];
  for (const p of f.players) {
    if (p.slot === survivorSlot || p.slot === targetSlot) continue;
    if ((p.state & STATE.PRESENT) === 0 || isGhost(p)) continue;
    if (los.sees(f, survivorSlot, p.slot) === false) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (const e of f.entities) {
    if ((e.state & STATE.GHOST) !== 0) continue;
    out.push({ x: e.x, y: e.y });
  }
  return out;
}

export function hiddenGate(f: Frame, s: PlayerSample, t: PlayerSample, los: LosView): HiddenGate {
  if (!isLiveSurvivor(s)) return 'notLive';
  if (!isSpawnedTarget(t)) return 'notTarget';
  // tMs is milliseconds since the replay opened, which is round start.
  if (f.tMs < TUNING.SPAWN_GRACE_MS) return 'inGrace';
  if (dist2d(s, t) <= TUNING.D_MIN) return 'tooClose';
  const own = los.sees(f, s.slot, t.slot);
  if (own === null) return 'losUnknown';
  if (own) return 'seen';
  if (los.othersSee(f, t.slot, s.slot)) return 'teamSees';
  const toT = bearing(s, t);
  for (const o of occluders(f, s.slot, t.slot, los)) {
    if (dist2d(s, o) > TUNING.OCCLUDE_MAX_DIST) continue;
    if (Math.abs(wrapDeg(bearing(s, o) - toT)) < TUNING.OCCLUDE_WINDOW) return 'occluded';
  }
  return 'pass';
}

/** Slots that were a spawned, scored infected at any point this round. */
export function spawnedSlotsOf(frames: Frame[]): Set<number> {
  const out = new Set<number>();
  for (const f of frames) for (const p of f.players) if (isSpawnedTarget(p)) out.add(p.slot);
  return out;
}

/** Every (frame, spawned infected) pair for one survivor, tallied, with the
 *  pairs that cleared every gate handed to `onPass`. The hidden counterpart of
 *  `scanPairs`. */
export function scanHidden(
  frames: Frame[], slot: number, los: LosView,
  onPass?: (s: PlayerSample, t: PlayerSample, f: Frame) => void,
): HiddenTally {
  const tally = emptyTally();
  const targets = spawnedSlotsOf(frames);
  for (const f of frames) {
    const s = f.players.find((p) => p.slot === slot);
    for (const ts of targets) {
      const t = f.players.find((p) => p.slot === ts);
      if (!t) continue;
      tally.considered++;
      if (!s) { tally.notLive++; continue; }
      const gate = hiddenGate(f, s, t, los);
      if (gate === 'pass') { tally.passed++; onPass?.(s, t, f); } else tally[gate]++;
    }
  }
  return tally;
}

/** Metric D: tracking windows against spawned infected hidden from the whole
 *  team. Scored by `lagFidelity`, the lag search, from the start: unlike the
 *  ghost score there is no older number here for it to replace. */
export function hiddenTrackWindows(frames: Frame[], slot: number, los: LosView): TrackWindow[] {
  if (!los.known) return [];
  return trackWindowsFor(frames, slot, spawnedSlotsOf(frames), (f, s, g) => hiddenGate(f, s, g, los) === 'pass');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integrityHidden.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/integrity/hidden.ts tests/hiddenFixtures.ts tests/integrityHidden.test.ts
git commit -m "Integrity: the hidden-from-team gate and metric D, tracking a spawned infected nobody could see"
```

---

### Task 4: Metric E (hidden pre-aim)

**Files:**
- Modify: `src/integrity/occupancy.ts:94-104` (extract `occFromBlocks`)
- Modify: `src/integrity/hidden.ts` (append)
- Test: `tests/integrityHidden.test.ts` (append)

**Interfaces:**
- Consumes: `scanHidden` (Task 3), `classOf`, `TRACKED_CLASSES`, `InfectedClass` (Task 1), `PriorTable`, `priorAt`, `cellKey`, `cellOf` (aimPrior.ts), `onTarget` (geometry.ts).
- Produces:
  - `occFromBlocks(blocks: Map<string, { n: number; on: number; p: number }>, pairs: number): OccResult | null` exported from `occupancy.ts`
  - `interface HiddenOcc { all: OccResult | null; byClass: Record<InfectedClass, OccResult | null> }`
  - `hiddenOccupancy(frames: Frame[], slot: number, prior: PriorTable | null, los: LosView): { occ: HiddenOcc | null; gates: HiddenTally }`

- [ ] **Step 1: Write the failing test**

Append to `tests/integrityHidden.test.ts` (add `hiddenOccupancy` to the import from `hidden.js`, and add `import { cellKey, cellOf, type PriorTable } from '../src/integrity/aimPrior.js';`):

```ts
/** A prior that puts probability `p` on every cell the hunter stood in. */
function priorOver(frames: Frame[], slot: number, p: number): PriorTable {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const t = f.players[slot];
    const c = cellOf(t.x, t.y);
    counts.set(cellKey(c.cx, c.cy), p * 1000);
  }
  return { frames: 1000, counts };
}

describe('metric E, hidden pre-aim', () => {
  it('counts blocks on a hidden hunter against what the map predicts, per class', () => {
    // On time, so the aim is inside E_DWELL every frame. tMs runs 5000 to 8900:
    // blocks 2, 3 and 4 of OCC_BLOCK_MS.
    const frames = scene({ lagFrames: 0 });
    const { occ, gates } = hiddenOccupancy(frames, 0, priorOver(frames, 4, 0.01), LOS);
    expect(gates.passed).toBe(40);
    expect(occ!.all!.blocks).toBe(3);
    expect(occ!.all!.observed).toBeCloseTo(3);
    expect(occ!.all!.expected).toBeCloseTo(0.03);
    expect(occ!.byClass.hunter).toEqual(occ!.all);
    expect(occ!.byClass.smoker).toBeNull();
    expect(occ!.byClass.boomer).toBeNull();
  });

  it('has no score without a prior, and still reports coverage', () => {
    const { occ, gates } = hiddenOccupancy(scene({ lagFrames: 0 }), 0, null, LOS);
    expect(occ).toBeNull();
    expect(gates.passed).toBe(40);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integrityHidden.test.ts`
Expected: FAIL, `hiddenOccupancy` is not exported.

- [ ] **Step 3: Extract the block arithmetic in `occupancy.ts`**

Replace lines 94-104 of `src/integrity/occupancy.ts` (from `// Null, never zero.` to the final `return`) with:

```ts
  // Null, never zero. No prior means the map has too little history to say
  // anything, and a thin prior is worse than no score at all.
  if (!prior || prior.frames <= 0) return { occ: null, gates };
  return { occ: occFromBlocks(blocks, pairs), gates };
}

/** Blocks to sums. Shared with metric E so the two occupancy scores are the
 *  same arithmetic over different pairs. Null when no block formed. */
export function occFromBlocks(blocks: Map<string, { n: number; on: number; p: number }>, pairs: number): OccResult | null {
  if (blocks.size === 0) return null;
  let observed = 0, expected = 0, expectedSq = 0;
  for (const b of blocks.values()) {
    const p = b.p / b.n;
    observed += b.on / b.n;
    expected += p;
    expectedSq += p * p;
  }
  return { observed, expected, expectedSq, blocks: blocks.size, pairs };
```

(The function's closing `}` that followed the old `return` stays and now closes `occFromBlocks`.)

- [ ] **Step 4: Add metric E to `hidden.ts`**

Add these imports to the top of `src/integrity/hidden.ts`:

```ts
import { cellKey, cellOf, priorAt, type PriorTable } from './aimPrior.js';
import { onTarget } from './geometry.js';
import { occFromBlocks, type OccResult } from './occupancy.js';
import { TRACKED_CLASSES, classOf, type InfectedClass } from './los.js';
```

(Merge `onTarget` into the existing geometry import and `TRACKED_CLASSES`, `classOf`, `InfectedClass` into the existing los import rather than duplicating the lines.)

Append:

```ts
export interface HiddenOcc {
  all: OccResult | null;
  byClass: Record<InfectedClass, OccResult | null>;
}

type Blocks = Map<string, { n: number; on: number; p: number }>;

/**
 * Metric E: metric B's occupancy, over spawned infected hidden from the whole
 * team. Same aim prior, same OCC_BLOCK_MS blocks, same R_MAX bound; only the
 * pairs differ. Split by class in the same pass, because a player far above
 * the league on crouched hunters specifically is the strongest signal there is.
 */
export function hiddenOccupancy(
  frames: Frame[], slot: number, prior: PriorTable | null, los: LosView,
): { occ: HiddenOcc | null; gates: HiddenTally } {
  const all: Blocks = new Map();
  const byClass = new Map<InfectedClass, Blocks>(TRACKED_CLASSES.map((c) => [c, new Map()]));
  const pairsByClass = new Map<InfectedClass, number>(TRACKED_CLASSES.map((c) => [c, 0]));
  let pairs = 0;

  const add = (blocks: Blocks, key: string, p: number, on: boolean) => {
    const b = blocks.get(key) ?? { n: 0, on: 0, p: 0 };
    b.n++;
    b.p += p;
    if (on) b.on++;
    blocks.set(key, b);
  };

  const gates = scanHidden(frames, slot, los, (s, t, f) => {
    if (!prior) return;
    if (dist2d(s, t) > TUNING.R_MAX) return;
    const c = cellOf(t.x, t.y);
    const p = priorAt(prior, cellKey(c.cx, c.cy));
    const on = onTarget(s, t, TUNING.E_DWELL);
    const key = `${t.slot}:${Math.floor(f.tMs / TUNING.OCC_BLOCK_MS)}`;
    add(all, key, p, on);
    pairs++;
    const cls = classOf(t.cls);
    if (cls) {
      add(byClass.get(cls)!, key, p, on);
      pairsByClass.set(cls, pairsByClass.get(cls)! + 1);
    }
  });

  if (!prior || prior.frames <= 0) return { occ: null, gates };
  const split = Object.fromEntries(
    TRACKED_CLASSES.map((c) => [c, occFromBlocks(byClass.get(c)!, pairsByClass.get(c)!)]),
  ) as Record<InfectedClass, OccResult | null>;
  return { occ: { all: occFromBlocks(all, pairs), byClass: split }, gates };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/integrityHidden.test.ts tests/integrityGhostTrack.test.ts`
Expected: PASS, including every existing occupancy test (the extraction does not change results).

- [ ] **Step 6: Commit**

```bash
git add src/integrity/occupancy.ts src/integrity/hidden.ts tests/integrityHidden.test.ts
git commit -m "Integrity: metric E, pre-aim at spawned infected hidden from the team, split by class"
```

---

### Task 5: Metric F (reveal reaction)

**Files:**
- Modify: `src/integrity/hidden.ts` (append)
- Test: `tests/integrityHidden.test.ts` (append)

**Interfaces:**
- Consumes: `LosView`, `isSpawnedTarget`, `classOf`, `TRACKED_CLASSES` (Task 1).
- Produces:
  - `interface RevealCounts { reveals: number; on: number }`
  - `interface RevealResult extends RevealCounts { byClass: Record<InfectedClass, RevealCounts> }`
  - `revealReaction(frames: Frame[], slot: number, los: LosView): RevealResult | null`

- [ ] **Step 1: Write the failing test**

Append to `tests/integrityHidden.test.ts` (add `revealReaction` to the `hidden.js` import):

```ts
describe('metric F, reveal reaction', () => {
  // Hidden from everyone for 20 frames, then the survivor can see it.
  const reveal = (i: number) => (i < 20 ? 0 : 1 << 0);

  it('counts a reveal the crosshair was already on', () => {
    const r = revealReaction(scene({ lagFrames: 0, los: reveal }), 0, LOS)!;
    expect(r.reveals).toBe(1);
    expect(r.on).toBe(1);
    expect(r.byClass.hunter).toEqual({ reveals: 1, on: 1 });
    expect(r.byClass.smoker).toEqual({ reveals: 0, on: 0 });
  });

  it('counts a reveal the crosshair was nowhere near', () => {
    const r = revealReaction(scene({ yaw: () => 90, los: reveal }), 0, LOS)!;
    expect(r).toMatchObject({ reveals: 1, on: 0 });
  });

  it('does not count a reveal a teammate could already see', () => {
    const r = revealReaction(scene({ lagFrames: 0, los: (i) => (i < 20 ? 1 << 4 : 1 << 0) }), 0, LOS)!;
    expect(r.reveals).toBe(0);
  });

  it('does not count a reveal inside D_MIN', () => {
    const close = scene({ lagFrames: 0, los: reveal, extra: (_i, p) => { p[4] = { ...p[4], x: 200, y: 0 }; } });
    expect(revealReaction(close, 0, LOS)!.reveals).toBe(0);
  });

  it('has nothing to say about a file without line of sight', () => {
    expect(revealReaction(scene({ los: reveal }), 0, losView(header(false)))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integrityHidden.test.ts`
Expected: FAIL, `revealReaction` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/integrity/hidden.ts`:

```ts
export interface RevealCounts { reveals: number; on: number }
export interface RevealResult extends RevealCounts { byClass: Record<InfectedClass, RevealCounts> }

/**
 * Metric F: at each moment a spawned infected came into this survivor's view,
 * having been hidden from the whole team the frame before, was the crosshair
 * already on it.
 *
 * 10 Hz makes reaction time coarse (100 ms buckets), so the statistic is the
 * one bucket that resolves cleanly: "already on target at the reveal frame".
 * A wallhack user tracking through the wall is on target the instant the wall
 * stops being in the way; an honest player has to find it first.
 *
 * The frame before must be hidden from the WHOLE team, not just this survivor:
 * if a teammate could see it, a callout can put the crosshair there honestly.
 * Within D_MIN and beyond R_MAX nothing counts, as for every other metric.
 */
export function revealReaction(frames: Frame[], slot: number, los: LosView): RevealResult | null {
  if (!los.known) return null;
  const out: RevealResult = {
    reveals: 0, on: 0,
    byClass: Object.fromEntries(TRACKED_CLASSES.map((c) => [c, { reveals: 0, on: 0 }])) as Record<InfectedClass, RevealCounts>,
  };
  for (const ts of spawnedSlotsOf(frames)) {
    let hiddenBefore = false;
    for (const f of frames) {
      const s = f.players.find((p) => p.slot === slot);
      const t = f.players.find((p) => p.slot === ts);
      if (!s || !t || !isLiveSurvivor(s) || !isSpawnedTarget(t)) { hiddenBefore = false; continue; }
      const own = los.sees(f, slot, ts);
      if (own === false && los.othersSee(f, ts, slot) === false) { hiddenBefore = true; continue; }
      if (own === true && hiddenBefore && f.tMs >= TUNING.SPAWN_GRACE_MS) {
        const d = dist2d(s, t);
        if (d > TUNING.D_MIN && d <= TUNING.R_MAX) {
          const on = onTarget(s, t, TUNING.E_TRACK);
          out.reveals++;
          if (on) out.on++;
          const cls = classOf(t.cls);
          if (cls) {
            out.byClass[cls].reveals++;
            if (on) out.byClass[cls].on++;
          }
        }
      }
      hiddenBefore = false;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integrityHidden.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrity/hidden.ts tests/integrityHidden.test.ts
git commit -m "Integrity: metric F, already on target when a hidden infected comes into view"
```

---

### Task 6: Wire D, E, F into the round, the store and the run (analyzer version 5)

**Files:**
- Modify: `src/integrity/hidden.ts` (append `hiddenMetrics`)
- Modify: `src/integrity/round.ts:123-145` (`RoundMetrics`) and `:207-231` (`analyzeRound`)
- Modify: `src/integrity/store.ts:228-291` (`ANALYZER_VERSION`, `SaveRow`, `saveRound`)
- Modify: `src/integrity/run.ts:4,71-77`
- Test: `tests/integrityHidden.test.ts`, `tests/integrityStore.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 5.
- Produces:
  - `interface ClassSums { scoreable: number; fidSum: number; occ: OccResult | null; reveals: number; revealOn: number }`
  - `interface HiddenMetrics { windows: number; scoreable: number; fidSum: number; fidMax: number; occ: OccResult | null; reveals: number; revealOn: number; byClass: Record<InfectedClass, ClassSums>; gates: HiddenTally }`
  - `hiddenMetrics(frames, slot, prior, los): { metrics: HiddenMetrics | null; windows: TrackWindow[] }`
  - `RoundMetrics` gains optional `losKnown?: boolean`, `fidLagSum?: number`, `hidden?: HiddenMetrics | null`
  - `analyzeRound(frames, survivorSlots, prior, los = NO_LOS): { metrics; clips; hiddenClips: Map<number, TrackWindow[]> }`
  - `SaveRow` gains optional `hiddenClips?: TrackWindow[]`; `ANALYZER_VERSION = 5`

- [ ] **Step 1: Write the failing tests**

Append to `tests/integrityHidden.test.ts` (add `import { analyzeRound } from '../src/integrity/round.js';`):

```ts
describe('analyzeRound with line of sight', () => {
  it('measures D, E and F for a round that records line of sight', () => {
    const { metrics, hiddenClips } = analyzeRound(scene(), [0], null, LOS);
    const m = metrics.get(0)!;
    expect(m.losKnown).toBe(true);
    expect(m.hidden!.scoreable).toBeGreaterThan(0);
    expect(m.hidden!.fidMax).toBeGreaterThan(0.99);
    expect(m.hidden!.byClass.hunter.scoreable).toBe(m.hidden!.scoreable);
    expect(m.hidden!.byClass.hunter.fidSum).toBeCloseTo(m.hidden!.fidSum);
    expect(m.hidden!.gates.passed).toBe(40);
    expect(hiddenClips.get(0)!.length).toBeGreaterThan(0);
  });

  it('leaves the hidden metrics null, not zero, without line of sight', () => {
    const { metrics, hiddenClips } = analyzeRound(scene(), [0], null);
    expect(metrics.get(0)!.losKnown).toBe(false);
    expect(metrics.get(0)!.hidden).toBeNull();
    expect(hiddenClips.get(0)).toEqual([]);
  });

  it('stores the lag-tolerant ghost score beside the ranked one', () => {
    const { metrics } = analyzeRound(scene(), [0], null, LOS);
    // No ghosts in this scene, so both ghost sums are zero, and present.
    expect(metrics.get(0)!.fidLagSum).toBe(0);
    expect(metrics.get(0)!.fidSum).toBe(0);
  });
});
```

Append to `tests/integrityStore.test.ts`, inside `describe('saveRound', ...)`:

```ts
  it('stores hidden tracking clips as their own kind, scored by the lag search', () => {
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip], hiddenClips: [{ ...clip, startMs: 9000, endMs: 11000, lagFidelity: 0.8, lagMs: 200 }] }]);
    const rows = db.prepare('SELECT kind, score, detail FROM integrity_clips ORDER BY start_ms').all() as { kind: string; score: number; detail: string }[];
    expect(rows.map((r) => r.kind)).toEqual(['ghost_track', 'hidden_track']);
    expect(rows[1].score).toBe(0.8);
    expect(JSON.parse(rows[1].detail)).toMatchObject({ infectedSlot: 4, cls: 3, lagMs: 200 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integrityHidden.test.ts tests/integrityStore.test.ts`
Expected: FAIL, `analyzeRound` has no `hiddenClips` and `saveRound` ignores `hiddenClips`.

- [ ] **Step 3: Add `hiddenMetrics` to `hidden.ts`**

Append to `src/integrity/hidden.ts`:

```ts
export interface ClassSums { scoreable: number; fidSum: number; occ: OccResult | null; reveals: number; revealOn: number }

/**
 * One player-round of D, E and F, as SUMS, like everything else in
 * RoundMetrics: scores are made at read time in score.ts, so a threshold can
 * be wrong and the history re-scored. `fidSum` and `fidMax` are over
 * `lagFidelity`; `scoreable` counts windows with MIN_TRAVEL of motion at lag 0.
 */
export interface HiddenMetrics {
  windows: number;
  scoreable: number;
  fidSum: number;
  fidMax: number;
  occ: OccResult | null;
  reveals: number;
  revealOn: number;
  byClass: Record<InfectedClass, ClassSums>;
  gates: HiddenTally;
}

/** Null, never zero, for a file without line of sight: "not measured" and
 *  "measured and clean" must never look alike on the board. */
export function hiddenMetrics(
  frames: Frame[], slot: number, prior: PriorTable | null, los: LosView,
): { metrics: HiddenMetrics | null; windows: TrackWindow[] } {
  if (!los.known) return { metrics: null, windows: [] };
  const windows = hiddenTrackWindows(frames, slot, los);
  const { occ, gates } = hiddenOccupancy(frames, slot, prior, los);
  const reveal = revealReaction(frames, slot, los)!;
  const scoreable = windows.filter((w) => w.travel >= TUNING.MIN_TRAVEL);
  const byClass = Object.fromEntries(TRACKED_CLASSES.map((c) => [c, {
    scoreable: 0, fidSum: 0, occ: occ?.byClass[c] ?? null, reveals: reveal.byClass[c].reveals, revealOn: reveal.byClass[c].on,
  }])) as Record<InfectedClass, ClassSums>;
  for (const w of scoreable) {
    const c = classOf(w.targetCls);
    if (!c) continue;
    byClass[c].scoreable++;
    byClass[c].fidSum += w.lagFidelity;
  }
  const fids = windows.map((w) => w.lagFidelity);
  return {
    metrics: {
      windows: windows.length,
      scoreable: scoreable.length,
      fidSum: scoreable.reduce((a, w) => a + w.lagFidelity, 0),
      fidMax: fids.length ? Math.max(...fids) : 0,
      occ: occ?.all ?? null,
      reveals: reveal.reveals,
      revealOn: reveal.on,
      byClass,
      gates,
    },
    windows,
  };
}
```

- [ ] **Step 4: Extend `RoundMetrics` and `analyzeRound` in `round.ts`**

Add to the imports of `src/integrity/round.ts`:

```ts
import { hiddenMetrics, type HiddenMetrics } from './hidden.js';
import { NO_LOS, type LosView } from './los.js';
```

Add these fields at the end of the `RoundMetrics` interface (after `gates: GateTally;`):

```ts
  /** Whether this round's replay records line of sight. Optional, like every
   *  field below: rows written by version 4 have none of them and must still
   *  read. */
  losKnown?: boolean;
  /** Metric A at the best of the lag search, summed over the same scoreable
   *  windows as `fidSum`. Stored, not ranked: it replaces the lag 0 score only
   *  after calibration (spec section 6). */
  fidLagSum?: number;
  /** Metrics D, E and F. Null when the replay records no line of sight. */
  hidden?: HiddenMetrics | null;
```

Replace `analyzeRound` (lines 207-231) with:

```ts
export function analyzeRound(
  frames: Frame[], survivorSlots: number[], prior: PriorTable | null, los: LosView = NO_LOS,
): { metrics: Map<number, RoundMetrics>; clips: Map<number, TrackWindow[]>; hiddenClips: Map<number, TrackWindow[]> } {
  const metrics = new Map<number, RoundMetrics>();
  const clips = new Map<number, TrackWindow[]>();
  const hiddenClips = new Map<number, TrackWindow[]>();

  for (const slot of survivorSlots) {
    const windows = trackWindows(frames, slot);
    clips.set(slot, pickClips(windows));
    const { occ, gates } = occupancyWithGates(frames, slot, prior);
    const fids = windows.map((w) => w.fidelity);
    const scoreable = windows.filter((w) => w.travel >= TUNING.MIN_TRAVEL);
    const hidden = hiddenMetrics(frames, slot, prior, los);
    hiddenClips.set(slot, pickClips(hidden.windows, (w) => w.lagFidelity));
    metrics.set(slot, {
      fidMax: fids.length ? Math.max(...fids) : 0,
      fidP95: p95(fids),
      windows: windows.length,
      scoreable: scoreable.length,
      fidSum: scoreable.reduce((a, w) => a + w.fidelity, 0),
      occ,
      eligiblePairs: gates.passed,
      gates,
      losKnown: los.known,
      fidLagSum: scoreable.reduce((a, w) => a + w.lagFidelity, 0),
      hidden: hidden.metrics,
    });
  }
  return { metrics, clips, hiddenClips };
}
```

- [ ] **Step 5: Store version 5 and the new clip kind in `store.ts`**

Replace the line `export const ANALYZER_VERSION = 4;` with the version 5 note appended to the doc comment above it and the new value:

```ts
 *
 *  5: line of sight (plan 2 of the spawned-infected spec). Rounds carry
 *  losKnown, fidLagSum and the hidden metrics D, E and F; hidden tracking
 *  windows become `hidden_track` clips scored by the lag search. Ghost scores
 *  are unchanged in meaning, but a version 4 board mixed with version 5 rows
 *  would show hidden columns for some players and not others for no reason a
 *  reader could see, so the whole history is re-measured. */
export const ANALYZER_VERSION = 5;
```

(The existing `*/` that closed the comment after the version 4 paragraph must be removed, so the comment now closes after the version 5 paragraph.)

Replace the `SaveRow` interface with:

```ts
export interface SaveRow { slot: number; steamid: string; metrics: RoundMetrics; clips: TrackWindow[]; hiddenClips?: TrackWindow[] }
```

Inside `saveRound`, replace the `for (const c of r.clips) { ... }` loop with:

```ts
      for (const c of r.clips) {
        insClip.run(
          key.matchId, key.ordinal, key.half, r.slot, r.steamid, c.startMs, c.endMs,
          'ghost_track', c.fidelity,
          JSON.stringify({ ghostSlot: c.ghostSlot, meanErr: c.meanErr, meanDist: c.meanDist, travel: c.travel, lagFidelity: c.lagFidelity, lagMs: c.lagMs }),
          ANALYZER_VERSION,
        );
      }
      // Scored by the lag search, which is metric D's own score. `fidelityLag0`
      // rides along so a reviewer can see how much of the score the lag made.
      for (const c of r.hiddenClips ?? []) {
        insClip.run(
          key.matchId, key.ordinal, key.half, r.slot, r.steamid, c.startMs, c.endMs,
          'hidden_track', c.lagFidelity,
          JSON.stringify({ infectedSlot: c.ghostSlot, cls: c.targetCls, lagMs: c.lagMs, fidelityLag0: c.fidelity, meanErr: c.meanErr, meanDist: c.meanDist, travel: c.travel }),
          ANALYZER_VERSION,
        );
      }
```

- [ ] **Step 6: Pass line of sight in from the run**

In `src/integrity/run.ts`, add the import:

```ts
import { losView } from './los.js';
```

Replace lines 71-77 (the `analyzeRound` call and `saveRound`) with:

```ts
  const { metrics, clips, hiddenClips } = analyzeRound(replay.frames, slots, prior, losView(replay.header));
  saveRound(db, key, slots.map((slot) => ({
    slot,
    steamid: replay.header.slots[slot],
    metrics: metrics.get(slot)!,
    clips: clips.get(slot) ?? [],
    hiddenClips: hiddenClips.get(slot) ?? [],
  })));
```

- [ ] **Step 7: Run the full suite and type check**

Run: `npm test && npm run typecheck`
Expected: PASS. If a test asserts `ANALYZER_VERSION` against the literal 4, it is asserting the old version: change the literal to 5.

- [ ] **Step 8: Commit**

```bash
git add src/integrity/hidden.ts src/integrity/round.ts src/integrity/store.ts src/integrity/run.ts tests/integrityHidden.test.ts tests/integrityStore.test.ts
git commit -m "Integrity: analyzer version 5 measures D, E and F from line of sight and stores hidden_track clips"
```

---

### Task 7: Read-time scores for D, E and F

**Files:**
- Modify: `src/integrity/score.ts`
- Test: `tests/integrityScore.test.ts`

**Interfaces:**
- Consumes: `RoundMetrics.hidden`, `HiddenMetrics`, `InfectedClass`, `TRACKED_CLASSES`.
- Produces:
  - `calibrate(rows, pick?: (m: RoundMetrics) => OccResult | null | undefined)` (default `m => m.occ`)
  - `interface ClassScores { hiddenShare: number | null; hiddenOccZ: number | null; revealShare: number | null }`
  - `PlayerAgg` gains `losRounds: number; hiddenScoreable: number; hiddenShare: number | null; hiddenOccZ: number | null; reveals: number; revealShare: number | null; byClass: Record<InfectedClass, ClassScores>`
  - `ScoredPlayer` gains `pHidden: number | null; pHiddenOcc: number | null; pReveal: number | null`
  - `composite` unchanged (pFid, pOcc, pGap only).

- [ ] **Step 1: Write the failing test**

Append to `tests/integrityScore.test.ts` (add `import type { HiddenMetrics } from '../src/integrity/hidden.js';` and make sure `aggregate`, `scorePlayers`, `TUNING` are imported):

```ts
const hid = (over: Partial<HiddenMetrics> = {}): HiddenMetrics => ({
  windows: 4, scoreable: 3, fidSum: 0.3, fidMax: 0.2, occ: null, reveals: 4, revealOn: 1,
  byClass: {
    hunter: { scoreable: 3, fidSum: 0.3, occ: null, reveals: 4, revealOn: 1 },
    smoker: { scoreable: 0, fidSum: 0, occ: null, reveals: 0, revealOn: 0 },
    boomer: { scoreable: 0, fidSum: 0, occ: null, reveals: 0, revealOn: 0 },
  },
  gates: { considered: 0, notLive: 0, notTarget: 0, inGrace: 0, tooClose: 0, losUnknown: 0, seen: 0, teamSees: 0, occluded: 0, passed: 0 },
  ...over,
});

const losRows = (steamid: string, n: number, h: HiddenMetrics = hid()) =>
  Array.from({ length: n }, (_, i) => ({ steamid, metrics: m({ losKnown: true, hidden: h }), map: 'm', round: `${steamid}/${i}` }));

describe('the hidden columns', () => {
  it('reads n/a under MIN_BOARD_ROUNDS rounds with line of sight', () => {
    const [a] = aggregate(losRows('p', TUNING.MIN_BOARD_ROUNDS - 1));
    expect(a.losRounds).toBe(TUNING.MIN_BOARD_ROUNDS - 1);
    expect(a.hiddenShare).toBeNull();
    expect(a.revealShare).toBeNull();
    expect(a.byClass.hunter.hiddenShare).toBeNull();
  });

  it('pools D over windows and F over reveals once there is enough', () => {
    // 8 rounds x 3 windows = 24 >= MIN_TRACK_WINDOWS; 8 x 4 reveals = 32 >= MIN_REVEALS.
    const [a] = aggregate(losRows('p', 8));
    expect(a.hiddenScoreable).toBe(24);
    expect(a.hiddenShare).toBeCloseTo(0.1);
    expect(a.reveals).toBe(32);
    expect(a.revealShare).toBeCloseTo(0.25);
    expect(a.byClass.hunter.hiddenShare).toBeCloseTo(0.1);
    expect(a.byClass.hunter.revealShare).toBeCloseTo(0.25);
    expect(a.byClass.smoker).toEqual({ hiddenShare: null, hiddenOccZ: null, revealShare: null });
  });

  it('keeps F at n/a under MIN_REVEALS even with enough rounds', () => {
    const [a] = aggregate(losRows('p', 8, hid({ reveals: 2, revealOn: 2 })));
    expect(a.revealShare).toBeNull();
  });

  it('treats a version 4 row as no line of sight, not as zero', () => {
    const [a] = aggregate([{ steamid: 'old', metrics: m(), map: 'm', round: 'r' }]);
    expect(a.losRounds).toBe(0);
    expect(a.hiddenShare).toBeNull();
    expect(a.hiddenOccZ).toBeNull();
  });

  it('ranks the hidden columns by percentile and leaves the composite alone', () => {
    const low = losRows('low', 8, hid({ fidSum: 0.3 }));
    const high = losRows('high', 8, hid({ fidSum: 2.4 }));
    const scored = scorePlayers(aggregate([...low, ...high]));
    const byId = new Map(scored.map((p) => [p.steamid, p]));
    expect(byId.get('high')!.pHidden).toBe(1);
    expect(byId.get('low')!.pHidden).toBe(0);
    // Every other metric is identical, so the composite must be too.
    expect(byId.get('high')!.composite).toBe(byId.get('low')!.composite);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integrityScore.test.ts`
Expected: FAIL, `losRounds` and the other new fields are undefined.

- [ ] **Step 3: Implement**

In `src/integrity/score.ts`, add the imports:

```ts
import type { HiddenMetrics } from './hidden.js';
import { TRACKED_CLASSES, type InfectedClass } from './los.js';
```

Change `calibrate`'s signature and its one read of `occ`:

```ts
export function calibrate(
  rows: ScoreRow[], pick: (m: RoundMetrics) => OccResult | null | undefined = (m) => m.occ,
): (map: string | null | undefined) => number {
```

and inside it replace `const occ = r.metrics.occ;` with `const occ = pick(r.metrics);`. Add one sentence to its doc comment: "`pick` chooses which occupancy is being calibrated: metric B's, or metric E's, which is calibrated on its own because hidden pairs are a different population of moments."

Add after `PlayerAgg`'s `teamGap` field:

```ts
  /** Rounds whose replay recorded line of sight: what the hidden metrics'
   *  MIN_BOARD_ROUNDS counts. Version 4 rows have none. */
  losRounds: number;
  hiddenScoreable: number;
  /** Metric D: pooled lag-tolerant fidelity over scoreable hidden windows. */
  hiddenShare: number | null;
  /** Metric E: mean per-round z against its own per-map calibration. */
  hiddenOccZ: number | null;
  reveals: number;
  /** Metric F: share of reveals already on target. Null under MIN_REVEALS. */
  revealShare: number | null;
  /** The same three per infected class. Hunters are quiet when crouched, so a
   *  player far above the league on hunters is the strongest signal. */
  byClass: Record<InfectedClass, ClassScores>;
```

and before `PlayerAgg`:

```ts
export interface ClassScores { hiddenShare: number | null; hiddenOccZ: number | null; revealShare: number | null }
```

Add before `aggregate`:

```ts
/** D, E and F for one player's rounds, at the given class or overall. Every
 *  value is null under MIN_BOARD_ROUNDS rounds with line of sight: sample
 *  sizes here are small, and a small sample must read "not enough", not a
 *  number (spec section 3, Minimums). */
function hiddenScores(
  hid: { h: HiddenMetrics; map: string | null | undefined }[],
  k: (map: string | null | undefined) => number,
  part: (h: HiddenMetrics) => { scoreable: number; fidSum: number; occ: OccResult | null; reveals: number; revealOn: number },
): ClassScores & { scoreable: number; reveals: number } {
  const enough = hid.length >= TUNING.MIN_BOARD_ROUNDS;
  const parts = hid.map((x) => ({ p: part(x.h), map: x.map }));
  const scoreable = parts.reduce((a, x) => a + x.p.scoreable, 0);
  const fidSum = parts.reduce((a, x) => a + x.p.fidSum, 0);
  const reveals = parts.reduce((a, x) => a + x.p.reveals, 0);
  const on = parts.reduce((a, x) => a + x.p.revealOn, 0);
  return {
    scoreable,
    reveals,
    hiddenShare: enough && scoreable >= TUNING.MIN_TRACK_WINDOWS ? fidSum / scoreable : null,
    hiddenOccZ: enough ? meanOrNull(parts.map((x) => (x.p.occ ? occupancyZ(x.p.occ, k(x.map)) : null))) : null,
    revealShare: enough && reveals >= TUNING.MIN_REVEALS ? on / reveals : null,
  };
}
```

In `aggregate`, after `const k = calibrate(rows);` add:

```ts
  const kHidden = calibrate(rows, (m) => m.hidden?.occ);
  const kClass = new Map(TRACKED_CLASSES.map((c) => [c, calibrate(rows, (m) => m.hidden?.byClass[c].occ)]));
```

and in the per-player `return { ... }`, after `teamGap: meanOrNull(list.map(gapOf)),`, add:

```ts
      ...(() => {
        const hid = list.flatMap((r) => (r.metrics.hidden ? [{ h: r.metrics.hidden, map: r.map }] : []));
        const all = hiddenScores(hid, kHidden, (h) => h);
        return {
          losRounds: hid.length,
          hiddenScoreable: all.scoreable,
          hiddenShare: all.hiddenShare,
          hiddenOccZ: all.hiddenOccZ,
          reveals: all.reveals,
          revealShare: all.revealShare,
          byClass: Object.fromEntries(TRACKED_CLASSES.map((c) => {
            const s = hiddenScores(hid, kClass.get(c)!, (h) => h.byClass[c]);
            return [c, { hiddenShare: s.hiddenShare, hiddenOccZ: s.hiddenOccZ, revealShare: s.revealShare }];
          })) as Record<InfectedClass, ClassScores>,
        };
      })(),
```

Add to `ScoredPlayer`, after `pGap`:

```ts
  /** Percentiles of D, E and F among ranked players who have them. Shown, NOT
   *  in the composite: their thresholds are uncalibrated (spec section 6), and
   *  an uncalibrated number in the rank would reorder the review list on it. */
  pHidden: number | null;
  pHiddenOcc: number | null;
  pReveal: number | null;
```

In `scorePlayers`, after `const gaps = ...;` add:

```ts
  const hiddens = some(pool.map((a) => a.hiddenShare));
  const hiddenOccs = some(pool.map((a) => a.hiddenOccZ));
  const revealsP = some(pool.map((a) => a.revealShare));
```

in the ranked `map`, change the returned object to:

```ts
    return {
      ...a, ranked: true, pFid, pOcc, pGap,
      pHidden: a.hiddenShare == null ? null : percentile(hiddens, a.hiddenShare),
      pHiddenOcc: a.hiddenOccZ == null ? null : percentile(hiddenOccs, a.hiddenOccZ),
      pReveal: a.revealShare == null ? null : percentile(revealsP, a.revealShare),
      composite: parts.reduce((x, y) => x + y, 0) / parts.length,
    };
```

and in the unranked `map`, add `pHidden: null, pHiddenOcc: null, pReveal: null,` beside `pGap: null`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integrityScore.test.ts && npm run typecheck`
Expected: PASS. The type check will report every other `PlayerAgg`/`ScoredPlayer` literal missing the new fields; there should be none outside `score.ts` (the board adds names after scoring).

- [ ] **Step 5: Commit**

```bash
git add src/integrity/score.ts tests/integrityScore.test.ts
git commit -m "Integrity: read-time scores for D, E and F, per class, behind the board minimums and outside the composite"
```

---

### Task 8: Server surfacing (ranks and timeline)

**Files:**
- Modify: `src/admin/analyzerRanks.ts:16-55`
- Modify: `src/admin/timeline/analyzer.ts:37-46`
- Test: `tests/timelineEvidence.test.ts`

**Interfaces:**
- Consumes: `ScoredPlayer` fields from Task 7, `ClassScores`, `InfectedClass`.
- Produces: `AnalyzerRank` gains `losRounds`, `hiddenShare`, `hiddenOccZ`, `reveals`, `revealShare`, `pHidden`, `pHiddenOcc`, `pReveal`, `byClass: Record<InfectedClass, ClassScores>`.

- [ ] **Step 1: Write the failing test**

In `tests/timelineEvidence.test.ts`, change the `clip` helper to take a kind, keeping its default:

```ts
const clip = (version: number, startMs = 61500, kind = 'track') =>
  db.prepare(
    `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
     VALUES (7, 2, 1, 3, ?, ?, ?, ?, 0.82, '{}', ?)`,
  ).run(P, startMs, startMs + 6000, kind, version);
```

and add inside `describe('the analyzer source', ...)`:

```ts
  it('says in words which kind of moment a clip is', () => {
    clip(ANALYZER_VERSION, 1000, 'hidden_track');
    clip(ANALYZER_VERSION, 9000, 'ghost_track');
    const text = analyzerAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF }).map((i) => i.summary);
    expect(text.some((t) => /followed a spawned infected nobody on the team could see/.test(t))).toBe(true);
    expect(text.some((t) => /followed a ghost/.test(t))).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/timelineEvidence.test.ts`
Expected: FAIL, the summary still reads the raw kind.

- [ ] **Step 3: Implement the timeline text**

In `src/admin/timeline/analyzer.ts`, add above `export const analyzerAdapter`:

```ts
/** What each clip kind means, in the words an admin reads. An unknown kind
 *  (an old row, a future analyzer) shows as itself rather than disappearing. */
const CLIP_TEXT: Record<string, string> = {
  ghost_track: 'followed a ghost',
  hidden_track: 'followed a spawned infected nobody on the team could see',
};
```

and change the `summary` line to:

```ts
      summary: `Analyzer clip: ${CLIP_TEXT[r.kind] ?? r.kind}, fidelity ${r.score.toFixed(2)} over `
```

(the continuation line with the duration and "Watch it before deciding anything." stays as it is).

- [ ] **Step 4: Carry the new columns in `analyzerRanks.ts`**

Add the import:

```ts
import type { ClassScores } from '../integrity/score.js';
import type { InfectedClass } from '../integrity/los.js';
```

Add to the `AnalyzerRank` interface after `composite`:

```ts
  /** Metrics D, E and F. Shown beside the rank, not part of it. */
  losRounds: number;
  hiddenShare: number | null;
  hiddenOccZ: number | null;
  reveals: number;
  revealShare: number | null;
  pHidden: number | null;
  pHiddenOcc: number | null;
  pReveal: number | null;
  byClass: Record<InfectedClass, ClassScores>;
```

and to the object built in `analyzerRanks`, after `composite: p.composite,`:

```ts
    losRounds: p.losRounds,
    hiddenShare: p.hiddenShare,
    hiddenOccZ: p.hiddenOccZ,
    reveals: p.reveals,
    revealShare: p.revealShare,
    pHidden: p.pHidden,
    pHiddenOcc: p.pHiddenOcc,
    pReveal: p.pReveal,
    byClass: p.byClass,
```

- [ ] **Step 5: Run the tests and type check**

Run: `npm test && npm run typecheck`
Expected: PASS for the server side. The web type check (second half of `typecheck`) may fail on `web/src/api.ts` consumers until Task 9; if it does, Task 9 fixes it and this commit is still correct on its own for the server.

- [ ] **Step 6: Commit**

```bash
git add src/admin/analyzerRanks.ts src/admin/timeline/analyzer.ts tests/timelineEvidence.test.ts
git commit -m "Admin: carry the hidden columns in analyzer ranks and name clip kinds in the timeline"
```

---

### Task 9: Web surfacing (board columns, player file)

**Files:**
- Modify: `web/src/api.ts:1164-1169` (`AnalyzerRank`)
- Modify: `web/src/routes/admin/NeedsALook.tsx:135-160`
- Modify: `web/src/routes/admin/file/EvidenceDetail.tsx:50-60`, the column key `<dl>`, and the clip list item (around line 110)
- Modify fixtures: `web/src/routes/people.test.tsx:34-44`, and every `AnalyzerRank` literal in `web/src/routes/playerFile.test.tsx`
- Test: `web/src/routes/people.test.tsx`, `web/src/routes/playerFile.test.tsx`

**Interfaces:**
- Consumes: the `AnalyzerRank` wire shape from Task 8.
- Produces: `web` `AnalyzerRank` mirror with the same new fields; `ClassScores` and `InfectedClass` web types.

- [ ] **Step 1: Mirror the type**

In `web/src/api.ts`, replace the `AnalyzerRank` interface with:

```ts
export type InfectedClass = 'smoker' | 'boomer' | 'hunter';
export interface ClassScores { hiddenShare: number | null; hiddenOccZ: number | null; revealShare: number | null }

/** The analyzer board's columns for one player. A sort key, never a claim.
 *  Mirrors src/admin/analyzerRanks.ts. The hidden columns (D, E, F) are shown
 *  beside the rank and are not part of it. */
export interface AnalyzerRank {
  steamid: string; ranked: boolean; rank: number | null; of: number;
  rounds: number; eligibleRounds: number; clips: number;
  trackShare: number | null; occZ: number | null; teamGap: number | null;
  pFid: number | null; pOcc: number | null; pGap: number | null; composite: number | null;
  losRounds: number; hiddenShare: number | null; hiddenOccZ: number | null;
  reveals: number; revealShare: number | null;
  pHidden: number | null; pHiddenOcc: number | null; pReveal: number | null;
  byClass: Record<InfectedClass, ClassScores>;
}
```

- [ ] **Step 2: Update fixtures and write the failing tests**

In `web/src/routes/people.test.tsx`, add near the top (after the imports):

```ts
const noClass = { hiddenShare: null, hiddenOccZ: null, revealShare: null };
const noHidden = {
  losRounds: 0, hiddenShare: null, hiddenOccZ: null, reveals: 0, revealShare: null,
  pHidden: null, pHiddenOcc: null, pReveal: null,
  byClass: { hunter: noClass, smoker: noClass, boomer: noClass },
};
```

and spread it into both fixtures: in `lookRow.analyzer` add `...noHidden,` after `composite: 0.8,`; in `measured`, add `...noHidden,` before `...over`.

Then run `npm run typecheck`. Every other `AnalyzerRank` literal missing the new fields is reported with file and line (expected: in `web/src/routes/playerFile.test.tsx`). Add the same two constants to the top of each such file and spread `...noHidden` into each literal the type checker names.

Add to `web/src/routes/people.test.tsx`, next to the existing "Analyzer ranking" tests (reuse the same mocks those tests set up):

```ts
  it('shows the hidden-infected columns on the ranking tab', async () => {
    mockPeople.review.mockResolvedValue({
      players: [],
      measured: [measured({ hiddenShare: 0.3, hiddenOccZ: 1.25, revealShare: 0.5, losRounds: 9, reveals: 40 })],
      health: health(),
    });
    render(<NeedsALook isAdmin />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Analyzer ranking' }));
    expect(await screen.findByRole('columnheader', { name: 'Hidden tracking' })).toBeTruthy();
    expect(screen.getByText('0.300')).toBeTruthy();
    expect(screen.getByText('1.25')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
  });
```

Add to `web/src/routes/playerFile.test.tsx`, beside the clip tests:

```ts
  it('names a hidden tracking clip as what it is', async () => {
    mockPeople.file.mockResolvedValue(file({
      sections: {
        ...file().sections,
        evidence: {
          analyzer: null, rounds: [], flags: [], inputFlags: [], inputCaps: [],
          signonDrops: { count: 0, lastAt: null, rows: [] },
          clips: [{ id: 1, matchId: 42, ordinal: 2, half: 1, slot: 3, startMs: 5000, endMs: 7000, kind: 'hidden_track', score: 0.6, detail: {} }],
        },
      },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    await screen.findByRole('heading', { name: /griefer/ });
    expect(await screen.findByText(/hidden infected/)).toBeTruthy();
  });
```

- [ ] **Step 3: Run the web tests to verify they fail**

Run: `npx vitest run web/src/routes/people.test.tsx web/src/routes/playerFile.test.tsx`
Expected: the two new tests FAIL (no column, no label); every existing test passes.

- [ ] **Step 4: Add the board columns**

In `web/src/routes/admin/NeedsALook.tsx`, add a percent formatter beside `num3`:

```ts
const pct = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
```

In the measured table header, after `<th>Team gap</th>`, add:

```tsx
                      <th>Hidden tracking</th>
                      <th>Hidden pre-aim</th>
                      <th>Reveal on target</th>
```

and in the row, after `<td>{num(m.teamGap)}</td>`, add:

```tsx
                        <td>{num3(m.hiddenShare)}</td>
                        <td>{num(m.hiddenOccZ)}</td>
                        <td>{pct(m.revealShare)}</td>
```

- [ ] **Step 5: Add the player-file line, class split, key and clip label**

In `web/src/routes/admin/file/EvidenceDetail.tsx`, add below the `pct` helper:

```ts
/** A clip's kind in words. Unknown kinds show as themselves. */
const CLIP_KIND: Record<string, string> = { ghost_track: 'ghost', hidden_track: 'hidden infected' };
const clipKind = (k: string): string => CLIP_KIND[k] ?? k;
```

Inside the analyzer `<p class="muted">` (after the `team gap` line), add a second paragraph right after that `</p>`, still inside the `a === null ? ... : (...)` branch (wrap both paragraphs in a fragment `<>...</>`):

```tsx
          <p class="muted">
            Hidden infected ({a.losRounds} rounds with line of sight, not in the rank):
            {' '}tracking {num3(a.hiddenShare)} ({pct(a.pHidden)})
            {' · '}pre-aim {num(a.hiddenOccZ)} ({pct(a.pHiddenOcc)})
            {' · '}on target at reveal {pct(a.revealShare)} of {a.reveals} ({pct(a.pReveal)})
            {' · '}hunters: tracking {num3(a.byClass.hunter.hiddenShare)}, reveal {pct(a.byClass.hunter.revealShare)}
            {' · '}smokers: tracking {num3(a.byClass.smoker.hiddenShare)}, reveal {pct(a.byClass.smoker.revealShare)}
            {' · '}boomers: tracking {num3(a.byClass.boomer.hiddenShare)}, reveal {pct(a.byClass.boomer.revealShare)}
          </p>
```

In the `<dl class="colkey__list">`, before `<dt>Rank and n/a</dt>`, add:

```tsx
          <dt>Hidden tracking, pre-aim and reveal</dt>
          <dd>
            The same questions as tracking and occupancy, asked about spawned infected at the
            moments nobody on the survivor team could see them, from the line of sight the server
            records ten times a second. If a teammate could see it, the moment does not count, because
            a callout explains a crosshair honestly. "On target at reveal" is how often the crosshair
            was already on an infected the instant it came into view. These need eight rounds with
            line of sight, and reveal needs thirty reveals, before they read anything. They are
            shown, not ranked, until a calibration session has set what normal looks like.
          </dd>
```

In the clip list item, change the muted span to include the kind:

```tsx
                    <span class="muted"> · {clipKind(c.kind)} · fidelity {c.score.toFixed(2)} · {((c.endMs - c.startMs) / 1000).toFixed(1)}s</span>
```

- [ ] **Step 6: Run the tests and type check**

Run: `npm test && npm run typecheck`
Expected: PASS, web and server.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/NeedsALook.tsx web/src/routes/admin/file/EvidenceDetail.tsx web/src/routes/people.test.tsx web/src/routes/playerFile.test.tsx
git commit -m "Web: hidden-infected columns on the analyzer ranking, the player file line and the clip kind"
```

---

### Task 10: A synthetic wallhacker on a hidden infected

**Files:**
- Modify: `src/integrity/synthetic.ts:42-80`
- Modify: `scripts/inject-synthetic-tracker.ts`
- Test: `tests/integritySynthetic.test.ts`

**Interfaces:**
- Consumes: `isSpawnedTarget`, `losView` (Task 1), `hiddenTrackWindows`, `scanHidden` (Task 3), `pickClips` (Task 2).
- Produces: `injectTracker(frames, slot, targetSlot, opts, follow?: (p: PlayerSample) => boolean)` (default `isGhost`); `busiestHiddenPair(frames, survivorSlots, los)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integritySynthetic.test.ts` (add imports `import { losView, isSpawnedTarget } from '../src/integrity/los.js';`, `import { hiddenTrackWindows } from '../src/integrity/hidden.js';`, `import { pickClips } from '../src/integrity/ghostTrack.js';`, and `import { header, scene } from './hiddenFixtures.js';`):

```ts
describe('a synthetic wallhacker on a hidden infected', () => {
  const LOS = losView(header());

  it('is flagged when it follows the hidden hunter 150 ms late', () => {
    // The scene's own survivor looks the other way: an honest player.
    const honest = scene({ yaw: () => 90 });
    expect(hiddenTrackWindows(honest, 0, LOS)).toEqual([]);
    const cheat = injectTracker(honest, 0, 4, { lagMs: 150, noiseDeg: 0.5, noiseTauMs: 300, seed: 1 }, isSpawnedTarget);
    const clips = pickClips(hiddenTrackWindows(cheat, 0, LOS), (w) => w.lagFidelity);
    expect(clips.length).toBeGreaterThan(0);
  });

  it('still follows ghosts by default', () => {
    const frames = scene({ yaw: () => 90 });
    // No ghosts in this scene: the default leaves every frame untouched.
    expect(injectTracker(frames, 0, 4, { lagMs: 0, noiseDeg: 0, noiseTauMs: 0, seed: 1 })).toEqual(frames);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integritySynthetic.test.ts`
Expected: FAIL, `injectTracker` ignores the fifth argument and never rewrites a spawned hunter.

- [ ] **Step 3: Implement**

In `src/integrity/synthetic.ts`, add `import type { PlayerSample } from '../replayFormat.js';` (merge into the existing replayFormat import), and replace `ghostAt` and `injectTracker` with:

```ts
/** Where the target was at `tMs`, interpolated between the frames either
 *  side, or null when `follow` did not hold at both of them. */
function targetAt(
  frames: Frame[], i: number, targetSlot: number, tMs: number, follow: (p: PlayerSample) => boolean,
): { x: number; y: number; z: number } | null {
  let k = i;
  while (k > 0 && frames[k].tMs > tMs) k--;
  const a = frames[k].players[targetSlot], b = frames[Math.min(k + 1, i)].players[targetSlot];
  if (!a || !b || !follow(a) || !follow(b)) return null;
  const span = frames[Math.min(k + 1, i)].tMs - frames[k].tMs;
  const w = span > 0 ? Math.min(1, Math.max(0, (tMs - frames[k].tMs) / span)) : 0;
  return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w, z: a.z + (b.z - a.z) * w };
}

/**
 * The same round with `slot` looking at `targetSlot` whenever `follow` holds
 * for it and they are a live survivor. Only that survivor's yaw and pitch
 * change, and only in those frames. `follow` is `isGhost` for metric A; pass
 * `isSpawnedTarget` to plant a wallhacker on a spawned infected for metric D,
 * where the file's own line-of-sight bits decide which of those frames were
 * hidden.
 */
export function injectTracker(
  frames: Frame[], slot: number, targetSlot: number, opts: TrackerOpts,
  follow: (p: PlayerSample) => boolean = isGhost,
): Frame[] {
  const rand = gaussian(opts.seed);
  let noise = opts.noiseDeg * rand();
  return frames.map((f, i) => {
    const s = f.players[slot], g = f.players[targetSlot];
    if (i > 0) {
      const a = opts.noiseTauMs > 0 ? Math.exp(-(f.tMs - frames[i - 1].tMs) / opts.noiseTauMs) : 0;
      noise = a * noise + Math.sqrt(1 - a * a) * opts.noiseDeg * rand();
    }
    if (!s || !g || !isLiveSurvivor(s) || !follow(g)) return f;
    const seen = targetAt(frames, i, targetSlot, f.tMs - opts.lagMs, follow) ?? g;
    const rise = (seen.z + TUNING.TARGET_Z) - (s.z + TUNING.EYE_Z);
    const players = f.players.map((p) => (p.slot !== slot ? p : {
      ...p,
      // Stored as hundredths of a degree and as whole degrees, so rounded the
      // way the file would round them.
      yaw: Math.round(wrapDeg(bearing(s, seen) + noise) * 100) / 100,
      pitch: Math.round(-Math.atan2(rise, dist2d(s, seen)) * 180 / Math.PI),
    }));
    return { ...f, players };
  });
}
```

Append:

```ts
/** The survivor and spawned infected with the most hidden-from-team frames
 *  between them: the hidden counterpart of `busiestPair`. */
export function busiestHiddenPair(
  frames: Frame[], survivorSlots: number[], los: LosView,
): { slot: number; ghostSlot: number; pairs: number } | null {
  let best: { slot: number; ghostSlot: number; pairs: number } | null = null;
  for (const slot of survivorSlots) {
    const n = new Map<number, number>();
    scanHidden(frames, slot, los, (_s, t) => n.set(t.slot, (n.get(t.slot) ?? 0) + 1));
    for (const [ghostSlot, pairs] of n) if (!best || pairs > best.pairs) best = { slot, ghostSlot, pairs };
  }
  return best;
}
```

with imports `import { scanHidden } from './hidden.js';` and `import type { LosView } from './los.js';`.

- [ ] **Step 4: Add `--hidden` to the script**

In `scripts/inject-synthetic-tracker.ts`:

1. Add to the usage comment: `--hidden      follow a spawned infected hidden from the team (metric D) instead of a ghost`.
2. Add imports: `busiestHiddenPair` from `../src/integrity/synthetic.js`; `hiddenTrackWindows` from `../src/integrity/hidden.js`; `losView, isSpawnedTarget` from `../src/integrity/los.js`.
3. After the `num` helper, add `const hidden = args.includes('--hidden');`.
4. In `score`, replace the `windows` line with:

```ts
  const windows = (hidden ? hiddenTrackWindows(round.frames, slot, losView(round.header)) : trackWindows(round.frames, slot))
    .filter((w) => w.ghostSlot === ghostSlot);
```

   and make the fidelity it reports the metric's own score: replace `fids: scoreable.map((w) => w.fidelity), clips: pickClips(windows).length` with

```ts
    fids: scoreable.map((w) => (hidden ? w.lagFidelity : w.fidelity)),
    clips: (hidden ? pickClips(windows, (w) => w.lagFidelity) : pickClips(windows)).length,
```

5. In the loading loop, replace `const auto = busiestPair(replay.frames, survivors);` with:

```ts
  if (hidden && !replay.header.losKnown) { console.error(`${path}: records no line of sight, skipped`); continue; }
  const auto = hidden ? busiestHiddenPair(replay.frames, survivors, losView(replay.header)) : busiestPair(replay.frames, survivors);
```

6. Every `injectTracker(l.replay.frames, l.slot, l.ghostSlot, o)` call (two of them) gains a fifth argument: `hidden ? isSpawnedTarget : undefined`.

- [ ] **Step 5: Run the tests and type check**

Run: `npx vitest run tests/integritySynthetic.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Try the script on a real replay**

The owner pulled three rounds of the 2026-09-24 match (token `ffd662754e5a52ecc7c3fa6cd7a7f636`) into the session scratchpad; if they are gone, copy one from Dallas read-only: `scp root@45.32.199.85:/home/l4d/l4d1-server/left4dead/replays/pug_ffd662754e5a52ecc7c3fa6cd7a7f636_1_2.rpl /tmp/`.

Run: `npx tsx scripts/inject-synthetic-tracker.ts /tmp/pug_ffd662754e5a52ecc7c3fa6cd7a7f636_1_2.rpl --hidden --lag 150 --noise 1`
Expected: a table where "injected" has clips > 0 and "as played" has a far lower median. Record both rows in the commit message body.

- [ ] **Step 7: Commit**

```bash
git add src/integrity/synthetic.ts scripts/inject-synthetic-tracker.ts tests/integritySynthetic.test.ts
git commit -m "Integrity: plant a synthetic wallhacker on a hidden infected; --hidden in the injector"
```

---

### Task 11: How much does the lag search lift honest scores

**Files:**
- Create: `scripts/lag-inflation.ts`

**Interfaces:**
- Consumes: `decodeRound` (run.ts), `trackWindows` (ghostTrack.ts), `hiddenTrackWindows` (hidden.ts), `losView` (los.ts), `TUNING`.
- Produces: a console report only. No code depends on it.

The spec (Testing) requires that the lag search "not raise the league's own score distribution by more than the synthetic margin". Real rounds are the league; this measures the lift on them.

- [ ] **Step 1: Write the script**

Create `scripts/lag-inflation.ts`:

```ts
/**
 * How much the lag search lifts HONEST scores.
 *
 * Searching five lags gives a chance match five tries, so every player's
 * windows score a little higher than at lag 0. That lift is harmless only if
 * it is small next to the lift it gives a real tracker, which is what the
 * synthetic injector measures. This reports the first number, from real
 * replays, per metric:
 *
 *   ghost windows (metric A): lag 0 fidelity against lagFidelity
 *   hidden windows (metric D): lagFidelity, with the lag each window chose
 *
 *   npx tsx scripts/lag-inflation.ts <a.rpl> [b.rpl ...]
 */
import { readFileSync } from 'node:fs';
import { decodeRound } from '../src/integrity/run.js';
import { trackWindows } from '../src/integrity/ghostTrack.js';
import { hiddenTrackWindows } from '../src/integrity/hidden.js';
import { losView } from '../src/integrity/los.js';
import { TUNING } from '../src/integrity/constants.js';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: lag-inflation.ts <replay.rpl> [more.rpl ...]'); process.exit(2); }

const q = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
};
const summary = (label: string, xs: number[]) => ({
  label, n: xs.length,
  median: +q(xs, 0.5).toFixed(3), p90: +q(xs, 0.9).toFixed(3), max: +q(xs, 1).toFixed(3),
  [`>=${TUNING.CLIP_MIN}`]: xs.filter((x) => x >= TUNING.CLIP_MIN).length,
});

const ghost0: number[] = [], ghostLag: number[] = [], hidden: number[] = [];
const lags = new Map<number, number>();
let withLos = 0;
for (const path of files) {
  const round = decodeRound(readFileSync(path));
  if (!round) { console.error(`${path}: not readable, skipped`); continue; }
  const los = losView(round.header);
  if (los.known) withLos++;
  for (const slot of round.slots) {
    for (const w of trackWindows(round.frames, slot)) {
      if (w.travel < TUNING.MIN_TRAVEL) continue;
      ghost0.push(w.fidelity);
      ghostLag.push(w.lagFidelity);
    }
    for (const w of hiddenTrackWindows(round.frames, slot, los)) {
      if (w.travel < TUNING.MIN_TRAVEL) continue;
      hidden.push(w.lagFidelity);
      lags.set(w.lagMs, (lags.get(w.lagMs) ?? 0) + 1);
    }
  }
}

console.log(`${files.length} replays, ${withLos} with line of sight. Scoreable windows only.`);
console.table([summary('ghost, lag 0 (ranked)', ghost0), summary('ghost, lag search', ghostLag), summary('hidden, lag search', hidden)]);
console.log('hidden windows by chosen lag (ms):', Object.fromEntries([...lags].sort((a, b) => a[0] - b[0])));
```

- [ ] **Step 2: Run it on real replays**

Copy recent replays read-only into a scratch directory (the plan-1 era ones carry line of sight; older ones still give ghost numbers):

```bash
mkdir -p /tmp/lagcheck && scp 'root@45.32.199.85:/home/l4d/l4d1-server/left4dead/replays/pug_*.rpl' /tmp/lagcheck/
npx tsx scripts/lag-inflation.ts /tmp/lagcheck/*.rpl
```

Expected: a table. Compare the "ghost, lag search" median and p90 against "ghost, lag 0": that difference is the honest lift. Compare it with Task 10 Step 6's injected-minus-as-played difference: that is the synthetic margin. The lift must be well under the margin; write both numbers into the commit message. If the lift is not well under the margin, STOP and report to the owner before Task 12: the spec says the scores inflate in that case and the lag search must be reconsidered.

- [ ] **Step 3: Commit**

```bash
git add scripts/lag-inflation.ts
git commit -m "Integrity: measure how much the lag search lifts honest scores against the synthetic margin"
```

---

### Task 12: Review, merge and ship (owner go-ahead required)

**Files:** none new.

- [ ] **Step 1: Full verification in the worktree**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. Record the test count.

- [ ] **Step 2: Local re-measure on a copy, never production**

Pull a copy of the production DB and the replays read-only (see memory `pug-deploy-verification` and the existing `ops/pull-db-backups.sh` for where daily copies land), then:

```bash
DB_PATH=/tmp/lagcheck/pug.db REPLAY_DIR=/tmp/lagcheck npx tsx scripts/backfill-integrity.ts
```

Expected: the backfill completes; spot-check with sqlite that version 5 rows exist with `hidden` non-null for plan-1-era rounds and null for older ones:

```bash
sqlite3 /tmp/lagcheck/pug.db "SELECT analyzer_version, json_extract(metrics,'$.losKnown') los, COUNT(*) FROM integrity_rounds GROUP BY 1,2"
sqlite3 /tmp/lagcheck/pug.db "SELECT kind, COUNT(*) FROM integrity_clips WHERE analyzer_version = 5 GROUP BY kind"
```

- [ ] **Step 3: Owner review and go-ahead**

Show the owner: the decisions list at the top of this plan, Task 10's synthetic numbers, Task 11's lift numbers, and the Step 2 counts. Do not merge or deploy without an explicit yes.

- [ ] **Step 4: Merge and deploy**

Check `git -C /home/volence/l4d/pug reflog -5` and `git status` on master first (other sessions commit there). Rebase the branch onto current master, fast-forward master, push `origin master:main` and `private master:master` as the repo's memory notes describe, then deploy the web app with `./deploy-web.sh`. No game-server plugin change is involved.

- [ ] **Step 5: Re-measure production**

In the admin panel, Analyzer ranking tab, press "Re-analyse all replays" (admins only). The version bump makes every round with a replay pending anyway; the button just does it now rather than after the next match.

- [ ] **Step 6: Verify live**

Follow memory `pug-deploy-verification`: tree hash on the box matches, the page bundle contains "Hidden tracking", and the DB shows version 5 rows with `losKnown` true for rounds from 2026-09-23 onward. Report what was deployed in the final message.
