/**
 * Input burst statistics, for macro detection.
 *
 * Design: docs/superpowers/specs/2026-09-21-input-macro-detection-design.md
 *
 * The plugin ships the raw ORDERED intervals of a burst and nothing derived,
 * because the checks that survive a cheater adding jitter are order dependent
 * (`sameAsNext`, `closeToNext`, after Oryx-AC's `wpatt2`). A summary or a
 * histogram would discard exactly the information that catches the careful
 * case, and it could never be recovered from storage afterwards.
 */

/** A burst closes after this many ticks of silence, so every interval inside
 *  one is 1..30 by construction. That is what makes the one-character-per-
 *  interval encoding total: there is no value it cannot represent. */
export const BURST_MAX_TICKS = 30;

/** Matches the plugin's per-burst cap. A longer list did not come from us. */
export const MAX_INTERVALS = 256;

/** Ticks per second the servers run at; intervals are stored in ticks. */
export const TICKRATE = 100;

/** Base 48, so the alphabet is '0'..'M': digits and letters only. Base 33 was
 *  the obvious choice and was wrong, because chr(34) is a double quote and
 *  chr(39) a single one, and this line travels on the same stream as quoted
 *  chat. It is harmless for admission (our marker is anchored at the start of
 *  the body) but there is no reason to put quote characters inside a log line
 *  when a different offset costs nothing. */
const ENC_BASE = 48; // chr(48) = '0' = 1 tick, chr(77) = 'M' = 30 ticks

export function encodeIntervals(ticks: readonly number[]): string {
  return ticks.map((t) => String.fromCharCode(ENC_BASE + t - 1)).join('');
}

/** Null for anything the plugin could not have produced: an out of range
 *  character, an empty string, or more intervals than the cap. Refusing rather
 *  than clamping keeps a forged or corrupt line out of the statistics instead
 *  of turning it into a plausible looking burst. */
export function decodeIntervals(s: string): number[] | null {
  if (s.length === 0 || s.length > MAX_INTERVALS) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const t = s.charCodeAt(i) - ENC_BASE + 1;
    if (t < 1 || t > BURST_MAX_TICKS) return null;
    out.push(t);
  }
  return out;
}

export interface BurstStats {
  n: number;
  meanTicks: number;
  sdTicks: number;
  /** Coefficient of variation. Catches a naive macro; a jittered one reaches a
   *  human's value, which is why this is never the only signal. */
  cv: number;
  minTicks: number;
  maxTicks: number;
  /** Presses per second sustained across the burst. The signal jitter cannot
   *  fix: a hand fatigues and drifts, a script does not. */
  ratePerSec: number;
  /** Intervals identical to the one after them. */
  sameAsNext: number;
  /** Intervals within one tick of the one after them. */
  closeToNext: number;
}

export function burstStats(ticks: readonly number[]): BurstStats {
  const n = ticks.length;
  if (n === 0) {
    return { n: 0, meanTicks: 0, sdTicks: 0, cv: 0, minTicks: 0, maxTicks: 0, ratePerSec: 0, sameAsNext: 0, closeToNext: 0 };
  }
  let sum = 0, lo = Infinity, hi = 0;
  for (const t of ticks) { sum += t; if (t < lo) lo = t; if (t > hi) hi = t; }
  const mean = sum / n;
  let sq = 0;
  for (const t of ticks) sq += (t - mean) * (t - mean);
  const sd = Math.sqrt(sq / n);
  let same = 0, close = 0;
  for (let i = 0; i + 1 < n; i++) {
    if (ticks[i] === ticks[i + 1]) same++;
    if (Math.abs(ticks[i] - ticks[i + 1]) <= 1) close++;
  }
  return {
    n,
    meanTicks: mean,
    sdTicks: sd,
    cv: mean > 0 ? sd / mean : 0,
    minTicks: lo,
    maxTicks: hi,
    ratePerSec: mean > 0 ? TICKRATE / mean : 0,
    sameAsNext: same,
    closeToNext: close,
  };
}

/**
 * Signature v1: a pounce whose attack presses come faster than a hand can mash.
 *
 * Measured against a live client 2026-09-21, hunter pounces:
 *
 *   you, normal pounce   3 presses over 2.03s   mean interval 15.5t  (6.5/s)
 *   you, MASHING M1      8 presses over 1.61s   mean interval 19.7t  (5.1/s)
 *   macro 13/s, short    7 presses over 0.57s   mean interval  7.7t (13.0/s)
 *   macro 13/s, short    9 presses over 0.69s   mean interval  7.8t (12.9/s)
 *   macro 13/s, long    49 presses over 3.81s   mean interval  7.7t (13.0/s)
 *
 * This was a COUNT threshold first (airPresses >= 12) and that was wrong. The
 * count is bounded by how long the pounce lasts, so a macro on a short pounce
 * registers 7 or 9 presses and slips under, while only a freak 3.8 second leap
 * trips it. The interval is flat at 7.7t across all three macro pounces
 * regardless of length, because it does not depend on airborne time at all.
 *
 * A hand mashing as fast as it can reached 5.1/s. That is the number the
 * threshold sits above, with the macro more than twice it on the other side.
 */
export function pounceSpam(
  burst: { kind: string; weapon: string; intervals: readonly number[] },
  maxMeanTicks: number,
  minIntervals = MIN_POUNCE_INTERVALS,
): boolean {
  if (burst.kind !== 'pounce' || !POUNCE_WEAPONS.has(burst.weapon)) return false;
  if (burst.intervals.length < minIntervals) return false;
  return burstStats(burst.intervals).meanTicks <= maxMeanTicks;
}

/** Fewer than this and the mean is one or two samples of noise. A real pounce
 *  that only trips on a handful of presses is not worth an admin's time. */
export const MIN_POUNCE_INTERVALS = 4;

/** The pounce anchor fires for ANYONE airborne, so a survivor shooting while
 *  falling produces a `pounce` burst too. Measured 2026-09-21: a survivor firing
 *  mid-jump logged a=3, and a fire macro while jumping reached a=8. The weapon
 *  is what separates a hunter from a survivor who jumped, which is why it is on
 *  the wire. */
export const POUNCE_WEAPONS = new Set(['weapon_hunter_claw']);
