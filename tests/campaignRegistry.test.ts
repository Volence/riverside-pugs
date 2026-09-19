import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, publishCampaign, deleteCampaign } from '../src/customCampaigns.js';
import { upsertPlayer } from '../src/players.js';
import { ME, OTHER, seedMatch } from './playerStats.test.js';
import {
  campaignRegistry, resolveCampaignForMap, invalidateCampaignCache, firstMapOf,
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
      .toEqual(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']);
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
    const { setMissionsDir } = await import('../src/campaignRegistry.js');
    setMissionsDir('');
  });

  it('is empty when no missions directory is configured', async () => {
    const { setMissionsDir, campaignRegistry } = await import('../src/campaignRegistry.js');
    setMissionsDir('');
    expect(campaignRegistry(db).get('dead_air')!.maps).toEqual([]);
  });

  it('reads the stock chapter list once a missions directory is configured', async () => {
    const { setMissionsDir, campaignRegistry } = await import('../src/campaignRegistry.js');
    const dir = mkdtempSync(join(tmpdir(), 'missions-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'airport.txt'), AIRPORT);
      setMissionsDir(dir);
      expect(campaignRegistry(db).get('dead_air')!.maps).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
