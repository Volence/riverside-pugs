// scripts/win-dataset.ts
// Turn every past PUG half into 5-second snapshots for the live win model.
// Usage: npx tsx scripts/win-dataset.ts --db <copy of prod pug.db> [--out DIR] [--limit N] [--resume]
//
// Replays come from the public R2 URL and are cached under <out>/rpl/, so a
// rerun does not fetch them again. --resume also remembers replays that were
// missing (404) instead of asking for them again.
//
// Pass 1 learns a position-to-progress map per map from halves that have data
// feeds, holding out 20% of them to measure its error. Pass 2 writes one line
// per half: feed halves use the feeds, the others use their map's progress map
// when its holdout median error is small enough, else no progress at all.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DB } from '../src/db.js';
import { completedPug } from '../src/matchKinds.js';
import { decodeRoundReplay } from '../src/metrics/replayRound.js';
import type { RoundKey, RoundReplay } from '../src/metrics/types.js';
import { infectedMaskForHeader } from '../src/replaySides.js';
import { STATE } from '../src/replayFormat.js';
import {
  feedProgressPoints, halfSnapshots, progressTimeline, type Snapshot,
} from '../src/winLive/snapshot.js';
import { buildProgressMap, furthestProg, progressAt, type ProgressMap } from '../src/winLive/progressMap.js';

const R2_BASE = 'https://assets.riversidepug.com/';
const CONCURRENCY = 4;
const FETCH_TRIES = 4;
/** A map's progress map is trusted for non-feed halves up to this median error (progress points). */
const MAX_MAP_ERROR = 8;
/** Feed halves needed this many usable progress samples to count as having feeds. */
const MIN_FEED_POINTS = 3;
/** Training positions are taken this often per half. */
const TRAIN_EVERY_MS = 2000;
const HOLDOUT_EVERY_MS = 5000;

interface HalfRow {
  matchId: number; ordinal: number; half: 1 | 2; map: string; survTeam: 'a' | 'b';
  score: number; made: boolean | null; endedAt: string; r2Key: string;
}

type ProgSource = 'feeds' | 'map' | 'none';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg('db');
if (!dbPath) { console.error('usage: tsx scripts/win-dataset.ts --db <copy of prod pug.db> [--out DIR] [--limit N] [--resume]'); process.exit(1); }
if (resolve(dbPath).endsWith('/data/pug.db')) { console.error('refusing to run against data/pug.db; pass a copy with --db'); process.exit(1); }
const outDir = resolve(arg('out') ?? '/home/volence/l4d/pug/data/win-dataset');
const limit = arg('limit') ? Number(arg('limit')) : Infinity;
const resume = process.argv.includes('--resume');

const rplDir = join(outDir, 'rpl');
mkdirSync(rplDir, { recursive: true });
const missingPath = join(outDir, 'missing.json');
const missing = new Set<string>(resume && existsSync(missingPath) ? JSON.parse(readFileSync(missingPath, 'utf8')) : []);

const db: DB = new Database(dbPath, { readonly: true });

const rows = db.prepare(
  `SELECT mr.match_id AS matchId, mr.ordinal, mr.half, mm.map, mr.surv_team AS survTeam, mr.score,
          mr.survivors_alive AS alive, m.ended_at AS endedAt, rp.r2_key AS r2Key
   FROM match_rounds mr
   JOIN matches m ON m.id = mr.match_id
   JOIN match_maps mm ON mm.match_id = mr.match_id AND mm.ordinal = mr.ordinal
   JOIN match_replays rp ON rp.match_id = mr.match_id AND rp.ordinal = mr.ordinal AND rp.half = mr.half
   WHERE ${completedPug('m')} AND m.voided_at IS NULL AND mr.reliable = 1 AND mr.ended_at IS NOT NULL
     AND rp.r2_key IS NOT NULL
   ORDER BY mr.match_id, mr.ordinal, mr.half`,
).all() as (Omit<HalfRow, 'made'> & { alive: number | null })[];
const halves: HalfRow[] = rows
  .slice(0, limit)
  .map(({ alive, ...r }) => ({ ...r, made: alive === null ? null : alive > 0 }));
console.log(`${halves.length} halves selected`);

const tankFlowStmt = db.prepare(
  `SELECT prog FROM match_live_events
   WHERE match_id = ? AND map_ordinal = ? AND half = ? AND kind = 'tank_spawn' AND prog IS NOT NULL
   ORDER BY seq LIMIT 1`,
);
const tankFlowOf = (h: HalfRow): number | null =>
  (tankFlowStmt.get(h.matchId, h.ordinal, h.half) as { prog: number } | undefined)?.prog ?? null;

