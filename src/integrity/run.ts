import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.js';
import { parseReplay, slotInfected, type ReplayHeader } from '../replayFormat.js';
import { PriorBuilder, subtractRound, type PriorTable } from './aimPrior.js';
import { TUNING } from './constants.js';
import { analyzeRound, buildRoundPrior } from './round.js';
import {
  ANALYZER_VERSION, loadPrior, loadRoundPrior, saveRound, saveRoundPrior, savePrior, type RoundKey,
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

/**
 * Analyse one round from its bytes and persist the result.
 *
 * The prior handed to the metrics is the map pool MINUS this round, so nobody
 * is measured against a baseline they helped build. A map that has not yet
 * reached MIN_PRIOR_ROUNDS gets no prior at all and therefore no occupancy
 * score, only fidelity. That is the honest answer for a thin map and it is
 * reported rather than papered over.
 */
export function analyzeOneRound(db: DB, key: RoundKey, buf: Uint8Array): boolean {
  const replay = parseReplay(buf);
  if (!replay) return false;
  const slots = survivorSlots(replay.header);
  if (slots.length === 0) return false;

  const pooled = loadPrior(db, replay.header.map);
  let prior: PriorTable | null = null;
  if (pooled && pooled.rounds >= TUNING.MIN_PRIOR_ROUNDS) {
    const own = loadRoundPrior(db, key);
    prior = own ? subtractRound(pooled.table, own) : pooled.table;
  }

  const { metrics, clips, roundPrior } = analyzeRound(replay.frames, slots, prior);
  saveRoundPrior(db, key, roundPrior);
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

/** Pass one: pool the aim prior per map and remember each round's share.
 *  Returns rounds pooled per map. */
export function rebuildPriors(db: DB, dir: string): Map<string, number> {
  const pools = new Map<string, { builder: PriorBuilder; rounds: number }>();
  for (const f of findReplays(db, dir)) {
    const replay = parseReplay(readFileSync(f.path));
    if (!replay) continue;
    const slots = survivorSlots(replay.header);
    const entry = pools.get(replay.header.map) ?? { builder: new PriorBuilder(), rounds: 0 };
    // `buildRoundPrior` is the ONLY producer of a round's contribution. This
    // pass used to compute it a second time, byte for byte identical, and
    // `analyzeRound` then overwrote the row with its own copy. A drift between
    // the two would not fail: subtractRound clamps a mismatch to zero, so the
    // pool and the subtraction would silently disagree and every occupancy
    // z-score would shift.
    const own = buildRoundPrior(replay.frames, slots);
    entry.builder.add(own);
    entry.rounds++;
    pools.set(replay.header.map, entry);
    saveRoundPrior(db, f.key, own);
  }
  const counts = new Map<string, number>();
  for (const [map, e] of pools) {
    savePrior(db, map, e.builder, e.rounds);
    counts.set(map, e.rounds);
  }
  return counts;
}

/**
 * The whole history, in two passes.
 *
 * Priors first, scoring second, because scoring subtracts a round's own
 * contribution from the pool and that subtraction is nonsense if the pool does
 * not contain it yet. Two passes over the files is the price of getting
 * leave-one-round-out right.
 */
/**
 * Analyse only the rounds nothing has measured yet.
 *
 * The counterpart to `backfillAll`, and the reason the board can stop going
 * stale. This runs after a match finishes, so it must be cheap: it never
 * touches the map priors, which would mean re-reading every replay on disk,
 * and it reads only the files it is actually going to measure.
 *
 * "Not measured yet" includes a round measured by an older analyzer. The
 * version is stored per row precisely so a change to the analyzer can be
 * noticed, and mixing two analyzers' numbers on one board is worse than
 * either of them alone.
 *
 * Scores from here are measured against whatever priors already exist, which
 * for a map under MIN_PRIOR_ROUNDS means no occupancy score at all. That is
 * the same answer `backfillAll` gives, and it improves for everyone the next
 * time the priors are rebuilt.
 */
export function analyzePending(db: DB, dir: string): { rounds: number; skipped: number } {
  const done = new Set(
    (db.prepare(
      'SELECT DISTINCT match_id, ordinal, half FROM integrity_rounds WHERE analyzer_version = ?',
    ).all(ANALYZER_VERSION) as { match_id: number; ordinal: number; half: number }[])
      .map((r) => `${r.match_id}/${r.ordinal}/${r.half}`),
  );
  let rounds = 0, skipped = 0;
  for (const f of findReplays(db, dir)) {
    if (done.has(`${f.key.matchId}/${f.key.ordinal}/${f.key.half}`)) continue;
    if (analyzeOneRound(db, f.key, readFileSync(f.path))) rounds++;
    else skipped++;
  }
  return { rounds, skipped };
}

export function backfillAll(db: DB, dir: string): { rounds: number; skipped: number } {
  rebuildPriors(db, dir);
  let rounds = 0, skipped = 0;
  for (const f of findReplays(db, dir)) {
    if (analyzeOneRound(db, f.key, readFileSync(f.path))) rounds++;
    else skipped++;
  }
  return { rounds, skipped };
}
