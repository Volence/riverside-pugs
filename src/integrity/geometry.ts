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

/** Signed degrees from the yaw to the target bearing. Positive means the target
 *  is counterclockwise of the current yaw, or equivalently the degrees to add to
 *  yaw to face the target. Note: the design spec states the opposite sign; this
 *  implementation is the corrected convention. All metrics use its magnitude only. */
export function aimError(yaw: number, from: Pt, to: Pt): number {
  return wrapDeg(bearing(from, to) - yaw);
}

export type Pt3 = Pt & { z: number };

/** Degrees between the survivor's pitch and the pitch that would put the
 *  crosshair on the target. Positive means they are looking too low.
 *
 *  Source pitch is NEGATIVE UP, which is easy to get backwards and was checked
 *  against real replays rather than trusted: see EYE_Z. */
export function pitchError(from: Pt3 & { pitch: number }, to: Pt3): number {
  const rise = (to.z + TUNING.TARGET_Z) - (from.z + TUNING.EYE_Z);
  const wanted = -Math.atan2(rise, dist2d(from, to)) * 180 / Math.PI;
  return from.pitch - wanted;
}

/** Whether the view is on the target: yaw inside `yawTol`, and pitch inside
 *  PITCH_TOL. Yaw is the measurement. Pitch only answers "is that even the
 *  floor they are looking at", which is all its accuracy supports. */
export function onTarget(from: Pt3 & { yaw: number; pitch: number }, to: Pt3, yawTol: number): boolean {
  return Math.abs(aimError(from.yaw, from, to)) <= yawTol && Math.abs(pitchError(from, to)) <= TUNING.PITCH_TOL;
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

/** Why a pair did or did not contribute. `pass` is the only value that counts.
 *
 *  Named rather than boolean because "zero windows" and "zero eligible frames"
 *  are indistinguishable without it, and the first backfill produced exactly
 *  that ambiguity: no clips, and no way to tell whether the detector had a
 *  thousand clean chances or never ran at all. */
export type PairGate = 'notLive' | 'notGhost' | 'inGrace' | 'tooClose' | 'occluded' | 'pass';

/** Which gate a pair fell at, in evaluation order.
 *  Each clause is here because it generates false positives, not for tidiness. */
export function pairGate(a: PairArgs): PairGate {
  if (!isLiveSurvivor(a.survivor)) return 'notLive';
  if (!isGhost(a.ghost)) return 'notGhost';
  if (a.tMs - a.roundStartMs < TUNING.SPAWN_GRACE_MS) return 'inGrace';
  if (dist2d(a.survivor, a.ghost) <= TUNING.D_MIN) return 'tooClose';
  const toGhost = bearing(a.survivor, a.ghost);
  for (const o of a.others) {
    // Bounded by OCCLUDE_MAX_DIST, and deliberately NOT filtered by kind. See
    // that constant for the reasoning on both halves of this decision.
    if (dist2d(a.survivor, o) > TUNING.OCCLUDE_MAX_DIST) continue;
    if (Math.abs(wrapDeg(bearing(a.survivor, o) - toGhost)) < TUNING.OCCLUDE_WINDOW) return 'occluded';
  }
  return 'pass';
}

/** Whether one survivor and one ghost in one frame may contribute at all. */
export function pairEligible(a: PairArgs): boolean {
  return pairGate(a) === 'pass';
}
