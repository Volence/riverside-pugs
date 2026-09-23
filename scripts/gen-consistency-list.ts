/**
 * Generate consistency/configs/l4d_consistency.cfg: the explicit list of files the
 * server forces for consistency checking.
 *
 * The list is generated and COMMITTED rather than expanded from wildcards by the
 * plugin at runtime. A glob expanded against the game's file system hides a bad
 * rule as a silent zero; a generated file is diffable, reviewable, and is what the
 * campaign uploader intersects an uploaded VPK against.
 *
 * The rules, and the checks a list has to pass, are in src/consistencyGen.ts.
 * Their reasons are in
 * docs/superpowers/specs/2026-09-19-file-consistency-phase2-design.md.
 *
 * Usage:
 *   npx tsx scripts/gen-consistency-list.ts                    # groups 1 to 5, the shipped list
 *   npx tsx scripts/gen-consistency-list.ts --commons          # also group 6
 *   npx tsx scripts/gen-consistency-list.ts --batch2           # also groups 7 to 15, to l4d_consistency.batch2.cfg
 *   npx tsx scripts/gen-consistency-list.ts --batch2 --without 15
 *   npx tsx scripts/gen-consistency-list.ts --groups 1-5,16 --out /tmp/probe.cfg
 *   npx tsx scripts/gen-consistency-list.ts --game /path/to/left4dead
 *   npx tsx scripts/gen-consistency-list.ts --verify /path/to/other/left4dead
 *
 * --game is a STOCK install (default: the local test server). Models, materials
 * and particles are read from its pak01_dir.vpk and, for groups 7 and up, from
 * ../left4dead_dlc3/pak01_dir.vpk as well, dlc3 first, which is the engine's own
 * search order. Sounds and scripts are loose files on L4D1, so those are walked
 * on disk, through the same two directories.
 *
 * --batch2 writes to l4d_consistency.batch2.cfg unless --out says otherwise, so
 * that the shipped list is never replaced by accident. --groups names the groups
 * outright and always needs --out. --without drops groups from whatever the other
 * flags selected.
 *
 * --overlay names a search-path directory that SOME legitimate clients mount ahead
 * of left4dead and others do not (left4dead_dlc4). A listed path that an overlay
 * also ships, loose or in its pak01, would resolve differently for the two
 * populations and disconnect one of them, so generation fails naming it. Defaults
 * to <game>/../left4dead_dlc4 when that exists. May be given more than once.
 *
 * --verify compares every file on the list, loose or archived, against a second
 * install and names any that differ. Run it against a client before trusting a
 * server: the engine CRCs the SERVER's copy, so one customised sound on the
 * server would disconnect every stock client.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import {
  DUAL_COPY_WAIVED, GROUPS, NEVER_FORCE_PATTERNS, REF_WAIVED, SHIPPED, SearchPaths, generate, selectGroups,
} from '../src/consistencyGen.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const GAME = resolve(flag('--game') ?? '/home/volence/l4d1-ds/server/left4dead');
const VERIFY = flag('--verify');
const OVERLAYS = args.flatMap((a, i) => (a === '--overlay' && args[i + 1] ? [resolve(args[i + 1])] : []));
if (OVERLAYS.length === 0 && existsSync(join(GAME, '../left4dead_dlc4'))) OVERLAYS.push(join(GAME, '../left4dead_dlc4'));
const BATCH2 = args.includes('--batch2');

let select: number[];
try {
  select = selectGroups({ commons: args.includes('--commons'), batch2: BATCH2, groups: flag('--groups'), without: flag('--without') });
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const isShipped = select.length === SHIPPED.length && select.every((n, i) => n === SHIPPED[i]);
if (flag('--groups') && !flag('--out')) {
  console.error('--groups needs --out: a hand-picked list is a probe, and must not land on the shipped file');
  process.exit(2);
}
const configs = join(here, '../consistency/configs');
const OUT = resolve(flag('--out') ?? join(configs, BATCH2 ? 'l4d_consistency.batch2.cfg' : 'l4d_consistency.cfg'));

if (!existsSync(join(GAME, 'pak01_dir.vpk'))) {
  console.error(`no pak01_dir.vpk under ${GAME}`);
  process.exit(1);
}
// gameinfo.txt order: left4dead_dlc3 sits ahead of left4dead.
const stockOf = (game: string): SearchPaths => new SearchPaths([join(game, '../left4dead_dlc3'), game]);
const stock = stockOf(GAME);

const out = generate({
  groups: GROUPS, select, stock, base: GAME, overlays: OVERLAYS, dualCopyWaived: DUAL_COPY_WAIVED, refWaived: REF_WAIVED,
});

const kb = (n: number): string => `${String(Math.round(n / 1024)).padStart(6)} KB`;
for (const g of out.groups) {
  const dupes = g.alreadyListed ? `  (${g.alreadyListed} more already listed by an earlier group)` : '';
  console.log(`group ${String(g.n).padStart(2)}: ${String(g.paths.length).padStart(4)} ${kb(g.bytes)}  ${g.title}${dupes}`);
}
console.log(`total:    ${String(out.total).padStart(4)} ${kb(out.bytes)}${isShipped ? '' : `  (groups ${select.join(',')})`}`);
// The downloadables string table holds 8192 entries and the list shares it with
// what the map and the plugins put there: about 20 on the live servers, where
// sm_consistency_status reported 671 used with 651 forced.
console.log(`table:    about ${out.total + 20} of 8192 downloadables entries with this list forced`);
for (const n of out.notes) console.log(`note: ${n}`);
for (const p of out.problems) console.error(`PROBLEM: ${p}`);
const neverForced = out.problems.some((p) => p.includes('never-force list'));
console.log(`never-force: ${NEVER_FORCE_PATTERNS} patterns, ${neverForced ? 'VIOLATED' : '0 listed paths match'}`);
for (const o of out.overlays) console.log(`overlay: ${o.dir}: ${o.shipped} paths, ${o.hits} on the list`);
if (out.problems.length) process.exit(1);

if (VERIFY) {
  const other = stockOf(resolve(VERIFY));
  let differ = 0, missing = 0, loose = 0, archived = 0;
  for (const p of out.groups.flatMap((g) => g.paths)) {
    const a = stock.resolve(p)!; // generate() has already failed on a listed path stock lacks
    const b = other.resolve(p);
    if (!b) { console.error(`verify: MISSING in ${VERIFY}: ${p}`); missing++; continue; }
    if (a.kind === 'loose') loose++; else archived++;
    // Content on both sides, not the archive directory's record of it: a skin
    // edited into pak01 in place leaves the recorded CRC alone.
    if (crc32(a.read()) !== crc32(b.read())) { console.error(`verify: DIFFERS (${b.root} ${b.kind}): ${p}`); differ++; }
  }
  const md5 = (f: string): string => createHash('md5').update(readFileSync(f)).digest('hex');
  const dirFiles = ['pak01_dir.vpk', '../left4dead_dlc3/pak01_dir.vpk'].map((rel) => {
    const mine = join(GAME, rel), theirs = join(resolve(VERIFY), rel);
    const same = existsSync(mine) && existsSync(theirs) && md5(mine) === md5(theirs);
    return { rel, same };
  });
  console.log(`verify: ${loose} loose and ${archived} archived files compared, ${differ} differ, ${missing} missing; `
    + dirFiles.map((d) => `${d.rel.replace('../', '')} ${d.same ? 'identical' : 'DIFFERS'}`).join(', '));
  if (differ || missing || dirFiles.some((d) => !d.same)) process.exit(1);
}

writeFileSync(OUT, out.lines.join('\n'));
console.log(`wrote ${OUT}`);
