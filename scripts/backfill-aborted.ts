// Recover the record of matches that were aborted before archiveAborted existed.
//
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/backfill-aborted.ts [--write]'
//
// Until 2026-09-20 an abandoned, admin-aborted or reaped match had clearLive()
// run on it, which deleted the map list, the running scores and the per-player
// totals: the match page 404'd and nothing anywhere said who was in it or how
// far it got. archiveAborted now promotes that scratch into the permanent
// tables instead, and it is written to work on a match whose scratch is
// already gone, falling back to match_rounds, match_live_map_stats and
// match_demos (none of which clearLive touched). So the same function
// backfills history.
//
// Dry run by default: it prints what it would write and touches nothing.
// Voided matches are skipped; they completed and already have their rows.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { archiveAborted } from '../src/matchArchive.js';

const write = process.argv.includes('--write');
const db = openDb(loadConfig().dbPath);

const todo = db.prepare(
  `SELECT id, campaign, ended_at AS endedAt FROM matches
   WHERE state = 'aborted' AND voided_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM match_maps mm WHERE mm.match_id = matches.id)
   ORDER BY id`,
).all() as { id: number; campaign: string; endedAt: string | null }[];

if (todo.length === 0) {
  console.log('nothing to backfill');
  process.exit(0);
}

// A dry run does the real work and then rolls it back, so what it prints is
// what --write would actually store rather than a guess at it.
const lines: string[] = [];
db.exec('BEGIN');
try {
  for (const m of todo) {
    archiveAborted(db, m.id);
    const maps = db.prepare(
      'SELECT ordinal, map, team_a_score AS a, team_b_score AS b FROM match_maps WHERE match_id = ? ORDER BY ordinal',
    ).all(m.id) as { ordinal: number; map: string; a: number; b: number }[];
    const roster = (db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ?').get(m.id) as { n: number }).n;
    lines.push(
      `#${m.id} ${m.campaign} (${m.endedAt ?? 'no end time'}): ${roster} players, `
      + (maps.length === 0 ? 'no maps recoverable' : maps.map((x) => `${x.ordinal}:${x.map} ${x.a}-${x.b}`).join(', ')),
    );
  }
  db.exec(write ? 'COMMIT' : 'ROLLBACK');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

for (const l of lines) console.log(l);
console.log(write ? `\nbackfilled ${todo.length} match(es)` : `\n${todo.length} match(es) would be backfilled; re-run with --write`);
