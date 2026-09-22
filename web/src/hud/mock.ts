/**
 * The canvas preview: a believable stand-in for each HUD element, drawn from
 * plain shapes and text, never game art. `elementRect` is the only source of
 * where anything sits, so this file never computes a position on its own;
 * disagreeing with the generator here would defeat the point of a preview.
 */
import type { HudDesign } from './design';
import { ELEMENTS, elementById, type HudElement } from './elements';
import { elementRect, teamLayout } from './build';
import { SCREEN_H } from './units';
import { parseColour } from './textures';
import { DEFAULT_STATE, drawCrosshair, type CrosshairState } from '../crosshair/draw';

export type Side = 'survivor' | 'infected';

export function visibleElements(side: Side): HudElement[] {
  return ELEMENTS.filter((e) => e.side === side || e.side === 'both');
}

interface Rect { x: number; y: number; w: number; h: number; visible: boolean }

function rectFor(design: HudDesign, id: string): Rect {
  return elementRect(design, id, design.aspect);
}

/** Smallest-area element under the point wins, so a small element sitting
 *  inside a larger container (the crosshair inside the whole screen, say)
 *  stays selectable. */
export function hitTest(design: HudDesign, side: Side, ux: number, uy: number): string | null {
  let best: { id: string; area: number } | null = null;
  for (const el of visibleElements(side)) {
    const r = rectFor(design, el.id);
    if (!r.visible) continue;
    if (ux < r.x || ux > r.x + r.w || uy < r.y || uy > r.y + r.h) continue;
    const area = r.w * r.h;
    if (!best || area < best.area) best = { id: el.id, area };
  }
  return best ? best.id : null;
}

/** Per-viewer convenience only, so the read is guarded like every other
 *  localStorage access in this codebase: a private window or blocked site
 *  data makes it throw rather than return a crosshair. */
function loadXhairState(): CrosshairState {
  try {
    const raw = localStorage.getItem('xhair');
    return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

function fallbackRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath(); ctx.rect(x, y, w, h);
}

/** Draws the `panelBg` slot's own colour behind an element when the player
 *  restyled it, so a restyle shows up in the preview immediately. */
function panelBg(ctx: CanvasRenderingContext2D, design: HudDesign, x: number, y: number, w: number, h: number, fallback: string) {
  const style = design.styles.panelBg;
  const colourStr = style && (style.kind === 'flat' || style.kind === 'rounded') ? style.color ?? fallback : fallback;
  const [r, g, b, a] = parseColour(colourStr);
  ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
  if (style?.kind === 'rounded') { fallbackRoundRect(ctx, x, y, w, h, Math.min(8, w / 4, h / 4)); ctx.fill(); }
  else ctx.fillRect(x, y, w, h);
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, colour: string, weight = ''): void {
  ctx.fillStyle = colour;
  ctx.font = `${weight} ${size}px sans-serif`.trim();
  ctx.fillText(s, x, y);
}

// --- painters, one per element id, each drawing a believable stand-in ---

function paintOwnHealth(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign) {
  panelBg(ctx, design, r.x, r.y, r.w, r.h, '0 0 0 140');
  const portrait = r.h * 0.7;
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(r.x + 6, r.y + (r.h - portrait) / 2, portrait, portrait);
  const barX = r.x + portrait + 16, barW = r.w - portrait - 26, barY = r.y + r.h / 2 - 4, barH = 8;
  ctx.fillStyle = '#2a2a2a'; ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = '#4cd964'; ctx.fillRect(barX, barY, barW * 0.75, barH);
  text(ctx, '100', r.x + r.w - 30, r.y + r.h / 2 - 8, 14, '#ffffff', 'bold');
}

const TEAMMATE_NAMES = ['Francis', 'Louis', 'Zoey'];
const TEAM_CARDS = 3;

interface CardRect { x: number; y: number; w: number; h: number }

/** Card rects for a team-style element, laid out by the same direction and
 *  spacing `teamLayout` gives the generator's own team pass, so the preview
 *  can never disagree with the file the generator writes. */
function teamCards(design: HudDesign, id: string, r: Rect, k: number): CardRect[] {
  const { dir, spacing: gap } = teamLayout(design, elementById(id)!);
  const spacing = gap * k;
  const w = dir === 'row' ? Math.min(spacing, r.w / TEAM_CARDS) : r.w;
  const h = dir === 'row' ? r.h : Math.min(spacing, r.h / TEAM_CARDS);
  return Array.from({ length: TEAM_CARDS }, (_, i) => ({
    x: r.x + (dir === 'row' ? spacing * i : 0),
    y: r.y + (dir === 'column' ? spacing * i : 0),
    w, h,
  }));
}

function paintTeamColumn(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number) {
  for (const [i, c] of teamCards(design, 'teamColumn', r, k).entries()) {
    panelBg(ctx, design, c.x, c.y, c.w, c.h, '0 0 0 140');
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(c.x + 4, c.y + 4, c.h * 0.5, c.h * 0.5);
    text(ctx, TEAMMATE_NAMES[i], c.x + 4, c.y + c.h * 0.5 + 16, 11, '#ffffff');
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(c.x + 4, c.y + c.h - 10, c.w - 8, 5);
    ctx.fillStyle = '#4cd964'; ctx.fillRect(c.x + 4, c.y + c.h - 10, (c.w - 8) * 0.6, 5);
  }
}

function paintWeaponSelection(ctx: CanvasRenderingContext2D, r: Rect) {
  const slots = 5;
  const gap = 2;
  const boxH = (r.h - gap * (slots - 1)) / slots;
  for (let i = 0; i < slots; i++) {
    const y = r.y + i * (boxH + gap);
    ctx.fillStyle = i === 1 ? 'rgba(210,190,60,0.85)' : 'rgba(0,0,0,0.5)';
    ctx.fillRect(r.x, y, r.w, boxH);
  }
}

function paintChat(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  text(ctx, 'Zoey: watch the closet', r.x + 4, r.y + r.h - 28, 12, '#e8e8e8');
  text(ctx, 'Francis: got it', r.x + 4, r.y + r.h - 12, 12, '#e8e8e8');
}

function paintKillFeed(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.textAlign = 'right';
  text(ctx, 'Louis killed a Hunter', r.x + r.w, r.y + 16, 12, '#e8e8e8');
  text(ctx, 'A Smoker killed Zoey', r.x + r.w, r.y + 34, 12, '#e8e8e8');
  ctx.textAlign = 'left';
}

function paintTargetId(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.textAlign = 'center';
  text(ctx, 'Louis', r.x + r.w / 2, r.y + r.h / 2 + 4, 12, '#ffffff');
  ctx.textAlign = 'left';
}

function paintProgressBar(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = '#e8c23c';
  ctx.fillRect(r.x, r.y, r.w * 0.5, r.h);
}

function paintXhair(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
  const k = r.w / 26; // 26 HUD units, drawCrosshair's own scale
  drawCrosshair(ctx, r.x + r.w / 2, r.y + r.h / 2, k, loadXhairState(), null);
}

function paintInfectedRow(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number) {
  for (const c of teamCards(design, 'infectedRow', r, k)) {
    panelBg(ctx, design, c.x, c.y, c.w, c.h, '0 0 0 140');
  }
}

function paintSiHealth(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = '#4cd964';
  ctx.fillRect(r.x + 4, r.y + r.h - 14, r.w - 8, 8);
  text(ctx, '250', r.x + r.w - 30, r.y + 16, 14, '#ffffff', 'bold');
}

function paintAbilityRing(ctx: CanvasRenderingContext2D, r: Rect) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, radius = Math.min(r.w, r.h) / 2 - 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.5); ctx.stroke();
}

