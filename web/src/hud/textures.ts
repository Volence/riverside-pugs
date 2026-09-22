/** Pixel generators for HUD art. Plain arrays in, RGBA out, so they need no canvas and no DOM. */
export function parseColour(c: string): [number, number, number, number] {
  const p = c.split(' ').map((n) => Math.min(255, Math.max(0, parseInt(n, 10) || 0)));
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

export function vmtFor(materialName: string): string {
  return `UnlitGeneric\n{\n\t$basetexture "${materialName.toLowerCase()}"\n\t$translucent 1\n\t$vertexcolor 1\n\t$vertexalpha 1\n\t$ignorez 1\n\t$no_fullbright 1\n\t$nomip 1\n}\n`;
}
