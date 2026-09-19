/**
 * Generate consistency/configs/l4d_consistency.cfg: the explicit list of files the
 * server forces for consistency checking.
 *
 * The list is generated and COMMITTED rather than expanded from wildcards by the
 * plugin at runtime. A glob expanded against the game's file system hides a bad
 * rule as a silent zero; a generated file is diffable, reviewable, and is what the
 * campaign uploader intersects an uploaded VPK against.
 *
 * Rules and their reasons are in
 * docs/superpowers/specs/2026-09-19-file-consistency-phase2-design.md.
 *
 * Usage:
 *   npx tsx scripts/gen-consistency-list.ts                    # groups 1 to 5
 *   npx tsx scripts/gen-consistency-list.ts --commons          # also group 6
 *   npx tsx scripts/gen-consistency-list.ts --game /path/to/left4dead
 *   npx tsx scripts/gen-consistency-list.ts --verify /path/to/other/left4dead
 *
 * --game is a STOCK install (default: the local test server). Models, materials
 * and particles are read from its pak01_dir.vpk; sounds and scripts are loose
 * files on L4D1, so those are walked on disk.
 *
 * --overlay names a search-path directory that SOME legitimate clients mount ahead
 * of left4dead and others do not (left4dead_dlc4). A listed path that an overlay
 * also ships, loose or in its pak01, would resolve differently for the two
 * populations and disconnect one of them, so generation fails naming it. Defaults
 * to <game>/../left4dead_dlc4 when that exists. May be given more than once.
 *
 * --verify compares every loose file on the list against a second install and
 * names any that differ. Run it against a client before trusting a server: the
 * engine CRCs the SERVER's copy, so one customised sound on the server would
 * disconnect every stock client.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVpkPaths } from '../src/vpk.js';

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
const COMMONS = args.includes('--commons');
const OUT = resolve(flag('--out') ?? join(here, '../consistency/configs/l4d_consistency.cfg'));

/** A rule selects paths out of one source. `dir` matches files directly in that
 *  directory; `tree` matches the directory and everything below it. */
type Rule =
  | { from: 'manifest' }
  | { from: 'pak' | 'loose'; file: string }
  | { from: 'pak' | 'loose'; dir: string; ext?: string[] }
  | { from: 'loose'; tree: string };

interface Group { n: number; title: string; rules: Rule[] }

const SI = ['boomer', 'hulk', 'hunter', 'smoker', 'witch'];
const GUNS = ['smg', 'shotgun', 'auto_shotgun', 'rifle', 'hunting_rifle', 'pistol', 'minigun'];

const GROUPS: Group[] = [
  {
    n: 1, title: 'special infected models and materials',
    rules: [
      ...[...SI, 'smoker_tongue_attach'].map((m): Rule => ({ from: 'pak', file: `models/infected/${m}.mdl` })),
      // Both .vmt and .vtf: skins usually edit the material definition inside
      // pak01_dir.vpk and leave the stock texture alone.
      ...SI.map((m): Rule => ({ from: 'pak', dir: `materials/models/infected/${m}` })),
    ],
  },
  {
    n: 2, title: 'foliage and plants',
    rules: [
      { from: 'pak', dir: 'models/props_foliage', ext: ['mdl'] },
      { from: 'pak', dir: 'materials/models/props_foliage' },
      { from: 'pak', dir: 'models/props_plants', ext: ['mdl'] },
      { from: 'pak', dir: 'materials/models/props_plants' },
    ],
  },
  {
    n: 3, title: 'gunfire and the soundscripts',
    rules: [
      ...GUNS.map((g): Rule => ({ from: 'loose', dir: `sound/weapons/${g}/gunfire`, ext: ['wav'] })),
      // Every soundscript the manifest loads, not just the weapons one: a sound
      // entry can be redefined from any script the manifest names, so forcing
      // game_sounds_weapons.txt alone leaves the quiet-gun edit open one file
      // over. soundmixers.txt sets per-category volume, the same trick again.
      //
      // The manifest ITSELF is deliberately absent. The l4d2-on-l4d1 pack
      // (left4dead_dlc4, which Dallas mounts and which players need for the
      // L4D2 maps) ships its own game_sounds_manifest.txt, so a server with the
      // pack and a client without it, or the reverse, resolve different files
      // and the stock player is the one disconnected. See --overlay.
      { from: 'manifest' },
      { from: 'loose', file: 'scripts/soundmixers.txt' },
    ],
  },
  {
    n: 4, title: 'special infected sounds',
    rules: [
      ...['hunter', 'smoker', 'boomer', 'tank'].map((m): Rule => ({ from: 'loose', tree: `sound/player/${m}` })),
      { from: 'loose', tree: 'sound/npc/witch' },
      { from: 'loose', tree: 'sound/player/footsteps/tank' },
      { from: 'loose', tree: 'sound/player/footsteps/witch' },
      { from: 'loose', file: 'scripts/game_sounds_infected_special.txt' },
    ],
  },
  {
    n: 5, title: 'bile, smoke and the SI particle definitions',
    rules: [
      { from: 'pak', file: 'materials/particle/screenspaceboomervomit.vmt' },
      { from: 'pak', file: 'materials/particle/vomitscreensplash.vtf' },
      { from: 'pak', dir: 'materials/particle/smoke1' },
      { from: 'pak', dir: 'materials/particle/vistasmokev1' },
      { from: 'pak', file: 'materials/particle/particle_smokegrenade.vmt' },
      { from: 'pak', file: 'materials/particle/particle_smokegrenade1.vmt' },
      { from: 'pak', file: 'materials/particle/particle_smokegrenade_sc.vmt' },
      { from: 'pak', file: 'materials/particle/particle_smokegrenade.vtf' },
      ...['smoker_fx', 'boomer_fx', 'hunter_fx', 'tank_fx', 'witch_fx', 'infected_fx', 'screen_fx']
        .map((f): Rule => ({ from: 'pak', file: `particles/${f}.pcf` })),
    ],
  },
];

