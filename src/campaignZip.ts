import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DB } from './db.js';
import { getCampaign, listCampaigns } from './customCampaigns.js';
import { head, put, type R2Config } from './r2.js';

const execFileAsync = promisify(execFile);

/**
 * Zipped custom campaign downloads, kept in R2.
 *
 * A VPK is uncompressed and the maps in it deflate to about a third, so a
 * player downloading the zip gets the same file in a fraction of the time.
 * Serving it from R2 also takes the download off Dallas, which streamed every
 * one of them from the live game server's own disk. The raw VPK stays the
 * fallback: a campaign is served raw until its zip exists.
 */

/** The object key for a campaign's zip. Carries the VPK's hash, so the object
 *  never changes under a URL (it is served immutable) and a re-uploaded VPK
 *  gets a new key rather than an old zip. */
export function campaignZipKey(slug: string, sha256: string): string {
  return `campaigns/${slug}-${sha256.slice(0, 16)}.zip`;
}

/** The name a player's browser saves the zip as: the VPK's own name. */
export function campaignZipFilename(vpkFilename: string): string {
  return `${vpkFilename.replace(/\.vpk$/i, '')}.zip`;
}

/** The zip a campaign row may be served as, or null when it has none that
 *  matches its current VPK. */
export function currentZip(
  c: { slug: string; sha256: string; zip_key: string | null; zip_bytes: number | null },
): { key: string; bytes: number } | null {
  if (!c.zip_key || c.zip_bytes == null) return null;
  return c.zip_key === campaignZipKey(c.slug, c.sha256) ? { key: c.zip_key, bytes: c.zip_bytes } : null;
}

export interface CampaignZipDeps {
  r2: R2Config;
  addonsDir: string;
  /** Scratch directory; each zip is removed from it once uploaded. */
  workDir: string;
  /** Test seam. Production runs Info-ZIP at the lowest CPU and IO priority,
   *  because on Dallas this shares two cores with the game servers. */
  makeZip?: (vpkPath: string, zipPath: string) => Promise<void>;
  /** Test seam over r2.put + r2.head. */
  upload?: (key: string, zipPath: string, filename: string) => Promise<number>;
}

async function niceZip(vpkPath: string, zipPath: string): Promise<void> {
  // -j stores the bare file name, so the zip holds exactly `name.vpk`.
  await execFileAsync('nice', ['-n', '19', 'ionice', '-c', '3', 'zip', '-q', '-j', '-6', zipPath, vpkPath],
    { maxBuffer: 1 << 20 });
}

async function r2Upload(r2: R2Config, key: string, zipPath: string, filename: string): Promise<number> {
  const { bytes } = await put(r2, key, zipPath, {
    contentType: 'application/zip',
    contentDisposition: `attachment; filename="${filename}"`,
    cacheControl: 'public, max-age=31536000, immutable',
  });
  const after = await head(r2, key);
  if (!after || after.bytes !== bytes) {
    throw new Error(`R2 holds ${after ? after.bytes : 'nothing'} for ${key}, expected ${bytes}`);
  }
  return bytes;
}

/**
 * Zip one published campaign and upload it, unless it already has a current
 * zip. Returns what happened; throws only on a real failure, which the sweep
 * logs and retries on its next pass.
 */
export async function zipCampaign(db: DB, slug: string, deps: CampaignZipDeps): Promise<'zipped' | 'current' | 'skipped'> {
  const c = getCampaign(db, slug);
  if (!c || c.state !== 'published') return 'skipped';
  if (currentZip(c)) return 'current';
  const vpkPath = join(deps.addonsDir, c.vpk_filename);
  // The same guard the raw download route applies: a file that is not the one
  // the site recorded is never packaged as if it were.
  const onDisk = await stat(vpkPath).catch(() => null);
  if (!onDisk || onDisk.size !== c.size_bytes) return 'skipped';

  const key = campaignZipKey(c.slug, c.sha256);
  await mkdir(deps.workDir, { recursive: true });
  const zipPath = join(deps.workDir, `${c.slug}-${c.sha256.slice(0, 16)}.zip`);
  try {
    await rm(zipPath, { force: true });
    await (deps.makeZip ?? niceZip)(vpkPath, zipPath);
    const filename = campaignZipFilename(c.vpk_filename);
    const bytes = await (deps.upload ?? ((k, p, f) => r2Upload(deps.r2, k, p, f)))(key, zipPath, filename);
    // Only if the row still describes the VPK that was zipped: a delete or a
    // re-upload during the minute this took must not get this zip attached.
    db.prepare('UPDATE custom_campaigns SET zip_key = ?, zip_bytes = ? WHERE slug = ? AND sha256 = ?')
      .run(key, bytes, c.slug, c.sha256);
    return 'zipped';
  } finally {
    await rm(zipPath, { force: true });
  }
}

let sweeping: Promise<void> | null = null;
let again = false;

/**
 * Give every published campaign without a current zip one, one at a time.
 * Runs at startup and after each publish. A call while a sweep is running asks
 * that sweep for one more pass instead of starting a second, so two zips never
 * compete for the box's CPU. Never rejects.
 */
export function sweepCampaignZips(
  db: DB, deps: CampaignZipDeps, log: (msg: string, err?: unknown) => void = console.log,
): Promise<void> {
  if (sweeping) { again = true; return sweeping; }
  sweeping = (async () => {
    do {
      again = false;
      for (const c of listCampaigns(db, { state: 'published' })) {
        if (currentZip(c)) continue;
        try {
          const r = await zipCampaign(db, c.slug, deps);
          if (r === 'zipped') log(`[campaignZip] ${c.slug} zipped to R2`);
        } catch (err) {
          log(`[campaignZip] ${c.slug} failed, served raw until the next sweep`, err);
        }
      }
    } while (again);
  })().finally(() => { sweeping = null; });
  return sweeping;
}
