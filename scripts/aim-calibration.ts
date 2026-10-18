/**
 * The aim rules' one-week calibration report (src/aimCalibration.ts).
 *
 *   npx tsx scripts/aim-calibration.ts [--db PATH] [--days N]
 *
 * Read-only. Run it on a COPY of the production database (ops/pull-db-backups.sh),
 * never against the live file. Prints the pooled headshot rate per weapon
 * group (the hunting rifle's is what would enable it), how the honest
 * player-matches spread over p-values, the lowest ten, and how many
 * flick-and-return kills each player-match had. nepmir's match 722 (14 of
 * 16, 2 flicks) is the yardstick: a threshold that would not still fire on
 * it is too loose.
 */
import Database from 'better-sqlite3';
import type { DB } from '../src/db.js';
import { aimCalibration } from '../src/aimCalibration.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// A read-only handle, not openDb(): openDb creates tables and sets pragmas.
const db = new Database(flag('--db') ?? process.env.DB_PATH ?? 'pug.db', { readonly: true, fileMustExist: true }) as DB;
const days = Number(flag('--days') ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 90) {
  console.error(`--days is a whole number of days, 1 to 90; got ${flag('--days')}`);
  process.exit(1);
}
const r = aimCalibration(db, new Date(), days);

console.log(`since ${r.since}: ${r.playerMatches} player-matches with SI kills`);
console.log('\npools:');
for (const p of r.pools) console.log(`  ${p.group}: ${p.headshots} of ${p.kills} headshots${p.rate === null ? '' : ` (${p.rate.toFixed(3)})`}`);
for (const h of r.hs) {
  console.log(`\n${h.group}: ${h.scored} player-matches with 10+ kills`);
  for (const b of h.buckets) console.log(`  p < ${b.below.toExponential(0)}: ${b.count}`);
  for (const l of h.lowest) console.log(`  ${l.steamid} match ${l.matchId}: ${l.headshots} of ${l.kills}, p = ${l.p.toExponential(1)}`);
}
console.log('\nflick-and-return kills per player-match:');
for (const c of r.flicks.counts) console.log(`  ${c.flicks}: ${c.playerMatches}`);
for (const t of r.flicks.top) console.log(`  ${t.steamid} match ${t.matchId}: ${t.flicks} of ${t.kills}`);
