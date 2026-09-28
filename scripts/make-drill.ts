// Make a replay drill from a local .rpl file and print its code.
//
//   npx tsx scripts/make-drill.ts <replay.rpl> <tMs> [dbPath]
//
// For testing the practice plugin (l4d_practice.smx) against the local game
// server without a login cookie or a finished match in the database: the
// drill is built by the same builder the site uses (src/drillSpec.ts) and
// filed in practice_drills with no match and no creator, so the dev API
// serves it at GET /api/practice/drills/<code> like any other.
//
// dbPath defaults to what the API itself opens (DB_PATH, else data/pug.db
// relative to where this runs), so run it from the checkout the dev API
// runs from, or pass the same path. NEVER point it at the production
// database: it writes.
//
// tMs is milliseconds into the round, the same clock the replay viewer's scrub
// bar shows (1:05 is 65000). Names come from the database's players table
// when it knows the file's SteamIDs, and are empty otherwise. The file's own
// side mask decides sides; a file recorded before format version 3 falls
// back to slot order (0 to 3 survivors), as the viewer does for a loose file.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { parseReplay } from '../src/replayFormat.js';
import { buildDrill } from '../src/drillSpec.js';
import { createDrill } from '../src/practiceDrills.js';
import { drillMapLabel } from '../src/routes/practice.js';

const [file, rawT, dbArg] = process.argv.slice(2);
const tMs = Number(rawT);
if (!file || !Number.isFinite(tMs) || tMs < 0) {
  console.error('usage: make-drill.ts <replay.rpl> <tMs> [dbPath]');
  process.exit(2);
}

const replay = parseReplay(readFileSync(file));
if (!replay) {
  console.error(`${file}: not a replay this build can read (bad magic, too short, or a newer format)`);
  process.exit(1);
}

const db = openDb(dbArg ?? loadConfig().dbPath);
const ids = replay.header.slots.filter(Boolean);
const names: Record<string, string> = {};
if (ids.length > 0) {
  const rows = db.prepare(`SELECT steamid, name FROM players WHERE steamid IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { steamid: string; name: string }[];
  for (const r of rows) names[r.steamid] = r.name;
}

const body = buildDrill(replay, Math.round(tMs), {
  names, matchId: null, mapLabel: drillMapLabel(db, replay.header.map),
});
if (!body) {
  console.error(`${file}: the replay has no frames`);
  process.exit(1);
}

const { spec } = createDrill(db, body, {
  matchId: null, ordinal: replay.header.ordinal, half: replay.header.half, tMs: Math.round(tMs),
}, null);

console.error(`${spec.title}: ${spec.actors.length} actors, ${spec.entities.length} entities`);
for (const a of spec.actors) {
  console.error(`  ${a.side.padEnd(8)} ${a.cls.padEnd(7)} ${(a.name || '(no name)').padEnd(16)} hp ${a.health}+${a.temp} ${a.weapon}${a.ghost ? ' ghost' : ''}${a.incap ? ' incap' : ''}`);
}
for (const e of spec.entities) console.error(`  entity   ${e.kind.padEnd(7)} hp ${e.health}`);
// The code alone on stdout, so a caller can capture it.
console.log(spec.code);
