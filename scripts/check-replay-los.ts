// Print what a replay records about line of sight: whether the file carries
// it, the slot ranks, and per survivor/infected pair how many frames had the
// infected spawned and how many of those it was visible.
//   npx tsx scripts/check-replay-los.ts <file.rpl>
import { readFileSync } from 'node:fs';
import { canSee, parseReplay, sideRanks, STATE } from '../src/replayFormat.js';

const r = parseReplay(readFileSync(process.argv[2]));
if (!r) { console.error('not a replay'); process.exit(1); }
const h = r.header;
console.log(`map ${h.map} half ${h.half} frames ${r.frames.length} losKnown ${h.losKnown}`);
if (!h.losKnown) {
  console.log('line of sight is not recorded in this file: visibility unknown');
  process.exit(0);
}
const ranks = sideRanks(h);
console.log('survivor ranks', ranks.survivor.join(','), ' infected ranks', ranks.infected.join(','));
for (let s = 0; s < 8; s++) {
  if (ranks.survivor[s] < 0) continue;
  for (let i = 0; i < 8; i++) {
    if (ranks.infected[i] < 0) continue;
    let spawned = 0, seen = 0;
    for (const f of r.frames) {
      const p = f.players[i];
      if (!p || !(p.state & STATE.ALIVE) || (p.state & STATE.GHOST)) continue;
      spawned++;
      if (canSee(h, f, s, i)) seen++;
    }
    if (spawned) console.log(`slot ${s} -> slot ${i}: visible ${seen} of ${spawned} spawned frames`);
  }
}
