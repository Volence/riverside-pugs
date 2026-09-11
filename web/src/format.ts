import type { MatchResult, Winner } from './api';

export const CAMPAIGN_NAMES: Record<string, string> = {
  no_mercy: 'No Mercy',
  death_toll: 'Death Toll',
  dead_air: 'Dead Air',
  blood_harvest: 'Blood Harvest',
};

export function campaignName(slug: string): string {
  return CAMPAIGN_NAMES[slug] ?? slug;
}

export const RESULT_LABEL: Record<MatchResult, string> = { win: 'W', loss: 'L', draw: 'D' };

export function winnerLabel(winner: Winner): string {
  return winner === 'draw' ? 'Draw' : `Team ${winner.toUpperCase()}`;
}

/** `2026-09-06T04:12:33.000Z` → `2026-09-06 04:12`. Matches the previous
 *  frontend's formatting exactly: these are already local-ish strings from
 *  SQLite and are not re-zoned here. */
export function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '';
}

/** An SR delta, always signed, using a real minus (U+2212) rather than a hyphen
 *  so a column of deltas aligns and reads as arithmetic. Zero prints as ±0 so
 *  "rating did not move" is visibly different from a missing value. */
export function fmtDelta(d: number): string {
  if (d > 0) return `+${d}`;
  if (d < 0) return `−${Math.abs(d)}`;
  return '±0';
}

export function deltaClass(d: number): string {
  return d > 0 ? 'delta delta--up' : d < 0 ? 'delta delta--down' : 'delta';
}

/** `mm:ss` for the ready-check/vote countdown and the document title. */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function secondsLeft(deadline: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((deadline - now) / 1000));
}

/** Human labels for skill stat keys. Duplicates the registry in
 *  src/statKeys.ts rather than importing it, because web/ cannot import
 *  server code. Kept here so MatchDetail and Profile share one copy. */
export const STAT_LABELS: Record<string, string> = {
  skeets: 'Skeets', team_skeets: 'Team', skeets_hurt: 'Chip',
  skeet_assists: 'Assists', skeets_shotgun: 'Shotgun skeets',
  skeets_sniper: 'Sniper skeets', skeets_melee: 'Melee skeets',
  deadstops: 'Deadstops', boomer_pops: 'Boomer pops', crowns: 'Crowns',
  draw_crowns: 'Draw crowns', tongue_cuts: 'Tongue cuts', self_clears: 'Self clears',
  rock_skeets: 'Rocks shot', clears: 'Clears', insta_clears: 'Insta clears',
  dps_landed: 'DPs', pounce_damage_high: 'Pounce dmg',
  biles_landed: 'Biles', survivors_biled: 'Survs biled',
  boomer_spawns: 'Boomers', boomer_rate: 'Boomer %',
  boom_successes: 'Landed', boomed_vomit: 'Vomit', boomed_proxy: 'Proxy',
  tank_rocks_landed: 'Rocks hit', times_skeeted: 'Times skeeted',
  times_deadstopped: 'Times deadstopped', tank_damage: 'Tank damage',
  damage_as_si: 'Damage as SI', tank_punches: 'Tank punches',
  // Live-only keys. These are not in the server's stat registry: ck/sidmg/
  // sikill/ff/rev are the fixed match_players columns, and hp is live entity
  // state rather than a counter.
  hp: 'HP', ck: 'Commons', sidmg: 'SI dmg', sikill: 'SI kills',
  ff: 'FF', rev: 'Revives',
};

/** Live stat columns, in display order and grouped. The groups exist so the
 *  table can draw a divider between families: with fifteen numeric columns,
 *  ungrouped, it reads as an undifferentiated wall.
 *
 *  deadstops and tongue_cuts are absent on purpose. They do not occur in L4D1
 *  play here, so they were permanently-zero columns. The plugin no longer
 *  sends them live; they are still captured for the full end-of-match dump. */
export const LIVE_STAT_GROUPS: { key: string; keys: string[] }[] = [
  { key: 'core', keys: ['hp', 'ck', 'sidmg', 'sikill', 'ff', 'rev'] },
  { key: 'tank', keys: ['tank_damage', 'damage_as_si', 'tank_punches', 'tank_rocks_landed'] },
  { key: 'skeet', keys: ['skeets', 'team_skeets', 'skeets_hurt', 'skeet_assists'] },
  { key: 'skill', keys: ['boomer_pops', 'crowns', 'rock_skeets', 'dps_landed'] },
  { key: 'boom', keys: ['boomer_spawns', 'boom_successes', 'boomer_rate', 'boomed_vomit', 'boomed_proxy'] },
];

export const LIVE_STAT_ORDER = LIVE_STAT_GROUPS.flatMap((g) => g.keys);

/** True for the first present column of each group, so the table can put a
 *  rule to its left. Never true for the very first column. */
export function liveGroupStarts(orderedKeys: string[]): Set<string> {
  const out = new Set<string>();
  for (const g of LIVE_STAT_GROUPS) {
    const first = g.keys.find((k) => orderedKeys.includes(k));
    if (first && orderedKeys.indexOf(first) > 0) out.add(first);
  }
  return out;
}

export function orderLiveStatKeys(keys: string[]): string[] {
  const known = LIVE_STAT_ORDER.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !LIVE_STAT_ORDER.includes(k)).sort();
  return [...known, ...rest];
}

export function labelFor(key: string): string {
  return STAT_LABELS[key] ?? key;
}

/** SVG polyline points for the SR-over-time graph.
 *
 *  Returns null when there are fewer than two points, because a one-match
 *  "graph" is a dot that implies a trend it cannot support, so callers render a
 *  note instead. A flat series (span 0) is drawn as a centered horizontal line
 *  rather than dividing by zero. */
export function sparklinePoints(values: number[], w: number, h: number, pad = 5): string | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const usable = h - pad * 2;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = span === 0 ? h / 2 : h - pad - ((v - min) / span) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Human file size for demo downloads. Demos run from a few MB to over a GB,
 *  so the unit has to move; a raw byte count is unreadable at that range. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}


/**
 * Stats computed from other stats, injected before the table is built so they
 * flow through the same column machinery as real ones.
 *
 * Derived rather than stored: a ratio persisted alongside its inputs goes stale
 * the moment either input changes, and there is no reason for the wire or the
 * database to carry a number that is a division away.
 *
 * A rate with a zero denominator is ABSENT, not zero. Nobody has played boomer
 * yet is a different fact from played boomer and landed nothing, and the table
 * renders absent as "n/a".
 */
export function deriveLiveStats(stats: Record<string, number>): Record<string, number> {
  const out = { ...stats };
  // successes/attempts, exactly as l4dcompstats prints it, so the site and
  // the console never disagree. Uses boom_successes (once per boomer life),
  // NOT biles_landed (once per vomit) and not the per-survivor counters.
  const spawns = stats.boomer_spawns ?? 0;
  if (spawns > 0) {
    out.boomer_rate = Math.round(((stats.boom_successes ?? 0) / spawns) * 100);
  }
  return out;
}
