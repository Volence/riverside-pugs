import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { checkAddonsDir } from '../src/campaignCollisions.js';
import { makeVpk, makeVpkMulti } from './fixtures/makeVpk.js';

const FORCED = ['models/infected/hunter.mdl', 'scripts/game_sounds_weapons.txt'];

let db: DB;
let addons: string;
beforeEach(() => {
  db = openDb(':memory:');
  addons = mkdtempSync(join(tmpdir(), 'addons-check-'));
});
afterEach(() => { rmSync(addons, { recursive: true, force: true }); });

const campaign = (slug: string, published: boolean) => {
  insertDraft(db, {
    slug, name: slug.toUpperCase(), vpkFilename: `${slug}.vpk`,
    sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
  }, [{ map: `${slug}1`, display: null, isFinale: true }]);
  if (published) publishCampaign(db, slug, slug.toUpperCase());
};

describe('checkAddonsDir', () => {
  it('passes a campaign that ships only its own files', () => {
    campaign('clean', true);
    makeVpkMulti(join(addons, 'clean.vpk'), [
      { ext: 'txt', dir: 'missions', name: 'clean', body: 'x' },
      { ext: 'bsp', dir: 'maps', name: 'clean1', body: 'x' },
    ]);
    expect(checkAddonsDir(db, addons, FORCED)).toEqual([
      { filename: 'clean.vpk', slug: 'clean', state: 'published', result: 'ok', collisions: [] },
    ]);
  });

  it('names the enforced paths a published campaign overrides', () => {
    campaign('loud', true);
    makeVpkMulti(join(addons, 'loud.vpk'), [
      { ext: 'txt', dir: 'missions', name: 'loud', body: 'x' },
      { ext: 'txt', dir: 'Scripts', name: 'Game_Sounds_Weapons', body: 'x' },
    ]);
    expect(checkAddonsDir(db, addons, FORCED)).toEqual([
      { filename: 'loud.vpk', slug: 'loud', state: 'published', result: 'collides', collisions: ['scripts/game_sounds_weapons.txt'] },
    ]);
  });

  it('checks a VPK nobody uploaded through the site, because srcds mounts it all the same', () => {
    makeVpk(join(addons, 'handmade.vpk'), { ext: 'mdl', dir: 'models/infected', name: 'hunter', body: 'x' });
    expect(checkAddonsDir(db, addons, FORCED)).toEqual([
      { filename: 'handmade.vpk', slug: null, state: null, result: 'collides', collisions: ['models/infected/hunter.mdl'] },
    ]);
  });

  it('reports a campaign whose VPK is missing, and a file that is not a VPK', () => {
    campaign('gone', false);
    writeFileSync(join(addons, 'junk.vpk'), 'not a vpk at all');
    expect(checkAddonsDir(db, addons, FORCED)).toEqual([
      { filename: 'junk.vpk', slug: null, state: null, result: 'unreadable', collisions: [] },
      { filename: 'gone.vpk', slug: 'gone', state: 'draft', result: 'unreadable', collisions: [] },
    ]);
  });

  it('skips the numbered data halves of a split archive', () => {
    writeFileSync(join(addons, 'big_000.vpk'), 'raw data, no directory');
    makeVpk(join(addons, 'big_dir.vpk'), { ext: 'bsp', dir: 'maps', name: 'big1', body: 'x', archiveIndex: 0 });
    expect(checkAddonsDir(db, addons, FORCED).map((c) => c.filename)).toEqual(['big_dir.vpk']);
  });
});
