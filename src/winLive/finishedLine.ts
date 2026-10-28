import type { DB } from '../db.js';
import { completedPug } from '../matchKinds.js';
import { loadRoundReplay } from '../metrics/replayRound.js';
import { REPLAY_WAIT_MIN } from '../metrics/job.js';
import type { RoundKey, RoundReplay } from '../metrics/types.js';
import { finishedPlayed, winModel, type FutureHalf, type PlayedHalf, type WinModel } from '../winProb.js';
import { FORM_PARAMS } from '../winForm.js';
import { progressMade } from './halfModel.js';
import { momentOf, price, priceCtx, PROGRESS_MAPS, type Moment } from './liveState.js';
import { WIN_POINTS_VERSION } from './modelVersion.js';
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

/**
 * The in-half points of a finished match, one half at a time (each item is
 * one half's points), so a caller on the server's event loop can yield
 * between halves. Nothing when its score carries no line (finishedPlayed).
 * A half whose replay `loadReplay` cannot give (none, pruned, unreadable, or
 * it threw) has no points. Computes, writes nothing.
 */
export function* finishedPointsByHalf(
  db: DB, matchId: number, played: PlayedHalf[], loadReplay: (key: RoundKey) => RoundReplay | null, opts: FinishedOpts = {},
): Generator<FinishedPoint[]> {
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
    if (!rr) continue;
    const pts = finishedHalfSnapshots(db, key, r.map, rr, maps);
    if (pts.length === 0) continue;
    // Priced as the live side prices a played half: against the line as it
    // stood when the half began (this half first among those still to play).
    const plain = priceCtx(model, played.slice(0, j), slots.slice(j), 0, r.survTeam, null);
    const form = priceCtx(model, played.slice(0, j), slots.slice(j), 0, r.survTeam, FORM_PARAMS);
    yield pts.map((p) => ({
      ordinal: r.ordinal, half: key.half, tMs: p.snap.tMs,
      pA: price(model, plain, r.map, r.survTeam, key.half, gap, p.snap),
      pAForm: price(model, form, r.map, r.survTeam, key.half, gap, p.snap),
      moment: p.moment,
    }));
  }
}

/** All of finishedPointsByHalf at once, or null when the match's score
 *  carries no line. */
export function finishedPoints(
  db: DB, matchId: number, loadReplay: (key: RoundKey) => RoundReplay | null, opts: FinishedOpts = {},
): FinishedPoint[] | null {
  const played = finishedPlayed(db, matchId);
  if (!played) return null;
  return [...finishedPointsByHalf(db, matchId, played, loadReplay, opts)].flat();
}

/** Store a match's points on the current version, replacing whatever it had,
 *  and record the run (so a match with none is not picked again). */
export function writeFinishedPoints(db: DB, matchId: number, points: FinishedPoint[], now = sqliteNow()): void {
  const ins = db.prepare(
    `INSERT INTO match_win_points (match_id, ordinal, half, t_ms, p_a, p_a_form, moment, model_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM match_win_points WHERE match_id = ?').run(matchId);
    for (const p of points) ins.run(matchId, p.ordinal, p.half, p.tMs, p.pA, p.pAForm, p.moment, WIN_POINTS_VERSION);
    db.prepare(
      `INSERT INTO match_win_point_runs (match_id, model_version, points, computed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (match_id) DO UPDATE SET model_version = excluded.model_version, points = excluded.points, computed_at = excluded.computed_at`,
    ).run(matchId, WIN_POINTS_VERSION, points.length, now);
  })();
}

/** Compute a finished match's in-half points from its replays and store
 *  them (a match whose score carries no line stores none). Returns the
 *  number of points written. */
export function computeFinishedPoints(
  db: DB, matchId: number, loadReplay: (key: RoundKey) => RoundReplay | null, opts: FinishedOpts = {},
): number {
  const points = finishedPoints(db, matchId, loadReplay, opts) ?? [];
  writeFinishedPoints(db, matchId, points, opts.now);
  return points.length;
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
    LIMIT ?`).all(WIN_POINTS_VERSION, now, WIN_POINTS_RECENT_DAYS, now, REPLAY_WAIT_MIN, opts.limit) as { id: number }[])
    .map((r) => r.id);
}

/** Let the event loop run (a UDP line, a request) between halves. */
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * One reaper pass: compute and store the points of up to `limit` pending
 * matches from their local replays, yielding to the event loop between
 * halves (a half is about 20 ms of decoding and pricing; a whole match was
 * 150 to 180 ms on the 2026-10-28 data). A match that throws is logged and
 * recorded with no points, so it is not retried every tick; the pass never
 * rejects. Returns the matches done.
 */
export async function runWinPointsPass(db: DB, replayDir: string, opts: {
  limit: number; now?: string; load?: (key: RoundKey) => RoundReplay | null;
}): Promise<number> {
  let ids: number[];
  try { ids = pendingWinPointMatches(db, opts); } catch (err) {
    console.error('[win-points] pending query failed', err);
    return 0;
  }
  const load = opts.load ?? ((key: RoundKey) => loadRoundReplay(db, key, replayDir));
  for (const id of ids) {
    try {
      const played = finishedPlayed(db, id);
      const points: FinishedPoint[] = [];
      if (played) {
        for (const half of finishedPointsByHalf(db, id, played, load)) {
          points.push(...half);
          await yieldToLoop();
        }
      }
      writeFinishedPoints(db, id, points, opts.now);
    } catch (err) {
      console.error(`[win-points] match ${id} failed`, err);
      try { writeFinishedPoints(db, id, [], opts.now); } catch { /* picked again next tick */ }
    }
  }
  return ids.length;
}
