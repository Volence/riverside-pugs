import { describe, it, expect, vi, afterEach } from 'vitest';
import { fontCell, cssFamily, cssWeight, canvasFont, synthBoldSpacing, loadFace, _resetFaces, importedFace, _resetImportFaces } from './fonts';
import { registerImport, unregisterImport, baseFile } from './base';
import { sampleHud } from './importFixtures';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FONT_METRICS } from './art/index';

describe('fontCell: a scheme tall in pixels to the size the game draws', () => {
  it('reads a face with a VDMX table the way GDI does: the largest ppem whose cell fits', () => {
    // Trade Gothic Bold's VDMX: 32 ppem is 32 up and 8 down, a 40 cell. HudAmmo
    // (tall 18) at 1080p is a 40 cell (18 * 1080 / 480, truncated), and the
    // owner's screenshot shows its digits 23 pixels tall, which is 32 ppem.
    expect(fontCell('Trade Gothic Bold', 40)).toEqual({ em: 32, ascent: 32, cell: 40 });
    expect(fontCell('Trade Gothic Bold', 36)).toEqual({ em: 29, ascent: 29, cell: 36 });
    // Two ppems can share a cell height: Trade Gothic's 24 and 25 are both 30
    // tall. GDI takes the larger, with that row's ascent.
    expect(fontCell('Trade Gothic', 30)).toEqual({ em: 25, ascent: 24, cell: 30 });
  });

  it('truncates the pixel tall first, as VGUI scales a proportional tall to an int', () => {
    expect(fontCell('Trade Gothic Bold', 40.5)).toEqual(fontCell('Trade Gothic Bold', 40));
  });

  it('scales a face without VDMX by winAscent + winDescent, and so does a tall past the table', () => {
    const r = FONT_METRICS['Roboto Condensed'];
    const sum = r.winAscent + r.winDescent;
    expect(fontCell('Roboto Condensed', 36)).toEqual({ em: 36 * r.unitsPerEm / sum, ascent: 36 * r.winAscent / sum, cell: 36 });
    const b = FONT_METRICS['Trade Gothic Bold'];
    const bsum = b.winAscent + b.winDescent;
    expect(fontCell('Trade Gothic Bold', 1000)).toEqual({ em: 1000 * b.unitsPerEm / bsum, ascent: 1000 * b.winAscent / bsum, cell: 1000 });
    expect(fontCell('Trade Gothic Bold', 3).cell).toBe(3);
  });

  it('sizes a face it does not know as Roboto Condensed, the preview\'s fallback', () => {
    expect(fontCell('Futurot', 36)).toEqual(fontCell('Roboto Condensed', 36));
  });
});

describe('the CSS face for a scheme face', () => {
  it('draws the stock faces in the exported fonts, Roboto in its own, and Windows\' faces by name with fallbacks', () => {
    expect(cssFamily('Trade Gothic')).toMatch(/^"Trade Gothic", /);
    expect(cssFamily('Trade Gothic Bold')).toMatch(/^"Trade Gothic Bold", /);
    expect(cssFamily('trade gothic bold')).toMatch(/^"Trade Gothic Bold", /);
    expect(cssFamily('ToolBox')).toMatch(/^"ToolBox", /);
    expect(cssFamily('Roboto Condensed')).toMatch(/^"Roboto Condensed", /);
    expect(cssFamily('Verdana')).toMatch(/^Verdana, .*sans-serif$/);
    expect(cssFamily('Tahoma')).toMatch(/^Tahoma, .*sans-serif$/);
    expect(cssFamily('Arial')).toMatch(/^Arial, .*sans-serif$/);
    expect(cssFamily('')).toMatch(/"Roboto Condensed".*sans-serif$/);
  });

  it('keeps the scheme\'s weight: 0 is regular, and the face carries its own boldness', () => {
    expect(cssWeight(0)).toBe(400);
    expect(cssWeight(400)).toBe(400);
    expect(cssWeight(700)).toBe(700);
    expect(cssWeight(1000)).toBe(900);
    expect(cssWeight(550)).toBe(600);
  });

  it('widens a face the game emboldens itself by a pixel a glyph at 1080p: a bold weight on a face with no bold file', () => {
    // The stock Tab title, FrameTitle (Trade Gothic Bold, weight 700), is 333 px of ink in game and
    // was 308 in the preview without it (/home/volence/l4d/hud/probe-tab/p0/measure.txt, "title").
    expect(synthBoldSpacing('Trade Gothic Bold', 700)).toBe(1);
    expect(synthBoldSpacing('Trade Gothic', 600)).toBe(1);
    expect(synthBoldSpacing('Trade Gothic Bold', 400)).toBe(0);
    expect(synthBoldSpacing('Trade Gothic Bold', 0)).toBe(0);
    // Roboto Condensed has a bold file of its own, and a face the preview has no file for is left alone.
    expect(synthBoldSpacing('Roboto Condensed', 700)).toBe(0);
    expect(synthBoldSpacing('Verdana', 700)).toBe(0);
  });

  it('writes the canvas font from the face, the weight and the cell', () => {
    expect(canvasFont('Trade Gothic Bold', 0, 40)).toBe(`400 32px ${cssFamily('Trade Gothic Bold')}`);
  });
});

