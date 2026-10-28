/**
 * Win probability from the scoreboard alone: after every half of a match,
 * how often a team in that spot goes on to win.
 *
 * The model is deliberately plain. Every remaining survivor half is a draw
 * from that map's own history of half scores (every completed PUG round ever
 * played on it), the halves are added up per team by convolution, and the
 * answer is the chance team A's final total beats team B's. Ratings play no
 * part: both teams start at 50%, so the line says what the score says and
 * never "this team was meant to lose", which is the reason the rating
 * forecast is admin only (see ForecastPanel in web/src/routes/MatchDetail.tsx).
 *
 * Maps with little history borrow from the rest: their score distribution is
 * blended with a pooled shape (made-saferoom and wiped halves, each scaled to
 * the map's own typical made score) in proportion to how few rounds the map
 * has. A map never played at all is the pooled shape outright.
 *
 * Fitted and checked on the 2026-10-10 backup (491 completed PUGs, 3,898
 * halves): trained on the oldest 70% and tested on the newest 30%, the halves
 * it called 80-90% were won 83% of the time and the ones it called 90%+ 96%
 * (Brier 0.163). Treating halves as independent leaves it a little
 * underconfident, because a team that has outscored the other so far tends to
 * keep doing so; CALIBRATION is the one temperature that corrects for that.
 *
 * Team form (src/winForm.ts, the win_chance_form setting) is an option on
 * top: it tilts each team's remaining halves by how it has played so far in
 * the match and brings its own temperature. Without it every line is the
 * plain one described here.
 */
import type { DB } from './db.js';
import { completedPug } from './matchKinds.js';
import { unrecordedOrdinals } from './roundStats.js';
import { campaignRegistry } from './campaignRegistry.js';
import { stopAfterMap } from './stopPoint.js';
import { teamForm, tilt, type FormParams } from './winForm.js';
import { DEFAULT_DELAY_MS } from './replayTail.js';
import { winPointsVersion } from './winLive/modelVersion.js';

/** Score bucket width. Half scores run 0 to about 1,800; 20 keeps every
 *  convolution small without blurring a lead that decides a match. */
export const BIN = 20;
/** Highest half score kept apart; anything above lands in the last bucket. */
const MAX_HALF = 2000;
const NB = MAX_HALF / BIN + 1;
/** Rounds of a map's own history worth as much as the pooled shape. */
const SHRINK_ROUNDS = 30;
/** Prior weights when a map's make rate and made score are thin. */
const RATE_PRIOR = 20;
const SCALE_PRIOR = 10;
/** Logit temperature fitted on the backup above (1.15 by maximum likelihood). */
export const CALIBRATION = 1.15;
/** A model older than this is rebuilt on the next request. */
const MAX_AGE_MS = 30 * 60_000;

/** One half of history. `half` (1 or 2, which survivor turn on the map it
 *  was) is only read by the per-half base (BuildOpts.perHalf). */
export interface HalfRow { map: string; score: number; made: boolean | null; half?: 1 | 2 }

export interface WinModel {
  builtAt: number;
  /** How many halves the model was built from, shown on the page. */
  halves: number;
  dist(map: string): Float64Array;
  /** The map's typical made score (median made half, shrunk toward the
   *  pool's), the unit the pooled shapes and the live half model use. A map
   *  with no history gets the pooled value. */
  scale(map: string): number;
  /** The map's distribution for one survivor turn (1: the team surviving
   *  first on the map), only on a model built with BuildOpts.perHalf. The
   *  live line uses it (src/winLive); the public line never does. */
  distHalf?(map: string, half: 1 | 2): Float64Array;
}

export interface BuildOpts {
  /** Also build distHalf. dist and scale come out the same either way. */
  perHalf?: boolean;
}

/** The base distribution of a half: the per-half one when the model has
 *  it, else the map's. */
