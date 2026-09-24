import { type Frame, type PlayerSample } from '../replayFormat.js';
import { cellKey, cellOf, priorAt, type PriorTable } from './aimPrior.js';
import { TUNING } from './constants.js';
import { dist2d, isLiveSurvivor, occludedBy, onTarget } from './geometry.js';
import { trackWindowsFor, visibleOthers, type TrackWindow } from './ghostTrack.js';
import { occFromBlocks, type OccResult } from './occupancy.js';
import { isSpawnedTarget, TRACKED_CLASSES, classOf, type InfectedClass, type LosView } from './los.js';

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
  // Things the survivor could plausibly have been aiming at instead. As in
  // the ghost path (see OCCLUDE_MAX_DIST), bounded and not filtered by kind,
  // with one addition line of sight makes possible: another infected this
  // survivor could NOT see explains nothing about where they aimed, so it
  // never vetoes.
  const others = visibleOthers(f, s.slot, t.slot, (p) => los.sees(f, s.slot, p.slot) !== false);
  if (occludedBy(s, t, others)) return 'occluded';
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
