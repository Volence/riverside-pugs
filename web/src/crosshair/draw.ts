/** Crosshair geometry, shared by the live preview and the exported texture. */

export type Shape = 'cross' | 'crossdot' | 't' | 'dot' | 'circle' | 'circledot' | 'image';
/** A real in-game shot with the HUD off: web/public/hud-backdrops/, from /home/volence/l4d/hud/backdrops/ (its README says where each was taken). */
export type GameBackdrop = 'survivor-hilltop' | 'survivor-subway' | 'infected-hunter' | 'infected-ghost';
export type Backdrop = 'scene' | 'dark' | 'bright' | 'grey' | 'shot' | GameBackdrop;
export type Res = '768' | '1080' | '1440' | '2160';

export interface CrosshairState {
  shape: Shape;
  len: number;
  thick: number;
  gap: number;
  dot: number;
  radius: number;
  round: boolean;
  color: string;
  alpha: number;
  outline: number;
  oalpha: number;
  backdrop: Backdrop;
  res: Res;
}

export const DEFAULT_STATE: CrosshairState = {
  shape: 'cross', len: 7, thick: 2, gap: 3, dot: 2, radius: 8, round: false,
  color: '#39ff5a', alpha: 100, outline: 1, oalpha: 80, backdrop: 'scene', res: '1080',
};

/** Exported texture size, and the HUD element size in 640x480 VGUI units that
 *  hudlayout.res asks for. Every drawing parameter is in 1080p screen pixels,
 *  so PX_AT_1080 is what converts between the two. */
export const TEX = 128;
const UNITS = 26;
export const PX_AT_1080 = UNITS * 1080 / 480;

export const RES_SCALE: Record<Res, number> = {
  '768': 768 / 1080, '1080': 1, '1440': 4 / 3, '2160': 2,
};

export const PRESETS: Record<string, Partial<CrosshairState>> = {
  'Classic green': { shape: 'cross', len: 7, thick: 2, gap: 3, color: '#39ff5a', alpha: 100, outline: 1, oalpha: 80, round: false },
  'Small cyan': { shape: 'cross', len: 4, thick: 1.5, gap: 2, color: '#33e6ff', alpha: 100, outline: 1, oalpha: 90, round: false },
  'Dot': { shape: 'dot', dot: 3, color: '#ffffff', alpha: 100, outline: 1, oalpha: 100 },
  'T yellow': { shape: 't', len: 8, thick: 2, gap: 4, color: '#ffe14d', alpha: 100, outline: 1, oalpha: 80, round: false },
  'Circle + dot': { shape: 'circledot', radius: 8, thick: 1.5, dot: 2, color: '#ff4dd8', alpha: 90, outline: 0.5, oalpha: 80 },
  'Cross + dot': { shape: 'crossdot', len: 6, thick: 2, gap: 4, dot: 2, color: '#ffffff', alpha: 100, outline: 1, oalpha: 70, round: true },
};

export const SWATCHES = ['#39ff5a', '#33e6ff', '#ffffff', '#ffe14d', '#ff4dd8', '#ff5a3c'];

function hexToRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

const ARMS: Partial<Record<Shape, [number, number][]>> = {
  cross: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  crossdot: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  t: [[1, 0], [-1, 0], [0, 1]],
};

/**
 * Draw the crosshair centred at (cx, cy).
 *
 * `k` is pixels per 1080p screen pixel, which is what lets one routine serve
 * both the on-screen preview at any resolution and the 128px export texture.
 * The outline is a wider pass drawn first, under the colour pass.
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, k: number,
  s: CrosshairState, importedImage: CanvasImageSource | null,
): void {
  if (s.shape === 'image') {
    if (!importedImage) return;
    const size = PX_AT_1080 * k;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(importedImage, cx - size / 2, cy - size / 2, size, size);
    return;
  }

  const caps: CanvasLineCap = s.round ? 'round' : 'butt';
  const passes: { color: string; extra: number }[] = [];
  if (s.outline > 0 && s.oalpha > 0) passes.push({ color: `rgba(0,0,0,${s.oalpha / 100})`, extra: s.outline });
  passes.push({ color: rgba(s.color, s.alpha / 100), extra: 0 });

  const arms = ARMS[s.shape] ?? [];
  const hasDot = s.shape === 'dot' || s.shape === 'crossdot' || s.shape === 'circledot';
  const hasCircle = s.shape === 'circle' || s.shape === 'circledot';

  for (const p of passes) {
    ctx.strokeStyle = p.color;
    ctx.fillStyle = p.color;
    ctx.lineCap = caps;
    ctx.lineJoin = 'round';
    const t = (s.thick + 2 * p.extra) * k;
    if (arms.length) {
      ctx.lineWidth = t;
      ctx.beginPath();
      const g = s.gap * k - p.extra * k;
      const L = s.len * k + p.extra * k;
      for (const [dx, dy] of arms) {
        ctx.moveTo(cx + dx * g, cy + dy * g);
        ctx.lineTo(cx + dx * (g + L), cy + dy * (g + L));
      }
      ctx.stroke();
    }
    if (hasCircle) {
      ctx.lineWidth = t;
      ctx.beginPath();
      ctx.arc(cx, cy, s.radius * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (hasDot) {
      ctx.beginPath();
      ctx.arc(cx, cy, (s.dot / 2 + p.extra) * k, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** The in-game shots, all 1920 x 1080 JPEGs. */
