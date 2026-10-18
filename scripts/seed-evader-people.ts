// One-off: write the known evaders in src/evaderSeed.ts (dethisa, shove) as
// person records. Spec: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
//
//   # dry run: prints what it would do and changes nothing
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/seed-evader-people.ts'
//
//   # do it: only with the owner's go-ahead, and after a DB backup
//   ... scripts/seed-evader-people.ts --commit
//
// --db PATH points it at another database (a local copy, for a rehearsal).
// A path that does not exist is refused, never created empty.
// Safe to run twice. Exit code 1 when an account was already on a different
// person (reported, never moved).
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SEED_PEOPLE } from '../src/evaderSeed.js';
import { seedPeople } from '../src/seedEvaders.js';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const at = args.indexOf('--db');
const path = at >= 0 && args[at + 1] ? args[at + 1] : loadConfig().dbPath;
if (!existsSync(path)) {
  console.error(`No database at ${path}; refusing to create one.`);
  process.exit(2);
}
const db = openDb(path);
const r = seedPeople(db, SEED_PEOPLE, { dryRun: !commit });
console.log(`${commit ? 'Seeded' : 'Dry run, nothing written'}: ${path}`);
for (const [k, v] of Object.entries(r) as [string, string[]][]) {
  console.log(`  ${k}: ${v.length}`);
  for (const line of v) console.log(`    ${line}`);
}
db.close();
if (r.conflicts.length > 0) process.exitCode = 1;
