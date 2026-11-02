// scripts/win-backfill.ts
// Store the win line during halves (match_win_points) for finished matches
// the reaper will not reach: every completed, unvoided PUG without points on
// the current winPointsVersion() (src/winLive/finishedLine.ts), and every one
// whose run on it is partial (halves whose replay was missing at the time).
// Usage: npx tsx scripts/win-backfill.ts --db <path> [--commit] [--limit N] [--since-match N] [--cache DIR]
//
// Dry run by default: the DB is opened read-only and the points are computed
// and counted, nothing is written. --commit writes them. Replays come from the
// public R2 URL and are cached under --cache as <match>_<ordinal>_<half>.rpl
// (the naming scripts/win-dataset.ts uses, so its cache is reused). The
// default cache is data/win-dataset/rpl under the working directory.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { completedPug } from '../src/matchKinds.js';
import { decodeRoundReplay } from '../src/metrics/replayRound.js';
import type { RoundKey, RoundReplay } from '../src/metrics/types.js';
import { infectedMaskForHeader } from '../src/replaySides.js';
import { HEADER_BYTES } from '../src/replayFormat.js';
import { winModel } from '../src/winProb.js';
import { finishedPoints, writeFinishedPoints } from '../src/winLive/finishedLine.js';
import { winPointsVersion } from '../src/winLive/modelVersion.js';

const R2_BASE = 'https://assets.riversidepug.com/';
const CONCURRENCY = 4;
const FETCH_TRIES = 4;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const usage = 'usage: tsx scripts/win-backfill.ts --db <path> [--commit] [--limit N] [--since-match N] [--cache DIR]';
const dbPath = arg('db');
if (!dbPath) { console.error(usage); process.exit(1); }
const commit = process.argv.includes('--commit');
const limit = arg('limit') ? Number(arg('limit')) : Infinity;
const since = arg('since-match') ? Number(arg('since-match')) : 0;
const cacheDir = resolve(arg('cache') ?? 'data/win-dataset/rpl');
if (!Number.isFinite(since) || !(limit > 0)) { console.error(usage); process.exit(1); }
mkdirSync(cacheDir, { recursive: true });

// --commit opens it through openDb, which adds the tables if the DB predates
// them; a dry run touches nothing and reads a missing table as no runs yet.
const db: DB = commit ? openDb(dbPath) : new Database(dbPath, { readonly: true });
const hasTable = (name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
// A DB from before the live side stored LIVEHUD samples: none to read (a
// temporary table, so the read-only dry run still writes nothing).
if (!hasTable('match_progress_samples')) {
  db.exec('CREATE TEMP TABLE match_progress_samples (match_id INTEGER, ordinal INTEGER, half INTEGER, t_ms INTEGER, prog INTEGER, tank INTEGER)');
}
const hasRuns = hasTable('match_win_point_runs');

const ids = (db.prepare(`
  SELECT m.id FROM matches m
  WHERE ${completedPug('m')} AND m.voided_at IS NULL AND m.id >= ?
    ${hasRuns ? 'AND NOT EXISTS (SELECT 1 FROM match_win_point_runs w WHERE w.match_id = m.id AND w.model_version = ? AND w.halves_missing = 0)' : ''}
  ORDER BY m.id`).all(...(hasRuns ? [since, winPointsVersion()] : [since])) as { id: number }[])
  .map((r) => r.id)
  .slice(0, limit);

const replayRows = db.prepare(
  'SELECT ordinal, half, r2_key AS r2Key FROM match_replays WHERE match_id = ? AND r2_key IS NOT NULL',
);
const cachePath = (k: RoundKey): string => join(cacheDir, `${k.matchId}_${k.ordinal}_${k.half}.rpl`);

const counts = { fetched: 0, cached: 0, missing: 0, fetchFailed: 0 };

async function fetchOne(k: RoundKey, r2Key: string): Promise<void> {
  const path = cachePath(k);
  if (existsSync(path)) { counts.cached++; return; }
  for (let t = 1; t <= FETCH_TRIES; t++) {
    try {
      const res = await fetch(R2_BASE + r2Key);
      if (res.status === 404) { counts.missing++; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = `${path}.part`;
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      renameSync(tmp, path);
      counts.fetched++;
      return;
    } catch (e) {
      if (t === FETCH_TRIES) { console.error(`fetch failed ${r2Key}: ${(e as Error).message}`); counts.fetchFailed++; return; }
      await new Promise((r) => setTimeout(r, 500 * t));
    }
  }
}

async function fetchAll(): Promise<void> {
  const jobs: { k: RoundKey; r2Key: string }[] = [];
  for (const matchId of ids) {
    for (const r of replayRows.all(matchId) as { ordinal: number; half: 1 | 2; r2Key: string }[]) {
      jobs.push({ k: { matchId, ordinal: r.ordinal, half: r.half }, r2Key: r.r2Key });
    }
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      await fetchOne(jobs[i]!.k, jobs[i]!.r2Key);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** A half's replay from the cache, decoded the way the metrics job does. */
function loadCached(k: RoundKey): RoundReplay | null {
  const path = cachePath(k);
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  return decodeRoundReplay(buf, () => infectedMaskForHeader(db, buf.subarray(0, HEADER_BYTES), k.matchId, k.ordinal, k.half));
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`${ids.length} matches without full points on ${winPointsVersion()}${commit ? '' : ' (dry run)'}`);
  await fetchAll();
  const tFetch = Date.now();
  console.log(`replays: ${counts.cached} cached, ${counts.fetched} fetched, ${counts.missing} missing (404), ${counts.fetchFailed} failed`);

  const model = winModel(db);
  let withPoints = 0, partial = 0, noLine = 0, noReplay = 0, failed = 0, points = 0;
  ids.forEach((id, i) => {
    try {
      const res = finishedPoints(db, id, loadCached, { model });
      if (res === null) noLine++;
      else if (res.points.length === 0) noReplay++;
      else { withPoints++; points += res.points.length; if (res.halvesMissing > 0) partial++; }
      if (commit) writeFinishedPoints(db, id, res?.points ?? [], { halvesMissing: res?.halvesMissing ?? 0 });
    } catch (e) {
      failed++;
      console.error(`match ${id} failed: ${(e as Error).message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`computed ${i + 1}/${ids.length}`);
  });
  const tEnd = Date.now();
  console.log('--- summary ---');
  console.log(`matches ${ids.length}: with points ${withPoints} (partial ${partial}), no line (score carries none) ${noLine}, no usable replay ${noReplay}, failed ${failed}`);
  console.log(`points ${points}${commit ? ' written' : ' (not written, dry run)'}`);
  console.log(`time: fetch ${((tFetch - t0) / 1000).toFixed(1)} s, compute ${((tEnd - tFetch) / 1000).toFixed(1)} s (${ids.length ? ((tEnd - tFetch) / ids.length).toFixed(0) : 0} ms per match)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
