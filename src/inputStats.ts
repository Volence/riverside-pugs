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

/** What a signature reads. Storage and the wire both carry more. */
export interface SignatureBurst {
  kind: string;
  weapon: string;
  intervals: readonly number[];
}

/** Rates are presses per second, because that is the unit the measurements
 *  are in and the unit an admin can reason about. */
export interface Thresholds {
  pounceMinRate: number;
}

/**
 * Where the rate thresholds sit, and why.
 *
 * Measured on a real client: a hand clicking as fast as it can peaks near 8
 * presses/s (mean interval 125 ms, cv 0.39) and mashes M1 in the air at 5.1/s.
 * A macro held 13/s for twelve seconds, and 25 ms of jitter did not slow it.
 *
 * 12/s is 50% above the measured human peak and still under the macro. The
 * first threshold was 12 TICKS, which is 8.3/s, which is the human peak: in
 * simulation (tests/inputSignatureSim.test.ts) it flagged a legit 8/s clicker
 * on 45% of airborne phases. At 12/s, six intervals and four repeats the same
 * clicker is flagged in 0 of 2000 matches, a 9/s hand in under 1%, and the 13/s
 * macro in every match, jittered or not. 11/s was tried and rejected: over six
 * intervals the mean is too noisy, and the 9/s hand climbed past 30%.
 */
export const DEFAULT_THRESHOLDS: Thresholds = { pounceMinRate: 12 };

/** A threshold below this is inside human reach and would turn a signature
 *  back into a false positive machine, so settings cannot go under it. */
export const MIN_RATE_FLOOR = 10;
export const MAX_RATE_CEILING = 30;

/** Whether intervals summing to `sumTicks` over `n` gaps are at or above
 *  `rate` presses/s. Integer arithmetic, so the boundary is exact: 12/s is a
 *  mean of 8.33 ticks and no float decides which side 50/6 falls on. */
export function atOrAboveRate(sumTicks: number, n: number, rate: number): boolean {
  return n > 0 && sumTicks * rate <= TICKRATE * n;
}

/**
 * `pounce_spam`: attack presses during one airborne phase, on the hunter claw,
 * arriving faster than a hand can mash.
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
 * True here means this ONE phase qualifies. It is not a detection: that takes
 * POUNCE_REPEATS qualifying phases in one match, see matchDetections.
 */
export function pounceSpam(
  burst: SignatureBurst,
  minRate: number,
  minIntervals = MIN_POUNCE_INTERVALS,
): boolean {
  if (burst.kind !== 'pounce' || !POUNCE_WEAPONS.has(burst.weapon)) return false;
  if (burst.intervals.length < minIntervals) return false;
  let sum = 0;
  for (const t of burst.intervals) sum += t;
  return atOrAboveRate(sum, burst.intervals.length, minRate);
}

/** Fewer than this and the mean is a handful of samples of noise. Six is the
 *  shortest macro pounce that was measured (7 presses over 0.57 s), so the
 *  short pounce that killed the count threshold still qualifies. */
export const MIN_POUNCE_INTERVALS = 6;

/** Qualifying airborne phases, in one match, before there is a detection.
 *  A macro is on for every pounce, so it clears this within a spawn or two. A
 *  hand that got lucky on six intervals once does not. */
export const POUNCE_REPEATS = 4;

/** The pounce anchor fires for ANYONE airborne, so a survivor shooting while
 *  falling produces a `pounce` burst too. Measured 2026-09-21: a survivor firing
 *  mid-jump logged a=3, and a fire macro while jumping reached a=8. The weapon
 *  is what separates a hunter from a survivor who jumped, which is why it is on
 *  the wire. */
export const POUNCE_WEAPONS = new Set(['weapon_hunter_claw']);

export interface Signature {
  name: string;
  /** Qualifying bursts, in one match, before a detection exists. */
  repeats: number;
  qualifies(burst: SignatureBurst, t: Thresholds): boolean;
}

/** Every shipped signature. scripts/rerun-input-signatures.ts and the live path
 *  both run exactly this list, so a signature added here reaches history too. */
export const SIGNATURES: readonly Signature[] = [
  { name: 'pounce_spam', repeats: POUNCE_REPEATS, qualifies: (b, t) => pounceSpam(b, t.pounceMinRate) },
];

export interface MatchDetection {
  signature: string;
  /** Indexes into the bursts passed in, in order, of every one that qualified. */
  qualifying: number[];
}

/**
 * Signatures that reached their repeat count over ONE player's bursts in ONE
 * match. Pure, so the live path, the re-run tool and the calibration
 * simulation cannot disagree about what a detection is.
 */
export function matchDetections(bursts: readonly SignatureBurst[], t: Thresholds): MatchDetection[] {
  const out: MatchDetection[] = [];
  for (const sig of SIGNATURES) {
    const qualifying: number[] = [];
    bursts.forEach((b, i) => { if (sig.qualifies(b, t)) qualifying.push(i); });
    if (qualifying.length >= sig.repeats) out.push({ signature: sig.name, qualifying });
  }
  return out;
}
