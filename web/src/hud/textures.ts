/** Pixel generators for HUD art. Plain arrays in, RGBA out, so they need no canvas and no DOM. */
/** A "r g b [a]" colour, split on any run of whitespace, as a hand-written HUD may pad or double it. */
export function parseColour(c: string): [number, number, number, number] {
  const p = c.trim().split(/\s+/).map((n) => Math.min(255, Math.max(0, parseInt(n, 10) || 0)));
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 255];
}

export function flatTexture(w: number, h: number, colour: string): Uint8ClampedArray {
  const [r, g, b, a] = parseColour(colour);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a; }
  return out;
}

/** Coverage of pixel (x, y) by a rounded rectangle, 0 to 1, with a one pixel soft edge. */
function coverage(x: number, y: number, w: number, h: number, r: number): number {
  const cx = Math.min(Math.max(x + 0.5, r), w - r);
  const cy = Math.min(Math.max(y + 0.5, r), h - r);
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return Math.min(1, Math.max(0, r - d + 0.5));
}

export function roundedTexture(w: number, h: number, colour: string, radius: number): Uint8ClampedArray {
  const out = flatTexture(w, h, colour);
  const a = parseColour(colour)[3];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(y * w + x) * 4 + 3] = Math.round(a * coverage(x, y, w, h, radius));
  return out;
}

/**
 * The Fade splatter: the colour at its own alpha on the left edge, fading
 * linearly to clear at the right, the same on every row, so it reads as a
 * clean bar behind a card or a health bar whatever height the panel shows.
 */
export function fadeTexture(w: number, h: number, colour: string): Uint8ClampedArray {
  const [r, g, b, a] = parseColour(colour);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let x = 0; x < w; x++) {
    const alpha = Math.round(a * (1 - (x + 0.5) / w));
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = alpha;
    }
  }
  return out;
}

/**
 * `vertexColor: false` leaves out `$vertexcolor 1`. Without it the engine
 * ignores the draw colour's RGB (keeping its alpha), which is how "Keep my
 * colours" stops client.dll's health tint on the scratches. That is unproven
 * in game until the in-game check of the custom splatter plan. The default
 * output is what every existing download ships and must not change.
 */
export function vmtFor(materialName: string, opts: { vertexColor?: boolean } = {}): string {
  const vc = opts.vertexColor !== false ? '\t$vertexcolor 1\n' : '';
  return `UnlitGeneric\n{\n\t$basetexture "${materialName.toLowerCase()}"\n\t$translucent 1\n${vc}\t$vertexalpha 1\n\t$ignorez 1\n\t$no_fullbright 1\n\t$nomip 1\n}\n`;
}
