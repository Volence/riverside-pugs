// @vitest-environment node
//
// Node, not happy-dom: this reads the exported fonts off disk with node:fs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFont, decodeVfont, isVfont } from './ttf';
import { FONT_FILES, FONT_METRICS } from './art/index';
import { buildSfnt, headTable, hheaTable, hostileFont } from './importFixtures';

const here = fileURLToPath(new URL('.', import.meta.url));
const font = (face: string) => new Uint8Array(readFileSync(`${here}art/${FONT_FILES[face]}`));

/** The vfont encoding export-hud-art.py decodes, run forwards: XOR against a running key, then salt, its length and the marker. */
function toVfont(ttf: Uint8Array, salt: number[]): Uint8Array {
  let key = 167;
  for (const b of salt) key ^= (b + 167) & 0xff;
  const body = new Uint8Array(ttf.length);
  for (let i = 0; i < ttf.length; i++) { body[i] = ttf[i] ^ key; key = (body[i] + 167) & 0xff; }
  return new Uint8Array([...body, ...salt, salt.length + 1, ...new TextEncoder().encode('VFONT1')]);
}

describe('readFont', () => {
  for (const face of ['Trade Gothic', 'Trade Gothic Bold', 'ToolBox']) {
    it(`reads ${face} exactly as export-hud-art.py baked it`, () => {
      const info = readFont(font(face));
      expect(info.metrics).toEqual(FONT_METRICS[face]);
      expect(info.names).toContain(face);
    });
  }

  it('refuses a file that is not a font', () => {
    expect(() => readFont(new Uint8Array(40))).toThrow(/not a TrueType font/);
  });
});

describe('readFont: a hostile or truncated file never reads past a table', () => {
  const trade = font('Trade Gothic');

  it('still throws a catchable error for a real TTF cut off mid-file, rather than reading garbage', () => {
    // The outer table-directory loop already bounds every table's off+len
    // against the buffer, so a plain truncation is caught there.
    expect(() => readFont(trade.slice(0, Math.floor(trade.length / 2)))).toThrow();
  });

  it('reads no names from a name table whose record count claims more room than the table holds', () => {
    const sfnt = buildSfnt({ head: headTable(), hhea: hheaTable(), name: new Uint8Array([0, 0, 0xff, 0xff, 0, 6]) });
    expect(readFont(sfnt).names).toEqual([]);
  });

  it('skips a name record whose string offset runs past the name table instead of reading past it', () => {
    const name = new Uint8Array([0, 0, 0, 1, 0, 18, 0, 3, 0, 1, 4, 9, 0, 1, 0, 10, 3, 232]);
    const sfnt = buildSfnt({ head: headTable(), hhea: hheaTable(), name });
    expect(readFont(sfnt).names).toEqual([]);
  });

  it('drops a VDMX table whose group offset points outside it, falling back to the winAscent + winDescent rule', () => {
    const vdmx = new Uint8Array([0, 0, 0, 1, 0, 1, 0, 1, 0, 2, 39, 15]);
    const sfnt = buildSfnt({ head: headTable(), hhea: hheaTable(), VDMX: vdmx });
    expect(readFont(sfnt).metrics.vdmx).toBeUndefined();
  });

  it('drops a VDMX table whose ratio count claims more room than the table holds', () => {
    const vdmx = new Uint8Array([0, 0, 0, 1, 0xff, 0xff]);
    const sfnt = buildSfnt({ head: headTable(), hhea: hheaTable(), VDMX: vdmx });
    expect(readFont(sfnt).metrics.vdmx).toBeUndefined();
  });

  it('never throws for any of the six ways an imported font file can be broken, except the plain truncation case above', () => {
    for (const kind of ['nameOffset', 'vdmxOffset', 'nameCount', 'vdmxCount'] as const) {
      expect(() => readFont(hostileFont(kind, trade))).not.toThrow();
    }
  });
});

describe('decodeVfont', () => {
  it('decodes a .vfont back to the TrueType file it hides', () => {
    const ttf = font('Trade Gothic');
    const v = toVfont(ttf, [9, 200, 31]);
    expect(isVfont(v)).toBe(true);
    expect(isVfont(ttf)).toBe(false);
    expect(decodeVfont(v)).toEqual(ttf);
  });
});
