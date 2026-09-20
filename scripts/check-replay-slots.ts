// Check that a match's replay files name the right eight players.
//
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/check-replay-slots.ts <matchId>'
//
// This is the verification for the plugin's slot mapping (pug-match.sp,
// RplOpen). The replay format carries eight slots and the roster holds up to
// twelve, so on an over-full roster somebody has to be left out of the file.
// The old code took the first eight roster entries in order, which in match 65
// wrote a slot for an account that never connected and dropped the account
// that actually played out of every frame. The fix prefers roster entries with
// a connected client.
//
// Proving that needs a real round with real players, which is exactly what a
// live match is, so this reads the result instead of trying to stage it. Run
// it on the first match after the plugin ships.
//
// It reports, in order of how much it matters:
//   MISSING  a rostered player who is in no slot of a round they played
//   GHOST    a slot whose player is never PRESENT in any frame
//   EXTRA    a slot holding a SteamID that is not on the match roster
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decodeHeader, decodeFrames, HEADER_BYTES, STATE } from '../src/replayFormat.js';
import { resolveReplayPath } from '../src/replays.js';

const matchId = Number(process.argv[2]);
if (!Number.isInteger(matchId) || matchId <= 0) {
  console.error('usage: check-replay-slots.ts <matchId>');
  process.exit(2);
}

const config = loadConfig();
const db = openDb(config.dbPath);

const roster = db.prepare(
  `SELECT mp.player_id AS steamid, mp.team, COALESCE(p.name, mp.player_id) AS name
     FROM match_players mp LEFT JOIN players p ON p.steamid = mp.player_id
    WHERE mp.match_id = ? ORDER BY mp.team, mp.player_id`,
).all(matchId) as { steamid: string; team: string; name: string }[];

if (roster.length === 0) {
  console.error(`match ${matchId} has no roster`);
  process.exit(1);
}
const nameOf = new Map(roster.map((r) => [r.steamid, r.name]));
console.log(`match ${matchId}: ${roster.length} rostered`);
for (const t of ['a', 'b']) {
  const side = roster.filter((r) => r.team === t);
  console.log(`  team ${t.toUpperCase()}: ${side.length}${side.length > 4 ? '  <-- OVER FULL' : ''}`);
}

const rounds = db.prepare(
  'SELECT ordinal, half, filename FROM match_replays WHERE match_id = ? ORDER BY ordinal, half',
).all(matchId) as { ordinal: number; half: number; filename: string }[];

if (rounds.length === 0) {
  console.error('no replay rows for that match');
  process.exit(1);
}

let problems = 0;
for (const r of rounds) {
  const found = resolveReplayPath(db, matchId, r.ordinal, r.half, config.replayDir);
  if (!found) { console.log(`  ${r.ordinal}/${r.half}: file missing`); problems++; continue; }
  const buf = new Uint8Array(readFileSync(found.path));
  const header = decodeHeader(buf);
  if (!header) { console.log(`  ${r.ordinal}/${r.half}: unreadable header`); problems++; continue; }

  // Which slots are ever PRESENT. A slot that is never present across a whole
  // round is the signature of the bug: it belongs to somebody who was not
  // actually in the game.
  const { frames } = decodeFrames(buf, HEADER_BYTES, buf.length);
  const seen = new Set<number>();
  for (const f of frames) {
    for (const p of f.players) if ((p.state & STATE.PRESENT) !== 0) seen.add(p.slot);
  }

  const inSlots = new Set(header.slots.filter(Boolean));
  const notes: string[] = [];
  header.slots.forEach((id, slot) => {
    if (!id) return;
    if (!nameOf.has(id)) { notes.push(`EXTRA slot ${slot} ${id} is not on the roster`); problems++; }
    else if (!seen.has(slot)) { notes.push(`GHOST slot ${slot} ${nameOf.get(id)} never present`); problems++; }
  });
  for (const p of roster) {
    if (!inSlots.has(p.steamid)) { notes.push(`MISSING ${p.name} (${p.steamid}) is in no slot`); problems++; }
  }

  const tag = notes.length === 0 ? 'ok' : notes.join('; ');
  console.log(`  ${r.ordinal}/${r.half} ${header.map} frames=${frames.length}: ${tag}`);
}

console.log(problems === 0
  ? '\nevery round names exactly the players who were in it'
  : `\n${problems} problem(s); see above`);
process.exit(problems === 0 ? 0 : 1);
