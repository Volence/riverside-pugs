import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { makeVpkMulti } from './fixtures/makeVpk.js';
import {
  BATCH2, GROUPS, SHIPPED, SearchPaths, generate, neverForceReason, overlayPaths, parseGroupSpec, selectGroups,
  vmtReferences, type Group,
} from '../src/consistencyGen.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'consistency-gen-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

type PakFile = [path: string, body: string];
const pak = (searchPath: string, files: PakFile[]): void => {
  mkdirSync(join(root, searchPath), { recursive: true });
  makeVpkMulti(join(root, searchPath, 'pak01_dir.vpk'), files.map(([path, body], i) => {
    const slash = path.lastIndexOf('/'), dot = path.lastIndexOf('.');
    // Alternate inline and archived bodies: the real pak01 is nearly all archived.
    return { dir: path.slice(0, slash), name: path.slice(slash + 1, dot), ext: path.slice(dot + 1), body, archiveIndex: i % 2 ? 1 : undefined };
  }));
};
const loose = (searchPath: string, path: string, body: string): void => {
  mkdirSync(dirname(join(root, searchPath, path)), { recursive: true });
  writeFileSync(join(root, searchPath, path), body);
};
const stock = (): SearchPaths => new SearchPaths([join(root, 'left4dead_dlc3'), join(root, 'left4dead')]);
const run = (groups: Group[], select: number[], extra: Partial<Parameters<typeof generate>[0]> = {}) =>
  generate({ groups, select, stock: stock(), base: join(root, 'left4dead'), overlays: [], ...extra });

describe('vmtReferences', () => {
  it('finds textures under any key, quoted or bare, with either slash', () => {
    const refs = vmtReferences([
      'vertexlitgeneric', '{',
      '$baseTexture "models\\infected\\hunter/hunter_01"',
      '$bumpmap effects/flat_normal',
      '$detail "models/infected/hunter/hunter_01_detail.vtf"',
      '$phongexponenttexture "models/infected/hunter/hunter_exp"',
      '$phongboost 30', '$phongtint "[.4 .8 1]"',
      '}',
    ].join('\n'));
    expect(refs).toEqual([
      { key: '$basetexture', path: 'materials/models/infected/hunter/hunter_01.vtf' },
      { key: '$bumpmap', path: 'materials/effects/flat_normal.vtf' },
      { key: '$detail', path: 'materials/models/infected/hunter/hunter_01_detail.vtf' },
      { key: '$phongexponenttexture', path: 'materials/models/infected/hunter/hunter_exp.vtf' },
    ]);
  });

  it('reads an include as a material, and looks inside a patch block', () => {
    const refs = vmtReferences('patch { include "materials/models/infected/common/common_infected_shared.vmt"\n insert { $basetexture "models/infected/common/c_01" } }');
    expect(refs).toEqual([
      { key: 'include', path: 'materials/models/infected/common/common_infected_shared.vmt' },
      { key: '$basetexture', path: 'materials/models/infected/common/c_01.vtf' },
    ]);
  });

  it('ignores comments, numbers, vectors, cubemaps and render targets', () => {
    expect(vmtReferences('a { // $basetexture "x/y"\n $envmap env_cubemap\n $basetexture _rt_FullFrameFB\n $alpha 0.5\n $color "[1 1 1]" }')).toEqual([]);
  });
});

describe('group selection', () => {
  it('parses numbers and ranges', () => {
    expect(parseGroupSpec('1-5,7, 9-10')).toEqual([1, 2, 3, 4, 5, 7, 9, 10]);
    expect(() => parseGroupSpec('1-x')).toThrow();
    expect(() => parseGroupSpec('5-1')).toThrow();
  });

  it('ships the shipped groups unless told otherwise', () => {
    expect(SHIPPED).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(selectGroups({})).toEqual(SHIPPED);
    expect(selectGroups({ commons: true })).toEqual([...SHIPPED, 6].sort((a, b) => a - b));
    expect(selectGroups({ batch2: true })).toEqual([...SHIPPED, ...BATCH2]);
    expect(selectGroups({ without: '15' })).toEqual(SHIPPED.filter((n) => n !== 15));
    expect(selectGroups({ groups: '1,16' })).toEqual([1, 16]);
  });

  it('refuses a group that does not exist', () => {
    expect(() => selectGroups({ groups: '1,99' })).toThrow(/99/);
  });

  // l4d_consistency.sp has MAX_GROUPS 16: a 17th header is ignored and its
  // paths are reported under the 16th group's name.
  it('never defines more groups than the plugin can report', () => {
    expect(GROUPS.length).toBeLessThanOrEqual(16);
    expect(GROUPS.map((g) => g.n)).toEqual(GROUPS.map((_, i) => i + 1));
  });
});

