/**
 * Calibrate the ghost tracking metric against a known positive.
 *
 * CLIP_MIN was picked before the analyzer had ever seen anyone track a ghost.
 * This takes a real replay, rewrites ONE survivor's view so that they follow a
 * chosen ghost with a stated lag and aim error, writes the result to a scratch
 * file, and runs the real analyzer over that file. Everything else in the
 * round is as it was played, so the gates, the occluders and the ghost's actual
 * path are all real. See src/integrity/synthetic.ts.
 *
 *   npx tsx scripts/inject-synthetic-tracker.ts <replay.rpl> [options]
 *   npx tsx scripts/inject-synthetic-tracker.ts <a.rpl> <b.rpl> ... --sweep
 *
 *   --slot N      survivor to rewrite        (default: the busiest pair's)
 *   --ghost N     ghost to follow            (default: the busiest pair's)
 *   --lag MS      reaction lag               (default 150)
 *   --noise DEG   RMS aim error              (default 2)
 *   --tau MS      how slowly that error moves; 0 is white noise (default 300)
 *   --seed N                                 (default 1)
 *   --out FILE    where to write             (default: the OS temp directory)
 *   --sweep       no file; a table over a grid of lag, noise and tau, pooled
 *                 over every replay given
 *
 * It reads replays and writes ONE new file, never into a directory it read
 * from, and touches no database. The output's name does not match the pattern
 * the site indexes replays by, so it cannot be mistaken for a real round even
 * if it is left lying in the replay directory.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { encodeFrame, encodeHeader, parseReplay, slotInfected, type Frame, type Replay } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import { pickClips, trackWindows } from '../src/integrity/ghostTrack.js';
import { decodeRound } from '../src/integrity/run.js';
import { busiestPair, injectTracker, type TrackerOpts } from '../src/integrity/synthetic.js';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').match(/^--(slot|ghost|lag|noise|tau|seed|out)$/));
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const v = opt(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) { console.error(`--${name} wants a number, got "${v}"`); process.exit(2); }
  return n;
};
if (files.length === 0) {
  console.error('usage: inject-synthetic-tracker.ts <replay.rpl> [more.rpl ...] [--slot N] [--ghost N] [--lag MS] [--noise DEG] [--tau MS] [--seed N] [--out FILE] [--sweep]');
  process.exit(2);
}

function encodeReplay(replay: Replay, frames: Frame[]): Uint8Array {
  // No keyframe index: a reader then takes the frames to run to the end of the
  // file, which is what a never-closed replay looks like and decodes fine.
  const parts = [encodeHeader({ ...replay.header, indexOffset: 0, indexCount: 0, frameCount: frames.length }), ...frames.map(encodeFrame)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

interface Score { formed: number; scoreable: number; fids: number[]; clips: number }

/** What the real analyzer says about `slot` against `ghostSlot` in these bytes. */
function score(bytes: Uint8Array, slot: number, ghostSlot: number): Score {
  const round = decodeRound(bytes);
  if (!round) throw new Error('the injected replay did not decode');
  const windows = trackWindows(round.frames, slot).filter((w) => w.ghostSlot === ghostSlot);
  const scoreable = windows.filter((w) => w.travel >= TUNING.MIN_TRAVEL);
  return { formed: windows.length, scoreable: scoreable.length, fids: scoreable.map((w) => w.fidelity), clips: pickClips(windows).length };
}

const q = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
};

function row(label: Record<string, unknown>, s: Score): Record<string, unknown> {
  return {
    ...label,
    windows: s.formed,
    scoreable: s.scoreable,
    p10: +q(s.fids, 0.1).toFixed(2),
    median: +q(s.fids, 0.5).toFixed(2),
    p90: +q(s.fids, 0.9).toFixed(2),
    max: +q(s.fids, 1).toFixed(2),
    [`share>=${TUNING.CLIP_MIN}`]: s.fids.length ? +(s.fids.filter((f) => f >= TUNING.CLIP_MIN).length / s.fids.length).toFixed(2) : 0,
    clips: s.clips,
    trackShare: s.fids.length ? +(s.fids.reduce((a, b) => a + b, 0) / s.fids.length).toFixed(3) : 0,
  };
}

