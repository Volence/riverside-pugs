// Compute balance metrics for every pending round (missing, stale or waiting
// on a replay). Without --apply the work runs inside a transaction that is
// rolled back, so nothing is stored.
//
// The dry run holds that one write transaction, and so the database write
// lock, for the whole run: the live site cannot write while it runs. Point a
// dry run at a COPY of the database, never at the production file.
//
// The replay directory is required. Without it every round would be computed
// with no replay and stored as having seen none, so it would never get
// replay-derived metrics until the next engine bump.
//
// Refuses to start while a match is live or configuring (the reaper does the
// same), unless --force.
//
//   npx tsx scripts/backfill-round-metrics.ts <pug.db> <replayDir> [--apply] [--force]
import { existsSync, statSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { drainPending, matchActive } from '../src/metrics/job.js';
import { summarizeByPatch } from '../src/metrics/summary.js';

const SUMMARY_METRICS = [
  'round.saferoom', 'round.length_min', 'tank.spawns', 'tank.killed_rate', 'tank.lifetime_s',
  'witch.count', 'witch.startle_rate', 'hunter.skeet_rate', 'hunter.high_pounce_rate',
  'smoker.pull_rate', 'boomer.boomed_per_spawn', 'pace.survivor_spread',
];
const MAX_PASSES = 10_000;
const USAGE = `usage: tsx scripts/backfill-round-metrics.ts <pug.db> <replayDir> [--apply] [--force]
  <replayDir>  the replay directory (required; must exist)
  --apply      store the results; without it this is a dry run that is rolled back
  --force      run even while a match is live or configuring
  The dry run holds a write lock on the database for its whole duration.
  Run it against a COPY of the database, not the live one.`;

const [dbPath, replayDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');
if (!dbPath || !replayDir) {
  console.error(USAGE);
  process.exit(2);
}
if (!existsSync(replayDir) || !statSync(replayDir).isDirectory()) {
  console.error(`replay directory ${replayDir} does not exist or is not a directory\n${USAGE}`);
  process.exit(2);
}
const db = openDb(dbPath);
if (matchActive(db) && !force) {
  console.error('a match is live or configuring; refusing to start (pass --force to run anyway)');
  db.close();
  process.exit(1);
}
const t0 = Date.now();
let result: ReturnType<typeof drainPending> | undefined;
const work = () => {
  result = drainPending(db, replayDir, {
    limit: 50, replayWaitMin: 0, maxPasses: MAX_PASSES,
    onPass: (t) => process.stdout.write(`\r${t.computed} computed, ${t.frozen} frozen, ${t.failed} failed`),
  });
};
if (apply) work();
else {
  // Dry run: compute inside a transaction and roll it back. This holds the
  // write lock until the run ends; see the note at the top.
  try {
    db.transaction(() => { work(); throw new Error('dry run'); })();
  } catch (e) {
    if ((e as Error).message !== 'dry run') throw e;
  }
}
const r = result!;
const secs = (Date.now() - t0) / 1000;
console.log(`\n${apply ? 'applied' : 'dry run'}: ${r.computed} computed, ${r.frozen} frozen, ${r.failed} failed in ${r.passes} passes, ${secs.toFixed(1)} s`);
if (r.stop === 'stuck') {
  console.error('stopped: the last pass made no progress (only rounds that had already failed, whose failed marker could not be written). Check the errors above.');
}
if (r.stop === 'cap') console.error(`stopped: reached the limit of ${MAX_PASSES} passes with rounds still pending.`);
if (apply) {
  for (const s of summarizeByPatch(db, SUMMARY_METRICS)) {
    console.log(`${(s.patchName ?? 'untagged').padEnd(36)} ${s.metric.padEnd(26)} rounds ${String(s.rounds).padStart(4)}  ${s.value.toFixed(3)}`);
  }
}
db.close();
if (r.stop !== 'done') process.exitCode = 1;
