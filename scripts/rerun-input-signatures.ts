/**
 * Re-run input signatures over every stored burst.
 *
 * This is why the plugin ships raw ordered intervals instead of a summary: a
 * signature written today applies to everything recorded since the capture went
 * live, with nothing redeployed to a game server. The cheats are frozen; our
 * detectors are not.
 *
 *   npx tsx scripts/rerun-input-signatures.ts [--threshold N] [--db PATH]
 *
 * Writes only new detections (the table has UNIQUE(burst_id, signature)), so it
 * is safe to run repeatedly.
 */
import { openDb } from '../src/db.js';
import { DEFAULT_POUNCE_SPAM_THRESHOLD, rerunSignatures } from '../src/inputBursts.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dbPath = flag('--db') ?? process.env.DB_PATH ?? 'pug.db';
const threshold = Number(flag('--threshold') ?? DEFAULT_POUNCE_SPAM_THRESHOLD);
if (!Number.isFinite(threshold) || threshold < 3) {
  console.error(`--threshold must be a number >= 3, got ${flag('--threshold')}`);
  process.exit(1);
}

const db = openDb(dbPath);
const before = (db.prepare('SELECT COUNT(*) AS c FROM input_detections').get() as { c: number }).c;
const bursts = (db.prepare('SELECT COUNT(*) AS c FROM input_bursts').get() as { c: number }).c;
const fired = rerunSignatures(db, threshold);
const after = (db.prepare('SELECT COUNT(*) AS c FROM input_detections').get() as { c: number }).c;

console.log(`${bursts} bursts, threshold ${threshold}`);
console.log(`${fired} signature hits, ${after - before} of them new (${before} -> ${after})`);

if (after > before) {
  const rows = db.prepare(
    `SELECT steamid, signature, COUNT(*) AS n FROM input_detections
     GROUP BY steamid, signature ORDER BY n DESC LIMIT 10`,
  ).all() as { steamid: string; signature: string; n: number }[];
  console.log('\ntop by player:');
  for (const r of rows) console.log(`  ${r.steamid}  ${r.signature}  x${r.n}`);
}
