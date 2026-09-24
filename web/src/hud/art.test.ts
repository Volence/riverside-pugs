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
import { inflateSync } from 'node:zlib';
import { ART, ART_TOTAL_BYTES, ICON_ADVANCE, ICON_SPACE, EQUIP_ICON_SIZE, FONT_FILES, FONT_METRICS } from './art/index';
import { artUrl, normaliseMaterial, NEEDED_MATERIALS, ITEM_ICONS, EQUIP_ICONS, CROSSHAIR_OPEN, SKULL_ICON } from './art';
import { buildHud } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { SLOTS } from './slots';
import { TEX } from '../crosshair/draw';

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
  it('covers every item icon, with its advance, as the preview draws the Items row', () => {
    expect(ITEM_ICONS).toEqual(['icon/item/medkit', 'icon/item/pills', 'icon/item/molotov', 'icon/item/pipebomb']);
    for (const m of ITEM_ICONS) {
      expect(NEEDED_MATERIALS, m).toContain(m);
      expect(ART[m], m).toBe(m.replace(/\//g, '-') + '.png');
      expect(ICON_ADVANCE[m], m).toBeGreaterThan(0);
    }
    expect(ICON_SPACE).toBeGreaterThan(0);
  });
  it('covers every weapon selection icon, with its size on the icon sheet, as the preview draws the weapon slots', () => {
    // The sample loadout: pump shotgun, dual pistols, molotov, medkit, pills.
    // mod_textures.txt cuts each from vgui/hud/iconsheet: the shotgun 192 x 64, the rest 64 x 64.
    expect(EQUIP_ICONS).toEqual(['icon/equip/pumpshotgun', 'icon/equip/dualpistols', 'icon/equip/molotov', 'icon/equip/medkit', 'icon/equip/pills']);
    for (const m of EQUIP_ICONS) {
      expect(NEEDED_MATERIALS, m).toContain(m);
      expect(ART[m], m).toBe(m.replace(/\//g, '-') + '.png');
    }
    expect(EQUIP_ICON_SIZE['icon/equip/pumpshotgun']).toEqual([192, 64]);
    for (const m of EQUIP_ICONS.slice(1)) expect(EQUIP_ICON_SIZE[m], m).toEqual([64, 64]);
  });
  it('lists the stock fonts, decoded from the game\'s vfonts, under the names clientscheme.res gives them', () => {
    // tg.vfont's full name is "Trade Gothic" (its family is "TradeGothic");
    // tgb.vfont's family and full name are both "Trade Gothic Bold". GDI
    // matches a face by either, so these are the names the scheme uses.
    // ToolBox (toolbox.vfont) is the icon face of L4D_Icons: the own health
    // panel's HealthIcon writes "," in it, which is the game's "+".
    expect(FONT_FILES).toEqual({ 'Trade Gothic': 'font-trade-gothic.ttf', 'Trade Gothic Bold': 'font-trade-gothic-bold.ttf', ToolBox: 'font-toolbox.ttf' });
    for (const file of Object.values(FONT_FILES)) expect(existsSync(resolve(fileURLToPath(new URL('./art/', import.meta.url)), file)), file).toBe(true);
  });
  it('has the metrics of every face a scheme names, so no font is parsed at runtime', () => {
    for (const face of ['Trade Gothic', 'Trade Gothic Bold', 'ToolBox', 'Roboto Condensed', 'Verdana', 'Tahoma', 'Arial']) {
      const m = FONT_METRICS[face];
      expect(m, face).toBeDefined();
      expect(m.unitsPerEm, face).toBeGreaterThan(0);
      expect(m.winAscent + m.winDescent, face).toBeGreaterThan(m.unitsPerEm);
    }
    // The stock faces carry a VDMX table, which GDI reads to choose the
    // size for a cell height: rows of ppem, yMax, yMin. Trade Gothic Bold at
    // 32 ppem is 32 up and 8 down, a 40-pixel cell (probe: HudAmmo at 1080p).
    const vdmx = FONT_METRICS['Trade Gothic Bold'].vdmx!;
    const at32 = vdmx.findIndex((_, i) => i % 3 === 0 && vdmx[i] === 32);
    expect(vdmx.slice(at32, at32 + 3)).toEqual([32, 32, -8]);
    expect(FONT_METRICS['Roboto Condensed'].vdmx).toBeUndefined();
  });
  it('has the ability marker and the infected crosshair the game draws at the screen centre (probe Q16a)', () => {
    expect(NEEDED_MATERIALS).toContain('vgui/hud/pz_charge_crosshair');
    expect(CROSSHAIR_OPEN).toBe('icon/pz_crosshair_open');
    expect(NEEDED_MATERIALS).toContain(CROSSHAIR_OPEN);
    // hud_textures.txt PZ_crosshair_open: a 32 x 32 cell of sprites/crosshairs.
    expect(pngRgba(ART[CROSSHAIR_OPEN]).w).toBe(32);
  });
  it('has the infected card\'s class icons and its dead skull (client.dll strings beside ZombieTeamDisplayPlayer.res)', () => {
    // hud/ZombieTeamImage_<class> on PlayerImage (a ghost's GhostTeamImage_<class> material draws the same
    // texture at a pulsing alpha), and mod_textures.txt icon_skull, a 64 x 64 cell of vgui/hud/iconsheet,
    // at SkullIconPlacement (probe Q19, /home/volence/l4d/hud/probe-phase2-infected/b9/shots/crops/bl-abeg.png e).
    for (const c of ['hunter', 'smoker', 'boomer', 'tank']) {
      expect(NEEDED_MATERIALS, c).toContain(`vgui/hud/zombieteamimage_${c}`);
      expect(pngRgba(ART[`vgui/hud/zombieteamimage_${c}`]).w, c).toBe(64);
    }
    expect(SKULL_ICON).toBe('icon/skull');
    expect(NEEDED_MATERIALS).toContain(SKULL_ICON);
    expect(EQUIP_ICON_SIZE[SKULL_ICON]).toEqual([64, 64]);
  });
  it('exports the meter as the game shades it: the base times its red motion texture, not the base\'s orange', () => {
    // pz_charge_meter.vmt is UnlitTwoTexture with $texture2 PZ_charge_meter_motion. In game the lit
    // arc samples R 176, G 3, B 1 (/home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/progress-f-zoom.png);
    // the base texture alone averages 226 159 70 over the ring.
    const { w, px } = pngRgba(ART['vgui/hud/pz_charge_meter']);
    let r = 0, g = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 200) { r += px[i]; g += px[i + 1]; n++; }
    expect(w).toBe(128);
    expect(r / n).toBeGreaterThan(120);
    expect(g / n).toBeLessThan(50);                   // red, not orange
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
    // The crosshair modules draw, check and pack the player's own crosshair, never Valve's art.
    // probes.ts is the probe gates, a leaf that imports nothing.
    expect(modules).toEqual(['../crosshair/draw.ts', '../crosshair/model.ts', '../crosshair/vpk.ts', '../vpk/index.ts', '../vpk/zip.ts', 'base/index.ts', 'build.ts', 'children.ts', 'design.ts', 'elements.ts',
      'kv.ts', 'limits.ts', 'probes.ts', 'slots.ts', 'splatter.ts', 'text.ts', 'textures.ts', 'units.ts']);
  });

  // The exported fonts are Valve's too. A download carries the player's own
  // choice of Roboto Condensed and never a byte of Trade Gothic or ToolBox:
  // no emitted file is named like one, and none holds the same bytes.
  const exportedFonts = Object.values(FONT_FILES).map((f) => new Uint8Array(readFileSync(resolve(here, 'art', f))));
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const preset of ['stock', 'modern'] as const) {
    for (const font of ['preset', 'roboto'] as const) {
      it(`a ${preset} download in the ${font} font never contains an exported font`, () => {
        const realFonts = {
          regular: new Uint8Array(readFileSync(resolve(here, 'base/fonts/RobotoCondensed-Regular.ttf'))),
          bold: new Uint8Array(readFileSync(resolve(here, 'base/fonts/RobotoCondensed-Bold.ttf'))),
        };
        const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), preset, font };
        const files = buildHud(d, { fonts: realFonts });
        expect(exportedFonts.length).toBe(3);
        for (const f of files) {
          expect(f.path.toLowerCase(), f.path).not.toMatch(/trade.?gothic|font-trade|font-toolbox|\.vfont$/);
          for (const x of exportedFonts) expect(same(f.data, x), f.path).toBe(false);
        }
      });
    }
  }

  for (const f of modules) {
    it(`${f} never references the art`, () => {
      expect(readFileSync(resolve(here, f), 'utf8')).not.toMatch(ART_REF);
    });
  }

  // And no build emits one. The advanced-mode slots overwrite stock textures by
  // their pak01 names on purpose (with generated pixels), so those names, and
  // only those, may appear; every other emitted material must be one of ours.
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
  // panelBg rounded, everything else flat: a flat panelBg now ships no
  // texture at all (it is a plain fillcolor on the injected card child), so
  // rounded is what keeps this assertion meaningful for the one slot with a
  // normal-mode route.
  const everySlot = Object.fromEntries(SLOTS.map((s) => [s.id, { kind: s.id === 'panelBg' ? 'rounded' as const : 'flat' as const, color: '10 20 30 255' }]));
  for (const preset of ['stock', 'modern'] as const) {
    for (const advanced of [false, true]) {
      it(`a ${preset} build ${advanced ? 'in advanced mode ' : ''}emits no exported texture`, () => {
        // A bundled crosshair too: its texture is the player's own, drawn on the Crosshair page.
        // And every weapon box style and hidden picture, which ship generated textures of their own.
        const weapons = { boxActive: { kind: 'rounded' as const }, boxInactive: { kind: 'hidden' as const }, weaponIcons: false, itemIcons: false };
        const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), preset, advanced, styles: everySlot, crosshair: 'bundle', weapons };
        const allowed = new Set(advanced ? SLOTS.flatMap((s) => s.stockNames) : []);
        const materials = buildHud(d, { fonts, crosshair: new Uint8ClampedArray(TEX * TEX * 4) }).map((f) => f.path).filter((p) => p.startsWith('materials/'));
        expect(materials.length).toBeGreaterThan(0);
        for (const p of materials) {
          const name = p.slice('materials/'.length).replace(/\.(vtf|vmt)$/, '');
          if (ART[name] !== undefined) expect(allowed.has(name), p).toBe(true);
        }
      });
    }
  }
});

/**
 * The pixels of one exported PNG (8-bit RGBA, as PIL writes them): enough of
 * a decoder to check a colour without a new dependency.
 */
function pngRgba(file: string): { w: number; h: number; px: Uint8Array } {
  const buf = readFileSync(fileURLToPath(new URL(`./art/${file}`, import.meta.url)));
  let o = 8, w = 0, h = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6) throw new Error(`${file}: not 8-bit RGBA`);
    } else if (type === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4, px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  return { w, h, px };
}
