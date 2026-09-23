import { describe, it, expect } from 'vitest';
import { fontCell, cssFamily, cssWeight, canvasFont } from './fonts';
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

  it('writes the canvas font from the face, the weight and the cell', () => {
    expect(canvasFont('Trade Gothic Bold', 0, 40)).toBe(`400 32px ${cssFamily('Trade Gothic Bold')}`);
  });
});
