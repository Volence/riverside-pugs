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

/** A clear latency, in seconds to one decimal.
 *
 *  Seconds, not milliseconds: the difference between a 0.9s clear and a 1.8s
 *  one is what a player can act on, while the millisecond digits are noise from
 *  tickrate and network jitter. */
export function fmtLatency(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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
  // Not "DPs": the table upper-cases every header, so it rendered as DPS and
  // read as damage per second. The stat is skill_detect's high-damage pounce.
  dps_landed: 'High pounces', pounce_damage_high: 'Pounce dmg',
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

/** Stats that cannot occur in L4D1 pug play, so a column for them is
 *  permanently zero and spends horizontal space saying nothing.
 *
 *  - `skeets_melee`: L4D1 has no melee weapons at all.
 *  - `skeets_sniper`: the hunting rifle is L4D1's only sniper-class weapon and
 *    `rotoblin_limit_huntingrifle 0` keeps it out of pug play.
 *  - `deadstops`, `tongue_cuts`: already documented above as not occurring
 *    here. They were removed from LIVE_STAT_GROUPS, but the old ordering
 *    re-appended every unrecognised key, so that exclusion never actually held.
 *  - `survivors_biled`: skill_detect reports it as 0 on this engine. Its
 *    `biles_landed` sibling comes from the same forward and does fire, so the
 *    count being zero is the vomit-hit counter never incrementing, not an
 *    absence of biles. `boomed_vomit` measures the same thing from our own hook
 *    and works, so nothing is lost by hiding this one.
 *  - `skeets_shotgun`: shotgun is the ONLY weapon class skill_detect's trie can
 *    tag on L4D1 once magnum, GL and the hunting rifle are gone, so this is
 *    every skeet bar the rare SMG or rifle one. That remainder is still
 *    recoverable as skeets + team_skeets - skeets_shotgun if it is ever wanted.
 *  - `skeets_hurt`: a skeet on an already-damaged hunter. Marked neutral in the
 *    registry because it only means anything as a ratio against clean skeets,
 *    and a bare count of it is not something anyone acts on.
 *
 *  Every one of these is still captured in the end-of-match dump. Pointing this
 *  frontend at L4D2 is a matter of emptying this set, not of recapturing data. */
export const DEAD_STAT_KEYS: ReadonlySet<string> = new Set([
  'skeets_melee', 'skeets_sniper', 'deadstops', 'tongue_cuts', 'survivors_biled',
  'skeets_shotgun', 'skeets_hurt',
]);

/** Families, in reading order, that stat columns are grouped into.
 *
 *  Ordering by side alone still left a survivor block where crowns and draw
 *  crowns could sit apart and the boomer counters could be split by something
 *  unrelated. A family is the unit a reader actually compares within, so it is
 *  also the unit the table draws a divider between.
 *
 *  `core` carries the fixed match_players columns, which the registry gives no
 *  side because they are not skill-detect keys. */
export const STAT_FAMILIES: { key: string; side: 'core' | 'survivor' | 'infected'; keys: string[] }[] = [
  { key: 'core', side: 'core', keys: ['hp', 'ck', 'sidmg', 'sikill', 'ff', 'rev'] },
  { key: 'skeets', side: 'survivor', keys: ['skeets', 'team_skeets', 'skeet_assists'] },
  { key: 'pins', side: 'survivor', keys: ['clears', 'insta_clears', 'self_clears'] },
  { key: 'witch', side: 'survivor', keys: ['crowns', 'draw_crowns'] },
  { key: 'antitank', side: 'survivor', keys: ['tank_damage', 'rock_skeets'] },
  { key: 'survmisc', side: 'survivor', keys: ['boomer_pops'] },
  { key: 'sidamage', side: 'infected', keys: ['damage_as_si'] },
  { key: 'pounce', side: 'infected', keys: ['dps_landed', 'pounce_damage_high'] },
  {
    key: 'boomer',
    side: 'infected',
    keys: ['boomer_spawns', 'boom_successes', 'boomer_rate', 'boomed_vomit', 'boomed_proxy', 'biles_landed'],
  },
  { key: 'tank', side: 'infected', keys: ['tank_punches', 'tank_rocks_landed'] },
];

/** True for the first present column of each family, so the match table can
 *  rule a line to its left. Never true for the very first column, which has
 *  nothing to be separated from. Mirrors liveGroupStarts, which does the same
 *  job for the live card's own group list. */
export function statGroupStarts(orderedKeys: string[]): Set<string> {
  const out = new Set<string>();
  for (const family of STAT_FAMILIES) {
    const first = orderedKeys.find((k) => family.keys.includes(k));
    if (first && orderedKeys.indexOf(first) > 0) out.add(first);
  }
  return out;
}

/** Column order for the completed-match tables: first the core columns the
 *  registry gives no side, then everything done as survivors, then everything
 *  done as infected.
 *
 *  Replaces an ordering that appended every key LIVE_STAT_ORDER did not know
 *  into a single alphabetical tail. That tail interleaved the two sides and
 *  separated stats from their own family, which is why draw_crowns rendered
 *  nowhere near crowns. Within a side, keys keep their curated LIVE_STAT_ORDER
 *  position when they have one and fall back to alphabetical when they do not,
 *  so the familiar columns stay put instead of being reshuffled. */
export function orderStatKeysBySide(
  keys: string[],
  statDefs: { key: string; side: 'survivor' | 'infected' }[],
): string[] {
  const sideOf = new Map(statDefs.map((d) => [d.key, d.side]));
  const live = keys.filter((k) => !DEAD_STAT_KEYS.has(k));
  const claimed = new Set(STAT_FAMILIES.flatMap((f) => f.keys));

  // Each side is its families in reading order, then whatever that side has
  // that no family claims. A key the registry gives no side lands in core,
  // which is where the fixed match_players columns belong anyway.
  const block = (side: 'core' | 'survivor' | 'infected') => {
    const grouped = STAT_FAMILIES
      .filter((f) => f.side === side)
      .flatMap((f) => f.keys.filter((k) => live.includes(k)));
    const leftover = live
      .filter((k) => !claimed.has(k) && (sideOf.get(k) ?? 'core') === side)
      .sort();
    return [...grouped, ...leftover];
  };
  return [...block('core'), ...block('survivor'), ...block('infected')];
}

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
  // The dead-key filter applies here as well as to the match page. Leaving the
  // curated group list merely not mentioning a dead key was never enough: the
  // `rest` fallback below appends anything the list does not know, so an
  // omission silently reinstates the column. survivors_biled reaches the live
  // payload for real, so without this the live card grows a permanent zero.
  const live = keys.filter((k) => !DEAD_STAT_KEYS.has(k));
  const known = LIVE_STAT_ORDER.filter((k) => live.includes(k));
  const rest = live.filter((k) => !LIVE_STAT_ORDER.includes(k)).sort();
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
