// @vitest-environment node
//
// happy-dom (the web project's default) turns import.meta.url into a synthetic
// http: URL, not a file: one, which breaks the boundary test's fileURLToPath
// call below. sample.vpkcheck.test.ts hits the same thing and fixes it the
// same way; nothing in this file needs a DOM.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART, ART_TOTAL_BYTES } from './art/index';
import { artUrl, normaliseMaterial, NEEDED_MATERIALS } from './art';
import { buildHud } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { SLOTS } from './slots';

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
  // must not be able to reach them even by accident, so every module a build
  // runs through is found by walking build.ts's relative imports, and each is
  // checked for any reference to an art folder: a static import, a dynamic
  // import(), or an import.meta.glob over it.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const ART_REF = /['"]\.\.?\/(?:[^'"]*\/)?art[/'".]/;
  const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]+)['"]/g;

  function resolveModule(from: string, spec: string): string {
    const base = resolve(dirname(from), spec);
    for (const p of [base, `${base}.ts`, `${base}/index.ts`]) if (existsSync(p) && statSync(p).isFile()) return p;
    throw new Error(`${from}: cannot resolve ${spec}`);
  }
  function reachable(entry: string): string[] {
    const seen = new Set<string>();
    const todo = [entry];
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) todo.push(resolveModule(f, m[1]));
    }
    return [...seen].map((f) => relative(here, f)).sort();
  }
  const modules = reachable(resolve(here, 'build.ts'));

  it('the reference check catches every way a module could reach the art', () => {
    for (const s of ["import { ART } from './art/index';", "import u from './art/x.png';", "await import('./art');",
      "import.meta.glob('./art/*.png')", "import { artUrl } from '../hud/art';", "from './art'"]) expect(s).toMatch(ART_REF);
    for (const s of ["import { SLOTS } from './slots';", "from './partial'", "from '../vpk'"]) expect(s).not.toMatch(ART_REF);
  });

  it('walks every module build.ts reaches', () => {
    expect(modules).toEqual(['../vpk/index.ts', '../vpk/zip.ts', 'base/index.ts', 'build.ts', 'children.ts', 'design.ts', 'elements.ts',
      'kv.ts', 'slots.ts', 'textures.ts', 'units.ts']);
  });

  for (const f of modules) {
    it(`${f} never references the art`, () => {
      expect(readFileSync(resolve(here, f), 'utf8')).not.toMatch(ART_REF);
    });
  }

  // And no build emits one. The advanced-mode slots overwrite stock textures by
  // their pak01 names on purpose (with generated pixels), so those names, and
  // only those, may appear; every other emitted material must be one of ours.
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
  const everySlot = Object.fromEntries(SLOTS.map((s) => [s.id, { kind: 'flat' as const, color: '10 20 30 255' }]));
  for (const preset of ['stock', 'modern'] as const) {
    for (const advanced of [false, true]) {
      it(`a ${preset} build ${advanced ? 'in advanced mode ' : ''}emits no exported texture`, () => {
        const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), preset, advanced, styles: everySlot };
        const allowed = new Set(advanced ? SLOTS.flatMap((s) => s.stockNames) : []);
        const materials = buildHud(d, { fonts }).map((f) => f.path).filter((p) => p.startsWith('materials/'));
        expect(materials.length).toBeGreaterThan(0);
        for (const p of materials) {
          const name = p.slice('materials/'.length).replace(/\.(vtf|vmt)$/, '');
          if (ART[name] !== undefined) expect(allowed.has(name), p).toBe(true);
        }
      });
    }
  }
});
