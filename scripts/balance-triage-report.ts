/**
 * Run the triage migration and the boot refingerprint on a COPY of the
 * production database and print every patch's triage state.
 *
 *   cp pug.db /tmp/pug-copy.db && npx tsx scripts/balance-triage-report.ts /tmp/pug-copy.db
 *
 * Refuses a path that does not contain "copy", so it is never pointed at the
 * live file by mistake.
 */
import { openDb } from '../src/db.js';
import { loadBalanceKnobs } from '../src/balanceKnobs.js';
import { effectiveIgnored } from '../src/balanceIgnore.js';
import { listPatches, refingerprintPatches } from '../src/balancePatches.js';

const path = process.argv[2];
if (!path || !path.includes('copy')) {
  console.error('usage: balance-triage-report.ts <path containing "copy">');
  process.exit(2);
}
const db = openDb(path);
const knobs = loadBalanceKnobs();
const ignored = effectiveIgnored(db, knobs.ignored);
refingerprintPatches(db, knobs.versionless, ignored, (e) => console.log(`event: ${e.text}`));
for (const p of listPatches(db, { versionless: knobs.versionless, ignored })) {
  const into = p.foldedInto === null ? '' : ` -> ${p.foldedInto}`;
  console.log(`#${p.number} (id ${p.id}) ${p.source} ${p.triage}${into}  ${p.name ?? '(unnamed)'}  rounds=${p.rounds}`);
  for (const c of p.changes) console.log(`    ${c}`);
}
