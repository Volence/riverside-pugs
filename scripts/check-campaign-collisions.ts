/**
 * Check what is already installed against the enforced file list.
 *
 * The campaign uploader refuses a VPK that ships a path on the list, but every
 * campaign published before that check existed went in unchecked, and so did
 * anything copied into the addons directory by hand. A forced path that one of
 * them overrides disconnects every player on its maps. Run this once before the
 * list goes live, and again after regenerating the list (group 6).
 *
 *   npx tsx scripts/check-campaign-collisions.ts                 # ADDONS_DIR from .env
 *   ADDONS_DIR=/path/to/left4dead/addons npx tsx scripts/check-campaign-collisions.ts
 *   npx tsx scripts/check-campaign-collisions.ts --list consistency/configs/l4d_consistency.batch2.cfg
 *
 * --list checks against a list other than the shipped one, which is how a list
 * that is not live yet (batch 2, group 6) is cleared BEFORE it is promoted.
 *
 * Read-only: it opens the database to label VPKs with their campaign and
 * writes nothing. Exits 0 when nothing collides, 1 when something does or a
 * VPK could not be read, 2 when it could not run at all.
 */
import { loadDotEnv } from './dotenv.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadConsistencyList } from '../src/consistencyList.js';
import { checkAddonsDir } from '../src/campaignCollisions.js';

loadDotEnv();
const config = loadConfig(process.env);
if (!config.addonsDir) {
  console.error('No ADDONS_DIR configured; nothing to check.');
  process.exit(2);
}
const listArg = process.argv.indexOf('--list');
if (listArg >= 0 && !process.argv[listArg + 1]) {
  console.error('--list needs a path');
  process.exit(2);
}
const forced = listArg >= 0 ? loadConsistencyList(process.argv[listArg + 1]) : loadConsistencyList();
if (!forced) process.exit(2); // the loader has already said why

const db = openDb(config.dbPath);
const checks = checkAddonsDir(db, config.addonsDir, forced);

let bad = 0;
for (const c of checks) {
  const label = c.slug ? `${c.filename} (campaign ${c.slug}, ${c.state})` : `${c.filename} (not a site campaign)`;
  if (c.result === 'ok') {
    console.log(`ok        ${label}`);
  } else if (c.result === 'unreadable') {
    bad++;
    console.log(`UNREADABLE ${label}: missing, empty, or not a VPK directory`);
  } else {
    bad++;
    console.log(`COLLIDES  ${label}: ${c.collisions.length} enforced path(s)`);
    for (const p of c.collisions) console.log(`            ${p}`);
  }
}
console.log(`\n${checks.length} VPK(s) checked against ${forced.length} enforced paths in ${config.addonsDir}: ${bad} need attention.`);
process.exit(bad > 0 ? 1 : 0);
