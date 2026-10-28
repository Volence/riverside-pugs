import type { DB } from '../db.js';
import { completedPug } from '../matchKinds.js';
import { loadRoundReplay } from '../metrics/replayRound.js';
import { REPLAY_WAIT_MIN } from '../metrics/job.js';
import type { RoundKey, RoundReplay } from '../metrics/types.js';
import { finishedPlayed, winModel, type FutureHalf, type PlayedHalf, type WinModel } from '../winProb.js';
import { FORM_PARAMS } from '../winForm.js';
import { progressMade } from './halfModel.js';
import { momentOf, price, priceCtx, PROGRESS_MAPS, type Moment } from './liveState.js';
import { winPointsVersion } from './modelVersion.js';
import { feedProgressPoints, halfSnapshots, progressStep, type Snapshot } from './snapshot.js';
import { furthestProg, type ProgressMap } from './progressMap.js';

/**
 * A finished match's win line during its halves, computed once after the
 * match ends and stored (match_win_points), so the match page shows the same
 * in-half detail the Live page did without ever reading a replay on a page
 * view. matchWinLine merges the rows in.
 *
 * Train/serve parity, as in src/winLive/liveState.ts: each half's replay is
 * decoded the way the model's training rows were (decodeRoundReplay, paused
 * frames dropped by unpausedFrames), cut into 5 s snapshots by the same
 * `halfSnapshots`, with progress the running max of the furthest survivor
 * on the map's trusted progress map, made from the half's first known
 * value. A map without a trusted progress map uses the LIVEHUD samples the
 * live side stored at half end (match_progress_samples), else the data
 * feeds (scripts/win-dataset.ts's fallback), both as a backward step, else
 * none (the model marginalises unknown progress). The moments and the
 * saferoom mark are the live side's, and each point is priced by the same
 * `price` against the line as it stood when its half began, so a match
 * watched live ends up with the points the Live page showed (for halves on
 * a mapped map; the stored LIVEHUD samples are one per 10 s, not every one).
 *
 * Each point is priced twice, plain and with team form (FORM_PARAMS), since
 * which one a viewer sees is decided on the page view (formOption).
 */

/** One stored point. */
export interface FinishedPoint {
  ordinal: number;
  half: 1 | 2;
  tMs: number;
  pA: number;
  pAForm: number;
  moment: Moment | null;
}

export interface FinishedOpts {
  /** The base model (winModel(db) unless given). */
  model?: WinModel;
  /** The trusted progress maps by lowercased map (PROGRESS_MAPS unless given). */
  progressMaps?: ReadonlyMap<string, ProgressMap>;
  now?: string;
}

/** Feed halves need this many usable progress samples, as in the dataset. */
const MIN_FEED_POINTS = 3;

const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** The half's progress through time: trusted map, stored LIVEHUD samples,
 *  data feeds, or unknown (in that order). */
function halfProgress(
  db: DB, key: RoundKey, map: string, rr: RoundReplay, maps: ReadonlyMap<string, ProgressMap>,
): (tMs: number) => number | null {
  const pm = maps.get(map.toLowerCase());
  if (pm) {
    const pts: { tMs: number; prog: number }[] = [];
    for (const f of rr.frames) {
      const v = furthestProg(pm, f);
      if (v !== null) pts.push({ tMs: f.tMs, prog: v });
    }
    if (pts.length > 0) return progressStep(pts);
  }
  const stored = db.prepare(
    'SELECT t_ms AS tMs, prog FROM match_progress_samples WHERE match_id = ? AND ordinal = ? AND half = ? ORDER BY t_ms',
  ).all(key.matchId, key.ordinal, key.half) as { tMs: number; prog: number }[];
  if (stored.length > 0) return progressStep(stored);
  const feeds = feedProgressPoints(db, key, rr.frames[rr.frames.length - 1]!.tMs)
    .filter((p) => Number.isFinite(p.prog) && p.prog >= 0 && p.prog <= 100);
  if (feeds.length >= MIN_FEED_POINTS) return progressStep(feeds);
  return () => null;
}

/** A half's snapshots as the live side turns them into points: progress made
 *  from the first known value, the moment against the previous snapshot,
 *  the last one marked 'saferoom' when the survivors made it. */
