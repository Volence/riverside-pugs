import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { completedPug } from './matchKinds.js';
import { parseKeyValues, type KvNode } from './vpk.js';

/**
 * Per-map score multipliers (the mission file's VersusModifier), set from
 * how often survivors reach the saferoom.
 *
 * Owner ruling 2026-10-23, from Season 1 on: a map's multiplier is 1 / its
 * saferoom rate in the season that just ended, scaled so each campaign's
 * multipliers add up to what they did before, clamped to 0.75..1.75 (what
 * one map loses or gains by the clamp is shared over the campaign's other
 * maps in proportion), and rounded to 0.05. A harder map is worth more, so
 * every map carries about the same weight in a match. Only maps with at
 * least 50 completed PUGs are recalculated; the rest keep their numbers.
 * A mirrored map (l4d_vs_mX) plays and scores as its original l4d_vs_X: its
 * rounds count towards the original's rate and it takes the same number.
 *
 * The servers read the multiplier from the mission files (deploy repo,
 * tools/season-multipliers), so the table is computed once per season by
 * scripts/map-multipliers.ts and committed to balance/map-multipliers.json.
 * The site only shows it.
 */

export interface MultiplierRules {
  /** Completed PUGs a map needs in the previous season to be recalculated. */
  minMatches: number;
  min: number;
  max: number;
  /** Rounding step. */
  step: number;
}

export const SEASON_MULTIPLIER_RULES: MultiplierRules = { minMatches: 50, min: 0.75, max: 1.75, step: 0.05 };

/** One versus chapter as the mission file has it today. */
export interface LadderMap {
  map: string;
  /** The mission's Name, e.g. "Airport". */
  mission: string;
  chapter: number;
  /** Chapters in that mission's versus list (the last one is the finale). */
  chapters: number;
  modifier: number;
}

/** Rounds played on a map in the season, and how many reached the saferoom. */
export interface MapRate {
  map: string;
  matches: number;
  /** Rounds with a survivors reading (rounds from before the plugin reported it are left out). */
  rounds: number;
  madeIt: number;
}

export interface MultiplierRow {
  map: string;
  mission: string;
  chapter: number;
  before: number;
  after: number;
  /** Before rounding, for the record. Null when the map kept its number. */
  exact: number | null;
  saferoomRate: number | null;
  matches: number;
  rounds: number;
  recalculated: boolean;
}

/**
 * Clamp every value into [min, max] while keeping the total: what a clamped
 * value gives up (or takes) is spread over the values still inside the range
 * in proportion to their size, repeated until nothing is out of range. When
 * the total itself cannot fit (n * max < total, say) everything ends pinned.
 */
export function clampRedistribute(values: number[], min: number, max: number): number[] {
  const out = [...values];
  const pinned = new Array<boolean>(out.length).fill(false);
  for (let pass = 0; pass < out.length + 1; pass++) {
    let excess = 0;
    for (let i = 0; i < out.length; i++) {
      if (pinned[i]) continue;
      if (out[i] > max) { excess += out[i] - max; out[i] = max; pinned[i] = true; }
      else if (out[i] < min) { excess -= min - out[i]; out[i] = min; pinned[i] = true; }
    }
    if (Math.abs(excess) < 1e-12) break;
    const free = out.map((v, i) => (pinned[i] ? 0 : v)).reduce((a, b) => a + b, 0);
    if (free <= 0) break;
    for (let i = 0; i < out.length; i++) {
      if (!pinned[i]) out[i] += excess * (out[i] / free);
    }
  }
  return out;
}

/** Nearest multiple of `step`, without float dust (1.6000000000000001). */
export function roundToStep(x: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number((Math.round(x / step) * step).toFixed(decimals));
}

/** The original map a mirrored one copies (l4d_vs_mhospital01_apartment ->
 *  l4d_vs_hospital01_apartment), or null when `map` is not the mirror of a
 *  map in `known`. Checked against the known list so a custom map that just
 *  happens to start with an m is never folded into something else. */
export function mirrorOriginal(map: string, known: ReadonlySet<string>): string | null {
  const m = /^(l4d_vs_|l4d_|)m(.+)$/i.exec(map);
  if (!m) return null;
  const original = `${m[1]}${m[2]}`.toLowerCase();
  return known.has(original) ? original : null;
}

/** Rates per original map, mirrors folded in. */
export function foldMirrors(rates: MapRate[], known: ReadonlySet<string>): Map<string, MapRate> {
  const out = new Map<string, MapRate>();
  for (const r of rates) {
    const key = mirrorOriginal(r.map, known) ?? r.map.toLowerCase();
    const acc = out.get(key) ?? { map: key, matches: 0, rounds: 0, madeIt: 0 };
    acc.matches += r.matches;
    acc.rounds += r.rounds;
    acc.madeIt += r.madeIt;
    out.set(key, acc);
  }
  return out;
}

