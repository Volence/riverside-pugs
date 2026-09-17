import type { Frame } from '../replayFormat.js';
import { TUNING } from './constants.js';
import {
  aimError, bearing, dist2d, isGhost, isLiveSurvivor, pairEligible, wrapDeg, type Pt,
} from './geometry.js';
import { PriorBuilder, cellKey, cellOf, priorAt, type PriorTable } from './aimPrior.js';

/**
 * Metric A, the backbone: did the crosshair MOVE with an invisible target.
 *
 * Proximity alone is not evidence, because the good spawn spots are known and
 * people pre-aim them. A held angle produces none of the motion needed to
 * follow a moving target, so it scores zero however well chosen the spot was.
 * Producing that motion, against something you cannot see, is what has no
 * innocent explanation, and the more the ghost moves the harder it is to do by
 * accident.
 */

/**
 * How much of the motion needed to follow the target the crosshair actually
 * produced. 1 is exact, 0 is none of it.
 *
 * This replaces the Pearson correlation the design spec first called for.
 * Pearson has a degenerate case that fails at precisely the wrong moment: a
 * ghost moving at a constant angular rate, tracked perfectly, gives two
 * CONSTANT delta series, neither of which has any variance, so the correlation
 * is undefined and the most blatant possible cheat scores zero. Pearson is also
 * scale invariant, so half the required motion, perfectly proportioned, would
 * score a perfect 1. A normalised residual has neither problem.
 */
export function trackFidelity(dYaw: number[], dBearing: number[]): number {
  const n = Math.min(dYaw.length, dBearing.length);
  if (n < 1) return 0;
  let residual = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const d = dYaw[i] - dBearing[i];
    residual += d * d;
    total += dBearing[i] * dBearing[i];
  }
  // The target never moved, so following it required nothing and holding still
  // proves nothing. No evidence, not perfect evidence.
  if (total <= 1e-9) return 0;
  // Clamped: moving opposite to the target is not worse than useless evidence,
  // it is simply no evidence of tracking.
  return Math.max(0, 1 - Math.sqrt(residual / total));
}

export interface TrackWindow {
  startMs: number;
  endMs: number;
  ghostSlot: number;
  fidelity: number;
  meanErr: number;
  meanDist: number;
}

/** Positions of everything that is not this ghost and not the survivor: what
 *  the occlusion guard checks against. */
function visibleOthers(f: Frame, survivorSlot: number, ghostSlot: number): Pt[] {
  const out: Pt[] = [];
  for (const p of f.players) {
    if (p.slot === survivorSlot || p.slot === ghostSlot) continue;
    if (isGhost(p)) continue;
    if ((p.state & 1) === 0) continue; // not present
    out.push({ x: p.x, y: p.y });
  }
  for (const e of f.entities) out.push({ x: e.x, y: e.y });
  return out;
}

/** Every window in which this survivor held aim on one ghost for W frames,
 *  with how much of the motion needed to follow it they actually produced. */
