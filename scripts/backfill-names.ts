// Seed name history (src/playerNames.ts) from old srcds log files.
//
//   # read-only: prints what it would record and changes nothing
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/backfill-names.ts <logDir>'
//
//   # actually do it
//   ... scripts/backfill-names.ts <logDir> --commit
//
//   # also count play in files with no PUG token (pubs, before pug-match)
//   ... scripts/backfill-names.ts <logDir> --by-day [--commit]
//
// <logDir> is searched recursively for *.log, so a folder holding each box's
// left4dead/logs copied side by side works as one argument. Run it against
// a COPY of the logs on the web box; it never talks to a game server.
//
// How names are counted, which is the same rule the live path uses:
//
//   - A name is read from two kinds of line. The engine's own lines open with
//     the player: `"amour plastique<273><STEAM_1:1:527064265><Infected>" ...`.
//     pug-match's PUGNAME lines (0.3.7 on) carry the name last, after the
//     SteamID, where nothing typed can move it onto someone else. Bots have
//     no STEAM_ id and are never read.
//   - Each log file is one map, and pug-match writes `PUG <token> ...` lines
//     into it while a match is tracked. A name belongs to the match whose
//     token the file was carrying at that line (or, before the file's first
//     token, to that first token: players connect a moment before the
//     plugin's first line of the map).
//   - A token counts only if it is a COMPLETED match in this database, and a
//     name only if that SteamID (after aliases, so a merged alt's names land
//     on the main) was rostered in it. Tokens from tests, side games,
//     practice and aborted matches are skipped and counted in the summary.
//   - One use per player per name per match, however many lines or maps the
//     name appears on, under the same key the live path writes (m:<id>).
//     That makes it safe to run more than once, and safe to run after name
//     history has been live for a while: a match already counted is not
//     counted again.
//   - With --by-day, lines in files that never carried a token count once
//     per player per name per calendar day (the stamp's own date), as
//     `log:<date>`. Off by default, because the owner's rule is that a name
//     counts once it is used in a match, and a pub is not one.
//
// Line stamps are read as UTC. They are in the box's local time, which only
// shifts first and last seen by a few hours; no count depends on it.
//
// Nothing is posted to the rename digest: these are old names, not news.
import { copyFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { applyNameBackfill, planNameBackfill, type LogSighting, sightingsFromLog } from '../src/nameBackfill.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const commit = args.includes('--commit');
const byDay = args.includes('--by-day');

if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('usage: backfill-names.ts <logDir> [--by-day] [--commit]');
  process.exit(2);
}

function logFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...logFiles(p));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.log')) out.push(p);
  }
  return out.sort();
}

const config = loadConfig();
const db = openDb(config.dbPath);

const files = logFiles(dir);
const sightings: LogSighting[] = [];
for (const f of files) sightings.push(...sightingsFromLog(readFileSync(f, 'utf8')));
const plan = planNameBackfill(db, sightings, { byDay });

console.log(`${files.length} log files, ${sightings.length} name sightings.`);
console.log(`skipped: ${plan.skipped.unknownToken} in no completed match here, `
  + `${plan.skipped.notRostered} by players not rostered in theirs, `
  + `${plan.skipped.noToken} in files with no match${byDay ? '' : ' (see --by-day)'}.`);

// Per player: each name with the matches it would be counted in.
const byPlayer = new Map<string, Map<string, Set<string>>>();
for (const u of plan.uses) {
  const names = byPlayer.get(u.steamid) ?? new Map<string, Set<string>>();
  const keys = names.get(u.name) ?? new Set<string>();
  keys.add(u.matchKey);
  names.set(u.name, keys);
  byPlayer.set(u.steamid, names);
}
const nameOf = db.prepare('SELECT name FROM players WHERE steamid = ?');
console.log(`\n${plan.uses.length} name uses across ${byPlayer.size} players:`);
for (const [steamid, names] of byPlayer) {
  const current = (nameOf.get(steamid) as { name: string } | undefined)?.name ?? '(not on the site)';
  const list = [...names].map(([n, keys]) => `${n} (${keys.size})`).join(', ');
  console.log(`  ${steamid} ${current}: ${list}`);
}

if (!commit) {
  console.log('\nDry run. Nothing was changed. Re-run with --commit to apply.');
  process.exit(0);
}

// A copy beside the database, as merge-players.ts takes: the thing to restore
// from in the next minute if the numbers come out wrong.
const backup = `${config.dbPath}.before-names-${Date.now()}`;
copyFileSync(config.dbPath, backup);
console.log(`\nbackup: ${backup}`);
const added = applyNameBackfill(db, plan);
console.log(`recorded ${added} new name uses (${plan.uses.length - added} were already there).`);
