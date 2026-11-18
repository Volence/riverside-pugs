// Admin report for health-run scoring in shadow mode: each match's alt score
// beside its real one, and per-map walking to tune walk multipliers. Read
// only; nothing here writes a table.
import type { DB } from './db.js';
import { ALT_RULE, compareMatch, halfParts, HR1, type AltRaw } from './altScore.js';
import { parseAltCurve } from './logParse.js';

export interface AltReportHalf {
  ordinal: number;
  half: number;
  map: string;
  survTeam: 'a' | 'b';
  real: number | null;
  walk: number;
  tank: number;
  door: number;
  total: number;
  tankPct: number | null;
  tankBy: string | null;
  survivorsIn: number;
  /** A stored walk, tank or door differs by more than 1 from the same part
   *  recomputed from the half's raw components and multipliers. */
  mismatch: boolean;
  /** Team health % at 0, 5, .., 100% of the map covered (21 entries, -1 for a
   *  point not reached); null for a half recorded without the health curve. */
  curve: number[] | null;
  /** The covered figure (0..100) where the half's first tank window opened and
   *  where the paying (or last) one closed; -1 none, null not recorded. */
  tankOpen: number | null;
  tankClose: number | null;
}

export interface AltReportMatch {
  id: number;
  endedAt: string | null;
  campaign: string;
  realA: number;
  realB: number;
  realWinner: string | null;
  altA: number;
  altB: number;
  altWinner: string;
  complete: boolean;
  differs: boolean | null;
  counted: boolean;
  halves: AltReportHalf[];
}

export interface AltReport {
  /** Shares are 0..1, over complete counted matches. */
  summary: {
    matchesWithData: number; complete: number; differentWinner: number; share: { walk: number; tank: number; door: number };
    /** Halves with data, over every match, whose stored parts do not match their own breakdown. */
    mismatchedHalves: number;
  };
  maps: { map: string; halves: number; avgWalkRaw: number; suggestedWalkMult: number | null }[];
  matches: AltReportMatch[];
}

/** A map needs this many halves before its walk multiplier is suggested. */
const SUGGEST_MIN_HALVES = 100;

interface AltRow extends AltRaw {
  matchId: number;
  ordinal: number;
  half: number;
  survTeam: 'a' | 'b';
  walk: number;
  tank: number;
  door: number;
  walkMult: number;
  doorMult: number;
  tankPct: number | null;
  tankBy: string | null;
  survivorsIn: number;
  map: string;
  real: number | null;
  curve: string | null;
  tankOpen: number | null;
  tankClose: number | null;
}

interface MatchRow {
  id: number;
  state: string;
  kind: string;
  voidedAt: string | null;
  campaign: string;
  endedAt: string | null;
  realA: number;
  realB: number;
  realWinner: 'a' | 'b' | 'draw' | null;
  realHalves: number;
}

/**
 * Every match with hr1 rows, newest first (`limit` matches, default 100).
 * Summary and maps cover every match with data, not only the listed ones;
 * the counted fields and maps use counted matches only.
 * Totals shown are the stored walk/tank/door the server reported; the raw
 * components are used for the per-map walking at multiplier 1 and to check
 * the stored parts against their own breakdown (`mismatch`).
 */
