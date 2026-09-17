import type { Frame } from '../replayFormat.js';
import { TUNING } from './constants.js';
import { aimError } from './geometry.js';
import { scanPairs, type GateTally } from './ghostTrack.js';
import { cellKey, cellOf, priorAt, type PriorTable } from './aimPrior.js';

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
 *
 * This is the only metric that needs the aim prior, which is why it lives apart
 * from the metric A primitives in `ghostTrack.ts`.
 */
export function occupancy(frames: Frame[], slot: number, prior: PriorTable | null): OccResult | null {
  return occupancyWithGates(frames, slot, prior).occ;
}

/**
 * Occupancy plus the gate breakdown from the same single pass.
 *
 * One scan, one answer. The round pass needs both numbers and the scan is the
 * expensive part of the analyzer, so splitting them into two entry points that
 * each walk the frames would double the backfill for nothing, and two
 * implementations of the same gating is how the two quietly drift apart.
 *
 * The tally is produced whether or not a prior exists, which is the point: a
 * map under MIN_PRIOR_ROUNDS still gets a truthful coverage count even though
 * it gets no z-score.
 */
export function occupancyWithGates(
  frames: Frame[], slot: number, prior: PriorTable | null,
): { occ: OccResult | null; gates: GateTally } {
  let observed = 0, expected = 0, variance = 0;

  const gates = scanPairs(frames, slot, (s, g) => {
    if (!prior) return;
    const c = cellOf(g.x, g.y);
    const p = priorAt(prior, cellKey(c.cx, c.cy));
    expected += p;
    variance += p * (1 - p);
    if (Math.abs(aimError(s.yaw, s, g)) <= TUNING.E_DWELL) observed++;
  });

  // Null, never zero. No prior means the map has too little history to say
  // anything, and a thin prior is worse than no score at all. Zero variance
  // means the prior asserts certainty about every cell the ghost was in, and
  // dividing by that would manufacture a number out of nothing.
  if (!prior || prior.frames <= 0 || gates.passed === 0 || variance <= 1e-9) return { occ: null, gates };
  return {
    occ: { z: (observed - expected) / Math.sqrt(variance), observed, expected, pairs: gates.passed },
    gates,
  };
}
