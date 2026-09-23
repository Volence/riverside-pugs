// @vitest-environment node
//
// Node, not happy-dom: this reads the exported fonts off disk with node:fs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFont, decodeVfont, isVfont } from './ttf';
import { FONT_FILES, FONT_METRICS } from './art/index';

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

describe('decodeVfont', () => {
  it('decodes a .vfont back to the TrueType file it hides', () => {
    const ttf = font('Trade Gothic');
    const v = toVfont(ttf, [9, 200, 31]);
    expect(isVfont(v)).toBe(true);
    expect(isVfont(ttf)).toBe(false);
    expect(decodeVfont(v)).toEqual(ttf);
  });
});
