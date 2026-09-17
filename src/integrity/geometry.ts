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
  return wrapDeg(bearing(from, to) - yaw);
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
