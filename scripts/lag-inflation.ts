/**
 * How much the lag search lifts HONEST scores.
 *
 * Searching five lags gives a chance match five tries, so every player's
 * windows score a little higher than at lag 0. That lift is harmless only if
 * it is small next to the lift it gives a real tracker, which is what the
 * synthetic injector measures. This reports the first number, from real
 * replays, per metric:
 *
 *   ghost windows (metric A): lag 0 fidelity against lagFidelity
 *   hidden windows (metric D): lagFidelity, with the lag each window chose
 *
 *   npx tsx scripts/lag-inflation.ts <a.rpl> [b.rpl ...]
 */
import { readFileSync } from 'node:fs';
import { decodeRound } from '../src/integrity/run.js';
import { trackWindows } from '../src/integrity/ghostTrack.js';
import { hiddenTrackWindows } from '../src/integrity/hidden.js';
import { losView } from '../src/integrity/los.js';
import { TUNING } from '../src/integrity/constants.js';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: lag-inflation.ts <replay.rpl> [more.rpl ...]'); process.exit(2); }

const q = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
};
const summary = (label: string, xs: number[]) => ({
  label, n: xs.length,
  median: +q(xs, 0.5).toFixed(3), p90: +q(xs, 0.9).toFixed(3), max: +q(xs, 1).toFixed(3),
  [`>=${TUNING.CLIP_MIN}`]: xs.filter((x) => x >= TUNING.CLIP_MIN).length,
});

const ghost0: number[] = [], ghostLag: number[] = [], hidden: number[] = [];
const lags = new Map<number, number>();
let withLos = 0;
for (const path of files) {
  let round;
  try { round = decodeRound(readFileSync(path)); } catch { round = null; }
  if (!round) { console.error(`${path}: not readable, skipped`); continue; }
  const los = losView(round.header);
  if (los.known) withLos++;
  for (const slot of round.slots) {
    for (const w of trackWindows(round.frames, slot)) {
      if (w.travel < TUNING.MIN_TRAVEL) continue;
      ghost0.push(w.fidelity);
      ghostLag.push(w.lagFidelity);
    }
    for (const w of hiddenTrackWindows(round.frames, slot, los)) {
      if (w.travel < TUNING.MIN_TRAVEL) continue;
      hidden.push(w.lagFidelity);
      lags.set(w.lagMs, (lags.get(w.lagMs) ?? 0) + 1);
    }
  }
}

console.log(`${files.length} replays, ${withLos} with line of sight. Scoreable windows only.`);
console.table([summary('ghost, lag 0 (ranked)', ghost0), summary('ghost, lag search', ghostLag), summary('hidden, lag search', hidden)]);
console.log('hidden windows by chosen lag (ms):', Object.fromEntries([...lags].sort((a, b) => a[0] - b[0])));