export function finishedHalfSnapshots(
  db: DB, key: RoundKey, map: string, rr: RoundReplay, maps: ReadonlyMap<string, ProgressMap> = PROGRESS_MAPS,
): { snap: Snapshot; moment: Moment | null }[] {
  const snaps = halfSnapshots(rr, halfProgress(db, key, map, rr, maps), null);
  const prog0 = snaps.find((s) => s.prog !== null)?.prog ?? null;
  const out = snaps.map((s, i) => ({
    snap: { ...s, prog: progressMade(s.prog, prog0) },
    moment: momentOf(i > 0 ? snaps[i - 1]! : null, s) ?? null,
  }));
  const alive = (db.prepare('SELECT survivors_alive AS alive FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
    .get(key.matchId, key.ordinal, key.half) as { alive: number | null } | undefined)?.alive ?? null;
  if (out.length > 0 && alive !== null && alive > 0) out[out.length - 1]!.moment = 'saferoom';
  return out;
}

/** One half of finishedPointsByHalf: its points, or null when its replay
 *  could not be had. */
export interface HalfPoints { ordinal: number; half: 1 | 2; points: FinishedPoint[] | null }

/**
 * The in-half points of a finished match, one half at a time, so a caller
 * on the server's event loop can yield between halves. A half whose replay
 * `loadReplay` cannot give (none yet, pruned, unreadable, or it threw) comes
 * back with null points. Computes, writes nothing.
 */
export function* finishedPointsByHalf(
  db: DB, matchId: number, played: PlayedHalf[], loadReplay: (key: RoundKey) => RoundReplay | null, opts: FinishedOpts = {},
): Generator<HalfPoints> {
  const model = opts.model ?? winModel(db);
  const maps = opts.progressMaps ?? PROGRESS_MAPS;
  const slots: FutureHalf[] = played.map((r) => ({ team: r.survTeam, map: r.map }));
  let a = 0, b = 0;
  for (const [j, r] of played.entries()) {
    const gap = a - b;
    if (r.survTeam === 'a') a += r.score; else b += r.score;
    const key: RoundKey = { matchId, ordinal: r.ordinal, half: r.half as 1 | 2 };
    let rr: RoundReplay | null;
    try { rr = loadReplay(key); } catch { rr = null; }
    if (!rr) { yield { ordinal: r.ordinal, half: key.half, points: null }; continue; }
    const pts = finishedHalfSnapshots(db, key, r.map, rr, maps);
    // Priced as the live side prices a played half: against the line as it
    // stood when the half began (this half first among those still to play).
    const plain = priceCtx(model, played.slice(0, j), slots.slice(j), 0, r.survTeam, null);
    const form = priceCtx(model, played.slice(0, j), slots.slice(j), 0, r.survTeam, FORM_PARAMS);
    yield {
      ordinal: r.ordinal, half: key.half,
      points: pts.map((p) => ({
        ordinal: r.ordinal, half: key.half, tMs: p.snap.tMs,
        pA: price(model, plain, r.map, r.survTeam, key.half, gap, p.snap),
        pAForm: price(model, form, r.map, r.survTeam, key.half, gap, p.snap),
        moment: p.moment,
      })),
    };
  }
}

/** A match's points and how many of its halves had no replay to give them. */
export interface FinishedResult { points: FinishedPoint[]; halvesMissing: number }

/** All of finishedPointsByHalf at once, or null when the match's score
 *  carries no line (finishedPlayed). */
export function finishedPoints(
  db: DB, matchId: number, loadReplay: (key: RoundKey) => RoundReplay | null, opts: FinishedOpts = {},
): FinishedResult | null {
  const played = finishedPlayed(db, matchId);
  if (!played) return null;
  const out: FinishedResult = { points: [], halvesMissing: 0 };
  for (const h of finishedPointsByHalf(db, matchId, played, loadReplay, opts)) {
    if (h.points) out.points.push(...h.points); else out.halvesMissing++;
  }
  return out;
}

/** Store a match's points on the current version, replacing whatever it had,
 *  and record the run (so a match with none is not picked again by the
 *  reaper). `halvesMissing` counts the halves with no replay: a partial line,
 *  which scripts/win-backfill.ts picks up again. */
export function writeFinishedPoints(
  db: DB, matchId: number, points: FinishedPoint[], opts: { halvesMissing?: number; now?: string } = {},
): void {
  const ins = db.prepare(
    `INSERT INTO match_win_points (match_id, ordinal, half, t_ms, p_a, p_a_form, moment, model_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const version = winPointsVersion();
  db.transaction(() => {
    db.prepare('DELETE FROM match_win_points WHERE match_id = ?').run(matchId);
    for (const p of points) ins.run(matchId, p.ordinal, p.half, p.tMs, p.pA, p.pAForm, p.moment, version);
    db.prepare(
      `INSERT INTO match_win_point_runs (match_id, model_version, points, halves_missing, computed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (match_id) DO UPDATE SET model_version = excluded.model_version, points = excluded.points,
         halves_missing = excluded.halves_missing, computed_at = excluded.computed_at`,
    ).run(matchId, version, points.length, opts.halvesMissing ?? 0, opts.now ?? sqliteNow());
  })();
}

/** Compute a finished match's in-half points from its replays and store
 *  them (a match whose score carries no line stores none). Returns the
 *  number of points written. */
export function computeFinishedPoints(
  db: DB, matchId: number, loadReplay: (key: RoundKey) => RoundReplay | null, opts: FinishedOpts = {},
): number {
  const res = finishedPoints(db, matchId, loadReplay, opts) ?? { points: [], halvesMissing: 0 };
  writeFinishedPoints(db, matchId, res.points, { halvesMissing: res.halvesMissing, now: opts.now });
  return res.points.length;
}

/** The reaper looks back this far; older matches are scripts/win-backfill.ts's. */
export const WIN_POINTS_RECENT_DAYS = 3;

/**
 * Completed, unvoided PUGs that ended in the last WIN_POINTS_RECENT_DAYS
 * with no points on the current version, newest first. A match is picked
 * once every half has its replay indexed, or REPLAY_WAIT_MIN after it ended
 * (a remote server's files arrive by a pull that can lag), whichever comes
 * first.
 */
export function pendingWinPointMatches(db: DB, opts: { limit: number; now?: string }): number[] {
  const now = opts.now ?? sqliteNow();
  return (db.prepare(`
    SELECT m.id FROM matches m
    LEFT JOIN match_win_point_runs w ON w.match_id = m.id AND w.model_version = ?
    WHERE ${completedPug('m')} AND m.voided_at IS NULL AND w.match_id IS NULL AND m.ended_at IS NOT NULL
      AND m.ended_at >= datetime(?, '-' || ? || ' days')
      AND (m.ended_at <= datetime(?, '-' || ? || ' minutes') OR NOT EXISTS (
        SELECT 1 FROM match_rounds r
        WHERE r.match_id = m.id AND NOT EXISTS (
          SELECT 1 FROM match_replays rp WHERE rp.match_id = r.match_id AND rp.ordinal = r.ordinal AND rp.half = r.half)))
    ORDER BY m.ended_at DESC, m.id DESC
    LIMIT ?`).all(winPointsVersion(), now, WIN_POINTS_RECENT_DAYS, now, REPLAY_WAIT_MIN, opts.limit) as { id: number }[])
    .map((r) => r.id);
}

/** Let the event loop run (a UDP line, a request) between halves. */
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** A match whose computation threw is skipped by the reaper for this long
 *  (in this process), so it neither spins every tick nor holds up the
 *  matches behind it; no run is recorded, so it is tried again after. */
const FAILED_RETRY_MS = 60 * 60_000;
const failedAt = new Map<number, number>();

/**
 * One reaper pass: compute and store the points of up to `limit` pending
 * matches from their local replays, yielding to the event loop between
 * halves (a half is about 20 ms of decoding and pricing; a whole match was
 * 150 to 180 ms on the 2026-10-28 data). A match that throws is logged and
 * left without a run (a transient failure must not become permanent; the
 * recent window bounds the retries), skipped for FAILED_RETRY_MS. The pass
 * never rejects. Returns the matches whose points were stored.
 */
export async function runWinPointsPass(db: DB, replayDir: string, opts: {
  limit: number; now?: string; nowMs?: number; load?: (key: RoundKey) => RoundReplay | null;
}): Promise<number> {
  const nowMs = opts.nowMs ?? Date.now();
  for (const [id, at] of failedAt) if (nowMs - at >= FAILED_RETRY_MS) failedAt.delete(id);
  let ids: number[];
  try {
    ids = pendingWinPointMatches(db, { limit: opts.limit + failedAt.size, now: opts.now })
      .filter((id) => !failedAt.has(id)).slice(0, opts.limit);
  } catch (err) {
    console.error('[win-points] pending query failed', err);
    return 0;
  }
  const load = opts.load ?? ((key: RoundKey) => loadRoundReplay(db, key, replayDir));
  let done = 0;
  for (const id of ids) {
    try {
      const played = finishedPlayed(db, id);
      const res: FinishedResult = { points: [], halvesMissing: 0 };
      if (played) {
        for (const h of finishedPointsByHalf(db, id, played, load)) {
          if (h.points) res.points.push(...h.points); else res.halvesMissing++;
          await yieldToLoop();
        }
      }
      writeFinishedPoints(db, id, res.points, { halvesMissing: res.halvesMissing, now: opts.now });
      done++;
    } catch (err) {
      console.error(`[win-points] match ${id} failed`, err);
      failedAt.set(id, nowMs);
    }
  }
  return done;
}
