import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.js';
import { parseReplay, slotInfected, type Frame, type ReplayHeader } from '../replayFormat.js';
import { subtractRound, type PriorTable } from './aimPrior.js';
import { TUNING } from './constants.js';
import { analyzeRound, buildRoundPrior, unpausedFrames } from './round.js';
import {
  loadPrior, loadRoundPrior, markUnanalysable, pendingRounds, pooledRounds, poolRounds, saveRound,
  type PoolEntry, type RoundKey,
} from './store.js';

const NAME_RE = /^pug_([0-9a-f]{32})_(\d+)_([12])\.rpl$/;

/** Which roster slots were survivors this round, from the header's side mask. */
function survivorSlots(header: ReplayHeader): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < header.slots.length; slot++) {
    if (!header.slots[slot]) continue;
    if (!slotInfected(header, slot)) out.push(slot);
  }
  return out;
}

export interface DecodedRound { header: ReplayHeader; frames: Frame[]; slots: number[] }

/**
 * A replay's bytes as the analyzer sees them, or null when there is nothing to
 * analyse.
 *
 * The ONE door between the file format and the analyzer. The pooling pass and
 * the scoring pass both come through here, so whatever is decided about which
 * frames count is decided once and they cannot disagree. Paused frames are
 * dropped here and nowhere else: see `unpausedFrames`.
 */
export function decodeRound(buf: Uint8Array): DecodedRound | null {
  const replay = parseReplay(buf);
  if (!replay) return null;
  const slots = survivorSlots(replay.header);
  if (slots.length === 0) return null;
  return { header: replay.header, frames: unpausedFrames(replay.frames), slots };
}

/**
 * Analyse one round from its bytes and persist the result.
 *
 * The prior handed to the metrics is the map pool MINUS this round, so nobody
 * is measured against a baseline they helped build. The subtraction happens
 * only when this round has a share at the current version, which `poolRounds`
 * guarantees is a share the pool contains: a round that was never pooled is
 * scored against the pool as it stands, because there is nothing of its own in
 * there to take out. Pooling is the caller's job and comes first; see
 * `analyzePending` and `backfillAll`.
 *
 * A map that has not yet reached MIN_PRIOR_ROUNDS gets no prior at all and
 * therefore no occupancy score, only fidelity. That is the honest answer for a
 * thin map and it is reported rather than papered over.
 */
export function analyzeOneRound(db: DB, key: RoundKey, buf: Uint8Array): boolean {
  const replay = decodeRound(buf);
  if (!replay) return false;
  const { slots } = replay;

  const pooled = loadPrior(db, replay.header.map);
  let prior: PriorTable | null = null;
  if (pooled && pooled.rounds >= TUNING.MIN_PRIOR_ROUNDS) {
    const own = loadRoundPrior(db, key);
    prior = own ? subtractRound(pooled.table, own) : pooled.table;
  }

  const { metrics, clips } = analyzeRound(replay.frames, slots, prior);
  saveRound(db, key, slots.map((slot) => ({
    slot,
    steamid: replay.header.slots[slot],
    metrics: metrics.get(slot)!,
    clips: clips.get(slot) ?? [],
  })));
  return true;
}

interface Found { key: RoundKey; path: string }

/** Every replay file on disk that maps to a known match, by filename. Discovery
 *  is by name for the same reason `discoverMatchReplays` does it: the link
 *  between a file and its match is a property of the filename, so it survives
 *  anything happening to the backend. */
function findReplays(db: DB, dir: string): Found[] {
  const byToken = new Map<string, number>();
  for (const r of db.prepare('SELECT match_id, filename FROM match_replays').all() as { match_id: number; filename: string }[]) {
    const m = NAME_RE.exec(r.filename);
    if (m) byToken.set(m[1], r.match_id);
  }
  const out: Found[] = [];
  for (const name of readdirSync(dir)) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const matchId = byToken.get(m[1]);
    if (matchId == null) continue;
    out.push({ key: { matchId, ordinal: Number(m[2]), half: Number(m[3]) }, path: join(dir, name) });
  }
  return out;
}

/** Read and decode one file, or null. Never throws: see `scoreAll`. */
function readRound(f: Found): DecodedRound | null {
  try {
    return decodeRound(readFileSync(f.path));
  } catch {
    return null;
  }
}

const keyOf = (k: RoundKey): string => `${k.matchId}/${k.ordinal}/${k.half}`;

/**
 * Pool these replays into their maps' aim priors. Returns, per map touched,
 * the rounds pooled before and after.
 *
 * `buildRoundPrior` is the ONLY producer of a round's share and `poolRounds`
 * the only writer of one, so the pool and what is later subtracted from it
 * cannot drift apart.
 *
 * The shares are built first and written in one short transaction at the end.
 * Decoding is the slow part, and holding a write lock across it would stall
 * the web process, which shares this database and is recording live matches.
 */