/** The new multipliers for every chapter in `ladder`, campaign by campaign. */
export function computeMultipliers(
  ladder: LadderMap[],
  rates: Map<string, MapRate>,
  rules: MultiplierRules = SEASON_MULTIPLIER_RULES,
): MultiplierRow[] {
  const rows: MultiplierRow[] = ladder.map((l) => {
    const r = rates.get(l.map.toLowerCase());
    return {
      map: l.map, mission: l.mission, chapter: l.chapter, before: l.modifier, after: l.modifier, exact: null,
      saferoomRate: r && r.rounds > 0 ? r.madeIt / r.rounds : null,
      matches: r?.matches ?? 0, rounds: r?.rounds ?? 0, recalculated: false,
    };
  });
  const byMission = new Map<string, MultiplierRow[]>();
  for (const row of rows) {
    if (!byMission.has(row.mission)) byMission.set(row.mission, []);
    byMission.get(row.mission)!.push(row);
  }
  for (const group of byMission.values()) {
    // A map nobody ever finished (rate 0) has no finite weight; it keeps its
    // number rather than swallowing the whole campaign's sum.
    const recalc = group.filter((g) => g.matches >= rules.minMatches && (g.saferoomRate ?? 0) > 0);
    if (recalc.length === 0) continue;
    const total = recalc.reduce((a, g) => a + g.before, 0);
    const weights = recalc.map((g) => 1 / g.saferoomRate!);
    const wsum = weights.reduce((a, b) => a + b, 0);
    const scaled = clampRedistribute(weights.map((w) => (w / wsum) * total), rules.min, rules.max);
    recalc.forEach((g, i) => {
      g.exact = scaled[i];
      g.after = roundToStep(scaled[i], rules.step);
      g.recalculated = true;
    });
  }
  return rows;
}

const isNode = (v: string | KvNode | undefined): v is KvNode => typeof v === 'object' && v !== null;
const keyOf = (node: KvNode, key: string) => Object.entries(node).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];

/** A mission file's versus chapters with their VersusModifier. A chapter with
 *  no VersusModifier plays at 1.0 (the engine default). */
export function versusLadder(text: string): LadderMap[] {
  const root = parseKeyValues(text);
  const mission = keyOf(root, 'mission');
  if (!isNode(mission)) return [];
  const modes = keyOf(mission, 'modes');
  const versus = isNode(modes) ? keyOf(modes, 'versus') : undefined;
  if (!isNode(versus)) return [];
  const name = typeof mission['Name'] === 'string' ? mission['Name'] : '';
  const chapters = Object.entries(versus)
    .filter((e): e is [string, KvNode] => isNode(e[1]) && /^\d+$/.test(e[0]))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  return chapters.flatMap(([key, ch]) => {
    const map = keyOf(ch, 'Map');
    if (typeof map !== 'string') return [];
    const mod = keyOf(ch, 'VersusModifier');
    return [{ map, mission: name, chapter: Number(key), chapters: chapters.length, modifier: typeof mod === 'string' ? Number(mod) : 1 }];
  });
}

/** Completed PUGs, rounds and saferoom arrivals per map in one season. A
 *  round made it when any survivor was alive at its end (survivors_alive > 0,
 *  the same rule as the Survived column on the map pages). PUGs only, voided
 *  matches left out (owner 2026-10-23): scrims and tournament matches are
 *  played by other line-ups under other stakes and stay out of PUG numbers. */
export const SEASON_RATES_SQL = `
  SELECT mm.map AS map,
         COUNT(DISTINCT m.id) AS matches,
         SUM(r.survivors_alive IS NOT NULL) AS rounds,
         SUM(r.survivors_alive > 0) AS madeIt
  FROM matches m
  JOIN match_maps mm ON mm.match_id = m.id
  LEFT JOIN match_rounds r ON r.match_id = m.id AND r.ordinal = mm.ordinal
  WHERE ${completedPug('m')} AND m.voided_at IS NULL AND m.season_id = ?
  GROUP BY mm.map`;

/** What the site serves: the committed table for one season. */
export interface SeasonMultiplierTable {
  /** The season these numbers are played in, e.g. "Season 1". */
  season: string;
  /** The season whose rounds set them. */
  basedOn: string;
  computedAt: string;
  rules: MultiplierRules;
  maps: MultiplierRow[];
}

export const MULTIPLIER_TABLE_PATH = fileURLToPath(new URL('../balance/map-multipliers.json', import.meta.url));

/** The committed table, or null when there is none or it does not parse. */
export function loadMultiplierTable(path = MULTIPLIER_TABLE_PATH): SeasonMultiplierTable | null {
  try {
    const t = JSON.parse(readFileSync(path, 'utf8')) as SeasonMultiplierTable;
    return Array.isArray(t.maps) ? t : null;
  } catch {
    return null;
  }
}

/** One map's public line: its multiplier, the old one, and the saferoom rate
 *  that set it. Mirrors answer with their original's line. */
export interface MapMultiplier { after: number; before: number; saferoomRate: number | null; matches: number; recalculated: boolean }

export function multiplierFor(table: SeasonMultiplierTable, map: string): MapMultiplier | null {
  const known = new Set(table.maps.map((m) => m.map.toLowerCase()));
  const key = mirrorOriginal(map, known) ?? map.toLowerCase();
  const row = table.maps.find((m) => m.map.toLowerCase() === key);
  if (!row) return null;
  return { after: row.after, before: row.before, saferoomRate: row.saferoomRate, matches: row.matches, recalculated: row.recalculated };
}

/**
 * The public lines for a set of maps, keyed by map name, or null before the
 * season the table is for. Only recalculated maps: a map that kept its number
 * has nothing to explain, and the mission file the table was read from is not
 * always the one a map plays under (Crash Center's Alleys has its own).
 */
export function publicMultipliers(table: SeasonMultiplierTable | null, maps: string[]): PublicMultipliers | null {
  if (!table) return null;
  const out: Record<string, MapMultiplier> = {};
  for (const map of maps) {
    const line = multiplierFor(table, map);
    if (line?.recalculated) out[map] = line;
  }
  return { season: table.season, basedOn: table.basedOn, min: table.rules.min, max: table.rules.max, minMatches: table.rules.minMatches, maps: out };
}

export interface PublicMultipliers {
  season: string;
  basedOn: string;
  min: number;
  max: number;
  minMatches: number;
  maps: Record<string, MapMultiplier>;
}
