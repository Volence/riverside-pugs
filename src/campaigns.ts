export const CAMPAIGNS: Record<string, { name: string }> = {
  no_mercy: { name: 'No Mercy' },
  death_toll: { name: 'Death Toll' },
  dead_air: { name: 'Dead Air' },
  blood_harvest: { name: 'Blood Harvest' },
  dead_center: { name: 'Dead Center' },
  dark_carnival: { name: 'Dark Carnival' },
  swamp_fever: { name: 'Swamp Fever' },
  hard_rain: { name: 'Hard Rain' },
  the_parish: { name: 'The Parish' },
  the_passing: { name: 'Passifice' },
  cold_stream: { name: 'Cold Stream' },
  the_last_stand: { name: 'The Last Stand' },
  // Dead Center's first three chapters, then Crash Course's Alleys. Its own
  // mission is deploy/deadcenter/missions/garage.txt; see slugOf in
  // stockMissions.ts for why it is the garage file.
  crash_center: { name: 'Crash Center' },
};

/**
 * The mirrored campaigns (Season 1, "Wrong Way"): every chapter but the
 * finale flipped left to right, built in ~/l4d/mirror and installed on every
 * server as 00_mirrormaps_*.vpk since 2026-10-25 (deploy 8047c1b).
 *
 * `maps` is the mirror mission file's versus list, read out of each pack
 * (00_mirrormaps_<mission>.vpk, missions/<mission>_mirror.txt). Hardcoded
 * rather than read off disk like the stock lists: the packs live in the
 * servers' addons, not in any directory the site reads, and the stop map
 * depends on this list being whole. The finale was never mirrored, so the
 * last chapter keeps its original map name (the chapter count has to match
 * the original or pug-match ends the match a map early).
 *
 * `name` is the mission's own DisplayTitle, the campaign spelled backwards
 * (owner, 2026-10-21). Their stats stay apart from the originals: the map
 * names differ, so every map page and saferoom rate is the mirror's own. In
 * Season 1 a mirror also keeps its own multiplier (the ladder in its pack's
 * mission file; see mapMultipliers.multiplierFor).
 *
 * Not in CAMPAIGNS: that table is the stock list a test pins key for key.
 */
export const MIRROR_CAMPAIGNS: Record<string, { name: string; original: string; maps: string[] }> = {
  no_mercy_mirror: {
    name: 'Ycrem On', original: 'no_mercy',
    maps: ['l4d_vs_mhospital01_apartment', 'l4d_vs_mhospital02_subway', 'l4d_vs_mhospital03_sewers', 'l4d_vs_mhospital04_interior', 'l4d_vs_hospital05_rooftop'],
  },
  death_toll_mirror: {
    name: 'Llot Htaed', original: 'death_toll',
    maps: ['l4d_vs_msmalltown01_caves', 'l4d_vs_msmalltown02_drainage', 'l4d_vs_msmalltown03_ranchhouse', 'l4d_vs_msmalltown04_mainstreet', 'l4d_vs_smalltown05_houseboat'],
  },
  dead_air_mirror: {
    name: 'Ria Daed', original: 'dead_air',
    maps: ['l4d_vs_mairport01_greenhouse', 'l4d_vs_mairport02_offices', 'l4d_vs_mairport03_garage', 'l4d_vs_mairport04_terminal', 'l4d_vs_airport05_runway'],
  },
  blood_harvest_mirror: {
    name: 'Tsevrah Doolb', original: 'blood_harvest',
    maps: ['l4d_vs_mfarm01_hilltop', 'l4d_vs_mfarm02_traintunnel', 'l4d_vs_mfarm03_bridge', 'l4d_vs_mfarm04_barn', 'l4d_vs_farm05_cornfield'],
  },
  // The garage mission: Dead Center's first three chapters and Crash Course's
  // Alleys, so it mirrors Crash Center. There is no separate Dead Center
  // mirror (a map can belong to one mission only). The title is the
  // mission's, which still says Dead Center backwards.
  crash_center_mirror: {
    name: 'Retnec Daed', original: 'crash_center',
    maps: ['mc1m1_hotel', 'mc1m2_streets', 'mc1m3_mall', 'l4d_mgarage01_alleys', 'c1m4_atrium'],
  },
  dark_carnival_mirror: {
    name: 'Lavinrac Krad', original: 'dark_carnival',
    maps: ['mc2m1_highway', 'mc2m2_fairgrounds', 'mc2m3_coaster', 'mc2m4_barns', 'c2m5_concert'],
  },
  swamp_fever_mirror: {
    name: 'Revef Pmaws', original: 'swamp_fever',
    maps: ['mc3m1_plankcountry', 'mc3m2_swamp', 'mc3m3_shantytown', 'c3m4_plantation'],
  },
  hard_rain_mirror: {
    name: 'Niar Drah', original: 'hard_rain',
    maps: ['mc4m1_milltown_a', 'mc4m2_sugarmill_a', 'mc4m3_sugarmill_b', 'mc4m4_milltown_b', 'c4m5_milltown_escape'],
  },
  the_parish_mirror: {
    name: 'Hsirap Eht', original: 'the_parish',
    maps: ['mc5m1_waterfront', 'mc5m2_park', 'mc5m3_cemetery', 'mc5m4_quarter', 'c5m5_bridge'],
  },
  // Passifice's chain, mirrored: both Passing maps and the first two river maps.
  the_passing_mirror: {
    name: 'Ecifircas Eht', original: 'the_passing',
    maps: ['mc6m1_riverbank', 'mc6m2_bedlam', 'l4d_mriver01_docks', 'l4d_mriver02_barge', 'l4d_river03_port'],
  },
  cold_stream_mirror: {
    name: 'Maerts Dloc', original: 'cold_stream',
    maps: ['mc13m1_alpinecreek', 'mc13m2_southpinestream', 'mc13m3_memorialbridge', 'c13m4_cutthroatcreek'],
  },
  the_last_stand_mirror: {
    name: 'Dnats Tsal Eht', original: 'the_last_stand',
    maps: ['mc14m1_junkyard', 'c14m2_lighthouse'],
  },
};

