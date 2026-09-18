/**
 * Run the demo offload to R2 once, now, instead of waiting for the hourly sweep.
 *
 * Exists for the first migration, when there is a backlog of a couple of
 * gigabytes to move and nobody wants to wait an hour per batch, and afterwards
 * for the case where a sweep failed and you want to see it fail in a terminal
 * rather than in the journal.
 *
 * Usage, on the box, as the pug user so it can read .env and write the db:
 *
 *   cd /home/pug/app
 *   sudo -u pug npx tsx scripts/offload-demos.ts            # dry run, uploads nothing
 *   sudo -u pug npx tsx scripts/offload-demos.ts --upload   # upload, keep local copies
 *   sudo -u pug npx tsx scripts/offload-demos.ts --upload --delete   # and reclaim space
 *
 * The three modes are deliberate. --upload without --delete is the safe first
 * pass: everything is copied up and the local files are untouched, so the bucket
 * can be checked by hand before anything is destroyed. Running again with
 * --delete verifies each remote copy and only then removes the local one. See
 * offloadMatchDemos for why that ordering is not negotiable.
 */
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { sweepDemos } from '../src/demoOffload.js';
import { r2FromEnv } from '../src/r2.js';

/**
 * Load .env into the environment, the way systemd does for the service.
 *
 * The app itself never reads .env: `pug-web.service` has EnvironmentFile and
 * that is the only thing that supplies DB_PATH, DEMO_DIR and the R2 keys. A
 * script run by hand inherits none of it and would otherwise report "R2 is not
 * configured" while sitting next to a perfectly good .env file, which is a
 * confusing way to be told to prefix a command with `set -a`.
 *
 * Deliberately does not override anything already set, so a one-off
 * `DEMO_DIR=/somewhere npx tsx ...` still wins. Deliberately lives here and not
 * in src/config.ts: how the SERVER gets its configuration is systemd's job and
 * is not being changed.
 */
function loadDotEnv(path = '.env'): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // No .env is fine: the environment may already carry everything.
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    // Strip one layer of matching quotes, which systemd also accepts.
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    process.env[m[1]] ??= value;
  }
}

loadDotEnv();

const upload = process.argv.includes('--upload');
const deleteLocal = process.argv.includes('--delete');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 1000;

const cfg = loadConfig(process.env);
const r2 = r2FromEnv();

if (!r2) {
  console.error('R2 is not configured. All five of R2_ENDPOINT, R2_BUCKET,');
  console.error('R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL must be set.');
  process.exit(1);
}
if (!cfg.demoDir) {
  console.error('DEMO_DIR is not set, so there is nothing to sweep.');
  process.exit(1);
}

const db = openDb(cfg.dbPath);

const pending = db.prepare(
  `SELECT COUNT(*) AS files, COUNT(DISTINCT d.match_id) AS matches, COALESCE(SUM(d.bytes), 0) AS bytes
     FROM match_demos d JOIN matches m ON m.id = d.match_id
    WHERE d.r2_key IS NULL AND m.state IN ('completed', 'aborted')`,
).get() as { files: number; matches: number; bytes: number };

const done = db.prepare('SELECT COUNT(*) AS n FROM match_demos WHERE r2_key IS NOT NULL').get() as { n: number };

console.log(`bucket    : ${r2.bucket}`);
console.log(`demo dir  : ${cfg.demoDir}`);
console.log(`already up: ${done.n} files`);
console.log(`pending   : ${pending.files} files across ${pending.matches} matches, ${(pending.bytes / 1e6).toFixed(1)} MB`);

if (!upload) {
  console.log('\nDry run. Pass --upload to copy them up, and --delete as well to reclaim the space.');
  process.exit(0);
}

console.log(`\nUploading${deleteLocal ? ' and deleting local copies' : ' (local copies kept)'}...`);
const started = Date.now();
const r = await sweepDemos(db, r2, cfg.demoDir, { limit, deleteLocal });
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\nuploaded  : ${r.uploaded}`);
console.log(`skipped   : ${r.skipped}`);
console.log(`failed    : ${r.failed}`);
console.log(`reclaimed : ${(r.bytes / 1e6).toFixed(1)} MB`);
console.log(`took      : ${secs}s`);

// Non-zero exit on any failure so a wrapper or a human notices, rather than
// reading "uploaded: 0, failed: 108" as success.
process.exit(r.failed > 0 ? 1 : 0);