function paintGhostPanel(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.textAlign = 'center';
  text(ctx, 'You will spawn as a', r.x + r.w / 2, r.y + r.h / 2 - 8, 13, '#e8e8e8');
  text(ctx, 'Hunter in 12', r.x + r.w / 2, r.y + r.h / 2 + 12, 13, '#e8e8e8');
  ctx.textAlign = 'left';
}

function paintTankPanel(ctx: CanvasRenderingContext2D, r: Rect) {
  text(ctx, 'Frustration', r.x, r.y + 12, 12, '#e8e8e8');
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(r.x, r.y + 18, r.w, r.h - 18);
  ctx.fillStyle = '#d64545';
  ctx.fillRect(r.x, r.y + 18, r.w * 0.5, r.h - 18);
}

const PAINTERS: Record<string, (ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number) => void> = {
  ownHealth: paintOwnHealth,
  teamColumn: paintTeamColumn,
  weaponSelection: paintWeaponSelection,
  chat: paintChat,
  killFeed: paintKillFeed,
  targetId: paintTargetId,
  progressBar: paintProgressBar,
  xhair: paintXhair,
  infectedRow: paintInfectedRow,
  siHealth: paintSiHealth,
  abilityRing: paintAbilityRing,
  ghostPanel: paintGhostPanel,
  tankPanel: paintTankPanel,
};

const FALLBACK_ACCENT = '#de4e40';

function accentColour(ctx: CanvasRenderingContext2D): string {
  try {
    const v = getComputedStyle(ctx.canvas).getPropertyValue('--accent').trim();
    return v || FALLBACK_ACCENT;
  } catch {
    return FALLBACK_ACCENT;
  }
}

function drawSelection(ctx: CanvasRenderingContext2D, r: Rect, el: HudElement, accent: string) {
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  if (el.resize === 'free') {
    const s = 8;
    ctx.fillStyle = accent;
    ctx.fillRect(r.x + r.w - s / 2, r.y + r.h - s / 2, s, s);
  }
  ctx.restore();
}

function drawHiddenOutline(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

export function drawHud(
  ctx: CanvasRenderingContext2D, pxW: number, pxH: number, design: HudDesign, side: Side, selectedId: string | null,
): void {
  ctx.clearRect(0, 0, pxW, pxH);
  const k = pxH / SCREEN_H;
  const accent = accentColour(ctx);

  for (const el of visibleElements(side)) {
    const u = rectFor(design, el.id);
    const hidden = !u.visible;
    if (hidden && el.id !== selectedId) continue;

    const r: Rect = { x: u.x * k, y: u.y * k, w: u.w * k, h: u.h * k, visible: u.visible };
    const paint = PAINTERS[el.id];
    if (!paint) continue;

    if (hidden) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      paint(ctx, r, design, k);
      ctx.restore();
      drawHiddenOutline(ctx, r);
    } else {
      paint(ctx, r, design, k);
    }

    if (el.id === selectedId) drawSelection(ctx, r, el, accent);
  }
}