function poolReplays(db: DB, files: Found[]): Map<string, { before: number; after: number }> {
  const entries: PoolEntry[] = [];
  for (const f of files) {
    const replay = readRound(f);
    if (!replay) continue;
    entries.push({ key: f.key, map: replay.header.map, prior: buildRoundPrior(replay.frames, replay.slots) });
  }
  return poolRounds(db, entries);
}

/** Pool every replay on disk. Returns rounds pooled per map. */
export function rebuildPriors(db: DB, dir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [map, n] of poolReplays(db, findReplays(db, dir))) counts.set(map, n.after);
  return counts;
}

/** Measure these, and mark the ones that cannot be so they stop being pending.
 *  See `pendingRounds`. */
function scoreAll(db: DB, files: Found[]): { rounds: number; skipped: number } {
  let rounds = 0, skipped = 0;
  for (const f of files) {
    let ok = false;
    try {
      ok = analyzeOneRound(db, f.key, readFileSync(f.path));
    } catch (err) {
      // One round must not end the pass. If it did, the process would exit
      // with that round still pending and be started again a minute later.
      console.error(`[integrity] ${f.path} could not be analysed:`, err);
    }
    if (ok) rounds++;
    else { markUnanalysable(db, f.key, 'unreadable'); skipped++; }
  }
  return { rounds, skipped };
}

/**
 * Analyse only the rounds nothing has measured yet.
 *
 * The counterpart to `backfillAll`, and the reason the board can stop going
 * stale. This runs after a match finishes, so it must be cheap: it reads only
 * the files it is actually going to measure, twice each, once to pool and once
 * to score.
 *
 * It pools what it measures. Until version 4 it did not, so a map only crossed
 * MIN_PRIOR_ROUNDS when somebody ran a full backfill by hand, and after an
 * ANALYZER_VERSION bump it subtracted each round's share from the OLD
 * analyzer's pool, which had never contained it. Pooling first, through
 * `poolRounds`, fixes both: every round scored here is in the pool it is
 * subtracted from, and a version bump rebuilds the pools as a side effect of
 * re-measuring, because old-version shares are never summed.
 *
 * When a map crosses MIN_PRIOR_ROUNDS in this pass, its earlier rounds are
 * measured again. They were scored with no prior and would otherwise read
 * "no occupancy" until the next full backfill. This happens once per map and
 * costs at most MIN_PRIOR_ROUNDS files.
 *
 * "Not measured yet" includes a round measured by an older analyzer. The
 * version is stored per row precisely so a change to the analyzer can be
 * noticed, and mixing two analyzers' numbers on one board is worse than
 * either of them alone.
 *
 * What is pending comes from `pendingRounds`, the same query that decides
 * whether this pass is started at all. A pending round whose file is gone or
 * will not decode is marked unanalysable, which takes it out of that query, so
 * one bad replay cannot have the server start this process every minute.
 */
export function analyzePending(db: DB, dir: string): { rounds: number; skipped: number } {
  const pending: Found[] = [];
  let missing = 0;
  for (const r of pendingRounds(db)) {
    const path = NAME_RE.test(r.filename) ? join(dir, r.filename) : null;
    if (path && existsSync(path)) pending.push({ key: r.key, path });
    else { markUnanalysable(db, r.key, 'missing'); missing++; }
  }
  if (pending.length === 0) return { rounds: 0, skipped: missing };

  const waiting = new Set<string>();
  for (const [map, n] of poolReplays(db, pending)) {
    if (n.before < TUNING.MIN_PRIOR_ROUNDS && n.after >= TUNING.MIN_PRIOR_ROUNDS) {
      for (const k of pooledRounds(db, map)) waiting.add(keyOf(k));
    }
  }
  const isPending = new Set(pending.map((f) => keyOf(f.key)));
  const again = waiting.size === 0 ? []
    : findReplays(db, dir).filter((f) => waiting.has(keyOf(f.key)) && !isPending.has(keyOf(f.key)));
  const got = scoreAll(db, [...pending, ...again]);
  return { rounds: got.rounds, skipped: got.skipped + missing };
}

/**
 * The whole history, in two passes.
 *
 * Priors first, scoring second, because scoring subtracts a round's own
 * contribution from the pool and that subtraction is nonsense if the pool does
 * not contain it yet. Two passes over the files is the price of getting
 * leave-one-round-out right.
 */
export function backfillAll(db: DB, dir: string): { rounds: number; skipped: number; perMap: Map<string, number> } {
  const files = findReplays(db, dir);
  const perMap = new Map<string, number>();
  for (const [map, n] of poolReplays(db, files)) perMap.set(map, n.after);
  return { ...scoreAll(db, files), perMap };
}