const GROUP6: Group = {
  n: 6, title: 'common infected',
  rules: [
    { from: 'pak', dir: 'models/infected', ext: ['mdl'] }, // narrowed to common_* below
    { from: 'pak', dir: 'materials/models/infected/common' },
    { from: 'loose', tree: 'sound/npc/infected' },
    { from: 'loose', tree: 'sound/player/footsteps/infected' },
    { from: 'loose', tree: 'sound/player/footsteps/boomer' },
    { from: 'loose', file: 'scripts/game_sounds_infected_common.txt' },
  ],
};

const pakPaths = listVpkPaths(join(GAME, 'pak01_dir.vpk'));
if (pakPaths.length === 0) {
  console.error(`no pak01_dir.vpk under ${GAME}`);
  process.exit(1);
}
const pakLower = new Map(pakPaths.map((p) => [p.toLowerCase(), p]));

// Loose files resolve through the search paths in gameinfo order: left4dead_dlc3
// sits ahead of left4dead, and several soundscripts exist only there.
const LOOSE_ROOTS = [join(GAME, '../left4dead_dlc3'), GAME];
const resolveLoose = (rel: string): string | null => {
  for (const root of LOOSE_ROOTS) if (existsSync(join(root, rel))) return join(root, rel);
  return null;
};

function manifestScripts(): string[] {
  const manifest = resolveLoose('scripts/game_sounds_manifest.txt');
  if (!manifest) return [];
  const out: string[] = [];
  for (const m of readFileSync(manifest, 'utf8').matchAll(/^\s*"(?:precache|preload)_file"\s+"([^"]+)"/gm)) {
    if (resolveLoose(m[1])) out.push(m[1]);
    else console.error(`manifest names a script that does not exist: ${m[1]}`);
  }
  return out;
}

function walk(rel: string, recurse: boolean): string[] {
  const abs = join(GAME, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs).sort()) {
    const childRel = `${rel}/${name}`;
    const st = statSync(join(GAME, childRel));
    if (st.isDirectory()) { if (recurse) out.push(...walk(childRel, true)); }
    else out.push(childRel);
  }
  return out;
}

const extOf = (p: string): string => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

function select(rule: Rule): string[] {
  if (rule.from === 'manifest') return manifestScripts();
  if ('file' in rule) {
    if (rule.from === 'pak') { const hit = pakLower.get(rule.file.toLowerCase()); return hit ? [hit] : []; }
    return resolveLoose(rule.file) ? [rule.file] : [];
  }
  if ('tree' in rule) return walk(rule.tree, true);
  const inDir = rule.from === 'pak'
    ? pakPaths.filter((p) => p.slice(0, p.lastIndexOf('/')).toLowerCase() === rule.dir.toLowerCase())
    : walk(rule.dir, false);
  return rule.ext ? inDir.filter((p) => rule.ext!.includes(extOf(p))) : inDir;
}