export const GAME_BACKDROPS: Record<GameBackdrop, { src: string; label: string }> = {
  'survivor-hilltop': { src: '/hud-backdrops/survivor-hilltop.jpg', label: 'Survivor: forest' },
  'survivor-subway': { src: '/hud-backdrops/survivor-subway.jpg', label: 'Survivor: saferoom' },
  'infected-hunter': { src: '/hud-backdrops/infected-hunter.jpg', label: 'Infected: Hunter' },
  'infected-ghost': { src: '/hud-backdrops/infected-ghost.jpg', label: 'Infected: ghost' },
};

/**
 * The shot each side is previewed on when nobody picked one: the HUD editor's
 * default and the shared previews'. The Hunter rather than the ghost for
 * infected, because the ghost shot has a smeared band over the hands along
 * its bottom edge, right where the HUD sits.
 */
export const SIDE_BACKDROP: Record<'survivor' | 'infected', GameBackdrop> = {
  survivor: 'survivor-hilltop',
  infected: 'infected-hunter',
};

export function isGameBackdrop(kind: string): kind is GameBackdrop {
  return Object.hasOwn(GAME_BACKDROPS, kind);
}

interface GameShot { img: HTMLImageElement; state: 'loading' | 'ready' | 'failed'; waiting: (() => void)[] }
const shots = new Map<GameBackdrop, GameShot>();

function shotOf(kind: GameBackdrop): GameShot {
  let s = shots.get(kind);
  if (s) return s;
  const img = new Image();
  const shot: GameShot = { img, state: 'loading', waiting: [] };
  const settle = (state: 'ready' | 'failed') => {
    shot.state = state;
    const waiting = shot.waiting;
    shot.waiting = [];
    for (const f of waiting) f();
  };
  img.onload = () => settle('ready');
  img.onerror = () => settle('failed');
  img.src = GAME_BACKDROPS[kind].src;
  shots.set(kind, shot);
  s = shot;
  return s;
}

/** The shot once it has loaded, or null (and `onLoad` runs once it does). Loaded once per page. */
export function gameBackdropImage(kind: GameBackdrop, onLoad?: () => void): HTMLImageElement | null {
  const s = shotOf(kind);
  if (s.state === 'ready') return s.img;
  if (s.state === 'loading' && onLoad) s.waiting.push(onLoad);
  return null;
}

/** The shot, waited for; null when it cannot load. */
export function loadGameBackdrop(kind: GameBackdrop): Promise<HTMLImageElement | null> {
  const s = shotOf(kind);
  if (s.state !== 'loading') return Promise.resolve(s.state === 'ready' ? s.img : null);
  return new Promise((resolve) => s.waiting.push(() => resolve(s.state === 'ready' ? s.img : null)));
}

/** Tests only: forget every loaded shot. */
export function resetGameBackdrops(): void {
  shots.clear();
}

/** Draw `img` (iw x ih) to cover the canvas, centred, cropping what is over. */
function cover(ctx: CanvasRenderingContext2D, w: number, h: number, img: CanvasImageSource, iw: number, ih: number): void {
  const r = Math.max(w / iw, h / ih);
  const sw = iw * r;
  const sh = ih * r;
  ctx.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh);
}

/** The preview background. `shot` is a user-supplied screenshot; `scene` is a
 *  drawn stand-in for a saferoom, so the crosshair can be judged against both
 *  a light wall and a dark floor at once; a GameBackdrop is a real in-game
 *  shot, drawn dark until it has loaded, when `onLoad` runs so the caller
 *  can paint again. */
export function drawBackdrop(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  kind: Backdrop, shotImage: CanvasImageSource | null, shotSize: { w: number; h: number } | null,
  onLoad?: () => void,
): void {
  if (kind === 'shot' && shotImage && shotSize) {
    cover(ctx, w, h, shotImage, shotSize.w, shotSize.h);
    return;
  }
  if (isGameBackdrop(kind)) {
    const img = gameBackdropImage(kind, onLoad);
    if (img) { cover(ctx, w, h, img, img.naturalWidth || 1920, img.naturalHeight || 1080); return; }
    kind = 'dark';
  }
  const flat: Partial<Record<Backdrop, string>> = { dark: '#17161a', bright: '#c9c2b2', grey: '#7a7a7a' };
  const f = flat[kind];
  if (f) { ctx.fillStyle = f; ctx.fillRect(0, 0, w, h); return; }

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#8f8676');
  g.addColorStop(0.55, '#b9ae98');
  g.addColorStop(0.56, '#5e5647');
  g.addColorStop(1, '#3d3830');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const r = ctx.createRadialGradient(w * 0.5, h * 0.15, 10, w * 0.5, h * 0.15, w * 0.6);
  r.addColorStop(0, 'rgba(255,240,200,0.35)');
  r.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let i = 0; i < 40; i++) {
    const x = (i * 97) % w;
    const y = (i * 53) % (h * 0.55);
    ctx.fillRect(x, y, 30 + (i % 5) * 12, 2);
  }
}