describe('the rules as written', () => {
  const byN = new Map(GROUPS.map((g) => [g.n, g]));

  // Groups 1 to 5 are live as generated from the base pak alone. If one of them
  // starts reading the dlc3 pak, the shipped list changes under players.
  it('keeps every group written before batch 2 on the base pak', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) expect(byN.get(n)!.baseOnly, `group ${n}`).toBe(true);
    for (const n of [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) expect(byN.get(n)!.baseOnly, `group ${n}`).toBeUndefined();
  });

  it('forces the particle definitions dlc3 overrides only from group 16, which no batch includes', () => {
    const pcfRule = byN.get(11)!.rules.find((r) => 'dir' in r && r.dir === 'particles');
    const excepted = (pcfRule && 'except' in pcfRule ? pcfRule.except ?? [] : []).map((e) => e.path).sort();
    const forced = byN.get(16)!.rules.map((r) => ('file' in r ? r.file : '')).sort();
    expect(excepted).toHaveLength(8);
    expect(forced).toEqual(excepted);
    expect(byN.get(16)!.allowDualCopy).toBe(true);
    expect([...SHIPPED, 6, ...BATCH2]).not.toContain(16);
  });

  it('never names a manifest, gameinfo or a weapon script in a file rule', () => {
    const files = GROUPS.flatMap((g) => g.rules).flatMap((r) => ('file' in r ? [r.file] : []));
    expect(files.filter((f) => /manifest|gameinfo|propdata|scripts\/weapon_/.test(f))).toEqual([]);
  });
});

describe('neverForceReason', () => {
  it('names what the owner allows players to change', () => {
    for (const p of [
      'resource/ui/hudlayout.res', 'scripts/hudlayout.res', 'scripts/hudanimations.txt', 'scripts/hud_textures.txt',
      'scripts/mod_textures.txt', 'materials/vgui/white.vmt', 'materials/crosshairs/x.vtf', 'materials/sprites/crosshair1.vmt',
      'materials/correction/ghost.raw', 'materials/correction/ghost.pwl.raw', 'materials/correction/infected.raw',
      'materials/correction/infected.pwl.raw',
    ]) expect(neverForceReason(p), p).not.toBeNull();
  });

  it('is case-blind, as the engine file system is', () => {
    expect(neverForceReason('Materials/VGUI/hud/icon.vtf')).not.toBeNull();
  });

  it('lets game assets through', () => {
    for (const p of ['materials/particle/warp_ripple3.vmt', 'scripts/soundmixers.txt', 'materials/correction/farm_main.raw']) {
      expect(neverForceReason(p), p).toBeNull();
    }
  });
});

describe('SearchPaths', () => {
  it('resolves dlc3 ahead of base, archive ahead of loose, whatever the case', () => {
    pak('left4dead', [['particles/fire_01.pcf', 'base'], ['materials/effects/burned.vtf', 'tex']]);
    pak('left4dead_dlc3', [['particles/fire_01.pcf', 'sacrifice'], ['models/infected/hulk_dlc3.mdl', 'mdl']]);
    loose('left4dead', 'scripts/soundmixers.txt', 'mix');
    loose('left4dead', 'particles/fire_01.pcf', 'loose');
    const s = stock();

    expect(s.resolve('Particles/FIRE_01.pcf')!.read().toString()).toBe('sacrifice');
    expect(s.copies('particles/fire_01.pcf').map((c) => [c.root, c.kind])).toEqual([
      ['left4dead_dlc3', 'pak'], ['left4dead', 'pak'], ['left4dead', 'loose'],
    ]);
    expect(s.resolve('models/infected/hulk_dlc3.mdl')!.root).toBe('left4dead_dlc3');
    expect(s.resolve('scripts/soundmixers.txt')!.crc()).toBe(crc32(Buffer.from('mix')));
    expect(s.resolve('materials/effects/burned.vtf')!.size).toBe(3);
    expect(s.resolve('nope/nothing.txt')).toBeNull();
  });
});

describe('overlayPaths', () => {
  it('holds what the overlay ships loose and in its pak, lower-cased', () => {
    pak('left4dead_dlc4', [['Particles/particles_manifest.txt', 'x']]);
    loose('left4dead_dlc4', 'scripts/Game_Sounds_Manifest.txt', 'x');
    expect([...overlayPaths(join(root, 'left4dead_dlc4'))].sort()).toEqual([
      'particles/particles_manifest.txt', 'scripts/game_sounds_manifest.txt',
    ]);
  });
});

