import { describe, it, expect, afterEach } from 'vitest';
import { buildHud, type BuildAssets } from './build';
import { validateDesign, type HudDesign } from './design';
import { registerImport, unregisterImport, isCommunityImport } from './base';
import { SLOTS } from './slots';
import { SPLATTERS } from './splatter';
import { sampleHud, latin1 } from './importFixtures';
import { TEX } from '../crosshair/draw';
import { hudFileProblem, hudPathProblem, shareableHudFiles } from '../../../src/hudFiles';

/** Each registration gets an id of its own: the base caches keep what they read for an id for ever. */
let minted = 0;
const used: string[] = [];
const freshId = () => { const id = `c${(++minted).toString(16).padStart(63, '0')}`; used.push(id); return id; };
afterEach(() => { for (const id of used.splice(0)) unregisterImport(id); });

/** A 1x1 PNG as the design stores it (bare base64): the design only needs an image to exist, the pixels come from BuildAssets. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Uploaded pictures beyond the style slots: splatters, a gun and an item picture, the microphone. */
const EXTRA_IMAGES: Record<string, { w: number; h: number }> = {
  ...Object.fromEntries(SPLATTERS.map((s) => [s.id, s.size])),
  wiconMachinegun: { w: 192, h: 64 },
  wiconPills: { w: 64, h: 64 },
  voiceSelf: { w: 64, h: 64 },
};
const ALL_IMAGES: Record<string, { w: number; h: number }> = {
  ...Object.fromEntries(SLOTS.map((s) => [s.id, s.size])),
  ...EXTRA_IMAGES,
};

/** Everything the editor can write, switched on. */
function everything(base: Record<string, unknown>, imported: boolean): HudDesign {
  return validateDesign({
    v: 1, name: 'all_on', crosshair: 'bundle', xhairArt: { kind: 'built', state: {} },
    ...(imported ? {} : { font: 'roboto' }),
    elements: {
      teamColumn: { fit: true },
      chat: { x: 134, y: 320, fontSize: 12, bg: '0 0 0 120' },
      killNotices: { color: '255 200 0 255', fontSize: 12, noticeBox: { kind: 'flat', color: '0 0 0 150' } },
      spawnCountdown: { color: '255 0 0 255', fontSize: 14 },
      vote: { bg: '10 10 10 200' },
      progressBar: { scale: 1.2 },
    },
    styles: Object.fromEntries(SLOTS.map((s) => [s.id, { kind: 'image' }])),
    images: Object.fromEntries(Object.entries(ALL_IMAGES).map(([id, sz]) => [id, { ...sz, png: PNG }])),
    children: { teamColumn: { Name: { fontSize: 14, x: 10 } } },
    weapons: {
      boxActive: { kind: 'rounded', color: '10 20 30 200' },
      boxInactive: { kind: 'flat', color: '0 0 0 100' },
      clipFont: 30,
      icons: { icon_equip_machinegun: 'wiconMachinegun', icon_equip_pills: 'wiconPills' },
    },
    splatters: Object.fromEntries(SPLATTERS.map((s) => [s.id, { kind: 'image' }])),
    pickupFlyIn: false,
    ...base,
  });
}

const ASSETS: BuildAssets = {
  fonts: { regular: new Uint8Array([0, 1, 0, 0, 9]), bold: new Uint8Array([0, 1, 0, 0, 8]) },
  images: Object.fromEntries(Object.entries(ALL_IMAGES).map(([id, sz]) => [id, new Uint8ClampedArray(sz.w * sz.h * 4).fill(200)])),
  crosshair: new Uint8ClampedArray(TEX * TEX * 4).fill(255),
};

describe('every path buildHud can generate is on the community allowlist (src/hudFiles.ts)', () => {
  const cases: [string, () => HudDesign][] = [
    ['stock', () => everything({ preset: 'stock' }, false)],
    ['modern', () => everything({ preset: 'modern' }, false)],
    ['advanced stock', () => everything({ preset: 'stock', advanced: true }, false)],
    ['advanced modern', () => everything({ preset: 'modern', advanced: true }, false)],
    ['an imported HUD', () => {
      const id = freshId();
      // The shareable part of the fixture: what a community import can hold.
      registerImport(id, shareableHudFiles(sampleHud()).kept, { community: true });
      return everything({ preset: 'imported', imported: { id, name: 'edgehud' } }, true);
    }],
  ];
  for (const [name, design] of cases) {
    it(`${name}: a newly generated path outside the list fails here`, () => {
      const d = design();
      const paths = buildHud(d, ASSETS).map((f) => f.path);
      // The switches really are on: fonts (not on an import), style art, weapon boxes, the crosshair.
      if (d.preset !== 'imported') expect(paths).toContain('resource/robotocondensed-regular.ttf');
      expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vtf');
      expect(paths).toContain('materials/vgui/hud/altcrosshair.vtf');
      expect(paths.some((p) => p.startsWith('materials/vgui/hud/hudeditor/weapon'))).toBe(true);
      if (d.advanced) expect(paths).toContain('materials/vgui/s_panel_dead.vtf');
      // The editor's later passes: splatter art, the microphone, weapon pictures, the fly-in edit.
      expect(paths).toContain('materials/vgui/hud/hudeditor/splatteam.vtf');
      expect(paths).toContain('materials/vgui/hud/hudeditor/voice_self.vtf');
      expect(paths).toContain('scripts/mod_textures.txt');
      expect(paths).toContain('scripts/hudanimations.txt');
      if (d.preset === 'stock') expect(paths).toContain('resource/ui/spectatorinfected.res');
      // addoninfo.txt is the editor's own, allowed at build only.
      const outside = paths.filter((p) => p !== 'addoninfo.txt' && hudPathProblem(p) !== null);
      expect(outside).toEqual([]);
    });
    it(`${name}: every generated text file passes the content check`, () => {
      // Binary stand-ins (the test fonts and textures) are not real files; the
      // text the editor writes (hudanimations.txt's fly-in edit, chatscheme.res,
      // mod_textures.txt, the panels) is exactly what ships.
      const files = buildHud(design(), ASSETS).filter((f) => /\.(res|txt)$/.test(f.path) && f.path !== 'addoninfo.txt');
      expect(files.length).toBeGreaterThan(0);
      const problems = files.map((f) => hudFileProblem(f.path, f.data)).filter((p) => p !== null);
      expect(problems).toEqual([]);
    });
  }
});

