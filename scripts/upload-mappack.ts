/**
 * Put the L4D2 mappack in R2 for players to download.
 *
 * One object, uploaded once per pack version. The inner zip of the gamemaps
 * download, not the wrapper: the wrapper holds a ReadMe, two JPGs and this
 * file, so hosting it would make every player unzip twice for no gain.
 *
 * Usage: npx tsx scripts/upload-mappack.ts <path-to-l4d2-in-l4d1.zip>
 *
 * Credentials come from the environment or a .env beside you, same as the
 * other operator scripts here. This one takes no --env flag because it is
 * meant to run once, by hand, from wherever the real zip and the real
 * credentials both happen to be.
 */
import { stat } from 'node:fs/promises';
import { head, put, publicUrlFor, r2FromEnv } from '../src/r2.js';
import { loadDotEnv } from './dotenv.js';

const KEY = 'mappack/L4D2-Maps-for-L4D1-v3.1e.zip';
const FILENAME = 'L4D2-Maps-for-L4D1-v3.1e.zip';

// The version is baked into the key, so the object is never rewritten in
// place and can be cached forever.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// A real pack is 3.4 GB. Anything under 3 GB is a truncated or half-finished
// download, and uploading it would hand every player in the pool a mappack
// that fails partway through unzipping.
const MIN_BYTES = 3 * 1024 * 1024 * 1024;

const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

loadDotEnv();

const localPath = process.argv[2];
if (!localPath) {
  console.error('Usage: npx tsx scripts/upload-mappack.ts <path-to-l4d2-in-l4d1.zip>');
  process.exit(1);
}

const r2 = r2FromEnv();
if (!r2) {
  console.error('R2 is not configured. All five of R2_ENDPOINT, R2_BUCKET,');
  console.error('R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL must be set.');
  process.exit(1);
}

let local: { size: number };
try {
  local = await stat(localPath);
} catch (err) {
  console.error(`Could not read ${localPath}: ${String(err)}`);
  process.exit(1);
}

if (local.size < MIN_BYTES) {
  console.error(`${localPath} is only ${gb(local.size)}, expected at least ${gb(MIN_BYTES)}.`);
  console.error('That looks like a truncated or half-finished download, not the full mappack.');
  console.error('Nothing was uploaded. Re-download the zip and try again.');
  process.exit(1);
}

console.log(`Uploading ${localPath} (${gb(local.size)}) to ${r2.bucket}/${KEY} ...`);

try {
  await put(r2, KEY, localPath, {
    contentType: 'application/zip',
    contentDisposition: `attachment; filename="${FILENAME}"`,
    cacheControl: CACHE_CONTROL,
  });
} catch (err) {
  console.error(`Upload failed: ${String(err)}`);
  process.exit(1);
}

// Verify the bytes landed. A PUT that reports success but stores a truncated
// object would hand every player the exact broken download this script
// exists to prevent.
const after = await head(r2, KEY).catch(() => null);
if (!after || after.bytes !== local.size) {
  console.error(`Upload reported success but the stored object does not match.`);
  console.error(`local: ${local.size} bytes, remote: ${after ? after.bytes : 'missing'} bytes.`);
  console.error('Do not point players at this yet. Re-run the upload.');
  process.exit(1);
}

console.log(`Done. ${gb(after.bytes)} stored at ${publicUrlFor(r2, KEY)}`);
process.exit(0);