interface Loaded { path: string; replay: Replay; slot: number; ghostSlot: number }

const loaded: Loaded[] = [];
for (const path of files) {
  const replay = parseReplay(readFileSync(path));
  if (!replay) { console.error(`${path}: not a replay this build can read, skipped`); continue; }
  const survivors = replay.header.slots.flatMap((id, slot) => (id && !slotInfected(replay.header, slot) ? [slot] : []));
  const auto = busiestPair(replay.frames, survivors);
  const slot = opt('slot') !== undefined ? num('slot', 0) : auto?.slot;
  const ghostSlot = opt('ghost') !== undefined ? num('ghost', 0) : auto?.ghostSlot;
  if (slot === undefined || ghostSlot === undefined) { console.error(`${path}: no survivor and ghost were ever eligible together, skipped`); continue; }
  loaded.push({ path, replay, slot, ghostSlot });
}
if (loaded.length === 0) process.exit(1);

if (args.includes('--sweep')) {
  const grid: TrackerOpts[] = [];
  for (const noiseTauMs of [300, 0]) for (const lagMs of [0, 150, 250]) for (const noiseDeg of [0, 0.5, 1, 2, 3]) {
    grid.push({ lagMs, noiseDeg, noiseTauMs, seed: num('seed', 1) });
  }
  const before: Score = { formed: 0, scoreable: 0, fids: [], clips: 0 };
  for (const l of loaded) {
    const s = score(encodeReplay(l.replay, l.replay.frames), l.slot, l.ghostSlot);
    before.formed += s.formed; before.scoreable += s.scoreable; before.fids.push(...s.fids); before.clips += s.clips;
  }
  const table = [row({ tau: '', lag: '', noise: 'as played' }, before)];
  for (const o of grid) {
    const total: Score = { formed: 0, scoreable: 0, fids: [], clips: 0 };
    for (const l of loaded) {
      const s = score(encodeReplay(l.replay, injectTracker(l.replay.frames, l.slot, l.ghostSlot, o)), l.slot, l.ghostSlot);
      total.formed += s.formed; total.scoreable += s.scoreable; total.fids.push(...s.fids); total.clips += s.clips;
    }
    table.push(row({ tau: o.noiseTauMs, lag: o.lagMs, noise: o.noiseDeg }, total));
  }
  console.log(`${loaded.length} replay${loaded.length === 1 ? '' : 's'}, one injected survivor each, busiest pair. CLIP_MIN ${TUNING.CLIP_MIN}, MIN_TRAVEL ${TUNING.MIN_TRAVEL}.`);
  console.table(table);
  process.exit(0);
}

const l = loaded[0];
const o: TrackerOpts = { lagMs: num('lag', 150), noiseDeg: num('noise', 2), noiseTauMs: num('tau', 300), seed: num('seed', 1) };
const out = resolve(opt('out') ?? join(tmpdir(), `synthetic-${basename(l.path)}`));
if (files.some((f) => dirname(resolve(f)) === dirname(out))) {
  console.error(`refusing to write ${out}: that is a directory a replay was read from`);
  process.exit(2);
}
const bytes = encodeReplay(l.replay, injectTracker(l.replay.frames, l.slot, l.ghostSlot, o));
writeFileSync(out, bytes);
console.log(`${basename(l.path)}: survivor slot ${l.slot} now follows ghost slot ${l.ghostSlot}, lag ${o.lagMs} ms, noise ${o.noiseDeg} deg RMS (tau ${o.noiseTauMs} ms), seed ${o.seed}`);
console.log(`written to ${out}`);
console.table([
  row({ replay: 'as played' }, score(encodeReplay(l.replay, l.replay.frames), l.slot, l.ghostSlot)),
  row({ replay: 'injected' }, score(bytes, l.slot, l.ghostSlot)),
]);
