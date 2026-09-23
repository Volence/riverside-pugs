/**
 * Upload replays to R2 once, by hand, instead of waiting for the hourly
 * sweep (see src/replayOffload.ts's sweepReplays, which src/index.ts already
 * runs on boot and hourly).
 *
 * Two independent things this can upload, chosen by whether --backups is
 * given:
 *
 *  - Without --backups: the normal sweep, run once, now. Same query and the
 *    same per-file checks (resolvable, quiet REPLAY_QUIET_MS, closed header)
 *    the hourly sweep uses, exposed as eligibleReplays so the dry run here
 *    can never drift from what the sweep would actually do.
 *
 *  - With --backups <dir>: replays whose row is already pruned on the box
 *    (pruned_at set) but never made it to R2 (r2_key null), read instead
 *    from a workstation backup of the replay directory. This is the recovery
 *    path for anything pruned before R2 offload existed: the row survives a
 *    prune, but with no r2_key nothing serves the bytes back until one of
 *    these exists somewhere to upload from.
 *
 * Usage, on the box, as the pug user so it can read .env and write the db:
 *
 *   cd /home/pug/app
 *   sudo -u pug npx tsx scripts/offload-replays.ts                          # dry run, the sweep
 *   sudo -u pug npx tsx scripts/offload-replays.ts --commit                 # upload, the sweep
 *   sudo -u pug npx tsx scripts/offload-replays.ts --limit=200 --commit     # bound how many
 *   sudo -u pug npx tsx scripts/offload-replays.ts --backups /path --commit # from a backup copy
 *
 * Dry run by default in both modes: nothing is uploaded and nothing in the
 * database changes until --commit is given. Refuses to run at all, even dry,
 * without R2 configured, the same as scripts/offload-demos.ts: a plan that
 * can never be carried out is not worth printing.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { eligibleReplays, offloadReplay, sweepReplays } from '../src/replayOffload.js';
import { r2FromEnv, type R2Config } from '../src/r2.js';
import { loadDotEnv } from './dotenv.js';

// Same pattern src/replays.ts and src/replayPrune.ts use for a replay
// filename. Neither exports it, so it is restated here.
const NAME_RE = /^pug_[0-9a-f]{32}_\d+_[12]\.rpl$/;

loadDotEnv();

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 1000;
const backupsIdx = args.indexOf('--backups');
const backupsDir = backupsIdx >= 0 ? args[backupsIdx + 1] : undefined;

const cfg = loadConfig(process.env);
const r2 = r2FromEnv();

if (!r2) {
  console.error('R2 is not configured. All five of R2_ENDPOINT, R2_BUCKET,');
  console.error('R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL must be set.');
  process.exit(1);
}

const db = openDb(cfg.dbPath);

if (backupsDir) {
  await runBackups(db, r2, backupsDir);
} else {
  await runSweep(db, r2);
}

async function runSweep(db: DB, r2: R2Config): Promise<void> {
  if (!cfg.replayDir) {
    console.error('REPLAY_DIR is not set, so there is nothing to sweep.');
    process.exit(1);
  }

  console.log(`bucket     : ${r2.bucket}`);
  console.log(`replay dir : ${cfg.replayDir}`);

  if (!commit) {
    const { eligible, skipped } = eligibleReplays(db, cfg.replayDir, { limit });
    console.log(`eligible   : ${eligible.length} replay(s), ${skipped} considered but not ready`);
    for (const row of eligible) {
      console.log(`  match ${row.matchId} ${row.ordinal}/${row.half}  ${row.filename}`);
    }
    console.log('\nDry run. Pass --commit to upload them.');
    return;
  }

  console.log('\nUploading...');
  const started = Date.now();
  const r = await sweepReplays(db, r2, cfg.replayDir, { limit });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nuploaded : ${r.uploaded}`);
  console.log(`skipped  : ${r.skipped}`);
  console.log(`failed   : ${r.failed}`);
  console.log(`took     : ${secs}s`);

  process.exit(r.failed > 0 ? 1 : 0);
}

async function runBackups(db: DB, r2: R2Config, backupsDir: string): Promise<void> {
  const rows = db.prepare(
    `SELECT match_id AS matchId, ordinal, half, filename
       FROM match_replays
      WHERE pruned_at IS NOT NULL AND r2_key IS NULL
      ORDER BY match_id ASC, ordinal ASC, half ASC
      LIMIT ?`,
  ).all(limit) as { matchId: number; ordinal: number; half: number; filename: string }[];

  const found: { matchId: number; ordinal: number; half: number; filename: string; path: string }[] = [];
  for (const row of rows) {
    // Same hardening resolveReplayPath uses: a filename that is not exactly
    // what we write is left alone rather than normalised into something
    // plausible. NAME_RE also guarantees no path separator, so a plain join
    // cannot escape backupsDir.
    if (row.filename !== basename(row.filename) || !NAME_RE.test(row.filename)) continue;
    const path = join(backupsDir, row.filename);
    if (!existsSync(path)) continue;
    found.push({ ...row, path });
  }

  console.log(`bucket      : ${r2.bucket}`);
  console.log(`backups dir : ${backupsDir}`);
  console.log(`eligible    : ${found.length} of ${rows.length} pruned-without-key row(s)`);

  if (!commit) {
    for (const row of found) console.log(`  match ${row.matchId} ${row.ordinal}/${row.half}  ${row.filename}`);
    console.log('\nDry run. Pass --commit to upload them.');
    return;
  }

  console.log('\nUploading...');
  let uploaded = 0, failed = 0;
  for (const row of found) {
    const r = await offloadReplay(db, r2, row, row.path);
    if (r === 'uploaded') uploaded++; else failed++;
  }

  console.log(`\nuploaded : ${uploaded}`);
  console.log(`failed   : ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}
