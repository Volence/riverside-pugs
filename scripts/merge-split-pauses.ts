// Join pause ledger rows split by a leave flag change mid-pause (match 190
// showed two pauses as four). See src/pauseMerge.ts for the rule.
//
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/merge-split-pauses.ts [--apply]'
//
// Without --apply it only prints what it would join. Back the database up
// before --apply.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { applyPauseMerge, planPauseMerge } from '../src/pauseMerge.js';

const apply = process.argv.includes('--apply');
const db = openDb(loadConfig().dbPath);
const chains = planPauseMerge(db);
for (const c of chains) console.log(`match ${c.matchId}: rows ${c.ids.join(' + ')}`);
console.log(`${chains.length} pauses joined from ${chains.reduce((n, c) => n + c.ids.length, 0)} rows${apply ? '' : ' (dry run, nothing written)'}`);
if (apply) applyPauseMerge(db, chains);
