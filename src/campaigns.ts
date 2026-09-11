export const CAMPAIGNS: Record<string, { name: string }> = {
  no_mercy: { name: 'No Mercy' },
  death_toll: { name: 'Death Toll' },
  dead_air: { name: 'Dead Air' },
  blood_harvest: { name: 'Blood Harvest' },
};

/**
 * L4D1 map names embed their campaign as a fixed word after the `l4d_` or
 * `l4d_vs_` prefix: `l4d_vs_airport01_greenhouse` is Dead Air. Matching on that
 * word is stable across all five chapters and across the coop/versus variants.
 *
 * Needed because a match started in-game with `!load_4v4p` reports the map it
 * is standing on: the plugin has no campaign table and should not grow one.
 *
 * Returns null rather than a default for anything unrecognised. Guessing would
 * silently file an L4D2 or custom map under a real campaign.
 */
const CAMPAIGN_BY_MAP_WORD: Record<string, string> = {
  hospital: 'no_mercy',
  smalltown: 'death_toll',
  airport: 'dead_air',
  farm: 'blood_harvest',
};

export function campaignForMap(map: string): string | null {
  const m = /^l4d_(?:vs_)?([a-z]+)\d*/.exec(map.toLowerCase());
  if (!m) return null;
  return CAMPAIGN_BY_MAP_WORD[m[1]] ?? null;
}