export function halfBase(model: WinModel, map: string, half: 1 | 2): Float64Array {
  return model.distHalf ? model.distHalf(map, half) : model.dist(map);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function histogram(scores: Iterable<number>): Float64Array {
  const h = new Float64Array(NB);
  let n = 0;
  for (const s of scores) {
    h[Math.min(NB - 1, Math.max(0, Math.round(s / BIN)))] += 1;
    n += 1;
  }
  if (n > 0) for (let i = 0; i < NB; i++) h[i] /= n;
  return h;
}

/** Build the model from raw halves. Pure, so tests can feed it directly. */
export function buildWinModel(rows: HalfRow[], now = Date.now(), opts: BuildOpts = {}): WinModel {
  const byMap = new Map<string, HalfRow[]>();
  for (const r of rows) {
    const list = byMap.get(r.map);
    if (list) list.push(r); else byMap.set(r.map, [r]);
  }
  // A half whose survivors_alive was never captured still has a true score,
  // so it counts toward its map's own history; it just cannot say whether
  // the saferoom was made, so it stays out of the make/wipe split.
  const known = rows.filter((r) => r.made !== null);
  const madeScores = known.filter((r) => r.made).map((r) => r.score);
  const poolScale = madeScores.length ? median(madeScores) : 600;
  const poolRate = known.length ? madeScores.length / known.length : 0.4;

  const scale = new Map<string, number>();
  const rate = new Map<string, number>();
  for (const [map, list] of byMap) {
    const k = list.filter((r) => r.made !== null);
    const mk = k.filter((r) => r.made).map((r) => r.score);
    scale.set(map, mk.length
      ? (median(mk) * mk.length + poolScale * SCALE_PRIOR) / (mk.length + SCALE_PRIOR)
      : poolScale);
    rate.set(map, (mk.length + poolRate * RATE_PRIOR) / (k.length + RATE_PRIOR));
  }
  // The pooled shapes, in units of each map's typical made score.
  const normMade: number[] = [];
  const normWiped: number[] = [];
  for (const r of known) {
    const s = scale.get(r.map) ?? poolScale;
    (r.made ? normMade : normWiped).push(r.score / s);
  }

  const cache = new Map<string, Float64Array>();
  const dist = (map: string): Float64Array => {
    const hit = cache.get(map);
    if (hit) return hit;
    const s = scale.get(map) ?? poolScale;
    const p = rate.get(map) ?? poolRate;
    const made = histogram(normMade.map((x) => x * s));
    const wiped = histogram(normWiped.map((x) => x * s));
    const own = byMap.get(map) ?? [];
    const ownHist = histogram(own.map((r) => r.score));
    const w = own.length / (own.length + SHRINK_ROUNDS);
    const out = new Float64Array(NB);
    // With no halves at all (an empty DB) every shape is zero; a single
    // bucket at 0 keeps the arithmetic defined and the answer at 50%.
    if (normMade.length + normWiped.length + own.length === 0) out[0] = 1;
    else {
      for (let i = 0; i < NB; i++) {
        const pooled = normMade.length && normWiped.length
          ? p * made[i] + (1 - p) * wiped[i]
          : normMade.length ? made[i] : wiped[i];
        out[i] = w * ownHist[i] + (1 - w) * pooled;
      }
    }
    cache.set(map, out);
    return out;
  };
  const model: WinModel = { builtAt: now, halves: rows.length, dist, scale: (map) => scale.get(map) ?? poolScale };
  if (opts.perHalf) model.distHalf = perHalfDist(rows, byMap, scale, poolScale);
  return model;
}

/**
 * The per-half distributions (BuildOpts.perHalf). On the 2026-10-28 data the
 * team surviving first on a map made the saferoom 34% of the time and the
 * one surviving second 24%, which one distribution per map cannot show.
 *
 * Built in the same spirit as dist: a map's own half-h histogram, shrunk by
 * SHRINK_ROUNDS toward a prior that is itself the map's both-halves
 * histogram shrunk toward a pooled per-half shape. The pooled shape is
 * dist's pooled shape made from half-h rows only, with a half-h make rate
 * shrunk toward the pool's half-h rate. So a busy map is mostly its own
 * half-h history, a thin map borrows the half difference from the pool, and
 * a map never played is the pooled per-half shape outright. Rows without a
 * half count for the map's both-halves histogram only.
 *
 * It lost the 2026-10-28 backtest (scripts/win-backtest.ts --part live):
 * pooled half-end Brier 0.1761 against 0.1720 for dist, and it opened team A
 * at 63% on the matches A won 49% of. From map 2 on the leader survives
 * first, so most of the half 1 advantage is the better team going first,
 * which the line already prices through the score. Kept for that record;
 * nothing builds it outside the backtest.
 */
function perHalfDist(
  rows: HalfRow[], byMap: Map<string, HalfRow[]>, scale: Map<string, number>, poolScale: number,
): (map: string, half: 1 | 2) => Float64Array {
  const known = rows.filter((r) => r.made !== null);
  const allMade = known.filter((r) => r.made).length;
  const pooled = ([1, 2] as const).map((h) => {
    // With no row for this half, the half falls back to every known row, so
    // both halves come out the same: no information, no difference.
    const own = known.filter((r) => r.half === h);
    const k = own.length ? own : known;
    const made = k.filter((r) => r.made).length;
    const rate = k.length ? made / k.length : known.length ? allMade / known.length : 0.4;
    const normMade: number[] = [];
    const normWiped: number[] = [];
    for (const r of k) (r.made ? normMade : normWiped).push(r.score / (scale.get(r.map) ?? poolScale));
    return { rows: own.length ? h : null, rate, normMade, normWiped };
  });
  const cache = new Map<string, Float64Array>();
  return (map, half) => {
    const key = `${half}\u0000${map}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const pool = pooled[half - 1];
    const s = scale.get(map) ?? poolScale;
    const all = byMap.get(map) ?? [];
    const own = pool.rows === null ? all : all.filter((r) => r.half === half);
    const ownKnown = own.filter((r) => r.made !== null);
    const p = (ownKnown.filter((r) => r.made).length + pool.rate * RATE_PRIOR) / (ownKnown.length + RATE_PRIOR);
    const made = histogram(pool.normMade.map((x) => x * s));
    const wiped = histogram(pool.normWiped.map((x) => x * s));
    const allHist = histogram(all.map((r) => r.score));
    const ownHist = histogram(own.map((r) => r.score));
    const w = all.length / (all.length + SHRINK_ROUNDS);
    const wh = own.length / (own.length + SHRINK_ROUNDS);
    const out = new Float64Array(NB);
    if (pool.normMade.length + pool.normWiped.length + all.length === 0) out[0] = 1;
    else {
      for (let i = 0; i < NB; i++) {
        const shape = pool.normMade.length && pool.normWiped.length
          ? p * made[i] + (1 - p) * wiped[i]
          : pool.normMade.length ? made[i] : wiped[i];
        out[i] = wh * ownHist[i] + (1 - wh) * (w * allHist[i] + (1 - w) * shape);
      }
    }
    cache.set(key, out);
    return out;
  };
}

function convolve(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] += ai * b[j];
  }
  return out;
}

/** The distribution of the sum of these halves. */
export function sumDists(dists: Float64Array[]): Float64Array {
  let d: Float64Array = new Float64Array([1]);
  for (const x of dists) d = convolve(d, x);
  return d;
}

/** Team form for winChance (src/winForm.ts): each team's remaining survivor
 *  halves tilted by that much, and the temperature fitted with form in place
 *  of CALIBRATION. All optional; none given is today's line. */
export interface WinChanceOpts { tiltA?: number; tiltB?: number; calibration?: number }

/**
 * Chance team A wins from here: `gap` is A's score minus B's so far, and each
 * list names the maps of that team's survivor halves still to play. A tie
 * counts as half a win either way. Calibrated; returns exactly 1, 0 or 0.5
 * once nothing is left to play.
 */
export function winChance(model: WinModel, gap: number, mapsA: string[], mapsB: string[], opts: WinChanceOpts = {}): number {
  return winChanceDists(
    gap,
    mapsA.map((m) => tilt(model.dist(m), opts.tiltA ?? 0)),
    mapsB.map((m) => tilt(model.dist(m), opts.tiltB ?? 0)),
    opts.calibration,
  );
}

/**
 * winChance from the score distributions of each team's halves still to
 * play, for callers that price a half by something other than its map's
 * history (the per-half base, a half in progress). Same arithmetic.
 */
export function winChanceDists(gap: number, distsA: Float64Array[], distsB: Float64Array[], calibration = CALIBRATION): number {
  if (distsA.length === 0 && distsB.length === 0) return gap > 0 ? 1 : gap < 0 ? 0 : 0.5;
  const ra = sumDists(distsA);
  const rb = sumDists(distsB);
  // P(gap + RA*BIN - RB*BIN > 0), summed without building the difference
  // distribution. Each bucket stands for scores spread evenly across its
  // width, so for each RA bucket the RB buckets wholly below team A's total
  // are a prefix, and the bucket A's total falls inside counts for the part
  // of it below. A total exactly on a bucket centre takes half: a tie. This
  // keeps a 1 point lead worth a little, not a whole bucket.
  const cumB = new Float64Array(rb.length + 1);
  for (let j = 0; j < rb.length; j++) cumB[j + 1] = cumB[j] + rb[j];
  const g = gap / BIN;
  let win = 0;
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] === 0) continue;
    const limit = i + g;
    if (limit <= -0.5) continue;
    if (limit >= rb.length - 0.5) { win += ra[i]; continue; }
    const j0 = Math.round(limit);
    win += ra[i] * (cumB[j0] + rb[j0] * (limit - j0 + 0.5));
  }
  const raw = Math.min(1 - 1e-9, Math.max(1e-9, win));
  const z = calibration * Math.log(raw / (1 - raw));
  return 1 / (1 + Math.exp(-z));
}

let cached: { db: DB; model: WinModel } | null = null;

/** Every half of every completed, unvoided PUG, the model's training set. */
export function trainingHalves(db: DB): HalfRow[] {
  return (db.prepare(
    `SELECT mm.map AS map, mr.score AS score, mr.survivors_alive AS alive
     FROM match_rounds mr
     JOIN match_maps mm ON mm.match_id = mr.match_id AND mm.ordinal = mr.ordinal
     JOIN matches m ON m.id = mr.match_id
     WHERE ${completedPug('m')} AND m.voided_at IS NULL AND mr.reliable = 1`,
  ).all() as { map: string; score: number; alive: number | null }[])
    .map((r) => ({ map: r.map, score: r.score, made: r.alive === null ? null : r.alive > 0 }));
}

/** The model for this DB, rebuilt when it is older than MAX_AGE_MS. */
export function winModel(db: DB, now = Date.now()): WinModel {
  if (cached && cached.db === db && now - cached.model.builtAt < MAX_AGE_MS) return cached.model;
  const model = buildWinModel(trainingHalves(db), now);
  cached = { db, model };
  return model;
}

export interface WinPoint {
  /** Null for the opening point, before anything was played. */
  ordinal: number | null;
  half: number | null;
  survTeam: 'a' | 'b' | null;
  map: string | null;
  scoreA: number;
  scoreB: number;
  /** Team A's chance of winning after this half. */
  pA: number;
  /** A point during a half (src/winLive/liveState.ts): ms into the half,
   *  RoundMs. Unset on half-end points. */
  tMs?: number;
  /** What just happened, on a point during a half. */
  moment?: 'tank_spawn' | 'tank_death' | 'wipe' | 'saferoom';
}

export interface WinLine {
  points: WinPoint[];
  /** Index into points of the half with the biggest swing (from the point
   *  before it), or null when nothing moved. */
  turning: number | null;
  /** The winner's lowest chance along the way, and where; null for a draw
   *  and for a match still being played. */
  winnerLow: { index: number; p: number } | null;
  /** How many halves of history the odds come from. */
  halves: number;
  /** Survivor halves still to play after the last point: 0 once finished. */
  halvesLeft: number;
}

/** One survivor half already played, in play order. */
export interface PlayedHalf { ordinal: number; half: number; survTeam: 'a' | 'b'; score: number; map: string }
/** One survivor half still to come: whose, and on which map. */
export interface FutureHalf { team: 'a' | 'b'; map: string }

/** Options for a line: `form` turns team form on (src/winForm.ts formOption
 *  says when), with `siDmg` the per-half SI damage terms where feeds exist.
 *  No caller passes siDmg today: SI damage did not improve the 2026-10-28
 *  backtest, so the fitted siDamage strength is 0 and the term is unused. */
export interface WinLineOpts { form?: FormParams; siDmg?: Map<string, number> }

/**
 * The line through `played`, pricing each point against every later played
 * half plus `future`. Shared by finished matches (no future) and live ones.
 * With form, each point tilts the halves after it by the form of the halves
 * up to it, never later ones.
 */
export function winLineFrom(model: WinModel, played: PlayedHalf[], future: FutureHalf[], opts: WinLineOpts = {}): WinLine {
  const slots: FutureHalf[] = [...played.map((r) => ({ team: r.survTeam, map: r.map })), ...future];
  const rest = (from: number, team: 'a' | 'b') => slots.slice(from).filter((x) => x.team === team).map((x) => x.map);
  const { form } = opts;
  /** Chance after the first `n` played halves, with gap `gap`. */
  const chance = (n: number, gap: number): number => {
    if (!form) return winChance(model, gap, rest(n, 'a'), rest(n, 'b'));
    const t = teamForm(model, played.slice(0, n), opts.siDmg, form);
    return winChance(model, gap, rest(n, 'a'), rest(n, 'b'), { tiltA: t.a, tiltB: t.b, calibration: form.calibration });
  };
  const points: WinPoint[] = [
    { ordinal: null, half: null, survTeam: null, map: null, scoreA: 0, scoreB: 0, pA: chance(0, 0) },
  ];
  let a = 0;
  let b = 0;
  played.forEach((r, i) => {
    if (r.survTeam === 'a') a += r.score; else b += r.score;
    points.push({
      ordinal: r.ordinal, half: r.half, survTeam: r.survTeam, map: r.map,
      scoreA: a, scoreB: b, pA: chance(i + 1, a - b),
    });
  });

  let turning: number | null = null;
  let biggest = 0;
  for (let i = 1; i < points.length; i++) {
    const swing = Math.abs(points[i].pA - points[i - 1].pA);
    if (swing > biggest + 1e-9) { biggest = swing; turning = i; }
  }
  if (biggest < 0.01) turning = null;

  let winnerLow: WinLine['winnerLow'] = null;
  const w = future.length > 0 ? null : a > b ? 'a' : b > a ? 'b' : null;
  if (w) {
    points.forEach((pt, index) => {
      const p = w === 'a' ? pt.pA : 1 - pt.pA;
      if (!winnerLow || p < winnerLow.p - 1e-9) winnerLow = { index, p };
    });
  }
  return { points, turning, winnerLow, halves: model.halves, halvesLeft: future.length };
}

type RoundRow = PlayedHalf & { endedAt: string | null; reliable: number };

/** Rounds with their map. For a live match the map row is LEFT joined:
 *  match_live_maps only gains a map at MAP_RESULT, after both halves, so a
 *  finished half 1 has no row yet and its map comes back null (the caller
 *  fills it from the plan). */
function roundsWithMaps(db: DB, matchId: number, table: 'match_maps' | 'match_live_maps'): (Omit<RoundRow, 'map'> & { map: string | null })[] {
  return db.prepare(
    `SELECT mr.ordinal, mr.half, mr.surv_team AS survTeam, mr.score, mm.map, mr.ended_at AS endedAt, mr.reliable
     FROM match_rounds mr
     ${table === 'match_maps' ? 'JOIN' : 'LEFT JOIN'} ${table} mm ON mm.match_id = mr.match_id AND mm.ordinal = mr.ordinal
     WHERE mr.match_id = ? ORDER BY mr.ordinal, mr.half`,
  ).all(matchId) as (Omit<RoundRow, 'map'> & { map: string | null })[];
}

/** Whether rounds are whole maps in order (half 1 then half 2, the two
 *  halves on opposite teams), allowing a lone half 1 at the end only when
 *  `openEnd` (a live match standing between its halves). */
function wellFormed(rounds: PlayedHalf[], openEnd: boolean): boolean {
  for (let i = 0; i < rounds.length; i += 2) {
    const h1 = rounds[i];
    const h2 = rounds[i + 1];
    if (h1.ordinal !== i / 2 || h1.half !== 1) return false;
    if (!h2) return openEnd;
    if (h2.ordinal !== h1.ordinal || h2.half !== 2 || h1.survTeam === h2.survTeam) return false;
  }
  return true;
}

/**
 * A finished match's survivor halves in play order, or null when its score
 * cannot carry a line: not completed, a map without both halves, or a map
 * whose stored score is not a result (see unrecordedOrdinals).
 */
export function finishedPlayed(db: DB, matchId: number): PlayedHalf[] | null {
  const match = db.prepare(
    'SELECT state, team_a_score AS a, team_b_score AS b FROM matches WHERE id = ?',
  ).get(matchId) as { state: string; a: number; b: number } | undefined;
  if (!match || match.state !== 'completed') return null;

  const rounds = roundsWithMaps(db, matchId, 'match_maps') as RoundRow[];
  if (rounds.length === 0) return null;
  const mapCount = (db.prepare('SELECT COUNT(*) AS n FROM match_maps WHERE match_id = ?').get(matchId) as { n: number }).n;
  if (rounds.length !== mapCount * 2 || !wellFormed(rounds, false)) return null;
  if (unrecordedOrdinals(db, matchId).size > 0) return null;
  const sumA = rounds.filter((r) => r.survTeam === 'a').reduce((n, r) => n + r.score, 0);
  const sumB = rounds.filter((r) => r.survTeam === 'b').reduce((n, r) => n + r.score, 0);
  // The rounds have to add up to the result the page shows, or the line
  // would end somewhere the scoreboard does not.
  if (sumA !== match.a || sumB !== match.b) return null;
  return rounds.map(({ ordinal, half, survTeam, score, map }) => ({ ordinal, half, survTeam, score, map }));
}

/** matchWinLine's options: `live` adds the stored points during halves
 *  (match_win_points, src/winLive/finishedLine.ts; the win_chance_live
 *  setting, winLiveOption), the form price when `form` is given. */
export interface FinishedLineOpts extends WinLineOpts { live?: boolean }

/**
 * The line for one finished match, or null when its score cannot carry one
 * (see finishedPlayed). With `live`, each half's stored in-half points (on
 * the current winPointsVersion(); rows on another are ignored) go just
 * before its half-end point; with none stored it is the half-end line.
 */
export function matchWinLine(db: DB, matchId: number, model: WinModel = winModel(db), opts: FinishedLineOpts = {}): WinLine | null {
  const played = finishedPlayed(db, matchId);
  if (!played) return null;
  const line = winLineFrom(model, played, [], opts);
  if (!opts.live) return line;
  return withInHalf(line, storedInHalfPoints(db, matchId, played, opts.form !== undefined), []);
}

/** The stored in-half points of a finished match by `${ordinal}:${half}`,
 *  each with the score its half started from. */
function storedInHalfPoints(db: DB, matchId: number, played: PlayedHalf[], form: boolean): Map<string, WinPoint[]> {
  const rows = db.prepare(
    `SELECT ordinal, half, t_ms AS tMs, p_a AS pA, p_a_form AS pAForm, moment FROM match_win_points
     WHERE match_id = ? AND model_version = ? ORDER BY ordinal, half, t_ms`,
  ).all(matchId, winPointsVersion()) as { ordinal: number; half: number; tMs: number; pA: number; pAForm: number; moment: WinPoint['moment'] | null }[];
  const out = new Map<string, WinPoint[]>();
  if (rows.length === 0) return out;
  const halves = new Map<string, { r: PlayedHalf; scoreA: number; scoreB: number }>();
  let a = 0, b = 0;
  for (const r of played) {
    halves.set(`${r.ordinal}:${r.half}`, { r, scoreA: a, scoreB: b });
    if (r.survTeam === 'a') a += r.score; else b += r.score;
  }
  for (const row of rows) {
    const k = `${row.ordinal}:${row.half}`;
    const h = halves.get(k);
    if (!h) continue;
    const list = out.get(k) ?? [];
    list.push({
      ordinal: row.ordinal, half: row.half, survTeam: h.r.survTeam, map: h.r.map, scoreA: h.scoreA, scoreB: h.scoreB,
      pA: form ? row.pAForm : row.pA, tMs: row.tMs, ...(row.moment ? { moment: row.moment } : {}),
    });
    out.set(k, list);
  }
  return out;
}

/** liveWinLine's options: `live` adds the points during halves
 *  (src/winLive/liveState.ts, the win_chance_live setting, winLiveOption),
 *  from state at least `delayMs` old (DEFAULT_DELAY_MS unless given: 0 is
 *  the caster overlay's undelayed view and must be asked for). */
export interface LiveLineOpts extends WinLineOpts { live?: boolean; nowMs?: number; delayMs?: number }

/** What gives liveWinLine its points during halves: the in-half points of
 *  each played half by `${ordinal}:${half}`, and the visible ones of the
 *  half in progress. */
export type InHalfProvider = (
  db: DB, matchId: number, model: WinModel, played: PlayedHalf[], future: FutureHalf[],
  opts: { form?: FormParams; nowMs: number; delayMs: number },
) => { finished: Map<string, WinPoint[]>; current: WinPoint[] };

/** src/winLive/liveState.ts registers itself here when it loads (the server
 *  and every caller that asks for `live` import it). A hook rather than an
 *  import because the web project's type check reads this module, and the
 *  replay reader behind the live points would pull the server's routes in
 *  with it. With nothing registered, `live` changes nothing. */
let inHalfProvider: InHalfProvider | null = null;
export function provideInHalfPoints(fn: InHalfProvider): void { inHalfProvider = fn; }

/**
 * The line so far for a match being played, priced against the maps it still
 * has to play: the campaign's chapters up to its stop map (see stopAfterMap).
 * Null when that plan is unknown (no missions directory, an unregistered
 * campaign), when the maps played do not follow it, or when the rounds so far
 * are not whole halves in order. A half in progress counts as still to play,
 * and with `live` its points so far come after the last half-end point
 * (each played half's own points before its half-end point).
 */
export function liveWinLine(db: DB, matchId: number, campaign: string, model: WinModel = winModel(db), opts: LiveLineOpts = {}): WinLine | null {
  // Scrims and event games choose their own maps (a stage's chapter count, a
  // tiebreak map), which the campaign's stop map does not know about.
  const kind = (db.prepare('SELECT kind FROM matches WHERE id = ?').get(matchId) as { kind: string } | undefined)?.kind;
  if (kind !== 'pug') return null;
  const chapters = campaignRegistry(db).get(campaign)?.maps ?? [];
  const stop = stopAfterMap(db, campaign);
  if (chapters.length === 0 || stop === null) return null;
  const plan = chapters.slice(0, chapters.indexOf(stop) + 1);
  if (plan.length === 0) return null;

  const rows = roundsWithMaps(db, matchId, 'match_live_maps').filter((r) => r.endedAt !== null);
  // A score the plugin could not read is stored as a 0; pricing it as a real
  // 0 would be a confident wrong answer.
  if (rows.some((r) => r.reliable !== 1)) return null;
  if (rows.some((r) => r.ordinal >= plan.length)) return null;
  if (rows.some((r) => r.map !== null && plan[r.ordinal].toLowerCase() !== r.map.toLowerCase())) return null;
  const played: PlayedHalf[] = rows.map((r) => ({ ...r, map: r.map ?? plan[r.ordinal] }));
  if (!wellFormed(played, true)) return null;

  const future: FutureHalf[] = [];
  const last = played[played.length - 1];
  let nextOrdinal = 0;
  if (last) {
    nextOrdinal = last.ordinal + 1;
    if (last.half === 1) future.push({ team: last.survTeam === 'a' ? 'b' : 'a', map: last.map });
  }
  for (let o = nextOrdinal; o < plan.length; o++) {
    future.push({ team: 'a', map: plan[o] }, { team: 'b', map: plan[o] });
  }
  const line = winLineFrom(model, played, future, opts);
  if (!opts.live || !inHalfProvider) return line;
  const extra = inHalfProvider(db, matchId, model, played, future, {
    form: opts.form, nowMs: opts.nowMs ?? Date.now(), delayMs: opts.delayMs ?? DEFAULT_DELAY_MS,
  });
  return withInHalf(line, extra.finished, extra.current);
}

/** `line` with each played half's in-half points just before its half-end
 *  point and the half in progress's after the last. The swing and the
 *  winner's low still point at the half-end points they did. */
function withInHalf(line: WinLine, finished: Map<string, WinPoint[]>, current: WinPoint[]): WinLine {
  if (finished.size === 0 && current.length === 0) return line;
  const points: WinPoint[] = [line.points[0]];
  const at: number[] = [0];
  for (let i = 1; i < line.points.length; i++) {
    const p = line.points[i];
    points.push(...(finished.get(`${p.ordinal}:${p.half}`) ?? []));
    at.push(points.length);
    points.push(p);
  }
  points.push(...current);
  return {
    ...line,
    points,
    turning: line.turning === null ? null : at[line.turning],
    winnerLow: line.winnerLow ? { ...line.winnerLow, index: at[line.winnerLow.index] } : null,
  };
}
