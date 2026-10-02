/**
 * Where caster cams sit on the 1920x1080 casters scene. Shared by the overlay
 * (which draws the frames) and the OBS scene collection (which places each
 * cam's browser source inside its frame), so the two cannot drift. No
 * imports: the web project includes this file as it is.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export const CANVAS = { w: 1920, h: 1080 } as const;

/** 16:9 frames, centred as a row, for one to three casters. */
export function camSlots(n: number): Rect[] {
  const count = Math.max(1, Math.min(3, Math.floor(n)));
  const w = count === 1 ? 1120 : count === 2 ? 820 : 560;
  const h = Math.round((w * 9) / 16);
  const gap = count === 1 ? 0 : count === 2 ? 60 : 50;
  const total = count * w + (count - 1) * gap;
  const x0 = Math.round((CANVAS.w - total) / 2);
  const y = count === 1 ? 210 : count === 2 ? 270 : 330;
  return Array.from({ length: count }, (_, i) => ({ x: x0 + i * (w + gap), y, w, h }));
}
