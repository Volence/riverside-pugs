import type { Frame } from '../replayFormat.js';
import { TUNING } from './constants.js';
import { bearing, dist2d, isGhost, isLiveSurvivor, wrapDeg } from './geometry.js';
import { scanPairs } from './ghostTrack.js';

/**
 * A known positive, manufactured.
 *
 * CLIP_MIN was chosen before the analyzer had ever seen anybody track a ghost,
 * and real history cannot supply one on demand. This rewrites one survivor's
 * view in a real round so that they DO track a chosen ghost, as well or as
 * badly as asked, and leaves everything else exactly as it was played: their
 * movement, the ghost's path, the commons and teammates the occlusion guard
 * vetoes on. So what comes out is what the analyzer would say about a player
 * of that quality in that round, gates and all.
 *
 * Pure: frames in, frames out. `scripts/inject-synthetic-tracker.ts` is the
 * part that touches files.
 */
export interface TrackerOpts {
  /** The view points at where the ghost was this long ago. Reaction lag: a
   *  person following a moving thing is always a little behind it. */
  lagMs: number;
  /** RMS of the aim error added to the yaw, degrees. */
  noiseDeg: number;
  /** How long that error takes to change, as the time constant of a first
   *  order autoregressive process. 0 is white noise, a fresh draw every frame,
   *  which no hand produces: a hand drifts off target and comes back over
   *  a few hundred milliseconds. The metric works on frame to frame CHANGES,
   *  so the same RMS costs far more fidelity white than slow. */
  noiseTauMs: number;
  seed: number;
}

/** Seeded, so a calibration run can be repeated and argued about. */
function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 1) / 4294967297; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** Where the ghost was at `tMs`, interpolated between the frames either side,
 *  or null when it was not a ghost at both of them. */
function ghostAt(frames: Frame[], i: number, ghostSlot: number, tMs: number): { x: number; y: number; z: number } | null {
  let k = i;
  while (k > 0 && frames[k].tMs > tMs) k--;
  const a = frames[k].players[ghostSlot], b = frames[Math.min(k + 1, i)].players[ghostSlot];
  if (!a || !b || !isGhost(a) || !isGhost(b)) return null;
  const span = frames[Math.min(k + 1, i)].tMs - frames[k].tMs;
  const w = span > 0 ? Math.min(1, Math.max(0, (tMs - frames[k].tMs) / span)) : 0;
  return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w, z: a.z + (b.z - a.z) * w };
}

/**
 * The same round with `slot` looking at `ghostSlot` for as long as it is a
 * ghost and they are a live survivor. Only that survivor's yaw and pitch
 * change, and only in those frames.
 */
export function injectTracker(frames: Frame[], slot: number, ghostSlot: number, opts: TrackerOpts): Frame[] {
  const rand = gaussian(opts.seed);
  let noise = opts.noiseDeg * rand();
  return frames.map((f, i) => {
    const s = f.players[slot], g = f.players[ghostSlot];
    if (i > 0) {
      const a = opts.noiseTauMs > 0 ? Math.exp(-(f.tMs - frames[i - 1].tMs) / opts.noiseTauMs) : 0;
      noise = a * noise + Math.sqrt(1 - a * a) * opts.noiseDeg * rand();
    }
    if (!s || !g || !isLiveSurvivor(s) || !isGhost(g)) return f;
    const seen = ghostAt(frames, i, ghostSlot, f.tMs - opts.lagMs) ?? g;
    const rise = (seen.z + TUNING.TARGET_Z) - (s.z + TUNING.EYE_Z);
    const players = f.players.map((p) => (p.slot !== slot ? p : {
      ...p,
      // Stored as hundredths of a degree and as whole degrees, so rounded the
      // way the file would round them.
      yaw: Math.round(wrapDeg(bearing(s, seen) + noise) * 100) / 100,
      pitch: Math.round(-Math.atan2(rise, dist2d(s, seen)) * 180 / Math.PI),
    }));
    return { ...f, players };
  });
}

/** The survivor and ghost with the most eligible frames between them: the pair
 *  an injection has the most room to show up in. Null when no pair ever
 *  cleared the gates, which is a round the detector could not have run in. */
export function busiestPair(frames: Frame[], survivorSlots: number[]): { slot: number; ghostSlot: number; pairs: number } | null {
  let best: { slot: number; ghostSlot: number; pairs: number } | null = null;
  for (const slot of survivorSlots) {
    const n = new Map<number, number>();
    scanPairs(frames, slot, (_s, g) => n.set(g.slot, (n.get(g.slot) ?? 0) + 1));
    for (const [ghostSlot, pairs] of n) if (!best || pairs > best.pairs) best = { slot, ghostSlot, pairs };
  }
  return best;
}
