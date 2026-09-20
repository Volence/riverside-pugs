import { describe, it, expect } from 'vitest';
import { CAMPAIGNS, DLC4_CAMPAIGNS, campaignForMap } from '../src/campaigns.js';

describe('campaignForMap', () => {
  // A self-started match reports the map it is standing on, not a campaign
  // key, because the plugin has no campaign table. Every campaign the site
  // knows must therefore be reachable from at least one real L4D1 map name.
  it.each([
    ['l4d_hospital01_apartment', 'no_mercy'],
    ['l4d_hospital05_rooftop', 'no_mercy'],
    ['l4d_smalltown01_caves', 'death_toll'],
    ['l4d_smalltown05_houseboat', 'death_toll'],
    ['l4d_airport01_greenhouse', 'dead_air'],
    ['l4d_airport05_runway', 'dead_air'],
    ['l4d_farm01_hilltop', 'blood_harvest'],
    ['l4d_farm05_cornfield', 'blood_harvest'],
  ])('maps coop map %s to %s', (map, expected) => {
    expect(campaignForMap(map)).toBe(expected);
  });

  // Versus maps carry a vs_ infix. These are the names a PUG will actually
  // report, so getting them wrong would break every real match.
  it.each([
    ['l4d_vs_hospital01_apartment', 'no_mercy'],
    ['l4d_vs_smalltown01_caves', 'death_toll'],
    ['l4d_vs_airport01_greenhouse', 'dead_air'],
    ['l4d_vs_farm01_hilltop', 'blood_harvest'],
  ])('maps versus map %s to %s', (map, expected) => {
    expect(campaignForMap(map)).toBe(expected);
  });

  it('is case insensitive', () => {
    expect(campaignForMap('L4D_VS_AIRPORT01_GREENHOUSE')).toBe('dead_air');
  });

  // The L4D2 ports use L4D2's own map naming, which shares nothing with the
  // l4d_<word><nn> scheme. Versus and coop are the SAME bsp on these, so there
  // is no vs_ variant to test.
  it.each([
    ['c1m1_hotel', 'dead_center'],
    ['c1m4_atrium', 'dead_center'],
    ['c2m1_highway', 'dark_carnival'],
    ['c2m5_concert', 'dark_carnival'],
    ['c3m1_plankcountry', 'swamp_fever'],
    ['c3m4_plantation', 'swamp_fever'],
    ['c4m1_milltown_a', 'hard_rain'],
    ['c4m5_milltown_escape', 'hard_rain'],
    ['c5m1_waterfront', 'the_parish'],
    ['c5m5_bridge', 'the_parish'],
    ['c6m1_riverbank', 'the_passing'],
    ['c6m3_port', 'the_passing'],
    ['c13m1_alpinecreek', 'cold_stream'],
    ['c13m4_cutthroatcreek', 'cold_stream'],
    ['c14m1_junkyard', 'the_last_stand'],
    ['c14m2_lighthouse', 'the_last_stand'],
  ])('maps dlc4 map %s to %s', (map, expected) => {
    expect(campaignForMap(map)).toBe(expected);
  });

  it('is case insensitive for dlc4 names too', () => {
    expect(campaignForMap('C1M1_HOTEL')).toBe('dead_center');
  });

  // A campaign number we do not ship must not be invented into a slug.
  it('returns null for an unknown dlc4 campaign number', () => {
    expect(campaignForMap('c7m1_somewhere')).toBeNull();
    expect(campaignForMap('c99m1_nope')).toBeNull();
  });

  it('every dlc4 slug exists in CAMPAIGNS', () => {
    for (const slug of DLC4_CAMPAIGNS) expect(Object.keys(CAMPAIGNS)).toContain(slug);
  });

  it('returns null for an unknown map rather than guessing', () => {
    expect(campaignForMap('de_dust2')).toBeNull();
    expect(campaignForMap('')).toBeNull();
    expect(campaignForMap('l4d_vs_dam01_something')).toBeNull();
  });

  it('only ever returns keys that exist in CAMPAIGNS', () => {
    const got = campaignForMap('l4d_vs_farm01_hilltop');
    expect(got).not.toBeNull();
    expect(Object.keys(CAMPAIGNS)).toContain(got);
  });
});
