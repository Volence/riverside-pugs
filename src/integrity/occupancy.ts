import type { Frame } from '../replayFormat.js';
import { TUNING } from './constants.js';
import { dist2d, onTarget } from './geometry.js';
import { scanPairs, type GateTally } from './ghostTrack.js';
import { cellKey, cellOf, priorAt, type PriorTable } from './aimPrior.js';

/**
 * One player-round's occupancy, as SUMS rather than as a score.
 *
 * Every field but `pairs` is a sum over blocks (see OCC_BLOCK_MS). The score
 * is worked out from these at read time, in `score.ts`, because it needs a
 * calibration that only the whole board can supply, and because a stored score
 * would go stale the moment that calibration moved.
 */
export interface OccResult {
  /** Sum over blocks of the fraction of the block spent on the ghost. */
  observed: number;
  /** Sum over blocks of the block's mean prior. */
  expected: number;
  /** Sum over blocks of the square of that, which is what the binomial
   *  variance needs and cannot be recovered from `expected`. */
  expectedSq: number;
  blocks: number;
  /** Pair-frames that went into the blocks. */
  pairs: number;
}

/**
 * Metric B: how much more often this player was on a ghost than the map's own
 * looking habits predict.
 *
 * `expected` is what map knowledge alone accounts for, summed from the prior.
 * `observed` is what they actually did. Only the excess counts, so a player
 * whose whole edge is knowing where SI spawn scores zero by construction: the
 * prior already contains that knowledge. Rare cells carry most of the signal
 * because their prior is low, which is the behaviour we want without a second
 * mechanism for it.
 *
 * COUNTED IN BLOCKS, NOT FRAMES. Version 3 took every 10 Hz frame as an
 * independent draw and called the result a z-score. A crosshair and a ghost
 * both stay where they are for seconds at a time, so a four second stare was
 * forty pieces of evidence and the real values ran from -9.6 to 62.8. A block
 * is one ghost over one OCC_BLOCK_MS stretch of the round; inside it the
 * frames are treated as ONE draw, observed as the fraction of them on target
 * and expected as their mean prior. That is conservative within a block,
 * which is the side to err on.
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
 * it gets no occupancy.
 */
export function occupancyWithGates(
  frames: Frame[], slot: number, prior: PriorTable | null,
): { occ: OccResult | null; gates: GateTally } {
  const blocks = new Map<string, { n: number; on: number; p: number }>();
  let pairs = 0;

  const gates = scanPairs(frames, slot, (s, g, f) => {
    if (!prior) return;
    // The prior's wedge stops at R_MAX, so by its own definition nobody is
    // ever looking at a cell further off than that. An observation it had no
    // way to predict does not belong in a comparison against it, and neither
    // does the expectation. The bound is this metric's alone: the pair is
    // still eligible and still counts as coverage.
    if (dist2d(s, g) > TUNING.R_MAX) return;
    const c = cellOf(g.x, g.y);
    const key = `${g.slot}:${Math.floor(f.tMs / TUNING.OCC_BLOCK_MS)}`;
    const b = blocks.get(key) ?? { n: 0, on: 0, p: 0 };
    b.n++;
    b.p += priorAt(prior, cellKey(c.cx, c.cy));
    // Pitch counts here and not in the prior, which has no target to take an
    // elevation to. That can only lower `observed` against `expected`, so the
    // asymmetry costs sensitivity and cannot flag anyone.
    if (onTarget(s, g, TUNING.E_DWELL)) b.on++;
    blocks.set(key, b);
    pairs++;
  });

  // Null, never zero. No prior means the map has too little history to say
  // anything, and a thin prior is worse than no score at all.
  if (!prior || prior.frames <= 0 || blocks.size === 0) return { occ: null, gates };
  let observed = 0, expected = 0, expectedSq = 0;
  for (const b of blocks.values()) {
    const p = b.p / b.n;
    observed += b.on / b.n;
    expected += p;
    expectedSq += p * p;
  }
  return { occ: { observed, expected, expectedSq, blocks: blocks.size, pairs }, gates };
}
