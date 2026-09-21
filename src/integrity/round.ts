import type { Frame } from '../replayFormat.js';
import { isLiveSurvivor } from './geometry.js';
import { pickClips, trackWindows, type GateTally, type TrackWindow } from './ghostTrack.js';
import { occupancyWithGates, type OccResult } from './occupancy.js';
import { PriorBuilder, type PriorTable } from './aimPrior.js';

/**
 * The round-level pass: every survivor, every metric, one round.
 *
 * Kept apart from the metric primitives because it sits at a different
 * abstraction level. `ghostTrack.ts` answers "what did this one crosshair do";
 * this answers "what does that mean next to the four other people in the
 * round", which is metric C.
 */

export interface RoundMetrics {
  fidMax: number;
  fidP95: number;
  occZ: number | null;
  /** 1 is the highest occupancy z on this side this round. Null without a prior. */
  teamRank: number | null;
  /** This player's z minus the mean of their teammates'. Null without a prior. */
  teamGap: number | null;
  /** Pairs that cleared every gate. Always `gates.passed`; kept as its own
   *  field because it is the one coverage number every consumer wants and
   *  because it predates the tally. It used to be read off the occupancy
   *  result, which made it 0 on every map under MIN_PRIOR_ROUNDS, which in the
   *  first backfill meant all 724 player-rounds. */
  eligiblePairs: number;
  /** Where the frames went. The diagnosable half of "no clips". */
  gates: GateTally;
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
  frames: Frame[], survivorSlots: number[], prior: PriorTable | null,
): { metrics: Map<number, RoundMetrics>; clips: Map<number, TrackWindow[]> } {
  const metrics = new Map<number, RoundMetrics>();
  const clips = new Map<number, TrackWindow[]>();
  const occ = new Map<number, OccResult | null>();

  for (const slot of survivorSlots) {
    const windows = trackWindows(frames, slot);
    clips.set(slot, pickClips(windows));
    const { occ: o, gates } = occupancyWithGates(frames, slot, prior);
    occ.set(slot, o);
    const fids = windows.map((w) => w.fidelity);
    metrics.set(slot, {
      fidMax: fids.length ? Math.max(...fids) : 0,
      fidP95: p95(fids),
      occZ: o?.z ?? null,
      teamRank: null,
      teamGap: null,
      eligiblePairs: gates.passed,
      gates,
    });
  }

  // Metric C. A second control on a different axis from the prior: the prior
  // removes what is normal for this MAP across all history, this removes what
  // was normal for this ROUND, including whatever the director happened to do.
  const scored = survivorSlots.filter((s) => occ.get(s) != null);
  if (scored.length > 1) {
    const byZ = [...scored].sort((a, b) => (occ.get(b)!.z) - (occ.get(a)!.z));
    for (const slot of scored) {
      const mine = occ.get(slot)!.z;
      const others = scored.filter((s) => s !== slot).map((s) => occ.get(s)!.z);
      const m = metrics.get(slot)!;
      m.teamRank = byZ.indexOf(slot) + 1;
      m.teamGap = mine - (others.reduce((a, b) => a + b, 0) / others.length);
    }
  }
  return { metrics, clips };
}
