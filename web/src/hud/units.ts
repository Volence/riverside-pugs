/**
 * HUD coordinates.
 *
 * VGUI lays the HUD out on a grid 480 units tall whose width follows the
 * aspect ratio, and a position may be measured from the left (`"10"`), from
 * the right (`"r125"`: left edge 125 units in from the right) or from the
 * centre (`"c-13"`). The preview and the generator both go through these
 * functions, which is what stops the canvas disagreeing with the file.
 */
export type Aspect = '16:9' | '16:10' | '4:3';
export const SCREEN_H = 480;
const RATIO: Record<Aspect, number> = { '16:9': 16 / 9, '16:10': 16 / 10, '4:3': 4 / 3 };
export const screenW = (a: Aspect): number => Math.round(SCREEN_H * RATIO[a]);

const TOKEN = /^([rcf]?)(-?\d+(?:\.\d+)?)$/i;

export function parsePos(token: string, extent: number): number {
  const m = TOKEN.exec(token.trim());
  if (!m) return 0;
  const n = parseFloat(m[2]);
  const a = m[1].toLowerCase();
  if (a === 'r') return extent - n;
  if (a === 'c') return extent / 2 + n;
  return n;
}

export function parseSize(token: string, extent: number): number {
  const m = TOKEN.exec(token.trim());
  if (!m) return 0;
  const n = parseFloat(m[2]);
  return m[1].toLowerCase() === 'f' ? extent - n : n;
}

/** The anchor follows the element's centre: left third plain, middle third centre, right third right. */
export function formatPos(pos: number, size: number, extent: number): string {
  const centre = pos + size / 2;
  if (centre < extent / 3) return String(Math.round(pos));
  if (centre < (extent * 2) / 3) return `c${Math.round(pos - extent / 2)}`;
  return `r${Math.round(extent - pos)}`;
}

export function scaleToken(token: string, k: number): string {
  const m = TOKEN.exec(token.trim());
  if (!m) return token;
  if (m[1].toLowerCase() === 'f') return token;
  return `${m[1]}${Math.round(parseFloat(m[2]) * k)}`;
}
