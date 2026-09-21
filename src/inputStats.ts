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
 * Signature v1. The only one shipped, because it is the only one that needs no
 * statistical tuning: a human issues one or two `+attack` presses per pounce and
 * someone holding the button through the air issues dozens. Separating 2 from 40
 * is arithmetic, not a threshold. Oryx-AC's equivalent (`highn`, 17+ scrolls per
 * jump) is its highest confidence check.
 *
 * The rate and variance signatures deliberately wait for real player
 * distributions; the only human sample in evidence is one person clicking for
 * fifteen seconds.
 */
export function pounceSpam(burst: { kind: string; airPresses: number }, threshold: number): boolean {
  return burst.kind === 'pounce' && burst.airPresses >= threshold;
}
