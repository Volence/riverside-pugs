import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, publishCampaign, deleteCampaign } from '../src/customCampaigns.js';
import { upsertPlayer } from '../src/players.js';
import { ME, OTHER, seedMatch } from './playerStats.test.js';
import {
  campaignRegistry, resolveCampaignForMap, invalidateCampaignCache, firstMapOf, stockChaptersOf,
  setMissionsDirs,
} from '../src/campaignRegistry.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  invalidateCampaignCache();
});

const publish = (slug = 'dbd') => {
  insertDraft(db, {
    slug, name: 'Dead Before Dawn', vpkFilename: `${slug}.vpk`,
    sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
  }, [
    { map: 'dbd1_alley', display: 'Alley', isFinale: false },
    { map: 'dbd2_mall', display: 'Mall', isFinale: true },
  ]);
  publishCampaign(db, slug, 'Dead Before Dawn');
  invalidateCampaignCache();
};

describe('campaignRegistry', () => {
  it('contains the four stock campaigns with no custom ones present', () => {
    expect([...campaignRegistry(db).keys()])
      .toEqual([
        'no_mercy',
        'death_toll',
        'dead_air',
        'blood_harvest',
        'dead_center',
        'dark_carnival',
        'swamp_fever',
        'hard_rain',
        'the_parish',
        'the_passing',
        'cold_stream',
        'the_last_stand',
      ]);
  });

  it('merges a published custom campaign in', () => {
    publish();
    expect(campaignRegistry(db).get('dbd')!.name).toBe('Dead Before Dawn');
  });

  // A draft is a half-finished upload. It must not be votable.
  it('leaves drafts out', () => {
    insertDraft(db, {
      slug: 'wip', name: 'WIP', vpkFilename: 'wip.vpk',
      sizeBytes: 1, sha256: 'b'.repeat(64), uploadedBy: null,
    }, [{ map: 'wip1', display: null, isFinale: true }]);
    invalidateCampaignCache();
    expect(campaignRegistry(db).has('wip')).toBe(false);
  });

  it('reports a custom campaign first map from its chapters', () => {
    publish();
    expect(firstMapOf(db, 'dbd')).toBe('dbd1_alley');
  });

  it('still reports the stock first maps as versus BSPs', () => {
    for (const slug of ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']) {
      expect(firstMapOf(db, slug)).toMatch(/^l4d_vs_/);
    }
  });
});

describe('resolveCampaignForMap', () => {
  it('resolves stock maps by prefix, with no DB lookup needed', () => {
    expect(resolveCampaignForMap(db, 'l4d_vs_farm01_hilltop')).toBe('blood_harvest');
  });

  it('resolves a custom map through its chapters', () => {
    publish();
    expect(resolveCampaignForMap(db, 'dbd2_mall')).toBe('dbd');
  });

  // Guessing is what campaignForMap was written to avoid: an unknown map must
  // stay unattributed rather than land under someone else's campaign.
  it('returns null for a map nothing claims', () => {
    expect(resolveCampaignForMap(db, 'some_random_map')).toBeNull();
  });

  // The parser is called per round by the log listener, so the lookup is
  // cached. A campaign removed after the cache warmed must stop resolving.
  it('stops resolving a deleted campaign once the cache is invalidated', () => {
    publish();
    expect(resolveCampaignForMap(db, 'dbd1_alley')).toBe('dbd');
    deleteCampaign(db, 'dbd');
    invalidateCampaignCache();
    expect(resolveCampaignForMap(db, 'dbd1_alley')).toBeNull();
  });
});

describe('stats attribute custom maps', () => {
  it('gives mapIndex a campaign for a custom map', async () => {
    publish();
    const { mapIndex } = await import('../src/playerStats.js');
    // Record one completed match on a custom map, following the fixture
    // pattern in tests/playerStats.test.ts, then assert the row is attributed.
    upsertPlayer(db, { steamid: ME, name: 'me', avatar: null }, []);
    upsertPlayer(db, { steamid: OTHER, name: 'them', avatar: null }, []);
    seedMatch(db, 1, [{ map: 'dbd1_alley', a: 1, b: 0 }], {});
    const row = mapIndex(db).find((r) => r.map === 'dbd1_alley');
    expect(row?.campaign).toBe('dbd');
  });
});

describe('campaignDisplayName', () => {
  it('gives a stock campaign its name', async () => {
    const { campaignDisplayName } = await import('../src/campaignRegistry.js');
    expect(campaignDisplayName(db, 'dead_air')).toBe('Dead Air');
  });

  // The bug this guards: every display site used to write
  // `CAMPAIGNS[slug]?.name ?? slug` inline, so a custom campaign printed its
  // raw slug. A Discord message announcing a live match read "city17_v2_8".
  it('gives a custom campaign its real name, not its slug', async () => {
    const { campaignDisplayName } = await import('../src/campaignRegistry.js');
    publish();
    expect(campaignDisplayName(db, 'dbd')).toBe('Dead Before Dawn');
  });

  it('falls back to the slug for a campaign nothing knows about', async () => {
    const { campaignDisplayName } = await import('../src/campaignRegistry.js');
    expect(campaignDisplayName(db, 'never_heard_of_it')).toBe('never_heard_of_it');
  });
});