export function trackWindows(frames: Frame[], slot: number): TrackWindow[] {
  if (frames.length === 0) return [];
  const roundStartMs = 0;
  const out: TrackWindow[] = [];

  const ghostSlots = new Set<number>();
  for (const f of frames) for (const p of f.players) if (isGhost(p)) ghostSlots.add(p.slot);

  for (const gs of ghostSlots) {
    // A run is consecutive frames where this pair is eligible AND on target.
    // Windows never straddle a break, because a break means the pair stopped
    // being comparable, not that nothing happened.
    let run: { tMs: number; yaw: number; bear: number; err: number; dist: number }[] = [];

    const flush = () => {
      for (let i = 0; i + TUNING.W <= run.length; i++) {
        const w = run.slice(i, i + TUNING.W);
        const dy: number[] = [], db: number[] = [];
        for (let k = 1; k < w.length; k++) {
          dy.push(wrapDeg(w[k].yaw - w[k - 1].yaw));
          db.push(wrapDeg(w[k].bear - w[k - 1].bear));
        }
        out.push({
          startMs: w[0].tMs,
          endMs: w[w.length - 1].tMs,
          ghostSlot: gs,
          fidelity: trackFidelity(dy, db),
          meanErr: w.reduce((s, x) => s + Math.abs(x.err), 0) / w.length,
          meanDist: w.reduce((s, x) => s + x.dist, 0) / w.length,
        });
      }
      run = [];
    };

    for (const f of frames) {
      const s = f.players.find((p) => p.slot === slot);
      const g = f.players.find((p) => p.slot === gs);
      if (!s || !g || !isLiveSurvivor(s) || !isGhost(g)) { flush(); continue; }
      if (!pairEligible({ survivor: s, ghost: g, others: visibleOthers(f, slot, gs), tMs: f.tMs, roundStartMs })) {
        flush(); continue;
      }
      const err = aimError(s.yaw, s, g);
      if (Math.abs(err) > TUNING.E_TRACK) { flush(); continue; }
      run.push({ tMs: f.tMs, yaw: s.yaw, bear: bearing(s, g), err, dist: dist2d(s, g) });
    }
    flush();
  }
  return out;
}

/** The reviewable moments: strongest first, never overlapping, capped. A
 *  reviewer's time is the scarce resource, so five separate moments beat fifty
 *  slices of the same one. */
export function pickClips(windows: TrackWindow[]): TrackWindow[] {
  const kept: TrackWindow[] = [];
  for (const w of [...windows].filter((x) => x.fidelity >= TUNING.CLIP_MIN).sort((a, b) => b.fidelity - a.fidelity)) {
    if (kept.length >= TUNING.CLIPS_PER_ROUND) break;
    if (kept.some((k) => w.startMs <= k.endMs && k.startMs <= w.endMs)) continue;
    kept.push(w);
  }
  return kept;
}

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
  if (pairs === 0) return null;
  // When variance is 0 (all p=1), return z=0. Otherwise compute z-score, clamping
  // variance to avoid division by zero on degenerate priors.
  if (variance <= 0) return { z: 0, observed, expected, pairs };
  return { z: (observed - expected) / Math.sqrt(variance), observed, expected, pairs };
}

export interface RoundMetrics {
  fidMax: number;
  fidP95: number;
  occZ: number | null;
  /** 1 is the highest occupancy z on this side this round. Null without a prior. */
  teamRank: number | null;
  /** This player's z minus the mean of their teammates'. Null without a prior. */
  teamGap: number | null;
  eligiblePairs: number;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/**
 * One round, every survivor.
 *
 * Also returns the round's own contribution to the aim prior, which the caller
 * subtracts before scoring so nobody is measured against a baseline they helped
 * build. See `subtractRound`.
 */
export function analyzeRound(
  frames: Frame[], survivorSlots: number[], prior: PriorTable | null,
): { metrics: Map<number, RoundMetrics>; clips: Map<number, TrackWindow[]>; roundPrior: PriorBuilder } {
  const metrics = new Map<number, RoundMetrics>();
  const clips = new Map<number, TrackWindow[]>();
  const occ = new Map<number, OccResult | null>();
  const roundPrior = new PriorBuilder();

  for (const f of frames) {
    for (const s of f.players) {
      if (survivorSlots.includes(s.slot) && isLiveSurvivor(s)) roundPrior.addSurvivorFrame(s, s.yaw);
    }
  }

  for (const slot of survivorSlots) {
    const windows = trackWindows(frames, slot);
    clips.set(slot, pickClips(windows));
    occ.set(slot, occupancy(frames, slot, prior));
    const fids = windows.map((w) => w.fidelity);
    metrics.set(slot, {
      fidMax: fids.length ? Math.max(...fids) : 0,
      fidP95: p95(fids),
      occZ: occ.get(slot)?.z ?? null,
      teamRank: null,
      teamGap: null,
      eligiblePairs: occ.get(slot)?.pairs ?? 0,
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
  return { metrics, clips, roundPrior };
}
