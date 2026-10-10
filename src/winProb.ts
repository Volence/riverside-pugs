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
 */
import type { DB } from './db.js';
import { completedPug } from './matchKinds.js';
import { unrecordedOrdinals } from './roundStats.js';
import { campaignRegistry } from './campaignRegistry.js';
import { stopAfterMap } from './stopPoint.js';

/** Score bucket width. Half scores run 0 to about 1,800; 20 keeps every
 *  convolution small without blurring a lead that decides a match. */
const BIN = 20;
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

export interface HalfRow { map: string; score: number; made: boolean | null }

export interface WinModel {
  builtAt: number;
  /** How many halves the model was built from, shown on the page. */
  halves: number;
  dist(map: string): Float64Array;
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
export function buildWinModel(rows: HalfRow[], now = Date.now()): WinModel {
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
  return { builtAt: now, halves: rows.length, dist };
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

function remaining(model: WinModel, maps: string[]): Float64Array {
  let d: Float64Array = new Float64Array([1]);
  for (const m of maps) d = convolve(d, model.dist(m));
  return d;
}

/**
 * Chance team A wins from here: `gap` is A's score minus B's so far, and each
 * list names the maps of that team's survivor halves still to play. A tie
 * counts as half a win either way. Calibrated; returns exactly 1, 0 or 0.5
 * once nothing is left to play.
 */
export function winChance(model: WinModel, gap: number, mapsA: string[], mapsB: string[]): number {
  if (mapsA.length === 0 && mapsB.length === 0) return gap > 0 ? 1 : gap < 0 ? 0 : 0.5;
  const ra = remaining(model, mapsA);
  const rb = remaining(model, mapsB);
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
  const z = CALIBRATION * Math.log(raw / (1 - raw));
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

/**
 * The line through `played`, pricing each point against every later played
 * half plus `future`. Shared by finished matches (no future) and live ones.
 */
export function winLineFrom(model: WinModel, played: PlayedHalf[], future: FutureHalf[]): WinLine {
  const slots: FutureHalf[] = [...played.map((r) => ({ team: r.survTeam, map: r.map })), ...future];
  const rest = (from: number, team: 'a' | 'b') => slots.slice(from).filter((x) => x.team === team).map((x) => x.map);
  const points: WinPoint[] = [
    { ordinal: null, half: null, survTeam: null, map: null, scoreA: 0, scoreB: 0, pA: winChance(model, 0, rest(0, 'a'), rest(0, 'b')) },
  ];
  let a = 0;
  let b = 0;
  played.forEach((r, i) => {
    if (r.survTeam === 'a') a += r.score; else b += r.score;
    points.push({
      ordinal: r.ordinal, half: r.half, survTeam: r.survTeam, map: r.map,
      scoreA: a, scoreB: b, pA: winChance(model, a - b, rest(i + 1, 'a'), rest(i + 1, 'b')),
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
 * The line for one finished match, or null when its score cannot carry one:
 * not completed, a map without both halves, or a map whose stored score is
 * not a result (see unrecordedOrdinals).
 */
export function matchWinLine(db: DB, matchId: number, model: WinModel = winModel(db)): WinLine | null {
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
  return winLineFrom(model, rounds, []);
}

/**
 * The line so far for a match being played, priced against the maps it still
 * has to play: the campaign's chapters up to its stop map (see stopAfterMap).
 * Null when that plan is unknown (no missions directory, an unregistered
 * campaign), when the maps played do not follow it, or when the rounds so far
 * are not whole halves in order. A half in progress counts as still to play.
 */
export function liveWinLine(db: DB, matchId: number, campaign: string, model: WinModel = winModel(db)): WinLine | null {
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
  return winLineFrom(model, played, future);
}
