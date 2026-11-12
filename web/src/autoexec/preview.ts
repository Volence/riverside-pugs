/**
 * Glow preview: real in-game shots with the game's own glow outlines laid on
 * in any colour.
 *
 * Every asset under /autoexec/ came from the owner's L4D1 client through the
 * in-game harness (~/l4d/hud/probe-autoexec-glow, NOTES.md there): a shot with
 * every glow off, then the same view with one glow set to white. The glow-*.png
 * masks hold, per pixel, how much the white glow brightened the shot (red
 * channel, square-root coded) and the black body fill the game draws inside
 * the outline (green channel). Comparing against shots taken with other
 * colours, the game's result is matched best by adding colour^0.75 * k in
 * plain sRGB values: within ~6/255 of the real capture on average.
 */
import { type Rgb } from './glows';

export const SCENE_W = 960;
export const SCENE_H = 540;

export type MaskName = 'standing' | 'incap' | 'smoker';
const MASK_AT: Record<MaskName, { x: number; y: number }> = {
  standing: { x: 615, y: 155 },
  incap: { x: 279, y: 197 },
  smoker: { x: 360, y: 344 },
};

export interface Slot {
  key: string;
  mask: MaskName;
  x: number;
  y: number;
  scale: number;
}

export interface Scene {
  id: 'survivor' | 'infected';
  title: string;
  src: string;
  slots: Slot[];
}

/** Where each outline sits. The first slot of each mask is where it was captured; the rest are copies. */
export const SCENES: Scene[] = [
  {
    id: 'survivor', title: 'As a survivor', src: '/autoexec/scene-survivor.jpg',
    slots: [
      { key: 'teammate', mask: 'standing', ...MASK_AT.standing, scale: 1 },
      { key: 'incap', mask: 'incap', ...MASK_AT.incap, scale: 1 },
      { key: 'boomed', mask: 'standing', x: 800, y: 172, scale: 0.88 },
    ],
  },
  {
    id: 'infected', title: 'As infected', src: '/autoexec/scene-infected.jpg',
    slots: [
      { key: 'teammate', mask: 'smoker', ...MASK_AT.smoker, scale: 1 },
      { key: 'high', mask: 'standing', x: 40, y: 150, scale: 0.95 },
      { key: 'med', mask: 'standing', x: 790, y: 140, scale: 0.95 },
      { key: 'low', mask: 'standing', x: 190, y: 168, scale: 0.8 },
    ],
  },
];

const images = new Map<string, Promise<HTMLImageElement>>();
export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`could not load ${src}`));
      img.src = src;
    });
    images.set(src, p);
  }
  return p;
}

interface MaskData { w: number; h: number; k: Float32Array; fill: Float32Array }
const maskCache = new Map<string, MaskData>();

function maskData(img: HTMLImageElement, name: string, scale: number): MaskData {
  const key = `${name}@${scale}`;
  const hit = maskCache.get(key);
  if (hit) return hit;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const k = new Float32Array(w * h);
  const fill = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4] / 255;
    k[i] = r * r;
    fill[i] = px[i * 4 + 1] / 255;
  }
  const out = { w, h, k, fill };
  maskCache.set(key, out);
  return out;
}

/**
 * Paint one scene with a colour per slot (slots without a colour stay as the
 * plain shot: no glow, like a colour of 0 0 0 in game).
 */
export async function paintScene(
  canvas: HTMLCanvasElement, scene: Scene, colours: Record<string, Rgb | undefined>,
): Promise<void> {
  const [base, ...masks] = await Promise.all([
    loadImage(scene.src),
    ...scene.slots.map((s) => loadImage(`/autoexec/glow-${s.mask}.png`)),
  ]);
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(base, 0, 0, SCENE_W, SCENE_H);
  const frame = ctx.getImageData(0, 0, SCENE_W, SCENE_H);
  const d = frame.data;
  scene.slots.forEach((slot, i) => {
    const c = colours[slot.key];
    if (!c || (c[0] === 0 && c[1] === 0 && c[2] === 0)) return;
    const m = maskData(masks[i], slot.mask, slot.scale);
    const cr = Math.pow(c[0], 0.75) * 255, cg = Math.pow(c[1], 0.75) * 255, cb = Math.pow(c[2], 0.75) * 255;
    for (let y = 0; y < m.h; y++) {
      const fy = slot.y + y;
      if (fy < 0 || fy >= SCENE_H) continue;
      for (let x = 0; x < m.w; x++) {
        const fx = slot.x + x;
        if (fx < 0 || fx >= SCENE_W) continue;
        const mi = y * m.w + x;
        const k = m.k[mi], f = m.fill[mi];
        if (k === 0 && f === 0) continue;
        const o = (fy * SCENE_W + fx) * 4;
        d[o] = Math.min(255, d[o] * (1 - f) + cr * k);
        d[o + 1] = Math.min(255, d[o + 1] * (1 - f) + cg * k);
        d[o + 2] = Math.min(255, d[o + 2] * (1 - f) + cb * k);
      }
    }
  });
  ctx.putImageData(frame, 0, 0);
}

/** A slot's label anchor, in percent of the scene (centre, just under the outline). */
export function slotAnchor(slot: Slot, maskSize: Record<MaskName, { w: number; h: number }>) {
  const s = maskSize[slot.mask];
  return {
    left: ((slot.x + (s.w * slot.scale) / 2) / SCENE_W) * 100,
    top: ((slot.y + s.h * slot.scale) / SCENE_H) * 100,
  };
}

/** Mask sizes at full scale (the PNGs' own sizes), so labels can be placed before images load. */
export const MASK_SIZE: Record<MaskName, { w: number; h: number }> = {
  standing: { w: 70, h: 130 },
  incap: { w: 157, h: 100 },
  smoker: { w: 68, h: 162 },
};