describe('loadFace', () => {
  // Stand in for a browser that has FontFace; each face loads when told to.
  const made: { family: string; source: string; weight?: string; done: () => void }[] = [];
  class FakeFontFace {
    weight?: string;
    private p: Promise<this>;
    constructor(public family: string, public source: string, d?: { weight?: string }) {
      this.weight = d?.weight;
      let done!: () => void;
      this.p = new Promise((res) => { done = () => res(this); });
      made.push({ family, source, weight: d?.weight, done });
    }
    load() { return this.p; }
  }
  const add = vi.fn();
  const setUp = () => {
    made.length = 0; add.mockClear(); _resetFaces();
    vi.stubGlobal('FontFace', FakeFontFace);
    Object.defineProperty(document, 'fonts', { value: { add }, configurable: true });
  };
  afterEach(() => { vi.unstubAllGlobals(); _resetFaces(); });

  it('registers an exported face once, under its own name, and redraws every view that asked once it loads', async () => {
    setUp();
    const a = vi.fn(), b = vi.fn();
    loadFace('Trade Gothic Bold', a);
    loadFace('trade gothic bold', b);
    expect(add).toHaveBeenCalledTimes(1);
    expect(made[0]).toMatchObject({ family: 'Trade Gothic Bold', weight: '400' });
    expect(made[0].source).toMatch(/^url\(.*font-trade-gothic-bold.*\.ttf.*\)$/);
    expect(a).not.toHaveBeenCalled();
    made[0].done();
    await new Promise((r) => setTimeout(r, 0));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    // Once in, asking again needs no redraw.
    const c = vi.fn();
    loadFace('Trade Gothic Bold', c);
    await new Promise((r) => setTimeout(r, 0));
    expect(c).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('registers both Roboto Condensed files, regular and bold, and nothing for Windows\' own faces', () => {
    setUp();
    loadFace('Roboto Condensed');
    expect(made.map((f) => [f.family, f.weight])).toEqual([['Roboto Condensed', '400'], ['Roboto Condensed', '700']]);
    for (const f of made) expect(f.source).toMatch(/RobotoCondensed-(Regular|Bold).*\.ttf/);
    loadFace('Verdana'); loadFace('Tahoma'); loadFace(''); loadFace('Futurot');
    expect(made).toHaveLength(2);
  });

  it("registers an imported face from the upload's own bytes, once", () => {
    setUp();
    const ID = '8'.repeat(64);
    const scheme = baseFile('stock', 'resource/clientscheme.res').replace(/CustomFontFiles\s*\{/, (m) => `${m}\r\n\t\t"9"\t\t"resource/MyHud.ttf"`);
    registerImport(ID, sampleHud({ 'resource/clientscheme.res': scheme, 'resource/myhud.ttf': new Uint8Array(readFileSync(join(__dirname, 'art/font-trade-gothic.ttf'))) }));
    try {
      const alias = importedFace(`imported:${ID}`, 'trade gothic')!;
      expect(alias).toBe(`HudImp_${'8'.repeat(12)}_Trade_Gothic`);
      loadFace(alias); loadFace(alias);
      expect(add).toHaveBeenCalledTimes(1);
      expect(made[0].family).toBe(alias);
      expect(made[0].source).toBeInstanceOf(ArrayBuffer);
    } finally { unregisterImport(ID); _resetImportFaces(); }
  });

  it('takes an import\'s faces out of the page when the import is removed', () => {
    setUp();
    const del = vi.fn();
    Object.defineProperty(document, 'fonts', { value: { add, delete: del }, configurable: true });
    const ID = '7'.repeat(64);
    const scheme = baseFile('stock', 'resource/clientscheme.res').replace(/CustomFontFiles\s*\{/, (m) => `${m}\r\n\t\t"9"\t\t"resource/MyHud.ttf"`);
    registerImport(ID, sampleHud({ 'resource/clientscheme.res': scheme, 'resource/myhud.ttf': new Uint8Array(readFileSync(join(__dirname, 'art/font-trade-gothic.ttf'))) }));
    try {
      const alias = importedFace(`imported:${ID}`, 'trade gothic')!;
      loadFace(alias);
      expect(add).toHaveBeenCalledTimes(1);
      unregisterImport(ID);
      expect(del).toHaveBeenCalledTimes(1);
      expect(del.mock.calls[0][0]).toBe(add.mock.calls[0][0]);
      // Its bytes are gone too: asking for the face again loads nothing.
      loadFace(alias);
      expect(add).toHaveBeenCalledTimes(1);
      registerImport(ID, sampleHud());
      expect(importedFace(`imported:${ID}`, 'trade gothic')).toBeUndefined();
    } finally { unregisterImport(ID); _resetImportFaces(); }
  });

  it('draws on in the fallback without FontFace', () => {
    _resetFaces();
    expect(() => loadFace('Trade Gothic', () => {})).not.toThrow();
  });
});
