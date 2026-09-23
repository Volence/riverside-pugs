/**
 * Stamp the side mask into every closed replay file that does not have one
 * yet, once, by hand.
 *
 * Every replay written before format version 3 (2026-09-23) has bytes 156
 * and 157 zero: no infected mask and no flag saying so. A viewer of one of
 * those files falls back to slot order, which is wrong for any second half
 * and for any roster recorded out of team order. This script fixes that in
 * place, using the same match_rounds and match_players rows the live upload
 * path (src/replayOffload.ts) uses to compute the mask for a freshly closed
 * round, so a file stamped by hand here and a file stamped on upload agree.
 *
 * Only bytes 156 and 157 of a file are ever touched, and only when byte 157
 * is not already 1. Everything else in the file, including its size, is
 * unchanged.
 *
 * Usage, on the box, as the pug user so it can read .env and write the files:
 *
 *   cd /home/pug/app
 *   sudo -u pug npx tsx scripts/stamp-replay-sides.ts /path/to/replays            # dry run
 *   sudo -u pug npx tsx scripts/stamp-replay-sides.ts /path/to/replays --commit   # write
 *
 * Dry run by default: it reports what it would stamp without touching a file.
 */
import { openSync, readSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { HEADER_BYTES, SIDES_FLAG_OFFSET } from '../src/replayFormat.js';
import { infectedMaskForHeader, stampSidesInFile } from '../src/replaySides.js';
import { loadDotEnv } from './dotenv.js';

// Same pattern src/replays.ts and src/replayPrune.ts use for a replay
// filename. Neither exports it, so it is restated here.
const NAME_RE = /^pug_[0-9a-f]{32}_\d+_[12]\.rpl$/;

/** Read just the header of a replay file. Throws (caller catches) when the
 *  file is missing or shorter than a header, which for this script means
 *  "not in this directory" and "skip it", not "crash". */
function readHeaderBytes(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const got = readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (got !== HEADER_BYTES) throw new Error('short read');
    return buf;
  } finally {
    closeSync(fd);
  }
}

const dir = process.argv[2];
if (!dir || dir.startsWith('--')) {
  console.error('Usage: stamp-replay-sides.ts <dir> [--commit]');
  process.exit(1);
}
const commit = process.argv.includes('--commit');

loadDotEnv();
const cfg = loadConfig(process.env);
const db = openDb(cfg.dbPath);

const rows = db.prepare(
  'SELECT match_id AS matchId, ordinal, half, filename FROM match_replays ORDER BY match_id ASC, ordinal ASC, half ASC',
).all() as { matchId: number; ordinal: number; half: number; filename: string }[];

interface Counts { stamped: number; already: number; unknown: number }
const byMatch = new Map<number, Counts>();
let totalStamped = 0, totalAlready = 0, totalUnknown = 0;

for (const row of rows) {
  // Same hardening resolveReplayPath uses: a filename that is not exactly
  // what we write is left alone rather than normalised into something
  // plausible.
  if (row.filename !== basename(row.filename) || !NAME_RE.test(row.filename)) continue;

  const path = join(dir, row.filename);
  let head: Buffer;
  try {
    head = readHeaderBytes(path);
  } catch {
    continue; // Not in this directory (or too short to be a real replay). Not counted.
  }

  const counts = byMatch.get(row.matchId) ?? { stamped: 0, already: 0, unknown: 0 };
  byMatch.set(row.matchId, counts);

  if (head[SIDES_FLAG_OFFSET] === 1) {
    counts.already++; totalAlready++;
    continue;
  }

  const mask = infectedMaskForHeader(db, head, row.matchId, row.ordinal, row.half);
  if (mask === null) {
    counts.unknown++; totalUnknown++;
    continue;
  }

  if (commit) stampSidesInFile(path, mask);
  counts.stamped++; totalStamped++;
}

for (const [matchId, c] of byMatch) {
  console.log(`match ${matchId}: stamped ${c.stamped}, already had ${c.already}, unknown ${c.unknown}`);
}
console.log(`total: stamped ${totalStamped}, already had ${totalAlready}, unknown ${totalUnknown}`);

if (!commit) {
  console.log('\nDry run. Pass --commit to write the mask into each file.');
}
