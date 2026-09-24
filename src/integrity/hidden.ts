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
