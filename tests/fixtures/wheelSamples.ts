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
