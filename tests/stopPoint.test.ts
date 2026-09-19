import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { invalidateCampaignCache, setMissionsDir } from '../src/campaignRegistry.js';
import { setMapsToPlay } from '../src/campaignRules.js';
import { stopAfterMap } from '../src/stopPoint.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  setMissionsDir('');
  invalidateCampaignCache();
  insertDraft(db, {
    slug: 'five', name: 'Five', vpkFilename: 'five.vpk',
    sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
  }, [1, 2, 3, 4, 5].map((n) => ({ map: `m${n}`, display: null, isFinale: n === 5 })));
  publishCampaign(db, 'five', 'Five');
  invalidateCampaignCache();
});
afterEach(() => { setMissionsDir(''); invalidateCampaignCache(); });

describe('stopAfterMap', () => {
  // The default is today's behaviour, and this is the assertion that protects
  // every match the site already runs.
  it('stops one before the last when there is no rule', () => {
    expect(stopAfterMap(db, 'five')).toBe('m4');
  });

  it('stops after the Nth map when a rule says N', () => {
    setMapsToPlay(db, 'five', 3);
    expect(stopAfterMap(db, 'five')).toBe('m3');
  });

  // The case the owner actually asked for, and the one the plugin has never
  // exercised: play the whole campaign including its finale.
  it('stops after the finale when the rule names every map', () => {
    setMapsToPlay(db, 'five', 5);
    expect(stopAfterMap(db, 'five')).toBe('m5');
  });

  // A rule left over from a campaign that was re-uploaded shorter must not
  // index off the end.
  it('clamps a rule naming more maps than the campaign has', () => {
    setMapsToPlay(db, 'five', 99);
    expect(stopAfterMap(db, 'five')).toBe('m5');
  });

  // Zero or negative is not a thing. Fall back to the default rather than
  // inventing a match with no maps.
  it.each([0, -1])('ignores a nonsense rule of %s', (n) => {
    setMapsToPlay(db, 'five', n);
    expect(stopAfterMap(db, 'five')).toBe('m4');
  });

  // No known maps means no argument, and the plugin keeps its own logic. This
  // is the stock case until a missions directory is configured.
  it('is null for a campaign with no known maps', () => {
    expect(stopAfterMap(db, 'dead_air')).toBeNull();
  });

  it('is null for a campaign nothing knows about', () => {
    expect(stopAfterMap(db, 'nope')).toBeNull();
  });

  // A one-chapter campaign has no "one before the last". Play the one map
  // rather than returning nothing.
  it('handles a single-map campaign', () => {
    insertDraft(db, {
      slug: 'one', name: 'One', vpkFilename: 'one.vpk',
      sizeBytes: 1, sha256: 'b'.repeat(64), uploadedBy: null,
    }, [{ map: 'solo', display: null, isFinale: true }]);
    publishCampaign(db, 'one', 'One');
    invalidateCampaignCache();
    expect(stopAfterMap(db, 'one')).toBe('solo');
  });
});
