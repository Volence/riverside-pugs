/**
 * The game's additive blend, done in linear light.
 *
 * A scheme font with "additive" "1" (HudAmmo, HUDHealth, the ToolBox icon
 * fonts, most of the stock HUD's) is drawn by the game adding each glyph's
 * colour to what is behind it. The owner's screenshots show the sum is taken
 * in linear light, not on the sRGB numbers the canvas holds: the grey (128)
 * reserve "128" on a wall of about (135, 126, 110) comes out (184, 177, 166)
 * in shot 20260923153714. The linear sum predicts (180, 174, 164); adding the
 * sRGB numbers, as the canvas's 'lighter' composite does, gives (249, 240,
 * 224), near white; the plain blend the preview drew before gives the grey
 * itself. So the preview decodes both colours to linear light, adds the
 * glyph's colour scaled by its coverage, and encodes the sum back.
 *
 * Pure pixel maths, no canvas: render.ts reads the pixels and writes them back.
 */

/** sRGB byte to linear light, 0..1, one entry per byte. */
const TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear light, 0..1, back to the nearest sRGB byte; anything over 1 is white, as the sum saturates in game. */
export function toSrgbByte(l: number): number {
  if (!(l > 0)) return 0;
  if (l >= 1) return 255;
  const c = l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

/** An sRGB byte in linear light. */
export function toLinear(byte: number): number {
  return TO_LINEAR[byte & 255];
}

/**
 * Adds src onto dst in place, pixel by pixel: both are RGBA bytes of the same
 * size, as getImageData gives them (not premultiplied). src is the glyphs
 * drawn alone on a clear canvas, so its alpha is each pixel's coverage
 * (times the colour's own alpha). dst's alpha is left as it is: the scene
 * behind the HUD is opaque.
 */
export function addLinear(dst: Uint8ClampedArray, src: Uint8ClampedArray): void {
  for (let i = 0; i < dst.length; i += 4) {
    const a = src[i + 3] / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) dst[i + c] = toSrgbByte(TO_LINEAR[dst[i + c]] + TO_LINEAR[src[i + c]] * a);
  }
}

/**
 * Blends src over dst in place, the game's normal (non-additive) blend taken
 * in linear light: dst = src * a + dst * (1 - a), both decoded from sRGB and
 * the sum encoded back. Same layout as addLinear; dst's alpha is left alone.
 * Slice 2.F X12's skull: s_panel_dead's grey 129 at alpha 156 is 113 in game
 * and was 76 in the preview, whose linearOverAlpha remap is exact for black
 * texels only; this is exact for every texel.
 */
export function overLinear(dst: Uint8ClampedArray, src: Uint8ClampedArray): void {
  for (let i = 0; i < dst.length; i += 4) {
    const a = src[i + 3] / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) dst[i + c] = toSrgbByte(TO_LINEAR[src[i + c]] * a + TO_LINEAR[dst[i + c]] * (1 - a));
  }
}

/**
 * The alpha (a byte) at which a plain gamma-space blend of a black texel
 * darkens what is behind it as much as the game's blend of that texel at
 * `alpha` does in linear light: there, (1 - a) scales the backdrop's linear
 * light, which is its sRGB value times (1 - a)^(1/2.2), whatever the
 * backdrop. Exact for black texels (to the 2.2 power the sRGB curve is close
 * to), near for dark ones. Slice 2.F Task X13: the dead card art
 * (s_panel_dead, black at 156) leaves a 255 stripe at 168 in game and 99 in
 * a gamma-space canvas; through this, 166.
 */
export function linearOverAlpha(alpha: number): number {
  const a = Math.min(1, Math.max(0, alpha / 255));
  return Math.round(255 * (1 - (1 - a) ** (1 / 2.2)));
}
