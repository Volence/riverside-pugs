import type { DB } from '../db.js';
import { PriorBuilder, type PriorTable } from './aimPrior.js';
import type { TrackWindow } from './ghostTrack.js';
import type { RoundMetrics } from './round.js';

/** Bump whenever a metric changes MEANING, so stale rows are identifiable
 *  without guessing from computed_at.
 *
 *  2: eligiblePairs now counts unconditionally instead of reading 0 on every
 *  map without a prior, RoundMetrics carries the gate tally, and the occlusion
 *  guard gained a distance bound. Version 1 rows are not comparable to these.
 *
 *  3: the occlusion guard no longer lets an entity carrying the GHOST bit veto
 *  a frame. AI controlled special infected are recorded as entities and can be
 *  unspawned, so version 2 dropped frames because of something invisible. */
export const ANALYZER_VERSION = 3;

export interface RoundKey { matchId: number; ordinal: number; half: number }
export interface SaveRow { slot: number; steamid: string; metrics: RoundMetrics; clips: TrackWindow[] }

const countsToJson = (m: Map<string, number>): string => JSON.stringify([...m]);
const countsFromJson = (s: string): Map<string, number> => new Map(JSON.parse(s) as [string, number][]);

/** Write one round's analysis, replacing any previous one.
 *
 *  Deliberately does NOT touch integrity_reviews. An admin's judgement outlives
 *  the numbers that prompted it. */
export function saveRound(db: DB, key: RoundKey, rows: SaveRow[]): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM integrity_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(key.matchId, key.ordinal, key.half);
    db.prepare('DELETE FROM integrity_clips WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(key.matchId, key.ordinal, key.half);
    const insRound = db.prepare(
      `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insClip = db.prepare(
      `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insRound.run(key.matchId, key.ordinal, key.half, r.slot, r.steamid, ANALYZER_VERSION, JSON.stringify(r.metrics), now);
      for (const c of r.clips) {
        insClip.run(
          key.matchId, key.ordinal, key.half, r.slot, r.steamid, c.startMs, c.endMs,
          'ghost_track', c.fidelity, JSON.stringify({ ghostSlot: c.ghostSlot, meanErr: c.meanErr, meanDist: c.meanDist, travel: c.travel }),
          ANALYZER_VERSION,
        );
      }
    }
  });
  tx();
}

export interface PoolEntry { key: RoundKey; map: string; prior: PriorTable }

/**
 * Store some rounds' shares of the aim prior and re-pool the maps they touch.
 *
 * THE INVARIANT, and the only writer that can break it: a map's pool is the
 * sum of that map's shares at the current analyzer version, exactly. Both
 * tables are written here, in one transaction, and nowhere else.
 *
 * That is what leave-one-round-out rests on. `subtractRound` clamps a share
 * the pool never contained to zero instead of failing, so a pool and a share
 * that disagree shift every occupancy score silently. Version 3 had two ways
 * to get there: the pending pass wrote shares and never pooled them, and after
 * a version bump it subtracted new shares from the old analyzer's pool. With
 * the invariant, "this share can be loaded" means "the pool contains it".
 *
 * The pool is re-summed from the stored shares rather than adjusted in place,
 * so a round pooled twice is counted once, and a round whose replay has since
 * been pruned stays in its map's prior for as long as its share is current.
 *
 * Returns how many rounds each touched map had before and after, which is how
 * a caller notices a map crossing MIN_PRIOR_ROUNDS.
 */
export function poolRounds(db: DB, entries: PoolEntry[]): Map<string, { before: number; after: number }> {
  const out = new Map<string, { before: number; after: number }>();
  const upsert = db.prepare(
    `INSERT INTO integrity_prior_rounds (match_id, ordinal, half, frames, counts, map, analyzer_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id, ordinal, half) DO UPDATE SET frames = excluded.frames, counts = excluded.counts,
       map = excluded.map, analyzer_version = excluded.analyzer_version`,
  );
  const shares = db.prepare('SELECT frames, counts FROM integrity_prior_rounds WHERE map = ? AND analyzer_version = ?');
  const savePool = db.prepare(
    `INSERT INTO integrity_prior (map, frames, rounds, counts, analyzer_version) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(map) DO UPDATE SET frames = excluded.frames, rounds = excluded.rounds,
       counts = excluded.counts, analyzer_version = excluded.analyzer_version`,
  );
  db.transaction(() => {
    for (const map of new Set(entries.map((e) => e.map))) {
      out.set(map, { before: loadPrior(db, map)?.rounds ?? 0, after: 0 });
    }
    for (const e of entries) {
      upsert.run(e.key.matchId, e.key.ordinal, e.key.half, e.prior.frames, countsToJson(e.prior.counts), e.map, ANALYZER_VERSION);
    }
    for (const [map, n] of out) {
      const pool = new PriorBuilder();
      const rows = shares.all(map, ANALYZER_VERSION) as { frames: number; counts: string }[];
      for (const r of rows) pool.add({ frames: r.frames, counts: countsFromJson(r.counts) });
      savePool.run(map, pool.frames, rows.length, countsToJson(pool.counts), ANALYZER_VERSION);
      n.after = rows.length;
    }
  })();
  return out;
}

/** A map's pool, or null when there is none THIS analyzer built. An older
 *  version's pool is a different measurement and is never handed back. */
export function loadPrior(db: DB, map: string): { table: PriorTable; rounds: number } | null {
  const row = db.prepare('SELECT frames, rounds, counts FROM integrity_prior WHERE map = ? AND analyzer_version = ?')
    .get(map, ANALYZER_VERSION) as { frames: number; rounds: number; counts: string } | undefined;
  if (!row) return null;
  return { table: { frames: row.frames, counts: countsFromJson(row.counts) }, rounds: row.rounds };
}

/** A round's share, or null when it has none at this version, which by the
 *  invariant above is the same as "its map's pool does not contain it". */
export function loadRoundPrior(db: DB, key: RoundKey): PriorTable | null {
  const row = db.prepare(
    'SELECT frames, counts FROM integrity_prior_rounds WHERE match_id = ? AND ordinal = ? AND half = ? AND analyzer_version = ?',
  ).get(key.matchId, key.ordinal, key.half, ANALYZER_VERSION) as { frames: number; counts: string } | undefined;
  if (!row) return null;
  return { frames: row.frames, counts: countsFromJson(row.counts) };
}

/** Round keys whose share is in this map's pool. */
export function pooledRounds(db: DB, map: string): RoundKey[] {
  return (db.prepare('SELECT match_id, ordinal, half FROM integrity_prior_rounds WHERE map = ? AND analyzer_version = ?')
    .all(map, ANALYZER_VERSION) as { match_id: number; ordinal: number; half: number }[])
    .map((r) => ({ matchId: r.match_id, ordinal: r.ordinal, half: r.half }));
}

export function setReview(db: DB, key: RoundKey, slot: number, state: string, note: string, adminId: string): void {
  db.prepare(
    `INSERT INTO integrity_reviews (match_id, ordinal, half, slot, state, note, reviewed_by, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id, ordinal, half, slot) DO UPDATE SET state = excluded.state, note = excluded.note,
       reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
  ).run(key.matchId, key.ordinal, key.half, slot, state, note, adminId, new Date().toISOString());
}
