import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { openVpk, tokenizeKeyValues, type VpkDir, type VpkDirEntry } from './vpk.js';

/**
 * The rules behind consistency/configs/l4d_consistency*.cfg, and the checks a
 * generated list has to pass. scripts/gen-consistency-list.ts is the command
 * line around this module; the rules and their reasons are in
 * docs/superpowers/specs/2026-09-19-file-consistency-phase2-design.md.
 *
 * Nothing here runs in the web service. It lives under src/ so that it is type
 * checked and tested, which scripts/ is not.
 */

// ---------------------------------------------------------------------------
// The install, seen the way the engine sees it
// ---------------------------------------------------------------------------

/** One copy of a game-relative path, in one search path. */
export interface StockCopy {
  /** The search path directory's name, e.g. `left4dead_dlc3`. */
  root: string;
  kind: 'pak' | 'loose';
  /** The path in that copy's own spelling. */
  path: string;
  size: number;
  /** CRC32 of the content: the pak directory's record, or computed for a loose file. */
  crc(): number;
  read(): Buffer;
}

const lower = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

function walkFiles(abs: string, rel: string, out: string[]): void {
  for (const name of readdirSync(abs)) {
    const childAbs = join(abs, name), childRel = rel ? `${rel}/${name}` : name;
    if (statSync(childAbs).isDirectory()) walkFiles(childAbs, childRel, out);
    else out.push(childRel);
  }
}

interface Root {
  dir: string;
  name: string;
  vpk: VpkDir | null;
  pak: Map<string, VpkDirEntry>;
  loose: Map<string, string>;
}

/**
 * Search path directories in ENGINE order, first wins: for a stock L4D1 that is
 * left4dead_dlc3 and then left4dead, which is gameinfo.txt's order. Each may
 * hold a pak01_dir.vpk and loose files.
 *
 * Inside one search path the archive is consulted before the loose file. That
 * is the 2026-09-19 probe result ("pak01 beats addons and loose files"), and
 * no path on any list exists both ways in one directory, so nothing rests on it.
 */
export class SearchPaths {
  private readonly roots: Root[];

  constructor(dirs: string[]) {
    this.roots = dirs.filter((d) => existsSync(d)).map((dir) => {
      const pakFile = join(dir, 'pak01_dir.vpk');
      const vpk = existsSync(pakFile) ? openVpk(pakFile) : null;
      const files: string[] = [];
      walkFiles(dir, '', files);
      return {
        dir, name: basename(dir), vpk,
        pak: new Map((vpk?.entries ?? []).map((e) => [lower(e.path), e])),
        loose: new Map(files.filter((f) => !f.toLowerCase().endsWith('.vpk')).map((f) => [lower(f), f])),
      };
    });
  }

  /** Every copy of a path, in the order the engine would find them. */
  copies(rel: string): StockCopy[] {
    const key = lower(rel);
    const out: StockCopy[] = [];
    for (const r of this.roots) {
      const e = r.pak.get(key);
      if (e) out.push({ root: r.name, kind: 'pak', path: e.path, size: e.size, crc: () => e.crc, read: () => r.vpk!.read(e) });
      const f = r.loose.get(key);
      if (f) {
        const abs = join(r.dir, f);
        out.push({ root: r.name, kind: 'loose', path: f, size: statSync(abs).size, crc: () => crc32(readFileSync(abs)), read: () => readFileSync(abs) });
      }
    }
    return out;
  }

  /** The copy the engine loads, or null. */
  resolve(rel: string): StockCopy | null {
    return this.copies(rel)[0] ?? null;
  }

