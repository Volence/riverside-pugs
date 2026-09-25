// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { buildHud, packHud } from './build';
import { DEFAULT_DESIGN, newDesign, validateDesign, type HudDesign } from './design';
import { gameDefault, isGameDefault } from './edit';
import { registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { readArt } from '../crosshair/model';

const ART = readArt({ kind: 'built', state: {} })!;

/** A design with something changed in every field a reset has to clear. */
const EVERYTHING: HudDesign = validateDesign({
  v: 1, name: 'loud hud', preset: 'modern', advanced: true, aspect: '16:10', font: 'roboto',
  crosshair: 'bundle', xhairArt: ART, hideGameCrosshair: true, pickupFlyIn: false,
  elements: { teamColumn: { fit: true, gap: 9 }, ownHealth: { fit: true }, chat: { x: 40, fontSize: 12 }, killNotices: { color: '255 0 0 255' } },
  children: { teamColumn: { Name: { x: 3 } } },
  styles: { panelBg: { kind: 'flat', color: '10 10 10 255' } },
  splatters: { splatTeam: { kind: 'fade', color: '1 2 3 255' } },
  weapons: { primaryY: 10, reserveColor: '1 1 1 255', weaponIcons: false },
});

describe('Reset to game default', () => {
  it('clears every edit, keeping only the name and the screen shape', () => {
    expect(gameDefault(EVERYTHING)).toEqual({
      v: 1, name: 'loud hud', preset: 'stock', advanced: false, aspect: '16:10', font: 'preset', crosshair: 'none',
      elements: {}, styles: {}, images: {}, children: {},
    });
  });

  it('does not fit the teammates or your own health, as a new design does', () => {
    expect(DEFAULT_DESIGN.elements.teamColumn?.fit).toBe(true);
    expect(gameDefault(newDesign(null)).elements).toEqual({});
  });

  it('leaves an imported HUD for the game own', () => {
    const d = gameDefault({ ...structuredClone(DEFAULT_DESIGN), preset: 'imported', imported: { id: 'a'.repeat(64), name: 'x' } });
    expect(d.preset).toBe('stock');
    expect('imported' in d).toBe(false);
  });

  it('survives the validator unchanged, so a reload or a share link keeps it exact', () => {
    const d = gameDefault(EVERYTHING);
    expect(validateDesign(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('is told apart from a design with anything changed', () => {
    expect(isGameDefault(gameDefault(EVERYTHING))).toBe(true);
    expect(isGameDefault(structuredClone(DEFAULT_DESIGN))).toBe(false);
    const d = gameDefault(EVERYTHING);
    expect(isGameDefault({ ...d, name: 'other', aspect: '4:3' })).toBe(true);
    expect(isGameDefault({ ...d, font: 'roboto' })).toBe(false);
    expect(isGameDefault({ ...d, pickupFlyIn: false })).toBe(false);
    expect(isGameDefault({ ...d, xhairArt: ART })).toBe(false);
  });
});

describe('the download of the game default', () => {
  afterEach(() => unregisterImport('f'.repeat(64)));

  for (const aspect of ['16:9', '16:10', '4:3'] as const) {
    it(`on ${aspect} writes no HUD file at all, only the addon's name`, () => {
      const d = { ...gameDefault(EVERYTHING), aspect };
      expect(buildHud(d).map((f) => f.path)).toEqual(['addoninfo.txt']);
      const p = packHud(d);
      expect(p.filename).toBe('loud hud.vpk');
      expect(p.files).toEqual(['addoninfo.txt']);
    });
  }

  it('from an imported HUD writes none of the import', () => {
    registerImport('f'.repeat(64), sampleHud());
    const on: HudDesign = { ...structuredClone(DEFAULT_DESIGN), preset: 'imported', imported: { id: 'f'.repeat(64), name: 'x' } };
    expect(buildHud(on).length).toBeGreaterThan(1);
    expect(buildHud(gameDefault(on)).map((f) => f.path)).toEqual(['addoninfo.txt']);
  });

  it('still writes a stock file an edit changed', () => {
    const d = { ...gameDefault(EVERYTHING), elements: { chat: { x: 41 } } };
    expect(buildHud(d).map((f) => f.path)).toContain('scripts/hudlayout.res');
  });
});
