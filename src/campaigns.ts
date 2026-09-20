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
  the_passing: { name: 'The Passing' },
  cold_stream: { name: 'Cold Stream' },
  the_last_stand: { name: 'The Last Stand' },
};

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
  'the_parish', 'the_passing', 'cold_stream', 'the_last_stand',
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

  const dlc4 = /^c(\d+)m\d+/.exec(lower);
  if (dlc4) return CAMPAIGN_BY_DLC4_NUMBER[dlc4[1]] ?? null;

  const m = /^l4d_(?:vs_)?([a-z]+)\d*/.exec(lower);
  if (!m) return null;
  return CAMPAIGN_BY_MAP_WORD[m[1]] ?? null;
}
