import { STATE, type Frame, type PlayerSample } from '../replayFormat.js';
import { TUNING } from './constants.js';
import {
  aimError, bearing, dist2d, isGhost, isLiveSurvivor, onTarget, pairEligible, pairGate, wrapDeg, type Pt,
} from './geometry.js';

/**
 * Metric A, the backbone: did the crosshair MOVE with an invisible target.
 *
 * Proximity alone is not evidence, because the good spawn spots are known and
 * people pre-aim them. A held angle produces none of the motion needed to
 * follow a moving target, so it scores zero however well chosen the spot was,
 * and so does a held corner, whose only motion is the survivor's own parallax.
 * Producing the motion the GHOST'S movement called for, against something you
 * cannot see, is what has no innocent explanation, and the more the ghost
 * moves the harder it is to do by accident.
 *
 * This module is metric A and the frame-eligibility primitives it shares with
 * metric B. Metric B lives in `occupancy.ts` and the round-level orchestration
 * in `round.ts`, which is what keeps this file free of any dependency on the
 * aim prior.
 */

/**
 * How much better "the crosshair followed the ghost" explains the yaw than the
 * best INNOCENT explanation does. 1 is exact, 0 is no better.
 *
 * This replaces the Pearson correlation the design spec first called for.
 * Pearson has a degenerate case that fails at precisely the wrong moment: a
 * ghost moving at a constant angular rate, tracked perfectly, gives two
 * CONSTANT delta series, neither of which has any variance, so the correlation
 * is undefined and the most blatant possible cheat scores zero. Pearson is also
 * scale invariant, so half the required motion, perfectly proportioned, would
 * score a perfect 1. A normalised residual has neither problem.
 *
 * WHAT IT IS NORMALISED BY is the part that was wrong until version 4. The
 * bearing to a ghost changes for two reasons, the ghost moving and the
 * SURVIVOR moving, and the old denominator was all of it. A survivor holding a
 * door frame while running past it turns their view exactly as the parallax of
 * that door demands, which is also what the parallax of a ghost standing behind
 * the door demands, so they were credited with tracking something that never
 * moved: 0.70 to 0.97 on synthetic frames, and the highest score in real
 * history, 0.622, was against a ghost that moved 0 units.
 *
 * So there are two innocent explanations to beat, not one, and the residual of
 * "followed the ghost" is measured against whichever of them does better:
 *
 *   held an ANGLE:        the yaw does not change. Its error against the
 *                         bearing is the whole bearing change, `dBearing`.
 *   held a WORLD POINT:   the yaw changes by the survivor's own parallax and
 *                         nothing else. Its error against the bearing is what
 *                         is left, the change the ghost's own steps caused,
 *                         `dGhost`.
 *
 * Both are needed. Subtracting the survivor's movement alone, which is the
 * obvious fix, breaks the first: when a survivor sidesteps with the crosshair
 * dead still and the ghost happens to sidestep the same way, the bearing barely
 * changes, the two causes cancel, and "the ghost moved and the crosshair
 * followed" scores 0.51 for a held angle. That is a real window, found in
 * pug_777fde4d..._1_2 at 56.2 s while checking the fix.
 *
 * With `dGhost` omitted the two series are the same, which is the case of a
 * survivor who is not moving, and the result is the plain residual ratio.
 *
 * THE LIMIT, which is a property of the evidence and not of the arithmetic: a
 * cheat user watching a ghost that is STANDING STILL behind a wall, while
 * strafing, does exactly what an honest player holding that corner does. Both
 * score 0 here and no function of yaw and position can separate them. The same
 * goes for a ghost moving in step with the survivor. Only a ghost whose own
 * movement demanded crosshair movement is evidence.
 */
export function trackFidelity(dYaw: number[], dBearing: number[], dGhost: number[] = dBearing): number {
  const n = Math.min(dYaw.length, dBearing.length, dGhost.length);
  if (n < 1) return 0;
  const need = requiredMotion(dBearing, dGhost);
  let residual = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const d = dYaw[i] - dBearing[i];
    residual += d * d;
    total += need[i] * need[i];
  }
  // An innocent explanation fits exactly, so following the ghost required
  // nothing that holding still would not also have produced. No evidence, not
  // perfect evidence.
  if (total <= 1e-9) return 0;
  // Clamped: moving opposite to the target is not worse than useless evidence,
  // it is simply no evidence of tracking.
  return Math.max(0, 1 - Math.sqrt(residual / total));
}

