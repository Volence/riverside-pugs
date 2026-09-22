// @vitest-environment node
//
// happy-dom (the web project's default) turns import.meta.url into a synthetic
// http: URL, not a file: one, which breaks the boundary test's fileURLToPath
// call below. sample.vpkcheck.test.ts hits the same thing and fixes it the
// same way; nothing in this file needs a DOM.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ART, ART_TOTAL_BYTES } from './art/index';
import { artUrl, normaliseMaterial, NEEDED_MATERIALS } from './art';

describe('normaliseMaterial', () => {
  it('resolves .res image values the way VGUI does, relative to materials/vgui', () => {
    expect(normaliseMaterial('hud/crouch_survivor')).toBe('vgui/hud/crouch_survivor');
    expect(normaliseMaterial('../vgui/hud/detail_scratches_top_1')).toBe('vgui/hud/detail_scratches_top_1');
    expect(normaliseMaterial('HUD/PZ_healthbar_250')).toBe('vgui/hud/pz_healthbar_250');
    expect(normaliseMaterial('../vgui/s_panel_background')).toBe('vgui/s_panel_background');
    expect(normaliseMaterial('vgui/healthbar_green')).toBe('vgui/healthbar_green');
  });
});

describe('the art index', () => {
  it('covers every material the preview draws', () => {
    for (const m of NEEDED_MATERIALS) expect(ART[m], m).toBeDefined();
  });
  it('stays under the size cap', () => {
    expect(ART_TOTAL_BYTES).toBeLessThan(1_000_000);
  });
  it('gives a URL for an indexed material and nothing for an unknown one', () => {
    expect(artUrl('vgui/healthbar_green')).toMatch(/\.png$/);
    expect(artUrl('vgui/does_not_exist')).toBeUndefined();
  });
});

describe('the art boundary', () => {
  // The exported PNGs are Valve's and are for the preview only. The generator
  // must not be able to reach them even by accident, so the modules a build
  // runs through are checked for any import of the art folder or its loader.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const generatorModules = ['build.ts', 'design.ts', 'elements.ts', 'slots.ts', 'textures.ts', 'kv.ts', 'units.ts', 'base/index.ts'];
  for (const f of generatorModules) {
    it(`${f} never imports the art`, () => {
      const src = readFileSync(here + f, 'utf8');
      expect(src).not.toMatch(/from\s+['"]\.\.?\/art/);
      expect(src).not.toMatch(/from\s+['"]\.\/art\//);
    });
  }
});
