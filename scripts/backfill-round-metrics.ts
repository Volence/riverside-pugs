// Compute balance metrics for every pending round (missing, stale or waiting
// on a replay). Without --apply the work runs inside a transaction that is
// rolled back, so nothing is stored.
//
//   npx tsx scripts/backfill-round-metrics.ts <pug.db> <replayDir> [--apply]
import { openDb } from '../src/db.js';
import { runMetricsPass } from '../src/metrics/job.js';
import { summarizeByPatch } from '../src/metrics/summary.js';

const SUMMARY_METRICS = [
  'round.saferoom', 'round.length_min', 'tank.spawns', 'tank.killed_rate', 'tank.lifetime_s',
  'witch.count', 'witch.startle_rate', 'hunter.skeet_rate', 'hunter.high_pounce_rate',
  'smoker.pull_rate', 'boomer.boomed_per_spawn', 'pace.survivor_spread',
];

const [dbPath, replayDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
if (!dbPath) {
  console.error('usage: tsx scripts/backfill-round-metrics.ts <pug.db> <replayDir> [--apply]');
  process.exit(2);
}
const db = openDb(dbPath);
const t0 = Date.now();
let computed = 0;
let failed = 0;
const work = () => {
  for (;;) {
    const pass = runMetricsPass(db, replayDir ?? '', { limit: 50, replayWaitMin: 0 });
    computed += pass.computed;
    failed += pass.failed;
    if (pass.computed + pass.failed === 0) break;
    process.stdout.write(`\r${computed} computed, ${failed} failed`);
  }
};
if (apply) work();
else {
  // Dry run: compute inside a transaction and roll it back.
  try {
    db.transaction(() => { work(); throw new Error('dry run'); })();
  } catch (e) {
    if ((e as Error).message !== 'dry run') throw e;
  }
}
const secs = (Date.now() - t0) / 1000;
console.log(`\n${apply ? 'applied' : 'dry run'}: ${computed} computed, ${failed} failed in ${secs.toFixed(1)} s`);
if (apply) {
  for (const r of summarizeByPatch(db, SUMMARY_METRICS)) {
    console.log(`${(r.patchName ?? 'untagged').padEnd(36)} ${r.metric.padEnd(26)} rounds ${String(r.rounds).padStart(4)}  ${r.value.toFixed(3)}`);
  }
}
db.close();