export function buildAltReport(db: DB, opts: { limit?: number } = {}): AltReport {
  const limit = opts.limit ?? 100;
  // A completed match keeps its maps in match_maps; a live one in
  // match_live_maps (deleted at archive). Both are keyed by the round ordinal.
  // The match_live_maps lookup assumes one map row per ordinal.
  const rows = db.prepare(
    `SELECT a.match_id AS matchId, a.ordinal, a.half, a.surv_team AS survTeam, a.walk, a.tank, a.door,
            a.walk_mult AS walkMult, a.door_mult AS doorMult,
            a.ws, a.wt, a.wr, a.ts, a.tt, a.tr, a.ds, a.dt, a.dr,
            a.tank_pct AS tankPct, a.tank_by AS tankBy, a.survivors_in AS survivorsIn,
            a.curve, a.tank_open AS tankOpen, a.tank_close AS tankClose,
            COALESCE(
              (SELECT mm.map FROM match_maps mm WHERE mm.match_id = a.match_id AND mm.ordinal = a.ordinal),
              (SELECT ml.map FROM match_live_maps ml WHERE ml.match_id = a.match_id AND ml.ordinal = a.ordinal LIMIT 1),
              '') AS map,
            r.score AS real
     FROM match_round_alt a
     LEFT JOIN match_rounds r ON r.match_id = a.match_id AND r.ordinal = a.ordinal AND r.half = a.half
     WHERE a.rule = ?
     ORDER BY a.match_id, a.ordinal, a.half`,
  ).all(ALT_RULE) as AltRow[];

  // Newest first is by match id, because ids grow over time.
  const matchRows = db.prepare(
    `SELECT m.id, m.state, m.kind, m.voided_at AS voidedAt, m.campaign, m.ended_at AS endedAt,
            m.team_a_score AS realA, m.team_b_score AS realB, m.winner AS realWinner,
            (SELECT COUNT(*) FROM match_rounds r WHERE r.match_id = m.id) AS realHalves
     FROM matches m
     WHERE m.id IN (SELECT match_id FROM match_round_alt WHERE rule = ?)
     ORDER BY m.id DESC`,
  ).all(ALT_RULE) as MatchRow[];

  const byMatch = new Map<number, AltRow[]>();
  for (const r of rows) {
    const list = byMatch.get(r.matchId);
    if (list) list.push(r);
    else byMatch.set(r.matchId, [r]);
  }

  let complete = 0;
  let differentWinner = 0;
  const parts = { walk: 0, tank: 0, door: 0 };
  const countedHalves: AltRow[] = [];
  const matches: AltReportMatch[] = [];
  for (const m of matchRows) {
    const halves = byMatch.get(m.id) ?? [];
    let altA = 0;
    let altB = 0;
    for (const h of halves) {
      const total = h.walk + h.tank + h.door;
      if (h.survTeam === 'a') altA += total;
      else altB += total;
    }
    const altWinner = altA > altB ? 'a' : altB > altA ? 'b' : 'draw';
    // compareMatch decides completeness; the winner comes from the stored totals.
    const isComplete = compareMatch(
      halves.map((h) => ({ ordinal: h.ordinal, half: h.half, survTeam: h.survTeam, raw: rawOf(h), walkMult: h.walkMult, doorMult: h.doorMult })),
      m.realHalves, m.realWinner, HR1,
    ).complete;
    const differs = isComplete && m.realWinner !== null ? altWinner !== m.realWinner : null;
    const counted = m.state === 'completed' && m.voidedAt === null && m.kind === 'pug' && isComplete;
    if (counted) {
      complete++;
      if (differs) differentWinner++;
      for (const h of halves) {
        parts.walk += h.walk;
        parts.tank += h.tank;
        parts.door += h.door;
      }
      countedHalves.push(...halves);
    }
    if (matches.length < limit) {
      matches.push({
        id: m.id, endedAt: m.endedAt, campaign: m.campaign, realA: m.realA, realB: m.realB, realWinner: m.realWinner,
        altA, altB, altWinner, complete: isComplete, differs, counted,
        halves: halves.map((h) => ({
          ordinal: h.ordinal, half: h.half, map: h.map, survTeam: h.survTeam, real: h.real,
          walk: h.walk, tank: h.tank, door: h.door, total: h.walk + h.tank + h.door,
          tankPct: h.tankPct, tankBy: h.tankBy, survivorsIn: h.survivorsIn, mismatch: isMismatch(h),
          // Read back through the parser that admitted it, so a hand-edited row cannot reach the page malformed.
          curve: h.curve === null ? null : parseAltCurve(h.curve), tankOpen: h.tankOpen, tankClose: h.tankClose,
        })),
      });
    }
  }
  const sum = parts.walk + parts.tank + parts.door;
  const share = sum > 0 ? { walk: parts.walk / sum, tank: parts.tank / sum, door: parts.door / sum } : { walk: 0, tank: 0, door: 0 };

  return {
    summary: { matchesWithData: matchRows.length, complete, differentWinner, share, mismatchedHalves: rows.filter(isMismatch).length },
    maps: mapWalking(countedHalves),
    matches,
  };
}

function rawOf(h: AltRow): AltRaw {
  return { ws: h.ws, wt: h.wt, wr: h.wr, ts: h.ts, tt: h.tt, tr: h.tr, ds: h.ds, dt: h.dt, dr: h.dr };
}

/** The stored parts are the plugin's own arithmetic on the stored raw
 *  components; a difference of more than 1 (beyond rounding) is a bug there. */
function isMismatch(h: AltRow): boolean {
  const p = halfParts(rawOf(h), h.walkMult, h.doorMult, HR1);
  return Math.abs(h.walk - p.walk) > 1 || Math.abs(h.tank - p.tank) > 1 || Math.abs(h.door - p.door) > 1;
}

/** Mean walking per half at walk multiplier 1, per named map, and the
 *  multiplier that would bring the map to the overall mean (to 0.05), or
 *  null below SUGGEST_MIN_HALVES halves or with no walking at all.
 *  Fed only halves of counted matches, so the fit is from ranked play. */
function mapWalking(rows: AltRow[]): AltReport['maps'] {
  const perMap = new Map<string, { halves: number; walk: number }>();
  let allHalves = 0;
  let allWalk = 0;
  for (const h of rows) {
    if (!h.map) continue;
    const walk = halfParts(rawOf(h), 1, h.doorMult, HR1).walk;
    const m = perMap.get(h.map) ?? { halves: 0, walk: 0 };
    m.halves++;
    m.walk += walk;
    perMap.set(h.map, m);
    allHalves++;
    allWalk += walk;
  }
  const overall = allHalves > 0 ? allWalk / allHalves : 0;
  return [...perMap.entries()]
    .map(([map, m]) => {
      const avgWalkRaw = m.walk / m.halves;
      const suggestedWalkMult = m.halves >= SUGGEST_MIN_HALVES && avgWalkRaw > 0
        ? Number((Math.round(overall / avgWalkRaw / 0.05) * 0.05).toFixed(2))
        : null;
      return { map, halves: m.halves, avgWalkRaw, suggestedWalkMult };
    })
    .sort((x, y) => y.halves - x.halves || x.map.localeCompare(y.map));
}
