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

/**
 * The color a campaign is tinted with, as a CSS color string.
 *
 * The four L4D1 campaigns keep their hand-picked tokens. Any other slug, and
 * custom campaigns are coming, hashes to a hue at a fixed chroma and
 * lightness, so a campaign the site has never seen still gets a tint at the
 * same visual weight as the originals, with no stylesheet edit. Deterministic
 * so the same campaign is the same color on every page and every visit.
 *
 * The hash is computed unconditionally, even for the four known slugs, so it
 * can ride along as the token's fallback: `var(--c-x, <hash>)` degrades to a
 * real color instead of an invalid one if a token is ever missing from
 * tokens.css, where a bare `var(--c-x)` would leave `color-mix` and friends
 * silently failing on an invalid value.
 */
export function campaignTint(slug: string): string {
  // FNV-1a over the slug, then spread across the hue circle. Multiplying by
  // the golden angle keeps neighbouring hashes from landing on neighbouring
  // hues, so two custom campaigns added together still look distinct.
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hue = Math.round(((h % 360) * 137.508) % 360);
  const hashed = `oklch(0.42 0.06 ${hue})`;
  if (Object.hasOwn(CAMPAIGN_NAMES, slug)) return `var(--c-${slug.replace(/_/g, '-')}, ${hashed})`;
  return hashed;
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
  tongue_clears: 'Tongue clears',
  dmg_as_hunter: 'As hunter', dmg_as_smoker: 'As smoker',
  dmg_as_boomer: 'As boomer', dmg_as_tank: 'As tank',
  dmg_to_incapped: 'On incapped',
  quad_caps: 'Quad caps', times_quadded: 'Times quadded',
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
 *  - `times_deadstopped`: the private counterpart of `deadstops`. Both are
 *    written by the same skill_detect forward (pug-stats.inc's
 *    OnSurvivorShoveHunter calls AddStat twice, once per side), so a dead
 *    `deadstops` means a dead `times_deadstopped` by construction. It is listed
 *    separately because it is the one `self`-visibility key here, and the
 *    profile's private panel renders its bag directly rather than through the
 *    ordering helpers, so omitting it from a group list would not have hidden
 *    it. Live DB at the time of writing: times_skeeted 358, this one 0.
 *
 *  Every one of these is still captured in the end-of-match dump. Pointing this
 *  frontend at L4D2 is a matter of emptying this set, not of recapturing data. */
/** Stats L4D1 cannot produce, hidden so the table is not a wall of zeroes.
 *
 *  Checked against the live data 2026-09-18: these six are 0 across all 229
 *  recorded player-matches. `skeets_shotgun` (462) and `skeets_hurt` (122) were
 *  in here too and are NOT dead, which is why the skeet columns could not be
 *  reconciled by eye: a populated stat was being hidden as uncollectable. */
export const DEAD_STAT_KEYS: ReadonlySet<string> = new Set([
  'skeets_melee', 'skeets_sniper', 'deadstops', 'tongue_cuts', 'survivors_biled',
  'times_deadstopped',
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
  { key: 'skeets', side: 'survivor', keys: ['skeets', 'team_skeets', 'skeets_hurt', 'skeets_shotgun', 'skeet_assists'] },
  { key: 'pins', side: 'survivor', keys: ['clears', 'insta_clears', 'self_clears', 'tongue_clears', 'times_quadded'] },
  { key: 'witch', side: 'survivor', keys: ['crowns', 'draw_crowns'] },
  { key: 'antitank', side: 'survivor', keys: ['tank_damage', 'rock_skeets'] },
  { key: 'survmisc', side: 'survivor', keys: ['boomer_pops'] },
  {
    key: 'sidamage',
    side: 'infected',
    keys: ['damage_as_si', 'dmg_as_hunter', 'dmg_as_smoker', 'dmg_as_boomer', 'dmg_as_tank', 'dmg_to_incapped'],
  },
  { key: 'pounce', side: 'infected', keys: ['dps_landed', 'pounce_damage_high', 'quad_caps'] },
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

/** Fewest measured rounds a survival percentage may be computed from before
 *  the UI will print it as a number.
 *
 *  A percentage carries no visible uncertainty: "100%" over two rounds and
 *  "100%" over two hundred render identically, and the first is the one the
 *  maps pages were showing. Four is one full playing of a map by both teams in
 *  both halves, which is the smallest sample that is not a single team's good
 *  night. Below it, `survivalLabel` reports the count instead of a rate. */
/**
 * Rounds needed before a survival figure is stated as a percentage.
 *
 * Raised from 4 to 6 on 2026-09-18. Four is two coin flips: The Greenhouse sat
 * at exactly 4 measured and printed a confident "50%", which is what prompted
 * this. Six is not statistically comfortable either, and nothing about this
 * data will be for a while, which is why the sample size is PRINTED beside the
 * figure rather than left to a tooltip. This threshold only decides when to
 * stop showing a raw count instead.
 *
 * Deliberately not higher. The best-covered maps currently have 8 measured
 * rounds and most have 6, so 8 would blank almost every map on the site. Worth
 * revisiting upward as the history fills in.
 */
export const MIN_SURVIVAL_SAMPLE = 6;

/** How to render a survival rate, given how many rounds it is over.
 *
 *  Three distinct cases, and conflating any two of them is what made this
 *  number misleading:
 *   - nothing measured at all: "n/a", already the previous behaviour
 *   - measured, but too thin to state as a rate: the raw count, so the reader
 *     can see the sample is small rather than infer confidence from a round %
 *   - enough to state: the percentage, with the sample size beside it
 *
 *  `measured` is deliberately a separate field from RoundAggregate.attempts.
 *  attempts counts rounds with a usable clock, which is a much larger set, and
 *  the map page used to label this figure with it. */
export function survivalLabel(
  survivalPct: number | null,
  measured: number,
): { value: string; sub?: string; thin: boolean } {
  if (survivalPct === null || measured <= 0) return { value: 'n/a', thin: true };
  if (measured < MIN_SURVIVAL_SAMPLE) {
    return { value: `${measured} round${measured === 1 ? '' : 's'}`, sub: 'too few to rate', thin: true };
  }
  return {
    value: `${survivalPct}%`,
    sub: `of ${measured} measured`,
    thin: false,
  };
}

/** Display names for the chapters of every campaign that runs here.
 *
 *  Keyed on the map name with any `l4d_vs_` / `l4d_` prefix already stripped by
 *  `mapName`, so the versus and co-op variants of a chapter share one entry
 *  rather than needing two. The stock four campaigns are L4D1's own chapter
 *  titles as the game's loading screen prints them; `river` and `c6m` are The
 *  Sacrifice and The Passing, which run here as the "Passifice" campaign.
 *
 *  Not exhaustive on purpose. `mapName` falls back to deriving something
 *  readable from the map name, so a custom campaign is legible the day it is
 *  added and only needs an entry here to read exactly right. */
export const MAP_NAMES: Record<string, string> = {
  // No Mercy
  hospital01_apartment: 'The Apartments',
  hospital02_subway: 'The Subway',
  hospital03_sewers: 'The Sewer',
  hospital04_interior: 'The Hospital',
  hospital05_rooftop: 'Rooftop Finale',
  // Death Toll
  smalltown01_caves: 'The Turnpike',
  smalltown02_drainage: 'The Drains',
  smalltown03_ranchhouse: 'The Church',
  smalltown04_mainstreet: 'The Town',
  smalltown05_houseboat: 'Boathouse Finale',
  // Dead Air
  airport01_greenhouse: 'The Greenhouse',
  airport02_offices: 'The Crane',
  airport03_garage: 'The Construction Site',
  airport04_terminal: 'The Terminal',
  airport05_runway: 'Runway Finale',
  // Blood Harvest
  farm01_hilltop: 'The Woods',
  farm02_traintunnel: 'The Tunnel',
  farm03_bridge: 'The Bridge',
  farm04_barn: 'The Train Station',
  farm05_cornfield: 'Farmhouse Finale',
  // The Sacrifice
  river01_docks: 'The Docks',
  river02_barge: 'The Barge',
  river03_port: 'Port Finale',
};

/** Display names for The Passing's chapters, which do not carry an `l4d_`
 *  prefix at all: they are L4D2-style `c6m*` names, mounted from dlc4. Kept
 *  separate from MAP_NAMES only because the prefix strip does not apply. */
const C6M_NAMES: Record<string, string> = {
  c6m1_riverbank: 'The Riverbank',
  c6m2_bedlam: 'Underground',
  c6m3_port: 'Port',
};

/** An engine map name as a human chapter title.
 *
 *  `l4d_vs_airport01_greenhouse` reads as "The Greenhouse". Six places used to
 *  print the raw engine name, including the map page's own <h1>, which is the
 *  single most prominent string on that page.
 *
 *  The fallback matters more than the table: custom campaigns are the whole
 *  reason this is a function rather than a lookup. For an unknown map it drops
 *  the `l4d_`/`l4d_vs_` prefix, drops the campaign word and chapter number that
 *  L4D1 map names lead with, and title-cases what is left, so
 *  `l4d_vs_dam03_spillway` reads as "Spillway" rather than as a filename. A map
 *  whose name has no such structure is returned with underscores turned to
 *  spaces and nothing else removed, which is still better than the raw key. */
export function mapName(map: string): string {
  if (!map) return '';
  const lower = map.toLowerCase();
  if (C6M_NAMES[lower]) return C6M_NAMES[lower];

  const bare = lower.replace(/^l4d_(?:vs_)?/, '');
  if (MAP_NAMES[bare]) return MAP_NAMES[bare];

  // `airport01_greenhouse` -> `greenhouse`. Only when the leading segment
  // actually looks like <word><digits>, so a custom name that is simply
  // `deadbeforedawn` is not mistaken for a campaign prefix and eaten.
  const stripped = bare.replace(/^[a-z]+\d+_/, '');
  const words = (stripped || bare).split('_').filter(Boolean);
  if (words.length === 0) return map;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Stats that get a "season leader" card above the leaderboard table.
 *
 *  Hand-picked rather than derived, because most stat keys make a nonsense
 *  card. A leader board for `boomer_spawns` would crown whoever drew boomer
 *  most often, and one for `dmg_as_hunter` would crown a share of a total that
 *  already has its own card. What belongs here is a stat where being top of it
 *  is an actual claim: something you did well, not something that happened to
 *  you or a slice of something else.
 *
 *  Order is display order. A key whose leader scores zero is dropped at render
 *  time, so a fresh season shows the cards it has earned and no empty shells.
 *  Nothing here may be in DEAD_STAT_KEYS; a test enforces that, since adding a
 *  dead key would produce a permanently empty card rather than an error. */
export const FEATURED_STAT_KEYS: readonly string[] = [
  'skeets', 'crowns', 'tank_damage', 'damage_as_si', 'clears', 'boomer_pops',
];

export interface StatLeader { steamid: string; name: string; value: number }

/**
 * Top `limit` players for one stat, from rows already loaded.
 *
 * Computed client-side on purpose. /api/leaderboard/stat/:key exists and does
 * this properly for one key, but the leaderboard payload already carries every
 * player's stat bag for the selected season, so calling it once per card would
 * be six requests for arithmetic over data in memory. The endpoint stays the
 * right tool for a standalone page that has not loaded the board.
 *
 * Players with no value, or zero, are excluded rather than filling the podium:
 * "third best, with none" is not a standing.
 */
export function statLeaders(
  rows: { steamid: string; name: string; stats?: Record<string, number> }[],
  key: string,
  limit = 3,
): StatLeader[] {
  return rows
    .map((r) => ({ steamid: r.steamid, name: r.name, value: r.stats?.[key] ?? 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Survival on one map, as a suffix to a win/loss detail on the profile.
 *
 * Counted over the halves the player played AS SURVIVOR, which is a different
 * and smaller denominator than maps played, so it carries its own count rather
 * than letting a reader assume it shares the W/L one. Winning and surviving are
 * genuinely different questions: a team can lose a map on points having reached
 * the saferoom both times, and can win one having been wiped.
 */
export function survivalNote(r: { survivalMeasured?: number; survived?: number }): string {
  const measured = r.survivalMeasured ?? 0;
  if (measured === 0) return '';
  return `  ${Math.round(((r.survived ?? 0) / measured) * 100)}% survived of ${measured}`;
}

export type MapSort = 'winrate' | 'survival';

/**
 * Order the profile's per-map rows, weakest first.
 *
 * Weakest first either way, because the reason to read this list is to find
 * what to work on. A row the chosen measure says nothing about sorts last
 * rather than being treated as a zero: never having a survival reading on a
 * map is not the same as never having survived it.
 */
export function sortMapRows<T extends {
  map: string; wins: number; losses: number; games: number;
  survivalMeasured?: number; survived?: number;
}>(rows: readonly T[], by: MapSort): T[] {
  const rate = (r: T): number => {
    if (by === 'survival') {
      const n = r.survivalMeasured ?? 0;
      return n === 0 ? Number.POSITIVE_INFINITY : (r.survived ?? 0) / n;
    }
    const decided = r.wins + r.losses;
    return decided === 0 ? Number.POSITIVE_INFINITY : r.wins / decided;
  };
  return [...rows].sort(
    (x, y) => rate(x) - rate(y) || y.games - x.games || x.map.localeCompare(y.map),
  );
}