const cachePath = (h: HalfRow): string => join(rplDir, `${h.matchId}_${h.ordinal}_${h.half}.rpl`);

async function fetchOne(h: HalfRow): Promise<void> {
  const path = cachePath(h);
  if (existsSync(path) || missing.has(h.r2Key)) return;
  for (let t = 1; t <= FETCH_TRIES; t++) {
    try {
      const res = await fetch(R2_BASE + h.r2Key);
      if (res.status === 404) { missing.add(h.r2Key); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) {
      if (t === FETCH_TRIES) { console.error(`fetch failed ${h.r2Key}: ${(e as Error).message}`); return; }
      await new Promise((r) => setTimeout(r, 500 * t));
    }
  }
}

async function fetchAll(): Promise<void> {
  let next = 0, done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= halves.length) return;
      await fetchOne(halves[i]);
      if (++done % 200 === 0) {
        console.log(`fetched ${done}/${halves.length}`);
        writeFileSync(missingPath, JSON.stringify([...missing]));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  writeFileSync(missingPath, JSON.stringify([...missing]));
}

function decodeHalf(h: HalfRow): RoundReplay | null {
  const path = cachePath(h);
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  try {
    return decodeRoundReplay(buf, () => infectedMaskForHeader(db, buf, h.matchId, h.ordinal, h.half));
  } catch {
    return null;
  }
}

const keyOf = (h: HalfRow): RoundKey => ({ matchId: h.matchId, ordinal: h.ordinal, half: h.half });

/** Feed progress timeline for a half, or null when it has too few usable samples. */
function feedTimeline(h: HalfRow, rr: RoundReplay): ((tMs: number) => number | null) | null {
  const endTMs = rr.frames[rr.frames.length - 1].tMs;
  const pts = feedProgressPoints(db, keyOf(h), endTMs)
    .filter((p) => Number.isFinite(p.prog) && p.prog >= 0 && p.prog <= 100);
  return pts.length >= MIN_FEED_POINTS ? progressTimeline(pts) : null;
}

interface FeedHalf {
  h: HalfRow;
  holdout: boolean;
  /** Per sampled frame: where each alive survivor stood and the known progress. */
  samples: { pos: [number, number, number][]; prog: number }[];
  /** Holdout frames (every HOLDOUT_EVERY_MS) kept for scoring. */
  evalFrames: { frame: RoundReplay['frames'][number]; truth: number }[];
}

function aliveSurvivors(frame: RoundReplay['frames'][number]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const p of frame.players) {
    if (p.infected === false && (p.state & STATE.ALIVE) !== 0) out.push([p.x, p.y, p.z]);
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main(): Promise<void> {
  await fetchAll();

  // Pass 1: feed halves -> per-map training samples.
  const feedHalves: FeedHalf[] = [];
  let seenFeed = 0;
  for (const h of halves) {
    const rr = decodeHalf(h);
    if (!rr) continue;
    const tl = feedTimeline(h, rr);
    if (!tl) continue;
    const fh: FeedHalf = { h, holdout: seenFeed++ % 5 === 4, samples: [], evalFrames: [] };
    let nextTrain = rr.frames[0].tMs, nextEval = rr.frames[0].tMs;
    for (const f of rr.frames) {
      const truth = tl(f.tMs);
      if (truth === null) continue;
      if (fh.holdout) {
        if (f.tMs >= nextEval) { fh.evalFrames.push({ frame: f, truth }); nextEval = f.tMs + HOLDOUT_EVERY_MS; }
      } else if (f.tMs >= nextTrain) {
        const pos = aliveSurvivors(f);
        if (pos.length > 0) fh.samples.push({ pos, prog: truth });
        nextTrain = f.tMs + TRAIN_EVERY_MS;
      }
    }
    feedHalves.push(fh);
  }
  console.log(`${feedHalves.length} halves with feeds (${feedHalves.filter((f) => f.holdout).length} held out)`);

  // A team's progress is set by its furthest survivor, so pairing it with every
  // survivor is noisy. Fit once with all survivors, then refit pairing the
  // progress only with the survivor the first fit puts furthest along.
  const fit = (map: string, fhs: FeedHalf[], pick: ProgressMap | null): ProgressMap => {
    const samples: { x: number; y: number; z: number; prog: number }[] = [];
    for (const fh of fhs) {
      for (const s of fh.samples) {
        let use = s.pos;
        if (pick) {
          let best: [number, number, number] | null = null, bestV = -Infinity;
          for (const p of s.pos) {
            const v = progressAt(pick, p[0], p[1], p[2]);
            if (v !== null && v > bestV) { bestV = v; best = p; }
          }
          if (!best) continue;
          use = [best];
        }
        for (const p of use) samples.push({ x: p[0], y: p[1], z: p[2], prog: s.prog });
      }
    }
    return buildProgressMap(map, samples);
  };
  const buildFor = (map: string, fhs: FeedHalf[]): ProgressMap => fit(map, fhs, fit(map, fhs, null));

  const maps = [...new Set(feedHalves.map((f) => f.h.map))].sort();
  const mapError = new Map<string, { median: number; n: number; unmapped: number }>();
  const allErr: number[] = [];
  for (const map of maps) {
    const mine = feedHalves.filter((f) => f.h.map === map);
    const pm = buildFor(map, mine.filter((f) => !f.holdout));
    const errs: number[] = [];
    let unmapped = 0;
    for (const fh of mine.filter((f) => f.holdout)) {
      for (const e of fh.evalFrames) {
        const v = furthestProg(pm, e.frame);
        if (v === null) unmapped++; else errs.push(Math.abs(v - e.truth));
      }
    }
    if (errs.length > 0) {
      mapError.set(map, { median: median(errs), n: errs.length, unmapped });
      allErr.push(...errs);
    }
  }

  // Shipped maps use every feed half, so they know a little more than the scored ones.
  const finalMaps = new Map<string, ProgressMap>();
  for (const map of maps) finalMaps.set(map, buildFor(map, feedHalves.filter((f) => f.h.map === map)));
  writeFileSync(join(outDir, 'progress-maps.json'), JSON.stringify([...finalMaps.values()]));
  feedHalves.length = 0; // release the samples and frames

  // Pass 2: every half.
  const outPath = join(outDir, 'halves.jsonl');
  rmSync(outPath, { force: true });
  const counts: Record<ProgSource, number> = { feeds: 0, map: 0, none: 0 };
  let skipped = 0, written = 0;
  let buffer: string[] = [];
  for (const h of halves) {
    const rr = decodeHalf(h);
    if (!rr) { skipped++; continue; }
    let progSource: ProgSource = 'none';
    let prog: (tMs: number) => number | null = () => null;
    const tl = feedTimeline(h, rr);
    const pm = finalMaps.get(h.map);
    const err = mapError.get(h.map);
    if (tl) { progSource = 'feeds'; prog = tl; }
    else if (pm && err && err.median <= MAX_MAP_ERROR) {
      const pts: { tMs: number; prog: number }[] = [];
      for (const f of rr.frames) {
        const v = furthestProg(pm, f);
        if (v !== null) pts.push({ tMs: f.tMs, prog: v });
      }
      if (pts.length > 0) { progSource = 'map'; prog = progressTimeline(pts); }
    }
    const snaps: Snapshot[] = halfSnapshots(rr, prog, tankFlowOf(h));
    counts[progSource]++;
    buffer.push(JSON.stringify({
      matchId: h.matchId, ordinal: h.ordinal, half: h.half, map: h.map, survTeam: h.survTeam,
      score: h.score, made: h.made, endedAt: h.endedAt, progSource, snaps,
    }));
    written++;
    if (buffer.length >= 100) { appendFileSync(outPath, buffer.join('\n') + '\n'); buffer = []; }
  }
  if (buffer.length > 0) appendFileSync(outPath, buffer.join('\n') + '\n');

  console.log('--- summary ---');
  console.log(`halves selected ${halves.length}, written ${written}, skipped (no replay or undecodable) ${skipped}, 404 ${missing.size}`);
  console.log(`progSource: feeds ${counts.feeds}, map ${counts.map}, none ${counts.none}`);
  console.log(`holdout median abs error, overall: ${allErr.length ? median(allErr).toFixed(2) : 'n/a'} (n=${allErr.length})`);
  for (const [map, e] of [...mapError].sort()) {
    console.log(`  ${map}: median ${e.median.toFixed(2)} over ${e.n} frames, ${e.unmapped} unmapped${e.median <= MAX_MAP_ERROR ? '' : '  (not trusted)'}`);
  }
  console.log(`no progress map: ${maps.filter((m) => !mapError.has(m)).join(', ') || 'none'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
