import type { Frame } from '../replayFormat.js';
import { TUNING } from './constants.js';
import { aimError, isGhost, isLiveSurvivor, pairEligible } from './geometry.js';
import { visibleOthers } from './ghostTrack.js';
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
