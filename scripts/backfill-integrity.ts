/**
 * Re-analyse every replay on disk.
 *
 * Run after changing anything in src/integrity/constants.ts: the stored rows
 * are measurements, so a threshold change means re-measuring, and nothing else
 * has to be migrated.
 *
 *   npx tsx scripts/backfill-integrity.ts
 */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { backfillAll, rebuildPriors } from '../src/integrity/run.js';
import { TUNING } from '../src/integrity/constants.js';

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const dir = config.replayDir;
if (!dir) {
  console.error('No REPLAY_DIR configured; nothing to analyse.');
  process.exit(1);
}

const perMap = rebuildPriors(db, dir);
const usable = [...perMap.entries()].filter(([, n]) => n >= TUNING.MIN_PRIOR_ROUNDS);
console.log(`Priors: ${perMap.size} maps seen, ${usable.length} at or above MIN_PRIOR_ROUNDS (${TUNING.MIN_PRIOR_ROUNDS}).`);
for (const [map, n] of [...perMap.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n >= TUNING.MIN_PRIOR_ROUNDS ? 'scored ' : 'skipped'} ${map}: ${n} rounds`);
}

const { rounds, skipped } = backfillAll(db, dir);
console.log(`Analysed ${rounds} rounds, skipped ${skipped}.`);