/** Mirrored map -> its mirror campaign. Only the flipped chapters: an
 *  unflipped finale (l4d_vs_hospital05_rooftop) is the original's map and
 *  keeps resolving to the original campaign. */
const MIRROR_BY_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries(MIRROR_CAMPAIGNS).flatMap(([slug, c]) =>
    c.maps.filter((m) => mirroredMapOriginal(m) !== null).map((m) => [m, slug] as [string, string])),
);

/** The original of a mirrored map name, by the build's naming rule
 *  (l4d_vs_X -> l4d_vs_mX, l4d_X -> l4d_mX, cNmM -> mcNmM), or null for any
 *  name that is not shaped like one. Shape only: callers that must not fold
 *  a custom map starting with an m check membership as well. */
function mirroredMapOriginal(map: string): string | null {
  const lower = map.toLowerCase();
  const dlc4 = /^m(c\d+m\d+.*)$/.exec(lower);
  if (dlc4) return dlc4[1];
  const l4d1 = /^(l4d_(?:vs_)?)m([a-z]+\d.*)$/.exec(lower);
  return l4d1 ? `${l4d1[1]}${l4d1[2]}` : null;
}

/** The original map of a mirrored one in MIRROR_CAMPAIGNS
 *  (mc1m3_mall -> c1m3_mall), or null for every other map. For chapter
 *  names and numbers, which the mirror shares with its original. */
export function mirrorMapOriginal(map: string): string | null {
  return MIRROR_BY_MAP.has(map.toLowerCase()) ? mirroredMapOriginal(map) : null;
}

/** Where Crash Center starts. Shared with Dead Center: the two differ only in
 *  where the site stops them (Dead Center after Mall, Crash Center after
 *  Alleys), because the game itself can give each map only one mission. */
export const CRASH_CENTER_FIRST_MAP = 'c1m1_hotel';

/**
 * Names shown ONLY in the campaign vote (site tiles and Discord buttons), for
 * easter eggs. Everywhere else, match pages, history, stats, keeps the plain
 * name. The Parish plays with the l4d_nightmode plugin on (owner, 2026-10-01),
 * so its vote tile hints that something is off; Dead Center, Dark Carnival and
 * Hard Rain joined it on 2026-10-02 when they went into the pool at night,
 * then Swamp Fever and Passifice.
 * Mirrored in web/src/format.ts.
 */
export const VOTE_NAMES: Record<string, string> = {
  // Empty since 2026-10-05 (owner): the glitch marks came off first, then
  // the "???", so the night campaigns vote under their plain names.
};

/**
 * What a map name may look like. A chapter's map name reaches an rcon command
 * line (`changelevel <map>`), and for a community campaign it comes out of a
 * file inside an uploaded VPK. Unquoted, a ';' in it starts a second command.
 * Quoting does not settle it either: the engine's command buffer honours
 * quotes for ';' but breaks on a newline wherever it finds one, and a mission
 * file can put a newline between quotes. So the name is refused where it
 * enters (parseMission) and asserted again where it leaves (the
 * orchestrator). Every stock and dlc4 map passes.
 */
