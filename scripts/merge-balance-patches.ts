/**
 * Fold duplicate detected balance patches into one.
 *
 *   npx tsx scripts/merge-balance-patches.ts <db> <keepId> <dropId,dropId,...> [--apply]
 *
 * Each dropped patch is folded into the kept one (src/balanceMerge.ts): its
 * rounds and metric context rows count for the kept patch, it stays in the
 * table as folded (undo with Unfold on the Patches tab), and per-server
 * sightings and server states are left alone, so the next sighting of an
 * unchanged box raises no alert. Nothing is deleted: rounds keep their
 * sighted patch, which a DELETE would break (foreign key). Dry run unless
 * --apply; refuses while a match is live, since a live match can tag rounds
 * mid-merge.
 *
 * Written for 2026-09-24: l4d2_spec_stays_spec coming and going between maps,
 * and a comment-only difference in server_custom_convars.cfg, split one config
 * into patches 6, 7, 8 and 9. Since then the boot refingerprint folds patches
 * that differ only by ignored or versionless plugins by itself.
 */
import Database from 'better-sqlite3';
import { mergeBalancePatches } from '../src/balanceMerge.js';

const [dbPath, keepArg, dropArg, flag] = process.argv.slice(2);
if (!dbPath || !keepArg || !dropArg) {
  console.error('usage: merge-balance-patches.ts <db> <keepId> <dropId,...> [--apply]');
  process.exit(2);
}
const keep = Number(keepArg);
const drop = dropArg.split(',').map(Number);
if (!Number.isInteger(keep) || drop.some((d) => !Number.isInteger(d) || d === keep)) {
  console.error('ids must be integers and keepId must not be dropped');
  process.exit(2);
}
const apply = flag === '--apply';
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

console.log(`keep #${keep}, fold ${drop.map((d) => `#${d}`).join(' ')} into it`);
const r = mergeBalancePatches(db, keep, drop, { apply });
if (!r.ok) {
  console.error(r.error);
  process.exit(1);
}
console.log(`  rounds that now count for #${r.target}: ${r.roundsMoved}`);
console.log(r.applied ? 'applied' : 'dry run, rolled back');
