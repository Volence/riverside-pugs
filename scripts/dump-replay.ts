// scripts/dump-replay.ts
// Read a replay written by the plugin and print what it contains.
// Usage: npx tsx scripts/dump-replay.ts <file.rpl>
import { readFileSync } from 'node:fs';
import { decodeIndex, parseReplay, ENTITY_KIND, STATE } from '../src/replayFormat.js';

const path = process.argv[2];
if (!path) { console.error('usage: tsx scripts/dump-replay.ts <file.rpl>'); process.exit(1); }

const buf = readFileSync(path);
const replay = parseReplay(buf);
if (!replay) { console.error('not a replay file (bad magic or too short)'); process.exit(1); }

const { header, frames, truncatedBytes } = replay;
console.log('header', header);
console.log('frames', frames.length, 'truncatedBytes', truncatedBytes);
console.log('index', decodeIndex(buf, header).length, 'keyframes');

if (frames.length >= 2) {
  const span = frames[frames.length - 1].tMs - frames[0].tMs;
  console.log('duration', (span / 1000).toFixed(1), 's');
  console.log('effective hz', (((frames.length - 1) * 1000) / span).toFixed(2));
}

const kindName = Object.fromEntries(Object.entries(ENTITY_KIND).map(([k, v]) => [v, k]));
const mid = frames[Math.floor(frames.length / 2)];
if (mid) {
  console.log('--- middle frame, t =', mid.tMs, 'ms ---');
  for (const p of mid.players) {
    if (!(p.state & STATE.PRESENT)) continue;
    console.log(
      ` slot ${p.slot} ${header.slots[p.slot] || '(no steamid)'}`,
      `pos ${p.x},${p.y},${p.z} yaw ${p.yaw}`,
      `hp ${p.health}+${p.temp} wep ${p.weapon} ${p.clip}/${p.reserve}`,
      `state 0x${p.state.toString(16)}`,
    );
  }
  const byKind: Record<string, number> = {};
  for (const e of mid.entities) byKind[kindName[e.kind] ?? `unknown(${e.kind})`] = (byKind[kindName[e.kind] ?? `unknown(${e.kind})`] ?? 0) + 1;
  console.log(' entities', mid.entities.length, byKind);
}
