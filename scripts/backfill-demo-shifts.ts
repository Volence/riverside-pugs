// Correct demo_tick for rounds recorded by pug-match 0.3.12 to 0.3.14, and
// give them the in-half pauses as demo_shifts, from the pause ledger. See
// src/demoShiftBackfill.ts for what it does and how precise it is.
//
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/backfill-demo-shifts.ts "<cutoff>" [--apply]'
//
// <cutoff> is when 0.3.15 went live on the LAST server to get it, UTC, in
// the database's 'YYYY-MM-DD HH:MM:SS' form. Rounds that went live before it
// are corrected; later ones are already right. Without --apply it only
// prints what it would change. Back the database up before --apply.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { applyDemoShiftBackfill, planDemoShiftBackfill } from '../src/demoShiftBackfill.js';

const cutoff = process.argv[2];
const apply = process.argv.includes('--apply');
if (!cutoff || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(cutoff)) {
  console.error('usage: backfill-demo-shifts.ts "YYYY-MM-DD HH:MM:SS" [--apply]');
  process.exit(2);
}

const db = openDb(loadConfig().dbPath);
const fixes = planDemoShiftBackfill(db, cutoff);
let moved = 0;
for (const f of fixes) {
  if (f.newTick === f.oldTick && f.shifts.length === 0) continue;
  moved++;
  const shifts = f.shifts.map((s) => `${s.tMs}:${s.ticks}`).join(',') || '-';
  console.log(`match ${f.matchId} map ${f.ordinal} half ${f.half}: tick ${f.oldTick} -> ${f.newTick}, pauses ${shifts}`);
}
console.log(`${fixes.length} rounds checked, ${moved} changed${apply ? '' : ' (dry run, nothing written)'}`);
if (apply) applyDemoShiftBackfill(db, fixes);
