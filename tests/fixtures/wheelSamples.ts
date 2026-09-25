/**
 * Real pistol bursts from prod, 2026-09-22, in the stored base-48 encoding
 * ('0' = 1 tick). Kept as captured so the steady-taps rule is pinned to what
 * a wheel and a fixed-rate tapper actually send, not to numbers made up here.
 */
const decode = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) - 47);

/** Icy Inferno, a known scroll-wheel player: burst 31120, match 124, first 100 gaps. */
export const ICY_WHEEL = decode(
  '0<3074519332037719E2825033115206034034224:9142348351816811311241249162031321330204242270725250833154142024712591716117161833',
);

/** Bellingham, flagged wheel-like: burst 29824, match 122. */
export const BELLINGHAM_TAPS = decode(
  '456555655656555655655556565556565556555664656556555655565565565',
);

/** A burst as stored: ordered intervals and one hold per press, both decoded. */
export interface StoredSample { intervals: number[]; holds: number[] }
const stored = (intervals: string, holds: string): StoredSample => ({ intervals: decode(intervals), holds: decode(holds) });

/**
 * Icy Inferno, match 190 (2026-09-24), spinning the wheel quickly up and down
 * (owner's ground truth). Fast notches merge into 2 to 5 tick holds and the
 * gaps are irregular 2 and 3 tick runs with resets, cv about 0.6, so only
 * about half the holds are one tick. The old 80% rule called these
 * variable-hold and put a legal wheel on Needs a look.
 */
export const ICY_FAST_PISTOL: StoredSample[] = [
  stored( // burst 134608, 74 gaps, 24.3/s
    '22538118117123121182571611424172411671534521241717114122214181727171241142',
    '010200000000100100310201000100110000100203001001010000000000101100100000011',
  ),
  stored( // burst 134831, 71 gaps, 22.8/s
    '11151884316161711234252523252416242416177252426259231725314212126:11353',
    '000001420020101000201010101110011000010221010101031001100001000101000400',
  ),
];
export const ICY_FAST_POUNCES: StoredSample[] = [
  stored('182216:5221111', '020100400100000'), // burst 133721
  stored('1125615', '00004030'), // burst 134295
  stored('211;13431', '1000020100'), // burst 135107
  stored('1112:112:221::=2532', '00000001311006604011'), // burst 135157
];

/**
 * caramellow, pounce bursts from matches 153 to 171: one-tick holds at a flat
 * 6 ticks (17/s), except where the device skips a beat and a gap reads 11 to
 * 13, twice the median. The old steady check counted each skip as off-beat,
 * found one of these four steady and called the detection wheel-like.
 */
export const CARAMELLOW_SKIPS: StoredSample[] = [
  stored('M545555455<55', '00000000000000'), // burst 80148, match 153
  stored('55;595<455', '00000000000'), // burst 102140, match 169
  stored('<4:4;5<4554555:5=485545554;5;58595;5', '0000000000000000000000000000000000000'), // burst 103072, match 170
  stored('5:55545', '00000000'), // burst 104639, match 171
];

/** mira, burst 117103, match 180: 21 gaps of 6 and 7 ticks, every hold one
 *  tick. The flat rate is what a script that taps without holding looks like. */
export const MIRA_180: StoredSample = stored('555565555556555556555', '0000000000000000000000');
