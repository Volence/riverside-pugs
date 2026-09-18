/**
 * Push the generated map overview layers to R2.
 *
 * The 4x4 set is 182 layers and 944 MB, against 28 MB for the 1x set it
 * replaces, and it grows by roughly 175 MB per custom campaign added. That is
 * too much to commit to a public repository, whose history would carry it
 * forever, and too much to rsync to a box that moved its demos off for space.
 * The files are written once, never read by the backend, and served whole, so
 * they belong in the bucket for the same reasons demos do: see src/r2.ts.
 *
 * Usage, from a checkout that has the converted files in web/public/overviews:
 *
 *   npx tsx scripts/upload-overviews.ts                 # dry run, uploads nothing
 *   npx tsx scripts/upload-overviews.ts --upload        # upload what is missing
 *   npx tsx scripts/upload-overviews.ts --upload --force  # re-upload everything
 *
 * Credentials come from the environment or a .env beside you. They live on the
 * box, so either run this there against a synced copy of the files or point it
 * at a local .env you populated yourself: `npx tsx scripts/upload-overviews.ts
 * --env /path/to/.env --upload`.
 *
 * Skipping is by size, not by hash. An overview is rewritten only by a
 * deliberate recapture, and a recapture that changes the picture essentially
 * always changes the byte count; --force covers the case where it did not.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { head, put, publicUrlFor, overviewKey, r2FromEnv, OVERVIEW_CACHE_CONTROL } from '../src/r2.js';
import { loadDotEnv } from './dotenv.js';

const argOf = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

loadDotEnv(argOf('env') ?? '.env');

const upload = process.argv.includes('--upload');
const force = process.argv.includes('--force');
const dir = argOf('dir') ?? 'web/public/overviews';

const r2 = r2FromEnv();
if (!r2) {
  console.error('R2 is not configured. All five of R2_ENDPOINT, R2_BUCKET,');
  console.error('R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL must be set.');
  console.error('Pass --env=/path/to/.env if the file is not beside you.');
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.webp')).sort();
if (files.length === 0) {
  console.error(`${dir} holds no .webp layers. Run tools/convert-overviews.sh first.`);
  process.exit(1);
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

let sent = 0;
let sentBytes = 0;
let skipped = 0;
let localBytes = 0;
const failures: string[] = [];

for (const file of files) {
  const key = overviewKey(file);
  const local = statSync(join(dir, file)).size;
  localBytes += local;

  let remote: { bytes: number } | null = null;
  try {
    remote = await head(r2, key);
  } catch (err) {
    // Bad credentials or an unreachable endpoint fail identically on every one
    // of 182 files. Say it once and stop rather than printing the same line
    // until the list runs out.
    if (sent === 0 && skipped === 0) {
      console.error(`Could not reach the bucket: ${String(err)}`);
      console.error('Check R2_ENDPOINT and the keys before retrying.');
      process.exit(1);
    }
    failures.push(`${file}: HEAD failed: ${String(err)}`);
    continue;
  }

  if (remote && remote.bytes === local && !force) {
    skipped += 1;
    continue;
  }

  const why = !remote ? 'missing' : remote.bytes !== local ? `${mb(remote.bytes)} remote` : 'forced';
  if (!upload) {
    console.log(`would upload ${file}  (${mb(local)}, ${why})`);
    sent += 1;
    sentBytes += local;
    continue;
  }

  try {
    await put(r2, key, join(dir, file), {
      contentType: 'image/webp',
      cacheControl: OVERVIEW_CACHE_CONTROL,
    });
  } catch (err) {
    failures.push(`${file}: ${String(err)}`);
    continue;
  }

  // Verify the bytes landed. A PUT that reports success but stores a truncated
  // object would leave a layer that renders as a broken image for everyone.
  const after = await head(r2, key).catch(() => null);
  if (!after || after.bytes !== local) {
    failures.push(`${file}: stored ${after ? after.bytes : 'nothing'}, expected ${local}`);
    continue;
  }
  sent += 1;
  sentBytes += local;
  console.log(`uploaded ${file}  (${mb(local)})`);
}

console.log('');
console.log(`${files.length} layers locally, ${mb(localBytes)} total`);
console.log(`${upload ? 'uploaded' : 'would upload'} ${sent} (${mb(sentBytes)}), already present ${skipped}`);
if (failures.length) {
  console.log('');
  console.error(`${failures.length} failed:`);
  for (const f of failures) console.error(`  ${f}`);
}
console.log('');
console.log('Base URL for tools/gen-overviews.py --base-url:');
console.log(`  ${publicUrlFor(r2, 'overviews').replace(/\/overviews$/, '/overviews')}`);
process.exit(failures.length ? 1 : 0);
