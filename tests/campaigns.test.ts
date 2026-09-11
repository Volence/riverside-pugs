import { describe, it, expect } from 'vitest';
import { CAMPAIGNS, campaignForMap } from '../src/campaigns.js';

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

  it('returns null for an unknown map rather than guessing', () => {
    expect(campaignForMap('c5m1_waterfront')).toBeNull();
    expect(campaignForMap('')).toBeNull();
    expect(campaignForMap('l4d_vs_dam01_something')).toBeNull();
  });

  it('only ever returns keys that exist in CAMPAIGNS', () => {
    const got = campaignForMap('l4d_vs_farm01_hilltop');
    expect(got).not.toBeNull();
    expect(Object.keys(CAMPAIGNS)).toContain(got);
  });
});