/** The crosshair motion that neither innocent explanation accounts for: the
 *  error series of whichever of them fits better. `trackFidelity` normalises by
 *  it and the minimum-signal gate measures its travel, and they must be the
 *  same series, or a window could be let in on one and scored on the other. */
export function requiredMotion(dBearing: number[], dGhost: number[]): number[] {
  const sq = (xs: number[]) => xs.reduce((a, x) => a + x * x, 0);
  return sq(dBearing) <= sq(dGhost) ? dBearing : dGhost;
}

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

/** Positions of everything that is not this ghost and not the survivor: what
 *  the occlusion guard checks against. */
export function visibleOthers(f: Frame, survivorSlot: number, ghostSlot: number): Pt[] {
  const out: Pt[] = [];
  for (const p of f.players) {
    if (p.slot === survivorSlot || p.slot === ghostSlot) continue;
    if (isGhost(p)) continue;
    if ((p.state & STATE.PRESENT) === 0) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (const e of f.entities) {
    // An invisible thing must never occlude, whoever is driving it. AI
    // controlled special infected are recorded as ENTITIES rather than player
    // records (the player block is the roster and a bot never joins it), and
    // the frame writer stamps them with the same GHOST bit a human infected
    // carries: plugin/pug-match.sp:1351 writes RplClientState(c, RplIsGhost(c))
    // and RplIsGhost reads m_isGhost for any TEAM_INFECTED client, bot or
    // human. A bot filling a disconnected SI's slot mid-round is the ordinary
    // way this happens.
    if ((e.state & STATE.GHOST) !== 0) continue;
    out.push({ x: e.x, y: e.y });
  }
  return out;
}

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

/** Slots that were a ghost at any point this round: the infected roster as the
 *  frames themselves report it. The header's side mask is not consulted here so
 *  that the primitives stay decodable from a frame buffer alone. */
function ghostSlotsOf(frames: Frame[]): Set<number> {
  const out = new Set<number>();
  for (const f of frames) for (const p of f.players) if (isGhost(p)) out.add(p.slot);
  return out;
}

/**
 * Why the detector saw what it saw, one player-round.
 *
 * `passed` is the coverage number, and it is the whole point: without it a
 * player-round with no clips could equally mean "four hundred clean chances
 * and never a tracking window" or "the gates dropped every single frame and the
 * detector never ran". The first backfill flagged zero clips across 724
 * player-rounds and could not tell those two apart, which made the result
 * uninterpretable. The breakdown says which gate did the dropping.
 */
export interface GateTally {
  /** Survivor-and-infected pairs looked at, the denominator for the rest. */
  considered: number;
  notLive: number;
  notGhost: number;
  inGrace: number;
  tooClose: number;
  occluded: number;
  /** Pairs that passed every gate. Counted unconditionally, with no reference
   *  to whether a prior exists, because coverage is a property of the frames
   *  and not of how much history the map happens to have. */
  passed: number;
}

/**
 * Walk every (frame, infected slot) pair for one survivor, tallying where each
 * one fell and handing the survivors of every gate to `onPass`.
 *
 * The candidate set is the slots that were a ghost at some point this round,
 * not every other player: counting a teammate as `notGhost` would bury the one
 * number that matters under the survivor roster.
 */
export function scanPairs(
  frames: Frame[],
  slot: number,
  onPass?: (survivor: PlayerSample, ghost: PlayerSample, frame: Frame) => void,
): GateTally {
  const t: GateTally = { considered: 0, notLive: 0, notGhost: 0, inGrace: 0, tooClose: 0, occluded: 0, passed: 0 };
  // Zero, not frames[0].tMs: tMs is BY DEFINITION milliseconds since the replay
  // opened, and the replay opens at round start, so the round starts at zero.
  // The first SAMPLED frame is merely the first sample.
  const roundStartMs = 0;
  const ghostSlots = ghostSlotsOf(frames);
  if (ghostSlots.size === 0) return t;

  for (const f of frames) {
    const s = f.players.find((p) => p.slot === slot);
    for (const gs of ghostSlots) {
      const g = f.players.find((p) => p.slot === gs);
      if (!g) continue;
      t.considered++;
      // Short-circuited rather than left to pairGate so a dead survivor does
      // not pay for an occluder list nobody will look at.
      if (!s || !isLiveSurvivor(s)) { t.notLive++; continue; }
      const gate = pairGate({ survivor: s, ghost: g, others: visibleOthers(f, slot, gs), tMs: f.tMs, roundStartMs });
      if (gate === 'pass') { t.passed++; onPass?.(s, g, f); } else t[gate]++;
    }
  }
  return t;
}

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
