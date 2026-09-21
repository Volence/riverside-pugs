/**
 * Re-analyse every replay on disk.
 *
 * Run after changing anything in src/integrity/constants.ts: the stored rows
 * are measurements, so a threshold change means re-measuring, and nothing else
 * has to be migrated.
 *
 *   npx tsx scripts/backfill-integrity.ts            # re-measure everything
 *   npx tsx scripts/backfill-integrity.ts --pending  # only unmeasured rounds
 *
 * --pending is what the server runs by itself after a match, so it must stay
 * cheap: it reads only the rounds no current-version analysis has touched,
 * pools them into their maps' priors and measures them.
 */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { analyzePending, backfillAll } from '../src/integrity/run.js';
import { TUNING } from '../src/integrity/constants.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const dir = config.replayDir;
if (!dir) {
  console.error('No REPLAY_DIR configured; nothing to analyse.');
  process.exit(1);
}

if (process.argv.includes('--pending')) {
  const got = analyzePending(db, dir);
  console.log(`Analysed ${got.rounds} pending round${got.rounds === 1 ? '' : 's'}, skipped ${got.skipped}.`);
  process.exit(0);
}

// One call, and the priors are reported after the fact. This used to call
// rebuildPriors and then backfillAll, which rebuilt them a second time.
const { rounds, skipped, perMap } = backfillAll(db, dir);
const usable = [...perMap.entries()].filter(([, n]) => n >= TUNING.MIN_PRIOR_ROUNDS);
console.log(`Priors: ${perMap.size} maps seen, ${usable.length} at or above MIN_PRIOR_ROUNDS (${TUNING.MIN_PRIOR_ROUNDS}).`);
for (const [map, n] of [...perMap.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n >= TUNING.MIN_PRIOR_ROUNDS ? 'scored ' : 'skipped'} ${map}: ${n} rounds`);
}
console.log(`Analysed ${rounds} rounds, skipped ${skipped}.`);

// Coverage, printed because "zero clips" is not a result on its own. It reads
// the same whether the detector had thousands of clean chances or never ran at
// all, and the first backfill over real history could not tell the two apart.
const totals = { considered: 0, notLive: 0, notGhost: 0, inGrace: 0, tooClose: 0, occluded: 0, passed: 0 };
let withCoverage = 0, playerRounds = 0;
// Current version only: rows an older analyzer wrote for rounds whose replay is
// gone are still in the table, and their coverage is not this run's.
for (const r of db.prepare('SELECT metrics FROM integrity_rounds WHERE analyzer_version = ?').all(ANALYZER_VERSION) as { metrics: string }[]) {
  const g = (JSON.parse(r.metrics) as { gates?: typeof totals }).gates;
  playerRounds++;
  if (!g) continue;
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += g[k];
  if (g.passed > 0) withCoverage++;
}
const share = (n: number) => (totals.considered ? `${((100 * n) / totals.considered).toFixed(1)}%` : 'n/a');
console.log(`Coverage: ${withCoverage} of ${playerRounds} player-rounds had at least one eligible pair.`);
console.log(`  pairs considered ${totals.considered}, passed ${totals.passed} (${share(totals.passed)})`);
console.log(`  dropped: occluded ${share(totals.occluded)}, inGrace ${share(totals.inGrace)}, ` +
  `notGhost ${share(totals.notGhost)}, tooClose ${share(totals.tooClose)}, notLive ${share(totals.notLive)}`);
