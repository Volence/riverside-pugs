/**
 * Push one version of the 3D theatre's heavy set to R2 (docs/theatre-3d.md).
 *
 * tools/sync-theatre.sh stages it in theatre-assets/<version>/: the converted
 * maps, models, sounds and character light, about 3.8 GB and 2,900 files, far
 * too much for the public repository or the box that holds 100 tick. They are
 * written once and read whole by browsers, so they belong in the bucket for the
 * same reasons demos and overview layers do (src/r2.ts). Each file goes to
 * theatre/<version>/<path>; the site's viewer loads them from
 * https://assets.riversidepug.com/theatre/<version>/ (the bucket's CORS rule
 * lets riversidepug.com GET and HEAD them).
 *
 * Usage, from the checkout that ran the sync:
 *
 *   npx tsx scripts/upload-theatre.ts                  # dry run, uploads nothing
 *   npx tsx scripts/upload-theatre.ts --upload         # upload what is missing
 *   npx tsx scripts/upload-theatre.ts --upload --force # re-upload everything
 *   --version=<v>   another staged version (default: web/public/theatre/manifest.json's)
 *   --dir=<path>    the staging folder (default: theatre-assets)
 *   --jobs=<n>      parallel requests (default 8)
 *   --env=<path>    the .env holding the R2 keys (default: ./.env)
 *
 * manifest.json goes up LAST, and only when every other file is there with the
 * right size: deploy-web.sh refuses to ship a site whose theatre version has no
 * manifest on R2, so a half-finished upload can never be deployed against.
 *
 * Skipping is by size: a version's content never changes (its name is the hash
 * of its content), so an object of the right size under that key is that file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { head, put, publicUrlFor, r2FromEnv } from '../src/r2.js';
import {
  findSteamIds, theatreContentType, theatreForbidden, theatreKey, THEATRE_CACHE_CONTROL,
} from '../src/theatreAssets.js';
import { loadDotEnv } from './dotenv.js';

const argOf = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

loadDotEnv(argOf('env') ?? '.env');

const upload = process.argv.includes('--upload');
const force = process.argv.includes('--force');
const jobs = Math.max(1, Number(argOf('jobs') ?? 8) || 8);
const stagingRoot = argOf('dir') ?? 'theatre-assets';

let version = argOf('version');
if (!version) {
  try {
    version = String(JSON.parse(readFileSync('web/public/theatre/manifest.json', 'utf8')).version ?? '');
  } catch {
    version = '';
  }
}
if (!version || !/^[A-Za-z0-9._-]+$/.test(version)) {
  console.error('No theatre version: run tools/sync-theatre.sh first, or pass --version=<v>.');
  process.exit(1);
}
const dir = join(stagingRoot, version);

let files: string[];
try {
  files = (readdirSync(dir, { recursive: true }) as string[])
    .map(String)
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => relative(dir, join(dir, f)).split('\\').join('/'))
    .sort();
} catch {
  console.error(`${dir} does not exist. Run tools/sync-theatre.sh first.`);
  process.exit(1);
}

// Checks before anything is sent: nothing forbidden, nothing of an unknown
// type, no SteamID in any text file, and the manifest is the version's own.
const problems: string[] = [];
for (const f of files) {
  if (theatreForbidden(f)) problems.push(`${f}: must never be published (backup, log, bookmark file or parser sample)`);
  else if (!theatreContentType(f)) problems.push(`${f}: not a file type the theatre uses`);
  else if (f.endsWith('.json')) {
    const ids = findSteamIds(readFileSync(join(dir, f), 'utf8'));
    if (ids.length) problems.push(`${f}: ${ids.length} SteamID(s)`);
  }
}
if (!files.includes('manifest.json')) problems.push('manifest.json is missing');
else {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version?: string };
  if (m.version !== version) problems.push(`manifest.json names version ${m.version}, not ${version}`);
}
if (problems.length) {
  console.error(`Refusing to upload ${dir}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const r2 = r2FromEnv();
if (!r2 && !upload) {
  // A dry run on a machine without the keys still checks the set and sizes it.
  const total = files.reduce((t, f) => t + statSync(join(dir, f)).size, 0);
  console.log(`theatre ${version}: ${files.length} files, ${mb(total)}, checks passed.`);
  console.log('R2 is not configured here, so what is already in the bucket is unknown (pass --env=<.env>).');
  process.exit(0);
}
if (!r2) {
  console.error('R2 is not configured. All five of R2_ENDPOINT, R2_BUCKET,');
  console.error('R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL must be set.');
  console.error('Pass --env=/path/to/.env if the file is not beside you.');
  process.exit(1);
}

let sent = 0;
let sentBytes = 0;
let skipped = 0;
let localBytes = 0;
const failures: string[] = [];

async function one(file: string): Promise<void> {
  const key = theatreKey(version!, file);
  const local = statSync(join(dir, file)).size;
  localBytes += local;
  let remote: { bytes: number } | null;
  try {
    remote = await head(r2!, key);
  } catch (err) {
    failures.push(`${file}: HEAD failed: ${String(err)}`);
    return;
  }
  if (remote && remote.bytes === local && !force) { skipped += 1; return; }
  const why = !remote ? 'missing' : remote.bytes !== local ? `${mb(remote.bytes)} remote` : 'forced';
  if (!upload) {
    if (sent < 20) console.log(`would upload ${file}  (${mb(local)}, ${why})`);
    sent += 1;
    sentBytes += local;
    return;
  }
  try {
    await put(r2!, key, join(dir, file), { contentType: theatreContentType(file)!, cacheControl: THEATRE_CACHE_CONTROL });
    // A PUT that reports success but stored a short object would break that
    // file for everyone for a year (immutable cache): check it landed whole.
    const after = await head(r2!, key);
    if (!after || after.bytes !== local) throw new Error(`stored ${after ? after.bytes : 'nothing'}, expected ${local}`);
  } catch (err) {
    failures.push(`${file}: ${String(err)}`);
    return;
  }
  sent += 1;
  sentBytes += local;
  if (sent % 100 === 0) console.log(`  ${sent} uploaded (${mb(sentBytes)})`);
}

// One HEAD first: bad keys or an unreachable endpoint fail the same on all
// 2,900 files, so say it once and stop.
try {
  await head(r2, theatreKey(version, 'manifest.json'));
} catch (err) {
  console.error(`Could not reach the bucket: ${String(err)}`);
  console.error('Check R2_ENDPOINT and the keys before retrying.');
  process.exit(1);
}

const body = files.filter((f) => f !== 'manifest.json');
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < body.length) await one(body[next++]);
}));
if (sent > 20 && !upload) console.log(`... and ${sent - 20} more`);

// The manifest last, and only over a complete set.
if (failures.length === 0) await one('manifest.json');
else console.error('manifest.json NOT uploaded: the set is incomplete (see the failures below).');

console.log('');
console.log(`theatre ${version}: ${files.length} files locally, ${mb(localBytes)} total`);
console.log(`${upload ? 'uploaded' : 'would upload'} ${sent} (${mb(sentBytes)}), already present ${skipped}`);
if (failures.length) {
  console.log('');
  console.error(`${failures.length} failed:`);
  for (const f of failures.slice(0, 50)) console.error(`  ${f}`);
}
console.log('');
console.log(`Served at ${publicUrlFor(r2, `theatre/${version}`)}/`);
process.exit(failures.length ? 1 : 0);