describe('a community import at build', () => {
  const withCfg = () => {
    const files = shareableHudFiles(sampleHud()).kept;
    files.set('cfg/autoexec.cfg', latin1('bind w kill'));
    return files;
  };
  const designOn = (id: string) => validateDesign({ v: 1, name: 'x', preset: 'imported', imported: { id, name: 'x' }, crosshair: 'none' });

  it('throws rather than ship a file outside the HUD folders', () => {
    const id = freshId();
    registerImport(id, withCfg(), { community: true });
    expect(() => buildHud(designOn(id))).toThrow('This community HUD would ship a file outside the HUD folders: cfg/autoexec.cfg');
  });

  it('throws rather than ship a file its own rewrite turned into a command', () => {
    // The check and the game read `//` after `[$WIN32` as a comment; the
    // builder's KeyValues reader takes a conditional to its `]`, and writing
    // the file back after an edit would make the commented-out keys live.
    const id = freshId();
    const files = shareableHudFiles(sampleHud()).kept;
    const layout = new TextDecoder('latin1').decode(files.get('scripts/hudlayout.res')!);
    const at = layout.indexOf('{', layout.indexOf('HudWeaponSelection')) + 1;
    const hidden = `${layout.slice(0, at)}\r\n\t\t"labelText" "a" [$WIN32 //] "command" "engine bind mouse1 quit"${layout.slice(at)}`;
    files.set('scripts/hudlayout.res', latin1(hidden));
    expect(hudFileProblem('scripts/hudlayout.res', files.get('scripts/hudlayout.res')!)).toBeNull();
    registerImport(id, files, { community: true });
    const moved = validateDesign({
      v: 1, name: 'x', preset: 'imported', imported: { id, name: 'x' }, crosshair: 'none',
      elements: { weaponSelection: { x: 400, y: 300 } },
    });
    expect(() => buildHud(moved)).toThrow(/This community HUD would ship a file that is not allowed: scripts\/hudlayout\.res/);
  });

  it("community build always writes the editor's addoninfo", () => {
    // An addoninfo.txt can reach a community layer only through a stale
    // store or a bug; the build still ships the editor's own, not that one.
    const id = freshId();
    const files = shareableHudFiles(sampleHud()).kept;
    files.set('addoninfo.txt', latin1('"AddonInfo" { "addontitle" "not the editor" "addonContent_Script" "1" }'));
    registerImport(id, files, { community: true });
    const got = new Map(buildHud(designOn(id)).map((f) => [f.path, f.data]));
    const plain = new Map(buildHud(validateDesign({ v: 1, name: 'x', preset: 'stock', crosshair: 'none' })).map((f) => [f.path, f.data]));
    expect(got.get('addoninfo.txt')).toEqual(plain.get('addoninfo.txt'));
  });

  it("passes a private import's own files through, as the import spec promised", () => {
    const id = freshId();
    const files = withCfg();
    registerImport(id, files);
    const out = new Map(buildHud(designOn(id)).map((f) => [f.path, f.data]));
    expect(out.get('cfg/autoexec.cfg')).toEqual(files.get('cfg/autoexec.cfg'));
  });
});

describe('isCommunityImport', () => {
  it('reports the flag, keeps it through a later plain register, and loses it on unregister', () => {
    const id = freshId();
    const files = sampleHud();
    registerImport(id, files);
    expect(isCommunityImport(`imported:${id}`)).toBe(false);
    registerImport(id, files, { community: true });
    expect(isCommunityImport(`imported:${id}`)).toBe(true);
    registerImport(id, files);
    expect(isCommunityImport(`imported:${id}`)).toBe(true);
    unregisterImport(id);
    expect(isCommunityImport(`imported:${id}`)).toBe(false);
  });

  it('is false for the built-in bases', () => {
    expect(isCommunityImport('stock')).toBe(false);
    expect(isCommunityImport('modern')).toBe(false);
  });
});
