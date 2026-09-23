import { describe, it, expect } from 'vitest';
import { addLinear, toLinear, toSrgbByte } from './additive';

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
