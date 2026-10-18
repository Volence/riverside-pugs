// One-off: tag connections recorded before the network tag with their AS
// number and provider, from the raw addresses in the game servers' chat logs.
// Spec: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
//
//   # 1. copy each box's chat logs here first (read-only on the box), e.g.
//   #    rsync -a <box>:<srcds>/left4dead/addons/sourcemod/logs/chat/ chatlogs/<box>/
//   # 2. dry run against the site database (owner go-ahead, after a DB backup)
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/backfill-network-asn.ts \
//       --asn data/ip2asn-v4.tsv.gz --logs chatlogs/dallas --logs chatlogs/riverside1 --logs chatlogs/riverside2'
//   # 3. the same with --commit
//
// It must run against the database whose salt hashed the rows (the site's,
// or a copy of it): any other salt matches nothing. --db PATH overrides the
// configured database. No address is ever printed or written.
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadAsnFile } from '../src/asnTable.js';
import { backfillNetworkAsn, chatLogLines } from '../src/asnBackfill.js';

const USAGE = 'usage: backfill-network-asn.ts --asn <ip2asn-v4.tsv.gz> --logs <dir> [--logs <dir>...] [--db PATH] [--commit]';
function fail(msg: string): never {
  console.error(`${msg}\n${USAGE}`);
  process.exit(2);
}

// Strict parse: a value flag with no value (end of args, or another flag next)
// is an error, never silently skipped.
const args = process.argv.slice(2);
const opts = { asn: [] as string[], logs: [] as string[], db: [] as string[] };
let commit = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--commit') { commit = true; continue; }
  if (a === '--asn' || a === '--logs' || a === '--db') {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
    opts[a.slice(2) as 'asn' | 'logs' | 'db'].push(v);
    i += 1;
    continue;
  }
  fail(`unknown argument ${a}`);
}
if (opts.asn.length !== 1 || opts.logs.length === 0 || opts.db.length > 1) fail('need exactly one --asn, at least one --logs, at most one --db');
const asnPath = opts.asn[0];
const dirs = opts.logs;
const path = opts.db[0] ?? loadConfig().dbPath;
// openDb creates a missing file; a typo must not leave an empty database
// behind that then "matches nothing".
if (!existsSync(path)) fail(`database not found: ${path}`);
const db = openDb(path);
const table = loadAsnFile(asnPath);
function* allLines(): Generator<string> { for (const d of dirs) yield* chatLogLines(d); }
const r = backfillNetworkAsn(db, allLines(), table, { dryRun: !commit });
console.log(`${commit ? 'Backfilled' : 'Dry run, nothing written'}: ${path} (${table.size} ranges)`);
console.log(`  ${r.lines} log lines, ${r.joins} joins, ${r.addresses} distinct addresses`);
console.log(`  ${r.matchedAddresses} match a recorded connection, ${r.unresolved} of them in no range`);
console.log(`  ${r.updatedRows} rows ${commit ? 'tagged' : 'would be tagged'}`);
db.close();
