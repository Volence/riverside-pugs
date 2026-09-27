import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, type DB } from '../src/db.js';
import { getCampaign, insertDraft, publishCampaign } from '../src/customCampaigns.js';
import {
  campaignZipFilename, campaignZipKey, currentZip, sweepCampaignZips, zipCampaign, type CampaignZipDeps,
} from '../src/campaignZip.js';

let db: DB;
let addons: string;

beforeEach(() => {
  db = openDb(':memory:');
  addons = mkdtempSync(join(tmpdir(), 'zips-'));
});
afterEach(() => rmSync(addons, { recursive: true, force: true }));

const publish = (slug: string, body: string, publishIt = true) => {
  writeFileSync(join(addons, `${slug}.vpk`), body);
  insertDraft(db, {
    slug, name: slug, vpkFilename: `${slug}.vpk`, sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'), uploadedBy: null,
  }, [{ map: `${slug}1`, display: null, isFinale: true }]);
  if (publishIt) publishCampaign(db, slug, slug);
};

/** A fake zipper and uploader: records what was uploaded, under which key and
 *  download name, and reports the zip as 7 bytes. */
const fakeDeps = (uploads: { key: string; filename: string; exists: boolean }[], fail = new Set<string>()): CampaignZipDeps => ({
  r2: { endpoint: 'e', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', publicUrl: 'p' },
  addonsDir: addons,
  workDir: join(addons, 'work'),
  makeZip: async (_vpk, zip) => { writeFileSync(zip, 'zipzip!'); },
  upload: async (key, zipPath, filename) => {
    if (fail.has(key)) throw new Error('R2 down');
    uploads.push({ key, filename, exists: existsSync(zipPath) });
    return 7;
  },
});

describe('campaignZip', () => {
  it('names the key after the hash and the download after the VPK', () => {
    expect(campaignZipKey('dbd', 'abcdef0123456789ffff')).toBe('campaigns/dbd-abcdef0123456789.zip');
    expect(campaignZipFilename('cityofthedeadreduxl4d.vpk')).toBe('cityofthedeadreduxl4d.zip');
  });

  it('zips, uploads, records the zip and cleans up its scratch file', async () => {
    publish('dbd', 'vpk bytes');
    const uploads: { key: string; filename: string; exists: boolean }[] = [];
    expect(await zipCampaign(db, 'dbd', fakeDeps(uploads))).toBe('zipped');
    const row = getCampaign(db, 'dbd')!;
    expect(uploads).toEqual([{ key: campaignZipKey('dbd', row.sha256), filename: 'dbd.zip', exists: true }]);
    expect(currentZip(row)).toEqual({ key: campaignZipKey('dbd', row.sha256), bytes: 7 });
    expect(readdirSync(join(addons, 'work'))).toEqual([]);
    // Nothing to do the second time.
    expect(await zipCampaign(db, 'dbd', fakeDeps(uploads))).toBe('current');
    expect(uploads).toHaveLength(1);
  });

  it('skips drafts and VPKs that no longer match their recorded size', async () => {
    publish('wip', 'draft', false);
    publish('dbd', 'vpk bytes');
    writeFileSync(join(addons, 'dbd.vpk'), 'edited by hand');
    const uploads: { key: string; filename: string; exists: boolean }[] = [];
    expect(await zipCampaign(db, 'wip', fakeDeps(uploads))).toBe('skipped');
    expect(await zipCampaign(db, 'dbd', fakeDeps(uploads))).toBe('skipped');
    expect(uploads).toEqual([]);
  });

  it('sweeps every published campaign, and one failure does not stop the rest', async () => {
    publish('aaa', 'first');
    publish('bbb', 'second');
    const failKey = campaignZipKey('aaa', getCampaign(db, 'aaa')!.sha256);
    const uploads: { key: string; filename: string; exists: boolean }[] = [];
    const logs: string[] = [];
    await sweepCampaignZips(db, fakeDeps(uploads, new Set([failKey])), (m) => logs.push(m));
    expect(currentZip(getCampaign(db, 'aaa')!)).toBeNull();
    expect(currentZip(getCampaign(db, 'bbb')!)).not.toBeNull();
    expect(logs.some((m) => m.includes('aaa failed'))).toBe(true);
    // The next sweep retries it.
    await sweepCampaignZips(db, fakeDeps(uploads), () => {});
    expect(currentZip(getCampaign(db, 'aaa')!)).not.toBeNull();
  });
});
