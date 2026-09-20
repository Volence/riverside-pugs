// Fold one Steam account into another and rebuild the affected seasons.
//
//   # read-only: prints what it would do and changes nothing
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/merge-players.ts <fromSteamId> <intoSteamId>'
//
//   # actually do it
//   ... scripts/merge-players.ts <fromSteamId> <intoSteamId> --commit
//
// `from` is the account that disappears; `into` is the one that keeps its
// history, its Discord link and its name. Everything the losing account did is
// reattached to the winner, and in a match where both were rostered the two
// rows become one with their figures added together.
//
// This rewrites rating history. Ratings are sequential, so a merge four
// matches back moves the rating of everyone who played in those matches, not
// just the person being merged. That is the point: those matches were scored
// with a five-man team. Take a copy of the database first; there is no undo.
//
// Run it on an EMPTY server. A live match writes to the same rows.
import { copyFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { mergePlayers } from '../src/mergePlayers.js';

const [from, into, ...flags] = process.argv.slice(2);
const commit = flags.includes('--commit');

if (!/^\d{17}$/.test(from ?? '') || !/^\d{17}$/.test(into ?? '')) {
  console.error('usage: merge-players.ts <fromSteamId> <intoSteamId> [--commit]');
  process.exit(2);
}

const config = loadConfig();
const db = openDb(config.dbPath);

const name = (id: string): string => {
  const row = db.prepare('SELECT name, status, discord_name FROM players WHERE steamid = ?').get(id) as
    | { name: string; status: string; discord_name: string | null } | undefined;
  return row ? `${row.name} [${row.status}${row.discord_name ? `, discord ${row.discord_name}` : ', no discord'}]` : '(unknown)';
};

console.log(`from: ${from} ${name(from)}`);
console.log(`into: ${into} ${name(into)}`);

const plan = mergePlayers(db, { from, into, dryRun: true });
console.log(`\nmatches the losing account played: ${plan.matchesMoved}`);
console.log(`matches BOTH were rostered in (rows will be summed): ${plan.matchesCollapsed}`);
console.log(`seasons to recompute: ${plan.seasons.join(', ') || 'none'}`);
console.log('\nrows to move:');
for (const [table, n] of Object.entries(plan.rowsByTable).sort()) console.log(`  ${table.padEnd(24)} ${n}`);

if (!commit) {
  console.log('\nDry run. Nothing was changed. Re-run with --commit to apply.');
  process.exit(0);
}

// A copy beside the database, not a backup system: this is the thing you
// restore from in the next sixty seconds if the numbers come out wrong.
const backup = `${config.dbPath}.before-merge-${Date.now()}`;
copyFileSync(config.dbPath, backup);
console.log(`\nbackup: ${backup}`);

const done = mergePlayers(db, { from, into });
console.log(`merged. ${done.matchesMoved} matches moved, ${done.matchesCollapsed} collapsed.`);

const after = db.prepare(
  'SELECT season_id, mu, sigma, wins, losses FROM player_ratings WHERE player_id = ? ORDER BY season_id',
).all(into) as { season_id: number; mu: number; sigma: number; wins: number; losses: number }[];
for (const r of after) {
  console.log(`season ${r.season_id}: mu ${r.mu.toFixed(3)} sigma ${r.sigma.toFixed(3)} ${r.wins}W ${r.losses}L`);
}
