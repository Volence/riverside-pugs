// Recompute balance metrics for rounds whose replay now lives only in R2.
//
// The metrics job reads replays from the local replay directory, and the
// prune deletes a local copy once R2 holds it. A round computed before its
// replay arrived, or one on an older metric engine, can then never get its
// replay metrics back through the job (on an engine bump it is frozen on its
// old rows instead). This fetches each such round's copy from R2 and stores
// its metrics on the current engine. Rounds whose file is still on disk are
// left to the job.
//
// Needs the R2_* variables (as in /home/pug/app/.env). Without --apply the
// metrics are computed and counted but nothing is written. Refuses to start
// while a match is live or configuring, unless --force.
//
//   npx tsx scripts/recompute-metrics-from-r2.ts <pug.db> <replayDir> [--apply] [--force] [--limit N]
import { openDb } from '../src/db.js';
import { matchActive } from '../src/metrics/job.js';
import { recomputeFromR2, roundsToRecomputeFromR2 } from '../src/metrics/r2Recompute.js';
import { getRange, r2FromEnv } from '../src/r2.js';

const args = process.argv.slice(2);
const limitAt = args.indexOf('--limit');
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : undefined;
const [dbPath, replayDir] = args.filter((a, i) => !a.startsWith('--') && (limitAt < 0 || i !== limitAt + 1));
const apply = args.includes('--apply');
const force = args.includes('--force');
if (!dbPath || !replayDir || (limit !== undefined && !(limit > 0))) {
  console.error('usage: tsx scripts/recompute-metrics-from-r2.ts <pug.db> <replayDir> [--apply] [--force] [--limit N]');
  process.exit(2);
}
const r2 = r2FromEnv();
if (!r2) {
  console.error('R2 is not configured: set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL');
  process.exit(2);
}
const db = openDb(dbPath);
if (matchActive(db) && !force) {
  console.error('a match is live or configuring; refusing to start (pass --force to run anyway)');
  process.exit(1);
}
console.log(`${roundsToRecomputeFromR2(db, replayDir).length} rounds have their replay only in R2 and stale or replay-less metrics`);
const t0 = Date.now();
const res = await recomputeFromR2(db, replayDir, {
  apply, limit,
  fetch: async (key) => (await getRange(r2, key, 0))?.body ?? null,
  onRound: (done, total) => process.stdout.write(`\r${done}/${total}`),
});
console.log(`\n${apply ? 'applied' : 'dry run, nothing written'}: ${res.recomputed} recomputed, ${res.missing} missing in R2, `
  + `${res.undecodable} unreadable, ${res.failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
db.close();
