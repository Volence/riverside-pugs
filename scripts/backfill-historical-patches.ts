import { openDb } from '../src/db.js';
import { applyHistoricalPatches } from '../src/historicalPatches.js';

const path = process.argv[2];
const apply = process.argv.includes('--apply');
if (!path) { console.error('usage: tsx scripts/backfill-historical-patches.ts <pug.db> [--apply]'); process.exit(2); }
const db = openDb(path);
const r = applyHistoricalPatches(db, { dryRun: !apply });
console.log(`${apply ? 'applied' : 'dry run'}: ${r.created} patches, ${r.tagged} rounds tagged`);
