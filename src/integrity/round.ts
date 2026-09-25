import type { Frame } from '../replayFormat.js';
import { TUNING } from './constants.js';
import { isLiveSurvivor } from './geometry.js';
import { pickClips, trackWindows, type GateTally, type TrackWindow } from './ghostTrack.js';
import { occupancyWithGates, type OccResult } from './occupancy.js';
import { PriorBuilder, type PriorTable } from './aimPrior.js';
import { hiddenMetrics, type HiddenMetrics } from './hidden.js';
import { NO_LOS, type LosView } from './los.js';

/**
 * The round-level pass: every survivor, every metric, one round.
 *
 * Kept apart from the metric primitives because it sits at a different
 * abstraction level. `ghostTrack.ts` answers "what did this one crosshair do";
 * this runs it for everyone in the round. What a player's numbers mean next to
 * their teammates', which is metric C, is a read-time question: see `score.ts`.
 */

export interface RoundMetrics {
  fidMax: number;
  fidP95: number;
  /** Fidelity windows that formed, how many of them held enough motion to be
   *  scored (MIN_TRAVEL), and the sum of those scores. The board divides the
   *  last by the second, pooled over a player's rounds, so tracking is a rate
   *  over chances rather than a maximum over playtime. */
  windows: number;
  scoreable: number;
  fidSum: number;
  /** Metric B as sums, null without a prior. The score, and the team gap that
   *  is metric C, are worked out from these at read time in `score.ts`: both
   *  need a calibration only the whole board can supply. */
  occ: OccResult | null;
  /** Pairs that cleared every gate. Always `gates.passed`; kept as its own
   *  field because it is the one coverage number every consumer wants and
   *  because it predates the tally. It used to be read off the occupancy
   *  result, which made it 0 on every map under MIN_PRIOR_ROUNDS, which in the
   *  first backfill meant all 724 player-rounds. */
  eligiblePairs: number;
  /** Where the frames went. The diagnosable half of "no clips". */
  gates: GateTally;
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
}

/**
 * The frames in which time actually passed.
 *
 * An engine pause keeps the frame writer running with the clock stopped: 11 of
 * the 189 replays in hand on 2026-09-21 hold a run of frames with tMs frozen,
 * 5865 frames in all and the longest 1197, byte-identical in all but 22. Each
 * copy used to count as a fresh look in the aim prior and as a fresh
 * observation in metric B, which is how one 385 frame pause gave match 37 an
 * occupancy of 62.8.
 *
 * A frame is kept only when its tMs is greater than the last KEPT frame's, so a
 * clock that steps backwards is dropped along with one that stands still. No
 * replay in hand has a backwards step; the rule covers it because the cost of
 * being wrong is a delta taken across negative time.
 */
export function unpausedFrames(frames: Frame[]): Frame[] {
  const out: Frame[] = [];
  let last = -Infinity;
  for (const f of frames) {
    if (f.tMs <= last) continue;
    out.push(f);
    last = f.tMs;
  }
  return out;
}

/**
 * One round's contribution to its map's aim prior.
 *
 * The single producer of this number, on purpose. The backfill's pooling pass
 * and the scoring pass both need it, and they must agree exactly: the pool is
 * the sum of these, and `subtractRound` takes one back out before a player is
 * scored. If the two ever disagreed, `subtractRound` would clamp the mismatch
 * to zero, the pool and the subtraction would quietly diverge, every occupancy
 * z-score would shift, and nothing would fail.
 */
export function buildRoundPrior(frames: Frame[], survivorSlots: number[]): PriorBuilder {
  const out = new PriorBuilder();
  for (const f of frames) {
    for (const s of f.players) {
      if (survivorSlots.includes(s.slot) && isLiveSurvivor(s)) out.addSurvivorFrame(s, s.yaw);
    }
  }
  return out;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/**
 * One round, every survivor.
 *
 * `prior` is the map's pool with this round already taken out, so nobody is
 * measured against a baseline they helped build. Taking it out is the caller's
 * job (`analyzeOneRound`), because only the caller knows whether the pool ever
 * contained this round.
 */
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
    // Clips come from the same scoreable windows as fidSum/scoreable above,
    // not every hidden window: a window under MIN_TRAVEL never contributed to
    // the score, so it should never become a clip either, however high its
    // lagFidelity.
    const hiddenScoreable = hidden.windows.filter((w) => w.travel >= TUNING.MIN_TRAVEL);
    hiddenClips.set(slot, pickClips(hiddenScoreable, (w) => w.lagFidelity));
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