  /** Archive paths in tree order: the last search path's first (the base game,
   *  which keeps a shipped group's order stable), then what earlier search
   *  paths add. `only` narrows it to one search path directory. */
  pakPaths(only?: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [...this.roots].reverse()) {
      if (only && r.dir !== only) continue;
      for (const e of r.vpk?.entries ?? []) {
        if (!seen.has(lower(e.path))) { seen.add(lower(e.path)); out.push(e.path); }
      }
    }
    return out;
  }

  /** The loose file the engine would open for this exact spelling, as an absolute path. */
  looseFile(rel: string): string | null {
    for (const r of this.roots) if (existsSync(join(r.dir, rel))) return join(r.dir, rel);
    return null;
  }

  get dirs(): string[] { return this.roots.map((r) => r.dir); }
}

/** Everything an overlay search path ships, loose or in its pak01, lower-cased. */
export function overlayPaths(dir: string): Set<string> {
  const pakFile = join(dir, 'pak01_dir.vpk');
  const shipped = new Set((existsSync(pakFile) ? openVpk(pakFile)?.entries ?? [] : []).map((e) => lower(e.path)));
  const files: string[] = [];
  walkFiles(dir, '', files);
  for (const f of files) if (!f.toLowerCase().endsWith('.vpk')) shipped.add(lower(f));
  return shipped;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** A path a rule would select and must not, with the reason. Printed on every
 *  run, and an exception that no longer matches anything fails generation. */
export interface Except { path: string; why: string }

/** A rule selects paths out of one source. `dir` matches files directly in that
 *  directory; `tree` matches the directory and everything below it; `companions`
 *  matches `<model>.<ext>` beside every .mdl the named groups force in this run. */
export type Rule =
  | { from: 'manifest' }
  | { from: 'pak' | 'loose'; file: string }
  | { from: 'pak' | 'loose'; dir: string; ext?: string[]; match?: RegExp; except?: Except[] }
  | { from: 'pak' | 'loose'; tree: string; ext?: string[]; except?: Except[] }
  | { from: 'companions'; of: number[]; ext: string[] };

export interface Group {
  n: number;
  title: string;
  rules: Rule[];
  /** Archive rules read the base game's pak01 only. Groups 1 to 6 were written
   *  before the generator could open the dlc3 pak, and groups 1 to 5 are LIVE
   *  as generated that way. Re-run against both paks, group 1's
   *  materials/models/infected/hulk rule would take in the Sacrifice tank and
   *  group 2's foliage rules 77 Sacrifice files, and the shipped list would
   *  change under players without anyone deciding it should. */
  baseOnly?: true;
  /** This group exists to force paths that base and dlc3 both hold with
   *  different content, so the dual-copy check notes them instead of failing. */
  allowDualCopy?: true;
}

const SI = ['boomer', 'hulk', 'hunter', 'smoker', 'witch'];
const GUNS = ['smg', 'shotgun', 'auto_shotgun', 'rifle', 'hunting_rifle', 'pistol', 'minigun'];
const MESH_EXT = ['vvd', 'dx90.vtx', 'dx80.vtx', 'sw.vtx', 'vtx', 'phy'];

/** Particle definitions that left4dead_dlc3's pak ALSO holds, with different
 *  content. See "Paths that base and dlc3 both hold" in the spec. */
const DLC3_OVERRIDDEN_PCFS = [
  'burning_fx', 'environment_fx', 'environmental_fx', 'fire_01', 'fire_01l4d', 'fire_infected_fx', 'water_fx', 'weapon_fx',
].map((f) => `particles/${f}.pcf`);

export const GROUPS: Group[] = [
  {
    n: 1, title: 'special infected models and materials', baseOnly: true,
    rules: [
      ...[...SI, 'smoker_tongue_attach'].map((m): Rule => ({ from: 'pak', file: `models/infected/${m}.mdl` })),
      // Both .vmt and .vtf: skins usually edit the material definition inside
      // pak01_dir.vpk and leave the stock texture alone.
      ...SI.map((m): Rule => ({ from: 'pak', dir: `materials/models/infected/${m}` })),
    ],
  },
  {
    n: 2, title: 'foliage and plants', baseOnly: true,
    rules: [
      { from: 'pak', dir: 'models/props_foliage', ext: ['mdl'] },
      { from: 'pak', dir: 'materials/models/props_foliage' },
      { from: 'pak', dir: 'models/props_plants', ext: ['mdl'] },
      { from: 'pak', dir: 'materials/models/props_plants' },
    ],
  },
  {
    n: 3, title: 'gunfire and the soundscripts', baseOnly: true,
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
    n: 4, title: 'special infected sounds', baseOnly: true,
    rules: [
      ...['hunter', 'smoker', 'boomer', 'tank'].map((m): Rule => ({ from: 'loose', tree: `sound/player/${m}` })),
      { from: 'loose', tree: 'sound/npc/witch' },
      { from: 'loose', tree: 'sound/player/footsteps/tank' },
      { from: 'loose', tree: 'sound/player/footsteps/witch' },
      { from: 'loose', file: 'scripts/game_sounds_infected_special.txt' },
    ],
  },
  {
    n: 5, title: 'bile, smoke and the SI particle definitions', baseOnly: true,
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
  {
    n: 6, title: 'common infected', baseOnly: true,
    rules: [
      { from: 'pak', dir: 'models/infected', ext: ['mdl'], match: /\/common_[^/]*\.mdl$/i },
      { from: 'pak', dir: 'materials/models/infected/common' },
      { from: 'loose', tree: 'sound/npc/infected' },
      { from: 'loose', tree: 'sound/player/footsteps/infected' },
      { from: 'loose', tree: 'sound/player/footsteps/boomer' },
      { from: 'loose', file: 'scripts/game_sounds_infected_common.txt' },
    ],
  },

  // Batch 2 (2026-09-21), groups 7 to 15. Anything unforced can be overridden
  // from a search path put first in gameinfo.txt, so these close what groups 1
  // to 5 left reachable around themselves. Opt-in with --batch2 until the
  // two-population client gate in the spec has been run.
  {
    n: 7, title: 'the Sacrifice tank',
    // Lives in left4dead_dlc3's pak, which groups 1 to 6 never read.
    rules: [
      { from: 'pak', file: 'models/infected/hulk_dlc3.mdl' },
      { from: 'pak', file: 'materials/models/infected/hulk/hulk_traincar_01.vmt' },
      { from: 'pak', file: 'materials/models/infected/hulk/hulk_traincar_01.vtf' },
      { from: 'pak', file: 'materials/models/infected/hulk/hulk_traincar_01_normal.vtf' },
    ],
  },
  {
    n: 8, title: 'textures the forced materials borrow from elsewhere',
    // A forced .vmt that names an unforced .vtf is only half forced: replace the
    // texture and the material is whatever the replacement says. The material
    // reference check below is what finds these; each is listed by hand so that
    // a new one is a decision and not a side effect.
    rules: [
      { from: 'pak', file: 'materials/effects/flat_normal.vtf' },          // hunter_01.vmt, hulk*.vmt $bumpmap
      { from: 'pak', file: 'materials/effects/burned.vtf' },               // hulk_01.vmt, hulk_traincar_01.vmt $detail
      { from: 'pak', file: 'materials/models/props/cs_office/plant01.vtf' },   // props_plants/plant01.vmt
      { from: 'pak', file: 'materials/models/props/cs_office/plant01_p.vtf' }, // props_plants/plant01_p.vmt
    ],
  },
  {
    n: 9, title: 'special infected mesh companions',
    rules: [{ from: 'companions', of: [1, 7], ext: MESH_EXT }],
  },
  {
    n: 10, title: 'the common infected parent material',
    // 65 common materials `include` this one file, so one edit re-skins every
    // common. The rest of group 6 stays out.
    rules: [{ from: 'pak', file: 'materials/models/infected/common/common_infected_shared.vmt' }],
  },
  {
    n: 11, title: 'every other particle definition and particle material',
    rules: [
      {
        from: 'pak', dir: 'particles', ext: ['pcf'],
        except: DLC3_OVERRIDDEN_PCFS.map((path) => ({ path, why: 'left4dead_dlc3 holds a different copy; group 16 forces these when asked' })),
      },
      // .vmt and .vtf only: the two loose files beside them
      // (grayscalegradient.tga and .txt) are source art the engine never opens.
      { from: 'pak', tree: 'materials/particle', ext: ['vmt', 'vtf'] },
      // What those materials borrow from outside materials/particle.
      ...['effects/blood_core', 'effects/muzzleflash2', 'effects/muzzleflash4', 'effects/muzzleflashx', 'effects/spark',
        'effects/yellowflare', 'cable/cablenormalmap'].map((t): Rule => ({ from: 'pak', file: `materials/${t}.vtf` })),
    ],
  },
  {
    n: 12, title: 'special infected footsteps',
    // Group 4 forces the tank's and the witch's. These two sets are what the
    // hunter, smoker and boomer walk on; loud-footstep packs replace them.
    rules: [
      { from: 'loose', tree: 'sound/player/footsteps/infected' },
      { from: 'loose', tree: 'sound/player/footsteps/boomer' },
    ],
  },
  {
    n: 13, title: 'detail sprites',
    // The cornfield and every patch of tall grass is one sprite sheet per map set.
    rules: ['detailsprites', 'detailsprites_overgrown', 'ruraldetailsprites']
      .flatMap((s): Rule[] => [{ from: 'pak', file: `materials/detail/${s}.vmt` }, { from: 'pak', file: `materials/detail/${s}.vtf` }]),
  },
  {
    n: 14, title: 'flashlight textures and the tank rock',
    rules: [
      { from: 'pak', file: 'materials/effects/flashlight001.vtf' },
      { from: 'pak', file: 'materials/effects/flashlight001_infected.vtf' },
      { from: 'pak', dir: 'models/props_debris', match: /\/concrete_chunk01a\.[^/]+$/i },
      { from: 'pak', file: 'materials/models/props_debris/concretedebris_chunk01.vmt' },
      { from: 'pak', file: 'materials/models/props_debris/concretedebris_chunk01.vtf' },
    ],
  },
  {
    n: 15, title: 'foliage mesh companions',
    // Large and lower value: an emptied .vvd is a rarer no-trees trick than an
    // emptied .mdl. Its own group so that --without 15 drops it.
    rules: [{ from: 'companions', of: [2], ext: MESH_EXT }],
  },

  // Not part of any batch; reached only with --groups.
  {
    n: 16, title: 'particle definitions the Sacrifice pak overrides', allowDualCopy: true,
    rules: DLC3_OVERRIDDEN_PCFS.map((file): Rule => ({ from: 'pak', file })),
  },
];

/** What a plain run writes to l4d_consistency.cfg, the file the servers and the
 *  campaign uploader read. Groups 7 to 15 were batch 2 and were promoted here on
 *  2026-09-23 after the owner's client gate. The next batch goes in BATCH2 the
 *  same way: generated beside this list, gated, then moved here. */
export const SHIPPED = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15];
export const COMMONS = [6];
export const BATCH2: number[] = [];

/** "1-5,7,9-10" as a sorted list of group numbers. */
export function parseGroupSpec(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`not a group number or range: ${part}`);
    const from = Number(m[1]), to = Number(m[2] ?? m[1]);
    if (to < from) throw new Error(`range runs backwards: ${part}`);
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function selectGroups(opts: { commons?: boolean; batch2?: boolean; groups?: string | null; without?: string | null }): number[] {
  const picked = opts.groups
    ? parseGroupSpec(opts.groups)
    : [...SHIPPED, ...(opts.commons ? COMMONS : []), ...(opts.batch2 ? BATCH2 : [])];
  const dropped = new Set(opts.without ? parseGroupSpec(opts.without) : []);
  const known = new Set(GROUPS.map((g) => g.n));
  for (const n of [...picked, ...dropped]) if (!known.has(n)) throw new Error(`there is no group ${n}`);
  return [...new Set(picked)].filter((n) => !dropped.has(n)).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// What players are ALLOWED to change, by the owner's ruling (2026-09-19): custom
// HUDs, custom crosshairs, and the infected-vision colour correction files, which
// may be edited or deleted outright. No rule may ever force one of these. It is
// checked against the finished list, so a broad rule added later (group 6, or a
// whole-directory rule) fails generation instead of disconnecting everyone who
// runs a HUD.
const NEVER_FORCE: { why: string; test: RegExp }[] = [
  { why: 'HUD and menu layout', test: /^resource\// },
  { why: 'HUD scripts', test: /^scripts\/(hudlayout\.res|hudanimations\.txt|hud_textures\.txt|mod_textures\.txt)$/ },
  { why: 'HUD scripts', test: /^scripts\/.*\.res$/ },
  { why: 'HUD and crosshair art', test: /^materials\/vgui\// },
  { why: 'crosshair art', test: /^materials\/(crosshairs?|sprites\/crosshair)/ },
  { why: 'infected vision colour correction', test: /^materials\/correction\/(ghost|infected)(\.pwl)?\.raw$/ },
];
export const NEVER_FORCE_PATTERNS = NEVER_FORCE.length;

/** Why a path may never be forced, or null when it may. */
export function neverForceReason(path: string): string | null {
  return NEVER_FORCE.find((n) => n.test.test(lower(path)))?.why ?? null;
}

/**
 * Listed paths that base and dlc3 both hold with different content, and are
 * forced anyway. Both of these have been on the live list since 2026-09-20 on
 * four servers, with stock clients connecting and playing: server and client
 * both resolve left4dead_dlc3 first, so both checksum the same copy.
 */
export const DUAL_COPY_WAIVED: Except[] = [
  { path: 'scripts/game_sounds_music.txt', why: 'on the live list since 2026-09-20 with stock clients connecting; both sides resolve the dlc3 copy' },
  { path: 'scripts/level_sounds_general.txt', why: 'on the live list since 2026-09-20 with stock clients connecting; both sides resolve the dlc3 copy' },
];

/** Stock textures a forced material names that are deliberately left unforced. */
export const REF_WAIVED: Except[] = [
  {
    path: 'materials/ads/ad01.vtf',
    why: 'only materials/particle/ctest.vmt names it, a developer test card that no particle definition uses, and it is a 340 KB billboard',
  },
];

/**
 * Every texture or material a .vmt names, as game-relative paths. Any value is
 * a candidate, whatever its key: the caller keeps the ones that exist in stock,
 * which is what tells `$detail "effects/burned"` from `$phongboost 30` without a
 * list of keys to fall out of date ($basetexture2, $envmapmask, $lightwarptexture
 * and the proxies' own texture parameters all work the same way). `include`, and
 * nothing else, names a material.
 */
export function vmtReferences(text: string): { key: string; path: string }[] {
  const out: { key: string; path: string }[] = [];
  let key: string | null = null;
  for (const raw of tokenizeKeyValues(text)) {
    if (raw === '{' || raw === '}') { key = null; continue; }
    if (key === null) {
      // A platform conditional (`[$X360]`) trails a value and is not a key.
      if (!/^\[.*\]$/.test(raw)) key = raw.toLowerCase();
      continue;
    }
    const k = key;
    key = null;
    const value = lower(raw).replace(/^\/+|\/+$/g, '');
    if (k === 'include') {
      const p = value.startsWith('materials/') ? value : `materials/${value}`;
      out.push({ key: k, path: p.endsWith('.vmt') ? p : `${p}.vmt` });
      continue;
    }
    // A texture name has a letter and no brackets, spaces or `$`, and is not a
    // cubemap placeholder or a render target. A bare word that survives this
    // (`$surfaceprop boulder`) is dropped by the caller, because no such texture exists.
    if (!/^[a-z0-9_\-./]*[a-z][a-z0-9_\-./]*$/.test(value)) continue;
    if (value === 'env_cubemap' || value.startsWith('_rt_')) continue;
    out.push({ key: k, path: `materials/${value.replace(/\.vtf$/, '')}.vtf` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GeneratedGroup {
  n: number;
  title: string;
  paths: string[];
  bytes: number;
  /** Paths this group selected that an earlier group had already listed. */
  alreadyListed: number;
}

export interface Generated {
  /** The file, line by line. */
  lines: string[];
  /** Selected groups, in order, including any that ended up empty. */
  groups: GeneratedGroup[];
  total: number;
  bytes: number;
  /** Anything here fails generation. */
  problems: string[];
  /** Printed on every run: exclusions, waivers, what could not be forced. */
  notes: string[];
  /** Per overlay directory: how many paths it ships and how many are listed. */
  overlays: { dir: string; shipped: number; hits: number }[];
}

export interface GenerateOptions {
  groups: Group[];
  select: number[];
  stock: SearchPaths;
  /** The base game directory (left4dead), for baseOnly groups and loose walks. */
  base: string;
  /** Search path directories that only SOME legitimate clients mount. */
  overlays: string[];
  dualCopyWaived?: Except[];
  refWaived?: Except[];
}

// Anything that is not a game asset the client could meaningfully differ on.
const SKIP_EXT = new Set(['cache', 'db', 'ds_store']);

const extOf = (p: string): string => p.slice(p.lastIndexOf('.') + 1).toLowerCase();
const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/')).toLowerCase();

function walkSorted(rootDir: string, rel: string, recurse: boolean): string[] {
  const abs = join(rootDir, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs).sort()) {
    const childRel = `${rel}/${name}`;
    if (statSync(join(rootDir, childRel)).isDirectory()) { if (recurse) out.push(...walkSorted(rootDir, childRel, true)); }
    else out.push(childRel);
  }
  return out;
}

export function generate(opts: GenerateOptions): Generated {
  const { stock, base } = opts;
  const problems: string[] = [];
  const notes: string[] = [];

  // Loose files resolve through the search paths in gameinfo order:
  // left4dead_dlc3 sits ahead of left4dead, and several soundscripts exist only there.
  const manifestScripts = (report: boolean): string[] => {
    const manifest = stock.looseFile('scripts/game_sounds_manifest.txt');
    if (!manifest) return [];
    const out: string[] = [];
    for (const m of readFileSync(manifest, 'utf8').matchAll(/^\s*"(?:precache|preload)_file"\s+"([^"]+)"/gm)) {
      if (stock.looseFile(m[1])) out.push(m[1]);
      else if (report) problems.push(`manifest names a script that does not exist: ${m[1]}`);
    }
    return out;
  };

  const pakCache = new Map<string, { paths: string[]; byLower: Map<string, string> }>();
  const pakView = (g: Group) => {
    const key = g.baseOnly ? 'base' : 'all';
    let v = pakCache.get(key);
    if (!v) {
      const paths = stock.pakPaths(g.baseOnly ? base : undefined);
      v = { paths, byLower: new Map(paths.map((p) => [p.toLowerCase(), p])) };
      pakCache.set(key, v);
    }
    return v;
  };
  const looseWalk = (g: Group, rel: string, recurse: boolean): string[] => {
    const out = walkSorted(base, rel, recurse);
    if (g.baseOnly) return out;
    const have = new Set(out.map(lower));
    for (const dir of stock.dirs) {
      if (dir === base) continue;
      for (const p of walkSorted(dir, rel, recurse)) if (!have.has(lower(p))) { have.add(lower(p)); out.push(p); }
    }
    return out;
  };

  // group number -> what that group selects in this run, whether or not it is on the list
  const selectedBy = new Map<number, string[]>();

  /** `report` is off for a group this run leaves out: what it would exclude or
   *  trip over is not this run's business. */
  const select = (g: Group, rule: Rule, report: boolean): string[] => {
    if (rule.from === 'manifest') return manifestScripts(report);
    if (rule.from === 'companions') {
      const pak = pakView(g);
      const models = rule.of.flatMap((n) => selectedBy.get(n) ?? []).filter((p) => extOf(p) === 'mdl');
      return models.flatMap((mdl) => rule.ext
        .map((ext) => pak.byLower.get(`${mdl.slice(0, -4)}.${ext}`.toLowerCase()))
        .filter((p): p is string => p !== undefined));
    }
    if ('file' in rule) {
      if (rule.from === 'pak') { const hit = pakView(g).byLower.get(rule.file.toLowerCase()); return hit ? [hit] : []; }
      return stock.looseFile(rule.file) ? [rule.file] : [];
    }
    let hits: string[];
    if ('tree' in rule) {
      const prefix = `${rule.tree.toLowerCase()}/`;
      hits = rule.from === 'pak' ? pakView(g).paths.filter((p) => p.toLowerCase().startsWith(prefix)) : looseWalk(g, rule.tree, true);
    } else {
      hits = rule.from === 'pak' ? pakView(g).paths.filter((p) => dirOf(p) === rule.dir.toLowerCase()) : looseWalk(g, rule.dir, false);
      if (rule.match) hits = hits.filter((p) => rule.match!.test(p));
    }
    if (rule.ext) hits = hits.filter((p) => rule.ext!.some((e) => p.toLowerCase().endsWith(`.${e}`)));
    for (const ex of rule.except ?? []) {
      const before = hits.length;
      hits = hits.filter((p) => lower(p) !== lower(ex.path));
      if (!report) continue;
      if (hits.length === before) problems.push(`group ${g.n}: an exception names a path its rule does not select: ${ex.path}`);
      else notes.push(`group ${g.n}: excluded ${ex.path}: ${ex.why}`);
    }
    return hits;
  };

  const wanted = new Set(opts.select);
  const seen = new Set<string>();
  const ownerOf = new Map<string, number>(); // lower-cased path -> the first group that selects it, on the list or not
  const lines: string[] = [
    '# GENERATED by scripts/gen-consistency-list.ts. Do not edit by hand; change the rules and re-run.',
    '# One game-relative path per line. "# group N: title" starts a group; the plugin reports per group.',
    '',
  ];
  const groups: GeneratedGroup[] = [];
  const allowDualCopy = new Set<string>();

  // The groups on the list first, in order, so that a companions rule follows
  // exactly the models this run forces. The rest are evaluated afterwards and
  // only so that the reference check can say "group 8 forces that".
  for (const g of [...opts.groups.filter((x) => wanted.has(x.n)), ...opts.groups.filter((x) => !wanted.has(x.n))]) {
    const onList = wanted.has(g.n);
    const selected: string[] = [];
    const paths: string[] = [];
    let alreadyListed = 0;
    for (const rule of g.rules) {
      const hits = select(g, rule, onList).filter((p) => !SKIP_EXT.has(extOf(p)));
      if (hits.length === 0 && onList) {
        // A rule that matches nothing is a typo or a game update, never something to skip quietly.
        problems.push(`group ${g.n}: rule matched NOTHING: ${JSON.stringify(rule, (_k, v) => (v instanceof RegExp ? String(v) : v))}`);
      }
      for (const p of hits) {
        selected.push(p);
        if (!ownerOf.has(lower(p))) ownerOf.set(lower(p), g.n);
        if (!onList) continue;
        if (seen.has(lower(p))) { alreadyListed++; continue; }
        seen.add(lower(p));
        paths.push(p);
        if (g.allowDualCopy) allowDualCopy.add(lower(p));
      }
    }
    selectedBy.set(g.n, selected);
    if (!onList) continue;
    const bytes = paths.reduce((n, p) => n + (stock.resolve(p)?.size ?? 0), 0);
    groups.push({ n: g.n, title: g.title, paths, bytes, alreadyListed });
    // A group whose every path an earlier group listed gets no header: the
    // plugin would report it as "forced 0 of 0".
    if (paths.length > 0) lines.push(`# group ${g.n}: ${g.title}`, ...paths, '');
  }

  const listed = groups.flatMap((g) => g.paths);

  // 1. Never force what players are allowed to change.
  for (const p of listed) {
    const why = neverForceReason(p);
    if (why) problems.push(`listed path is on the never-force list (${why}): ${p}`);
  }

  // 2. Never force what an overlay also ships.
  const overlays = opts.overlays.map((dir) => ({ dir, shipped: overlayPaths(dir) }));
  const overlayReport = overlays.map(({ dir, shipped }) => {
    const hits = listed.filter((p) => shipped.has(lower(p)));
    for (const h of hits) problems.push(`overlay ${dir} also ships a listed path: ${lower(h)}`);
    return { dir, shipped: shipped.size, hits: hits.length };
  });

  // 3. The engine will not force a path the server does not have, and a path
  //    that base and dlc3 both hold with different content is forced only on purpose.
  const dualWaived = new Map((opts.dualCopyWaived ?? []).map((w) => [lower(w.path), w.why]));
  for (const p of listed) {
    const copies = stock.copies(p);
    if (copies.length === 0) { problems.push(`listed path is not in the stock install: ${p}`); continue; }
    if (copies.length < 2 || new Set(copies.map((c) => c.crc())).size < 2) continue;
    const where = copies.map((c) => `${c.root} ${c.kind}`).join(', ');
    const why = dualWaived.get(lower(p));
    if (why) notes.push(`dual copy, waived: ${p} (${where}): ${why}`);
    else if (allowDualCopy.has(lower(p))) notes.push(`dual copy, forced on purpose by its group: ${p} (${where})`);
    else problems.push(`${p} exists with DIFFERENT content in ${where}; exclude it with a reason or waive it`);
  }

  // 4. A forced material is only as forced as the textures it names.
  const listedLower = new Set(listed.map(lower));
  const refWaived = new Map((opts.refWaived ?? []).map((w) => [lower(w.path), w.why]));
  const unforced = new Map<string, { by: string; key: string }[]>();
  for (const p of listed) {
    if (extOf(p) !== 'vmt') continue;
    const copy = stock.resolve(p);
    if (!copy) continue;
    for (const ref of vmtReferences(copy.read().toString('latin1'))) {
      if (listedLower.has(ref.path) || !stock.resolve(ref.path)) continue;
      unforced.set(ref.path, [...(unforced.get(ref.path) ?? []), { by: p, key: ref.key }]);
    }
  }
  for (const [ref, users] of [...unforced].sort(([a], [b]) => a.localeCompare(b))) {
    const who = `${users.length} forced material${users.length === 1 ? '' : 's'} (${users[0].by}, ${users[0].key})`;
    const never = neverForceReason(ref);
    const overlay = overlays.find((o) => o.shipped.has(ref));
    const owner = ownerOf.get(ref);
    if (never) notes.push(`unforced reference: ${ref}, named by ${who}: on the never-force list (${never})`);
    else if (overlay) notes.push(`unforced reference: ${ref}, named by ${who}: overlay ${overlay.dir} also ships it`);
    else if (refWaived.has(ref)) notes.push(`unforced reference: ${ref}, named by ${who}: waived, ${refWaived.get(ref)}`);
    else if (owner !== undefined && !wanted.has(owner)) notes.push(`unforced reference: ${ref}, named by ${who}: forced by group ${owner}, which this run leaves out`);
    else problems.push(`${ref} is referenced by ${who} and is neither forced nor waived`);
  }

  return {
    lines, groups, total: listed.length, bytes: groups.reduce((n, g) => n + g.bytes, 0), problems, notes, overlays: overlayReport,
  };
}
