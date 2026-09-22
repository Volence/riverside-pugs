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
export function decodeIntervals(s: string, maxLength = MAX_INTERVALS): number[] | null {
  if (s.length === 0 || s.length > maxLength) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const t = s.charCodeAt(i) - ENC_BASE + 1;
    if (t < 1 || t > BURST_MAX_TICKS) return null;
    out.push(t);
  }
  return out;
}

/** Holds are per PRESS and intervals are between presses, so a full burst has
 *  one more hold than it has intervals. Same alphabet, same 1..30 range: a hold
 *  of 30 means "30 or more", or a press still down when the burst was cut. */
export const MAX_HOLDS = MAX_INTERVALS + 1;

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

export interface HoldStats {
  n: number;
  medianTicks: number;
  minTicks: number;
  maxTicks: number;
  /** Spread. A scripted hold has almost none; a hand has a couple of ticks. */
  sdTicks: number;
  /** Share of presses that were down for a single usercmd. */
  oneTickFrac: number;
  /** Share within one tick of the median: how constant the hold is, without
   *  letting the last press of a burst (often simply kept down) decide it. */
  nearMedianFrac: number;
}

export function holdStats(holds: readonly number[] | null | undefined): HoldStats | null {
  if (!holds || holds.length === 0) return null;
  const sorted = [...holds].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  let sum = 0, one = 0, near = 0;
  for (const h of sorted) {
    sum += h;
    if (h === 1) one++;
    if (Math.abs(h - median) <= 1) near++;
  }
  const mean = sum / n;
  let sq = 0;
  for (const h of sorted) sq += (h - mean) * (h - mean);
  return {
    n, medianTicks: median, minTicks: sorted[0], maxTicks: sorted[n - 1],
    sdTicks: Math.sqrt(sq / n), oneTickFrac: one / n, nearMedianFrac: near / n,
  };
}

/**
 * What the holds look like. An ANNOTATION on evidence, never a detection and
 * never an input to one: it changes neither whether a signature fires nor its
 * severity.
 *
 *   wheel-like     nearly every press down for ONE usercmd. That is what a
 *                  mouse wheel bound to +attack or +jump produces, because a
 *                  wheel notch has no "held" state. A script that taps with no
 *                  hold time looks the same, so this says "not a finger on a
 *                  button", not "innocent": a free-spinning wheel decays and
 *                  wobbles in RATE where a script is flat, and that is for the
 *                  admin to read off the intervals. Whether a wheel bind is
 *                  legal at all is a league ruling (see the spec).
 *   fixed-hold     holds all within a tick of each other: an AutoHotkey-style
 *                  macro with a set hold time. One tick of slack is the same
 *                  aliasing that makes a flat 77 ms interval read 7,8,7,8.
 *   variable-hold  what a hand does: measured 5 to 12 ticks, never the same.
 *   no-hold-data   plugin 0.1.0 did not send holds, or there are too few.
 */
export type HoldAnnotation = 'wheel-like' | 'fixed-hold' | 'variable-hold' | 'no-hold-data';

export const MIN_HOLDS_TO_ANNOTATE = 4;

/** Whether a detection note says scroll wheel. Wheel binds are legal (owner's
 *  ruling, 2026-09-22): such a detection is kept on the file but is not
 *  evidence, and the admin channel is not told. Notes start with the hold
 *  annotation, so a suffix like ", plugin 0.1.0 capture" does not matter. */
export const isWheel = (note: string): boolean => note.startsWith('wheel-like');

export function holdAnnotation(holds: readonly number[] | null | undefined): HoldAnnotation {
  const h = holdStats(holds);
  if (!h || h.n < MIN_HOLDS_TO_ANNOTATE) return 'no-hold-data';
  if (h.oneTickFrac >= 0.8) return 'wheel-like';
  if (h.nearMedianFrac >= 0.9) return 'fixed-hold';
  return 'variable-hold';
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
  pistolMinRate: number;
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
 *
 * The pistol signature lands on the same number by a different road. It reads
 * three seconds rather than six intervals, so its mean is far steadier and
 * 11/s looked safe, but it takes the FASTEST three second window of every
 * pistol burst in a match, which is a great many draws. Simulated over 150
 * bursts a match: at 11/s a sustained 9/s hand is flagged in 23% of matches,
 * at 12/s in none, and the 13/s macro in every match either way.
 */
export const DEFAULT_THRESHOLDS: Thresholds = { pounceMinRate: 12, pistolMinRate: 12 };

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

/**
 * `pistol_rate`: primary-fire presses on a pistol, sustained at a rate a hand
 * cannot hold. This is the signature the measurements actually support: a hand
 * peaked at 8.0/s, both macros held 13/s for twelve unbroken seconds, and the
 * jittered one was FASTER, because jitter is symmetric. Hands fatigue; scripts
 * do not. It reads the MEAN rate over three seconds, never the variance, which
 * is why 25 ms of jitter (cv 0.32, a human number) does nothing to it.
 *
 * Presses are what is measured, not shots. Dual pistols fire more bullets per
 * second than one, but each bullet is still one press of the button, so a
 * second pistol changes nothing here and the weapon check does not care how
 * many are held (L4D1 reports `weapon_pistol` either way). The same goes for
 * whatever a fire-rate clamp lets through: OnPlayerRunCmdPre sees the presses.
 *
 * It looks for the fastest window of at least PISTOL_SUSTAIN_TICKS inside the
 * burst rather than averaging the whole burst, so a macro cannot hide by
 * clicking slowly for a few seconds before the burst closes. A burst shorter
 * than three seconds never qualifies, however fast: a hand can sprint.
 *
 * True here means this ONE burst qualifies; a detection takes PISTOL_REPEATS.
 */
export function pistolRate(
  burst: SignatureBurst,
  minRate: number,
  sustainTicks = PISTOL_SUSTAIN_TICKS,
): boolean {
  if (burst.kind !== 'fire' || !PISTOL_WEAPONS.has(burst.weapon)) return false;
  const iv = burst.intervals;
  // Two pointers: for each end j, the SHORTEST window ending there that still
  // spans sustainTicks. Any longer window ending at j only adds older, and so
  // by then already judged, intervals.
  let sum = 0, i = 0;
  for (let j = 0; j < iv.length; j++) {
    sum += iv[j];
    while (sum - iv[i] >= sustainTicks) { sum -= iv[i]; i++; }
    if (sum >= sustainTicks && atOrAboveRate(sum, j - i + 1, minRate)) return true;
  }
  return false;
}

/** Three seconds. At the 12/s threshold that is at least 36 presses. */
export const PISTOL_SUSTAIN_TICKS = 3 * TICKRATE;

/** Three seconds at 12/s is already far outside a hand, so two bursts are
 *  enough to call it a pattern rather than a capture glitch. */
export const PISTOL_REPEATS = 2;

export const PISTOL_WEAPONS = new Set(['weapon_pistol']);

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
  { name: 'pistol_rate', repeats: PISTOL_REPEATS, qualifies: (b, t) => pistolRate(b, t.pistolMinRate) },
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
