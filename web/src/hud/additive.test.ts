import { describe, it, expect } from 'vitest';
import { addLinear, overLinear, toLinear, toSrgbByte } from './additive';

const px = (...rgba: number[]) => new Uint8ClampedArray(rgba);

describe('addLinear', () => {
  it("adds the grey reserve onto the wall as the game does, in linear light", () => {
    // Shot 20260923153714: wall about (135, 126, 110), ReserveAmmoColor 128
    // grey, the glyph cores come out (184, 177, 166). The linear sum is
    // (180, 174, 164); the sRGB sum would be (255, 254, 238).
    const dst = px(135, 126, 110, 255);
    addLinear(dst, px(128, 128, 128, 255));
    expect([...dst]).toEqual([180, 174, 164, 255]);
  });

  it('saturates at white, leaves uncovered pixels alone, and scales by coverage', () => {
    const dst = px(200, 200, 200, 255, 50, 60, 70, 255, 0, 0, 0, 255);
    addLinear(dst, px(255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 128));
    expect([...dst.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...dst.slice(4, 8)]).toEqual([50, 60, 70, 255]);
    expect(dst[8]).toBe(toSrgbByte(128 / 255));                        // half-covered white on black: half the light
  });

  it('round-trips every byte through linear light', () => {
    for (let b = 0; b < 256; b++) expect(toSrgbByte(toLinear(b))).toBe(b);
  });
});

describe('overLinear', () => {
  it('blends the dead art over the scene in linear light, the skull as well as the black band', () => {
    // s_panel_dead: the band is black at alpha 156, the skull grey 129 at 156. Launch R (X12,
    // parity note "dead card"): the skull is 113,107,104 in game at 62,1010 and was 76,74,69 in the preview,
    // whose alpha remap (linearOverAlpha) is exact for black texels only. Over the preview's backdrop there
    // (about 47) the linear blend gives 106; black over a 255 stripe gives 167 (X13: game 168).
    const dst = px(47, 47, 47, 255, 255, 255, 255, 255);
    overLinear(dst, px(129, 129, 129, 156, 0, 0, 0, 156));
    expect([...dst.slice(0, 3)]).toEqual([106, 106, 106]);
    expect([...dst.slice(4, 7)]).toEqual([167, 167, 167]);
    expect([dst[3], dst[7]]).toEqual([255, 255]);
  });

  it('leaves an uncovered pixel alone and lets an opaque one replace the scene', () => {
    const dst = px(10, 20, 30, 255, 10, 20, 30, 255);
    overLinear(dst, px(200, 0, 0, 0, 200, 100, 50, 255));
    expect([...dst]).toEqual([10, 20, 30, 255, 200, 100, 50, 255]);
  });
});