// What players are ALLOWED to change, by the owner's ruling (2026-09-19): custom
// HUDs, custom crosshairs, and the infected-vision colour correction files, which
// may be edited or deleted outright. No rule may ever force one of these. It is
// checked here, against the finished list, so a broad rule added later (group 6,
// or a whole-directory rule) fails generation instead of disconnecting everyone
// who runs a HUD.
const NEVER_FORCE: { why: string; test: RegExp }[] = [
  { why: 'HUD and menu layout', test: /^resource\// },
  { why: 'HUD scripts', test: /^scripts\/(hudlayout\.res|hudanimations\.txt|hud_textures\.txt|mod_textures\.txt)$/ },
  { why: 'HUD scripts', test: /^scripts\/.*\.res$/ },
  { why: 'HUD and crosshair art', test: /^materials\/vgui\// },
  { why: 'crosshair art', test: /^materials\/(crosshairs?|sprites\/crosshair)/ },
  { why: 'infected vision colour correction', test: /^materials\/correction\/(ghost|infected)(\.pwl)?\.raw$/ },
];

// Anything that is not a game asset the client could meaningfully differ on.
const SKIP_EXT = new Set(['cache', 'db', 'ds_store']);

const groups = COMMONS ? [...GROUPS, GROUP6] : GROUPS;
const seen = new Set<string>();
const lines: string[] = [
  '# GENERATED by scripts/gen-consistency-list.ts. Do not edit by hand; change the rules and re-run.',
  '# One game-relative path per line. "# group N: title" starts a group; the plugin reports per group.',
  '',
];
let total = 0;
let failed = false;
for (const g of groups) {
  const paths: string[] = [];
  for (const rule of g.rules) {
    let hits = select(rule);
    if (g.n === 6 && 'dir' in rule && rule.dir === 'models/infected') {
      hits = hits.filter((p) => /\/common_[^/]*\.mdl$/i.test(p));
    }
    hits = hits.filter((p) => !SKIP_EXT.has(extOf(p)));
    if (hits.length === 0) {
      // A rule that matches nothing is a typo or a game update, never something to skip quietly.
      console.error(`group ${g.n}: rule matched NOTHING: ${JSON.stringify(rule)}`);
      failed = true;
    }
    for (const p of hits) if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); paths.push(p); }
  }
  lines.push(`# group ${g.n}: ${g.title}`, ...paths, '');
  console.log(`group ${g.n}: ${String(paths.length).padStart(4)}  ${g.title}`);
  total += paths.length;
}
console.log(`total:   ${String(total).padStart(4)}`);

for (const p of seen) {
  const hit = NEVER_FORCE.find((n) => n.test.test(p));
  if (hit) { console.error(`listed path is on the never-force list (${hit.why}): ${p}`); failed = true; }
}
console.log(`never-force: ${NEVER_FORCE.length} patterns, ${failed ? 'VIOLATED' : '0 listed paths match'}`);

for (const overlay of OVERLAYS) {
  const inPak = existsSync(join(overlay, 'pak01_dir.vpk')) ? listVpkPaths(join(overlay, 'pak01_dir.vpk')) : [];
  const shipped = new Set(inPak.map((p) => p.toLowerCase()));
  const walkAll = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const childAbs = join(abs, name), childRel = rel ? `${rel}/${name}` : name;
      if (statSync(childAbs).isDirectory()) walkAll(childAbs, childRel);
      else shipped.add(childRel.toLowerCase());
    }
  };
  walkAll(overlay, '');
  const hits = [...seen].filter((p) => shipped.has(p));
  for (const h of hits) console.error(`overlay ${overlay} also ships a listed path: ${h}`);
  console.log(`overlay: ${overlay}: ${shipped.size} paths, ${hits.length} on the list`);
  if (hits.length) failed = true;
}
if (failed) process.exit(1);

if (VERIFY) {
  const md5 = (f: string): string => createHash('md5').update(readFileSync(f)).digest('hex');
  let differ = 0, missing = 0, checked = 0;
  const otherRoots = [join(resolve(VERIFY), '../left4dead_dlc3'), resolve(VERIFY)];
  // `seen` is lower-cased for de-duplication; walk the emitted lines for real paths.
  for (const p of lines.filter((l) => l && !l.startsWith('#'))) {
    const a = resolveLoose(p);
    if (!a) continue; // archive content; pak01_dir.vpk itself is compared below
    const b = otherRoots.map((r) => join(r, p)).find((f) => existsSync(f));
    if (!b) { console.error(`verify: MISSING in ${VERIFY}: ${p}`); missing++; continue; }
    checked++;
    if (md5(a) !== md5(b)) { console.error(`verify: DIFFERS: ${p}`); differ++; }
  }
  const pakSame = existsSync(join(resolve(VERIFY), 'pak01_dir.vpk'))
    && md5(join(GAME, 'pak01_dir.vpk')) === md5(join(resolve(VERIFY), 'pak01_dir.vpk'));
  console.log(`verify: ${checked} loose files compared, ${differ} differ, ${missing} missing; pak01_dir.vpk ${pakSame ? 'identical' : 'DIFFERS'}`);
  if (differ || missing || !pakSame) process.exit(1);
}

writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT}`);