describe('stock chapter lists', () => {
  const AIRPORT = `"mission"
{
  "Name" "airport"
  "DisplayTitle" "Dead Air"
  "modes"
  {
    "versus"
    {
      "1" { "Map" "l4d_vs_airport01_greenhouse" "DisplayName" "The Greenhouse" }
      "2" { "Map" "l4d_vs_airport02_offices" "DisplayName" "The Crane" }
      "3" { "Map" "l4d_vs_airport03_garage" "DisplayName" "The Garage" }
      "4" { "Map" "l4d_vs_airport04_terminal" "DisplayName" "The Terminal" }
      "5" { "Map" "l4d_vs_airport05_runway" "DisplayName" "The Runway" }
    }
  }
}
`;

  afterEach(async () => {
    // A directory left set on one test's missions dir would otherwise leak
    // into the next test's registry cache.
    const { setMissionsDirs } = await import('../src/campaignRegistry.js');
    setMissionsDirs([]);
  });

  it('is empty when no missions directory is configured', async () => {
    const { setMissionsDirs, campaignRegistry } = await import('../src/campaignRegistry.js');
    setMissionsDirs([]);
    expect(campaignRegistry(db).get('dead_air')!.maps).toEqual([]);
  });

  it('reads the stock chapter list once a missions directory is configured', async () => {
    const { setMissionsDirs, campaignRegistry } = await import('../src/campaignRegistry.js');
    const dir = mkdtempSync(join(tmpdir(), 'missions-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'airport.txt'), AIRPORT);
      setMissionsDirs([dir]);
      expect(campaignRegistry(db).get('dead_air')!.maps).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // stockChaptersOf is the admin panel's only source for a stock campaign's
  // chapter display names: CampaignEntry.maps stays plain map names on
  // purpose, since stopAfterMap and the orchestrator only ever need those.
  it('carries chapter display names for the admin panel', async () => {
    const { setMissionsDirs } = await import('../src/campaignRegistry.js');
    const dir = mkdtempSync(join(tmpdir(), 'missions-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'airport.txt'), AIRPORT);
      setMissionsDirs([dir]);
      const chapters = stockChaptersOf(db, 'dead_air');
      expect(chapters.map((c) => c.display)).toEqual([
        'The Greenhouse', 'The Crane', 'The Garage', 'The Terminal', 'The Runway',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is empty for stockChaptersOf when no missions directory is configured', async () => {
    const { setMissionsDirs } = await import('../src/campaignRegistry.js');
    setMissionsDirs([]);
    expect(stockChaptersOf(db, 'dead_air')).toEqual([]);
  });
});

describe('dlc4 campaigns in the registry', () => {
  it('lists all twelve campaigns with no missions directory configured', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    const reg = campaignRegistry(db);
    expect(reg.size).toBe(12);
    // Chapter lists come from mission files, so they are empty here. The
    // campaign still exists, which is what makes the pool gate meaningful
    // even when the paths are unset.
    expect(reg.get('dead_center')?.maps).toEqual([]);
  });

  it('marks exactly the dlc4 campaigns as requiring dlc4', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    const reg = campaignRegistry(db);
    expect(reg.get('dead_center')?.requiresDlc4).toBe(true);
    expect(reg.get('the_last_stand')?.requiresDlc4).toBe(true);
    expect(reg.get('no_mercy')?.requiresDlc4).toBe(false);
  });

  it('gives a dlc4 campaign its own first map, with no vs_ infix', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    expect(firstMapOf(db, 'dead_center')).toBe('c1m1_hotel');
    expect(firstMapOf(db, 'the_parish')).toBe('c5m1_waterfront');
    expect(firstMapOf(db, 'no_mercy')).toBe('l4d_vs_hospital01_apartment');
  });

  it('resolves a dlc4 map to its campaign', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    expect(resolveCampaignForMap(db, 'c2m3_coaster')).toBe('dark_carnival');
  });

  // A published custom campaign must never be marked as needing dlc4: it has
  // its own VPK and its own install rows, and conflating the two gates would
  // make every custom campaign unpoolable the moment one server lacked dlc4.
  it('never marks a custom campaign as requiring dlc4', () => {
    publish();
    setMissionsDirs([]);
    invalidateCampaignCache();
    expect(campaignRegistry(db).get('dbd')?.requiresDlc4).toBe(false);
  });
});
