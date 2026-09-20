// Close out a match whose result is stuck in the plugin.
//
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/recover-match.ts <matchId> <dumpFile>'
//
// When finishMatch cannot pull sm_pug_dump (rcon down, response mangled), the
// match stays 'live' and the plugin keeps the result in its 'ended' state. Pull
// the dump by hand (`deploy/rcon.py "sm_pug_dump <token>"`), save it to a file,
// and run this. It does exactly what Orchestrator.finishMatch does after a
// successful pull: completeMatch, demo and replay scans, clear the live scratch
// rows, release the server. It does NOT abort the plugin; do that yourself once
// the match shows completed (`sm_pug_abort <token>`), and note the running
// service still has the token registered until its next restart.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { parseDump } from '../src/dumpParse.js';
import { completeMatch } from '../src/matchResult.js';
import { recordMatchDemos } from '../src/demos.js';
import { recordMatchReplays } from '../src/replays.js';
import { clearLive } from '../src/matchArchive.js';
import { release } from '../src/serverPool.js';

const matchId = Number(process.argv[2]);
const dumpFile = process.argv[3];
if (!Number.isInteger(matchId) || !dumpFile) {
  console.error('usage: recover-match.ts <matchId> <dumpFile>');
  process.exit(2);
}

const config = loadConfig();
const db = openDb(config.dbPath);
const match = db.prepare('SELECT id, state, server_id, token FROM matches WHERE id = ?')
  .get(matchId) as { id: number; state: string; server_id: number | null; token: string | null } | undefined;
if (!match) { console.error(`no match ${matchId}`); process.exit(1); }
if (match.state !== 'live') { console.error(`match ${matchId} is ${match.state}, not live; nothing to recover`); process.exit(1); }
if (!match.token) { console.error(`match ${matchId} has no token`); process.exit(1); }

const dump = parseDump(readFileSync(dumpFile, 'utf8'));
if (!dump) { console.error('dump did not parse'); process.exit(1); }
if (dump.matchId !== matchId) { console.error(`dump is for match ${dump.matchId}, not ${matchId}`); process.exit(1); }

if (!completeMatch(db, matchId, dump)) { console.error('completeMatch refused (state changed?)'); process.exit(1); }
console.log(`match ${matchId} completed: a=${dump.totalA} b=${dump.totalB} winner=${dump.winner}`);

try {
  const n = recordMatchDemos(db, matchId, match.token, config.demoDir);
  console.log(`demos recorded: ${n}`);
} catch (err) { console.error('demo scan failed (non-fatal):', err); }
try {
  const n = recordMatchReplays(db, matchId, match.token, config.replayDir);
  console.log(`replays recorded: ${n}`);
} catch (err) { console.error('replay scan failed (non-fatal):', err); }
clearLive(db, matchId);
if (match.server_id !== null) release(db, match.server_id);
console.log('live rows cleared, server released');
