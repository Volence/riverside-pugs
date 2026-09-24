import { describe, it, expect, afterEach } from 'vitest';
import { buildHud, type BuildAssets } from './build';
import { validateDesign, type HudDesign } from './design';
import { registerImport, unregisterImport, isCommunityImport } from './base';
import { SLOTS } from './slots';
import { sampleHud, latin1 } from './importFixtures';
import { TEX } from '../crosshair/draw';
import { hudPathProblem, shareableHudFiles } from '../../../src/hudFiles';

/** Each registration gets an id of its own: the base caches keep what they read for an id for ever. */
let minted = 0;
const used: string[] = [];
const freshId = () => { const id = `c${(++minted).toString(16).padStart(63, '0')}`; used.push(id); return id; };
afterEach(() => { for (const id of used.splice(0)) unregisterImport(id); });

/** A 1x1 PNG as the design stores it (bare base64): the design only needs an image to exist, the pixels come from BuildAssets. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Everything the editor can write, switched on. */
function everything(base: Record<string, unknown>, imported: boolean): HudDesign {
  return validateDesign({
    v: 1, name: 'all_on', crosshair: 'bundle', xhairArt: { kind: 'built', state: {} },
    ...(imported ? {} : { font: 'roboto' }),
    elements: { teamColumn: { fit: true } },
    styles: Object.fromEntries(SLOTS.map((s) => [s.id, { kind: 'image' }])),
    images: Object.fromEntries(SLOTS.map((s) => [s.id, { w: s.size.w, h: s.size.h, png: PNG }])),
    children: { teamColumn: { Name: { fontSize: 14, x: 10 } } },
    weapons: {
      boxActive: { kind: 'rounded', color: '10 20 30 200' },
      boxInactive: { kind: 'flat', color: '0 0 0 100' },
      weaponIcons: false, itemIcons: false, clipFont: 30,
    },
    ...base,
  });
}

const ASSETS: BuildAssets = {
  fonts: { regular: new Uint8Array([0, 1, 0, 0, 9]), bold: new Uint8Array([0, 1, 0, 0, 8]) },
  images: Object.fromEntries(SLOTS.map((s) => [s.id, new Uint8ClampedArray(s.size.w * s.size.h * 4).fill(200)])),
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
      // addoninfo.txt is the editor's own, allowed at build only.
      const outside = paths.filter((p) => p !== 'addoninfo.txt' && hudPathProblem(p) !== null);
      expect(outside).toEqual([]);
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
