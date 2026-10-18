// One-off: write the known evaders in src/evaderSeed.ts (dethisa, shove) as
// person records. Spec: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
//
//   # dry run: prints what it would do and changes nothing
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/seed-evader-people.ts'
//
//   # do it: only with the owner's go-ahead, and after a DB backup
//   ... scripts/seed-evader-people.ts --commit
//
// --db PATH points it at another database (a local copy, for a rehearsal). A
// --db with no value, a repeated --db or an unknown flag exits 2.
// A path that does not exist is refused, never created empty.
// Safe to run twice. Exit code 1 when an account was already on a different
// person (reported, never moved).
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SEED_PEOPLE } from '../src/evaderSeed.js';
import { seedPeople } from '../src/seedEvaders.js';

const USAGE = 'usage: seed-evader-people.ts [--db PATH] [--commit]';
function fail(msg: string): never {
  console.error(`${msg}\n${USAGE}`);
  process.exit(2);
}

// Strict parse, as scripts/backfill-network-asn.ts: a bare --db (end of args,
// or another flag next) must never fall back to the configured production
// path, and an unknown flag (say a typo of --commit) is an error.
const args = process.argv.slice(2);
const dbs: string[] = [];
let commit = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--commit') { commit = true; continue; }
  if (a === '--db') {
    const v = args[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) fail('--db needs a value');
    dbs.push(v);
    i += 1;
    continue;
  }
  fail(`unknown argument ${a}`);
}
if (dbs.length > 1) fail('--db may be given once');
const path = dbs[0] ?? loadConfig().dbPath;
if (!existsSync(path)) fail(`No database at ${path}; refusing to create one.`);
const db = openDb(path);
const r = seedPeople(db, SEED_PEOPLE, { dryRun: !commit });
console.log(`${commit ? 'Seeded' : 'Dry run, nothing written'}: ${path}`);
for (const [k, v] of Object.entries(r) as [string, string[]][]) {
  console.log(`  ${k}: ${v.length}`);
  for (const line of v) console.log(`    ${line}`);
}
db.close();
if (r.conflicts.length > 0) process.exitCode = 1;
