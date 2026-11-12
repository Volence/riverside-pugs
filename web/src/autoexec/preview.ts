/**
 * Glow preview: real in-game shots with the game's own glow outlines laid on
 * in any colour.
 *
 * Every asset under /autoexec/ came from the owner's L4D1 client through the
 * in-game harness (~/l4d/hud/probe-autoexec-glow, NOTES.md there): a shot with
 * every glow off, then the same view with one glow set to white. The glow-*.png
 * masks hold, per pixel, how much light the glow adds at full colour (red
 * channel, square-root coded, solved from every unclipped channel of eight
 * colour shots so a bright background does not weaken it) and the black body
 * fill the game draws inside the outline (green channel). The game adds
 * colour^0.75 * k in plain sRGB values, the same in every view: the infected
 * views only look different because of their background grading. Checked
 * against held-out shots at the default colours (NOTES.md).
 */
import { type Rgb } from './glows';

export const SCENE_W = 960;
export const SCENE_H = 540;

export type MaskName =
  | 'standing' | 'standing2' | 'incap' | 'ghost1' | 'ghost2' | 'ghost3' | 'ghost4' | 'smoker' | 'ammo';

/** Where each outline was captured (half-size coordinates) and its PNG size; masks.json in the probe folder. */
export const MASK_AT: Record<MaskName, { x: number; y: number; w: number; h: number }> = {
  standing: { x: 515, y: 158, w: 53, h: 122 },
  standing2: { x: 569, y: 158, w: 54, h: 122 },
  incap: { x: 402, y: 223, w: 79, h: 63 },
  ghost1: { x: 340, y: 163, w: 54, h: 120 },
  ghost2: { x: 569, y: 156, w: 70, h: 129 },
  ghost3: { x: 639, y: 180, w: 61, h: 96 },
  ghost4: { x: 750, y: 176, w: 73, h: 102 },
  smoker: { x: 362, y: 346, w: 65, h: 160 },
  ammo: { x: 398, y: 192, w: 158, h: 69 },
};

/** Mask sizes at full scale, so labels can be placed before images load. */
export const MASK_SIZE: Record<MaskName, { w: number; h: number }> = Object.fromEntries(
  Object.entries(MASK_AT).map(([k, v]) => [k, { w: v.w, h: v.h }]),
) as Record<MaskName, { w: number; h: number }>;

/** The mask's red channel is sqrt(K / K_MAX): K can pass 1 where the game's outline core clips to white. */
const K_MAX = 3;

export interface Slot {
  key: string;
  mask: MaskName;
  x: number;
  y: number;
  scale: number;
  /** Put the label above the outline (when a neighbour's label would collide). */
  above?: boolean;
  /** Not captured in this shot: the outline is the game's, taken from another shot. */
  pasted?: boolean;
}

export type SceneId = 'survivor' | 'items' | 'ghost' | 'spawned';
export interface Scene {
  id: SceneId;
  title: string;
  src: string;
  slots: Slot[];
}

const at = (key: string, mask: MaskName): Slot => ({ key, mask, x: MASK_AT[mask].x, y: MASK_AT[mask].y, scale: 1 });

/**
 * Where each outline sits. Every slot without `pasted` is the game's own outline in that very shot.
 * The two infected scenes share slot keys, so a glow shows in whichever of them is on screen.
 */
export const SCENES: Scene[] = [
  {
    id: 'survivor', title: 'As a survivor', src: '/autoexec/scene-survivor.jpg',
    slots: [at('teammate', 'standing'), { ...at('boomed', 'standing2'), above: true }, { ...at('incap', 'incap'), above: true }],
  },
  {
    id: 'items', title: 'Item under your crosshair', src: '/autoexec/scene-items.jpg',
    slots: [at('item', 'ammo')],
  },
  {
    id: 'ghost', title: 'As infected: ghost', src: '/autoexec/scene-ghost.jpg',
    slots: [
      at('high', 'ghost1'), at('med', 'ghost2'), { ...at('low', 'ghost3'), above: true }, at('boomed', 'ghost4'),
      { key: 'teammate', mask: 'smoker', x: 150, y: 250, scale: 0.95, pasted: true },
    ],
  },
  {
    id: 'spawned', title: 'As infected: spawned', src: '/autoexec/scene-spawned.jpg',
    slots: [
      at('teammate', 'smoker'),
      { key: 'high', mask: 'standing', x: 40, y: 150, scale: 1.05, pasted: true },
      { key: 'med', mask: 'standing2', x: 800, y: 140, scale: 1.05, pasted: true },
      { key: 'low', mask: 'standing', x: 190, y: 172, scale: 0.85, pasted: true },
      { key: 'boomed', mask: 'standing2', x: 560, y: 160, scale: 0.9, pasted: true },
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
    k[i] = r * r * K_MAX;
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
    top: ((slot.above ? slot.y : slot.y + s.h * slot.scale) / SCENE_H) * 100,
    above: !!slot.above,
  };
}
