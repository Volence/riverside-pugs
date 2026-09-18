/**
 * Recompute survivors_alive for rounds recorded before the 2026-09-18 fix.
 *
 * Until then the plugin counted survivors with IsPlayerAlive, which is true for
 * an INCAPACITATED player, and did not exclude PINNED or LEDGED either. A
 * versus round ends the instant the last survivor goes down, so a wipe was
 * recorded as 1 to 3 survivors and every map page read ~100% survived.
 *
 * Those rows are repairable, which is why this exists rather than a cutoff
 * that throws history away: the replay's final frame carries INCAP, LEDGED and
 * PINNED per player, so the count can be rebuilt from what was actually on
 * screen. Measured over the live data, 59 of 89 rounds flip from survived to
 * wiped and the survival rate goes from 98% to 31%.
 *
 * Idempotent: rerunning recomputes the same values. Only rounds with a
 * decodable replay are touched, and a round whose replay is missing or
 * truncated is left exactly as it was rather than guessed at.
 *
 *   npx tsx scripts/repair-survivors-alive.ts [--apply]
 *
 * Without --apply it reports what would change and writes nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decodeHeader, decodeFrames, HEADER_BYTES, STATE, slotInfected } from '../src/replayFormat.js';

const apply = process.argv.includes('--apply');
const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const dir = config.replayDir;
if (!dir) {
  console.error('No REPLAY_DIR configured; nothing to repair.');
  process.exit(1);
}

const rows = db.prepare(
  `SELECT mr.filename AS filename, mr.match_id AS matchId, mr.ordinal AS ordinal, mr.half AS half,
          rd.survivors_alive AS stored
   FROM match_replays mr
   JOIN match_rounds rd
     ON rd.match_id = mr.match_id AND rd.ordinal = mr.ordinal AND rd.half = mr.half
   WHERE rd.survivors_alive IS NOT NULL`,
).all() as { filename: string; matchId: number; ordinal: number; half: number; stored: number }[];

const upd = db.prepare(
  'UPDATE match_rounds SET survivors_alive = ? WHERE match_id = ? AND ordinal = ? AND half = ?',
);

let changed = 0, same = 0, skipped = 0;
const write = db.transaction((list: { r: typeof rows[number]; now: number }[]) => {
  for (const { r, now } of list) upd.run(now, r.matchId, r.ordinal, r.half);
});
const pending: { r: typeof rows[number]; now: number }[] = [];

for (const r of rows) {
  let frames;
  try {
    const buf = readFileSync(join(dir, r.filename));
    const header = decodeHeader(buf);
    if (!header) { skipped++; continue; }
    frames = decodeFrames(buf, HEADER_BYTES, buf.length, (s) => slotInfected(header, s)).frames;
  } catch {
    skipped++;
    continue;
  }
  if (frames.length === 0) { skipped++; continue; }

  const last = frames[frames.length - 1];
  let onTheirFeet = 0;
  for (const p of last.players) {
    if (p.infected || (p.state & STATE.PRESENT) === 0) continue;
    if ((p.state & STATE.ALIVE) === 0) continue;
    // The same three the fixed plugin excludes. A round cannot end with a
    // survivor still held and the rest safe: the saferoom door does not close
    // on a team mate who is being pinned.
    if ((p.state & (STATE.INCAP | STATE.LEDGED | STATE.PINNED)) !== 0) continue;
    onTheirFeet++;
  }

  if (onTheirFeet === r.stored) { same++; continue; }
  changed++;
  pending.push({ r, now: onTheirFeet });
  if (!apply) {
    console.log(`  match ${r.matchId} map ${r.ordinal} half ${r.half}: ${r.stored} -> ${onTheirFeet}`);
  }
}

if (apply && pending.length) write(pending);

const survived = (pick: (r: typeof rows[number]) => number) =>
  rows.filter((r) => pick(r) > 0).length;
console.log(`${rows.length} rounds with a replay: ${changed} changed, ${same} already correct, ${skipped} unreadable.`);
console.log(apply ? 'Written.' : 'Dry run. Pass --apply to write.');
console.log(`Survived before: ${survived((r) => r.stored)} of ${rows.length}.`);