describe('generate', () => {
  it('keeps a shipped group to the base pak, and lets a later group reach the dlc3 pak', () => {
    pak('left4dead', [['models/infected/hulk.mdl', 'a'], ['materials/models/infected/hulk/hulk_01.vtf', 'b']]);
    pak('left4dead_dlc3', [['models/infected/hulk_dlc3.mdl', 'c'], ['materials/models/infected/hulk/hulk_traincar_01.vtf', 'd']]);
    const groups: Group[] = [
      { n: 1, title: 'tank', baseOnly: true, rules: [{ from: 'pak', dir: 'materials/models/infected/hulk' }, { from: 'pak', file: 'models/infected/hulk.mdl' }] },
      { n: 2, title: 'sacrifice tank', rules: [{ from: 'pak', dir: 'materials/models/infected/hulk' }, { from: 'pak', file: 'models/infected/hulk_dlc3.mdl' }] },
    ];
    const out = run(groups, [1, 2]);
    expect(out.problems).toEqual([]);
    expect(out.groups.map((g) => g.paths)).toEqual([
      ['materials/models/infected/hulk/hulk_01.vtf', 'models/infected/hulk.mdl'],
      ['materials/models/infected/hulk/hulk_traincar_01.vtf', 'models/infected/hulk_dlc3.mdl'],
    ]);
    expect(out.groups[0].bytes).toBe(2);
    expect(out.lines.filter((l) => l.startsWith('# group'))).toEqual(['# group 1: tank', '# group 2: sacrifice tank']);
  });

  it('fails on a rule that matches nothing', () => {
    pak('left4dead', [['models/infected/hulk.mdl', 'a']]);
    const out = run([{ n: 1, title: 't', rules: [{ from: 'pak', file: 'models/infected/hunter.mdl' }] }], [1]);
    expect(out.problems.join('\n')).toMatch(/matched NOTHING/);
  });

  it('selects mesh companions of the models the selected groups force, and only those', () => {
    pak('left4dead', [
      ['models/infected/hunter.mdl', 'm'], ['models/infected/hunter.vvd', 'v'], ['models/infected/hunter.dx90.vtx', 'x'],
      ['models/infected/hunter.phy', 'p'], ['models/infected/hunter.ani', 'not asked for'],
      ['models/infected/common_male01.mdl', 'm'], ['models/infected/common_male01.vvd', 'v'],
      ['models/props_foliage/tree.mdl', 'm'], ['models/props_foliage/tree.vvd', 'v'],
    ]);
    const groups: Group[] = [
      { n: 1, title: 'si', rules: [{ from: 'pak', file: 'models/infected/hunter.mdl' }] },
      { n: 2, title: 'trees', rules: [{ from: 'pak', file: 'models/props_foliage/tree.mdl' }] },
      { n: 3, title: 'si meshes', rules: [{ from: 'companions', of: [1, 2], ext: ['vvd', 'dx90.vtx', 'dx80.vtx', 'phy'] }] },
    ];
    expect(run(groups, [1, 3]).groups[1].paths).toEqual([
      'models/infected/hunter.vvd', 'models/infected/hunter.dx90.vtx', 'models/infected/hunter.phy',
    ]);
  });

  it('drops an excepted path and says so; an exception that matches nothing is a problem', () => {
    pak('left4dead', [['particles/fire_fx.pcf', 'a'], ['particles/weapon_fx.pcf', 'b']]);
    const rule = (path: string): Group[] => [{
      n: 1, title: 'pcf', rules: [{ from: 'pak', dir: 'particles', ext: ['pcf'], except: [{ path, why: 'the Sacrifice pak overrides it' }] }],
    }];
    const out = run(rule('particles/weapon_fx.pcf'), [1]);
    expect(out.groups[0].paths).toEqual(['particles/fire_fx.pcf']);
    expect(out.notes.join('\n')).toMatch(/excluded particles\/weapon_fx\.pcf: the Sacrifice pak overrides it/);
    expect(out.problems).toEqual([]);
    expect(run(rule('particles/gone.pcf'), [1]).problems.join('\n')).toMatch(/gone\.pcf/);
  });

  it('fails on a path base and dlc3 both hold with different content, unless waived', () => {
    pak('left4dead', [['particles/fire_01.pcf', 'base'], ['particles/same.pcf', 'same']]);
    pak('left4dead_dlc3', [['particles/fire_01.pcf', 'sacrifice'], ['particles/same.pcf', 'same']]);
    const groups: Group[] = [{ n: 1, title: 'pcf', rules: [{ from: 'pak', dir: 'particles' }] }];
    const out = run(groups, [1]);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toMatch(/particles\/fire_01\.pcf.*left4dead_dlc3.*left4dead/);
    const waived = run(groups, [1], { dualCopyWaived: [{ path: 'particles/fire_01.pcf', why: 'proven live' }] });
    expect(waived.problems).toEqual([]);
    expect(waived.notes.join('\n')).toMatch(/proven live/);
  });

  it('fails on a path an overlay also ships', () => {
    pak('left4dead', [['particles/particles_manifest.txt', 'a']]);
    loose('left4dead_dlc4', 'particles/particles_manifest.txt', 'b');
    const out = run([{ n: 1, title: 'm', rules: [{ from: 'pak', file: 'particles/particles_manifest.txt' }] }], [1],
      { overlays: [join(root, 'left4dead_dlc4')] });
    expect(out.problems.join('\n')).toMatch(/also ships a listed path: particles\/particles_manifest\.txt/);
  });

  it('fails on a never-force path however it got onto the list', () => {
    pak('left4dead', [['materials/vgui/white.vmt', 'a']]);
    const out = run([{ n: 1, title: 'hud', rules: [{ from: 'pak', dir: 'materials/vgui' }] }], [1]);
    expect(out.problems.join('\n')).toMatch(/never-force list \(HUD and crosshair art\): materials\/vgui\/white\.vmt/);
  });

  describe('the material reference check', () => {
    const HUNTER = '$basetexture "models/infected/hunter/hunter_01"\n$bumpmap "effects/flat_normal"\n$envmap "vgui/white"\n$detail "not/in/stock"';
    const files: PakFile[] = [
      ['materials/models/infected/hunter/hunter_01.vmt', `vertexlitgeneric { ${HUNTER} }`],
      ['materials/models/infected/hunter/hunter_01.vtf', 't'],
      ['materials/effects/flat_normal.vtf', 'n'],
      ['materials/vgui/white.vtf', 'w'],
    ];
    const hunter: Group = { n: 1, title: 'hunter', rules: [{ from: 'pak', dir: 'materials/models/infected/hunter' }] };

    it('fails when a forced vmt points at a stock texture nothing forces', () => {
      pak('left4dead', files);
      const out = run([hunter], [1]);
      expect(out.problems).toEqual([
        'materials/effects/flat_normal.vtf is referenced by 1 forced material (materials/models/infected/hunter/hunter_01.vmt, $bumpmap) '
        + 'and is neither forced nor waived',
      ]);
      // vgui/white cannot be forced, by the owner's ruling, so it is a note and never a failure.
      expect(out.notes.join('\n')).toMatch(/materials\/vgui\/white\.vtf.*never-force/);
    });

    it('passes once the texture is forced', () => {
      pak('left4dead', files);
      const shared: Group = { n: 2, title: 'shared', rules: [{ from: 'pak', file: 'materials/effects/flat_normal.vtf' }] };
      expect(run([hunter, shared], [1, 2]).problems).toEqual([]);
    });

    it('notes, without failing, a texture that a group left out of this run forces', () => {
      pak('left4dead', files);
      const shared: Group = { n: 2, title: 'shared', rules: [{ from: 'pak', file: 'materials/effects/flat_normal.vtf' }] };
      const out = run([hunter, shared], [1]);
      expect(out.problems).toEqual([]);
      expect(out.notes.join('\n')).toMatch(/materials\/effects\/flat_normal\.vtf.*group 2, which this run leaves out/);
    });

    it('passes on a waiver and repeats the reason', () => {
      pak('left4dead', files);
      const out = run([hunter], [1], { refWaived: [{ path: 'materials/effects/flat_normal.vtf', why: 'a test says so' }] });
      expect(out.problems).toEqual([]);
      expect(out.notes.join('\n')).toMatch(/a test says so/);
    });

    it('follows an include into a material held by the dlc3 pak', () => {
      pak('left4dead', [['materials/models/infected/common/c.vmt', 'patch { include "materials/models/infected/common/shared.vmt" }']]);
      pak('left4dead_dlc3', [['materials/models/infected/common/shared.vmt', 'vertexlitgeneric {}']]);
      const out = run([{ n: 1, title: 'c', rules: [{ from: 'pak', file: 'materials/models/infected/common/c.vmt' }] }], [1]);
      expect(out.problems.join('\n')).toMatch(/materials\/models\/infected\/common\/shared\.vmt is referenced by 1 forced material/);
    });
  });

  it('leaves out a group whose paths an earlier group already listed', () => {
    pak('left4dead', [['materials/models/infected/common/shared.vmt', 'vertexlitgeneric {}']]);
    const groups: Group[] = [
      { n: 1, title: 'commons', rules: [{ from: 'pak', dir: 'materials/models/infected/common' }] },
      { n: 2, title: 'the parent', rules: [{ from: 'pak', file: 'materials/models/infected/common/shared.vmt' }] },
    ];
    const out = run(groups, [1, 2]);
    expect(out.problems).toEqual([]);
    expect(out.lines.filter((l) => l.startsWith('# group'))).toEqual(['# group 1: commons']);
    expect(out.groups[1]).toMatchObject({ n: 2, paths: [], alreadyListed: 1 });
  });
});