const MAP_NAME_RE = /^[A-Za-z0-9_]{1,63}$/;
export const isMapName = (s: string): boolean => MAP_NAME_RE.test(s);

/**
 * The campaigns that live in `left4dead_dlc4` rather than in the base game.
 *
 * A const set rather than something derived from which missions directory the
 * campaign was read from. Deriving it would make the pool gate collapse to
 * "allowed" whenever MISSIONS_DIR is unconfigured, which is failing open on the
 * one check that stops a match landing on a server with no maps. This fails
 * closed and does not depend on config at all.
 */
export const DLC4_CAMPAIGNS: ReadonlySet<string> = new Set([
  'dead_center', 'dark_carnival', 'swamp_fever', 'hard_rain',
  'the_parish', 'the_passing', 'cold_stream', 'the_last_stand', 'crash_center',
]);

/**
 * L4D1 map names embed their campaign as a fixed word after the `l4d_` or
 * `l4d_vs_` prefix: `l4d_vs_airport01_greenhouse` is Dead Air. Matching on that
 * word is stable across all five chapters and across the coop/versus variants.
 *
 * Needed because a match started in-game with `!load_4v4p` reports the map it
 * is standing on: the plugin has no campaign table and should not grow one.
 *
 * Returns null rather than a default for anything unrecognised. Guessing would
 * silently file a custom map under a real campaign.
 */
const CAMPAIGN_BY_MAP_WORD: Record<string, string> = {
  hospital: 'no_mercy',
  smalltown: 'death_toll',
  airport: 'dead_air',
  farm: 'blood_harvest',
  // The Sacrifice's maps, filed under Passifice on purpose.
  //
  // `the_passing` on this server is not stock The Passing: the dlc4 mission
  // file is overridden to chain c6m1 and c6m2 into the three river maps as one
  // five-chapter campaign, so the versus score carries across both. Chapters 3
  // to 5 are therefore river maps, and without this they resolve to null and
  // three fifths of the campaign goes unattributed in stats and in any match
  // started from in-game.
  //
  // The trade is that a standalone Sacrifice game would also read as Passifice.
  // That is the right way round here: the river maps are only reachable through
  // Passifice in this rotation, and losing attribution on the common case to
  // stay literal about the rare one would be the worse bargain.
  river: 'the_passing',
  // Crash Course's first map, which this site only plays as Crash Center's
  // chapter 4 (Hotel, Streets, Mall, Alleys). Crash Course itself is not a
  // site campaign, so nothing else can claim the word. Dead Air's
  // `l4d_vs_airport03_garage` is unaffected: its campaign word is `airport`.
  //
  // Crash Center's first three maps still read as dead_center here: a bare
  // map name cannot tell the two apart. A site-started match carries its own
  // campaign, so this only matters for a match started in game.
  garage: 'crash_center',
};

/**
 * The dlc4 ports keep L4D2's own naming, `c<campaign>m<chapter>_<place>`, which
 * shares no structure with the L4D1 scheme above and so needs its own table.
 *
 * Note the numbers are not contiguous: Cold Stream is 13 and The Last Stand is
 * 14, matching L4D2's own campaign ids. A range check would be wrong.
 */
const CAMPAIGN_BY_DLC4_NUMBER: Record<string, string> = {
  1: 'dead_center',
  2: 'dark_carnival',
  3: 'swamp_fever',
  4: 'hard_rain',
  5: 'the_parish',
  6: 'the_passing',
  13: 'cold_stream',
  14: 'the_last_stand',
};

export function campaignForMap(map: string): string | null {
  const lower = map.toLowerCase();

  // Before both patterns: mc1m1_hotel would otherwise fall through to null
  // and l4d_vs_mhospital01 read its campaign word as "mhospital".
  const mirror = MIRROR_BY_MAP.get(lower);
  if (mirror) return mirror;

  const dlc4 = /^c(\d+)m\d+/.exec(lower);
  if (dlc4) return CAMPAIGN_BY_DLC4_NUMBER[dlc4[1]] ?? null;

  const m = /^l4d_(?:vs_)?([a-z]+)\d*/.exec(lower);
  if (!m) return null;
  return CAMPAIGN_BY_MAP_WORD[m[1]] ?? null;
}
