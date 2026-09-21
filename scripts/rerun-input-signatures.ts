/**
 * Rebuild every input detection from the stored bursts.
 *
 * This is why the plugin ships raw ordered intervals instead of a summary: a
 * signature written today applies to everything recorded since the capture went
 * live, with nothing redeployed to a game server. The cheats are frozen; our
 * detectors are not.
 *
 *   npx tsx scripts/rerun-input-signatures.ts [--db PATH] [--dry-run]
 *       [--pounce-rate N] [--pistol-rate N]
 *
 * Runs every signature in SIGNATURES (src/inputStats.ts). Rates are presses per
 * second and default to the site's settings.
 *
 * It REPLACES the detections table rather than adding to it: a detection is a
 * function of the bursts and the current signatures, so a row written by a
 * signature that has since been recalibrated goes away. Bursts, which are the
 * evidence, are never modified. One transaction; --dry-run rolls it back and
 * only reports. Safe to run repeatedly.
 */
import { openDb } from '../src/db.js';
import { inputThresholds, rerunSignatures } from '../src/inputBursts.js';
import { MAX_RATE_CEILING, MIN_RATE_FLOOR, SIGNATURES, type Thresholds } from '../src/inputStats.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dbPath = flag('--db') ?? process.env.DB_PATH ?? 'pug.db';
const dryRun = args.includes('--dry-run');
const db = openDb(dbPath);

const thresholds: Thresholds = inputThresholds(db);
const overrides: [string, keyof Thresholds][] = [
  ['--pounce-rate', 'pounceMinRate'], ['--pistol-rate', 'pistolMinRate'],
];
for (const [name, key] of overrides) {
  const raw = flag(name);
  if (raw === undefined) continue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_RATE_FLOOR || n > MAX_RATE_CEILING) {
    console.error(`${name} is presses per second, ${MIN_RATE_FLOOR} to ${MAX_RATE_CEILING}; got ${raw}`);
    process.exit(1);
  }
  thresholds[key] = n;
}

const before = (db.prepare('SELECT COUNT(*) AS c FROM input_detections').get() as { c: number }).c;
const r = rerunSignatures(db, thresholds, { dryRun });

console.log(`signatures: ${SIGNATURES.map((s) => `${s.name} (x${s.repeats})`).join(', ')}`);
console.log(`thresholds: ${JSON.stringify(thresholds)}`);
console.log(`${r.bursts} bursts across ${r.groups} player-matches`);
console.log(`${before} detection rows before, ${r.detections} after, ${r.removed} no longer supported${dryRun ? ' (dry run, nothing written)' : ''}`);

if (!dryRun && r.detections > 0) {
  const rows = db.prepare(
    `SELECT steamid, signature, COUNT(*) AS matches, SUM(hits) AS hits FROM input_detections
     GROUP BY steamid, signature ORDER BY hits DESC LIMIT 10`,
  ).all() as { steamid: string; signature: string; matches: number; hits: number }[];
  console.log('\ntop by player:');
  for (const row of rows) console.log(`  ${row.steamid}  ${row.signature}  ${row.matches} match(es), ${row.hits} bursts`);
}
