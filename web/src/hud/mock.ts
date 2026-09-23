/**
 * The canvas preview. `elementRect` is the only source of where an element
 * sits, and the generated .res trees the only source of where anything
 * inside one sits, so this file never computes a position on its own;
 * disagreeing with the generator here would defeat the point of a preview.
 *
 * Four elements (ownHealth, teamColumn, infectedRow, siHealth) are drawn
 * straight from the generated .res files by render.ts's drawPanel, with the
 * real exported game art, so an edit to a slot or a scale is an edit to the
 * picture. Every other element here is still a hand-made stand-in drawn from
 * plain shapes and text.
 */
import type { Box, HudDesign } from './design';
import { ELEMENTS, elementById, type HudElement } from './elements';
import type { Guide } from './guides';
import { buildTrees, elementRect, teamLayout, teamCardRects, isFreeTeam } from './build';
import { kvFind, kvGet } from './kv';
import { SCREEN_H } from './units';
import { drawPanel, childRects, hiddenInState, type CardState } from './render';
import { DEFAULT_STATE, drawCrosshair, type CrosshairState } from '../crosshair/draw';
import { teamChild } from './children';

export type Side = 'survivor' | 'infected';

export function visibleElements(side: Side): HudElement[] {
  return ELEMENTS.filter((e) => e.side === side || e.side === 'both');
}

/** What a painter is handed: a box in canvas pixels. Whether the element is
 *  visible is decided before a painter is ever called, so it is not part of
 *  this; `rectFor` carries it because hit-testing and drawHud both need it. */
interface Rect { x: number; y: number; w: number; h: number }

/**
 * What the page asks the canvas to show beyond the design, all in HUD
 * units, all measured by selection.ts from the generator's trees: the
 * teammate card state, the selection's outlines (one per selected thing as
 * drawn, so a piece is outlined in every card), the box its handles sit on
 * and the handle points, the hover outline and its name, the Shift+drag box,
 * and the snap guides of a drag under way.
 */
export interface HudView {
  state?: CardState;
  frames?: Box[];
  box?: Box | null;
  handles?: { x: number; y: number }[];
  hover?: { rects: Box[]; label: string } | null;
  marquee?: Box | null;
  guides?: Guide[];
}

/** Whether a point is on a box, edges included. */
export const inside = (r: Rect, ux: number, uy: number) => ux >= r.x && ux <= r.x + r.w && uy >= r.y && uy <= r.y + r.h;

function rectFor(design: HudDesign, id: string): Rect & { visible: boolean } {
  return elementRect(design, id, design.aspect);
}

/** Card 4 shows only while spectating a full team: never drawn, never a target. */
export const TEAM_CARDS = 3;

/** Smallest-area element under the point wins, so a small element sitting
 *  inside a larger container (the crosshair inside the whole screen, say)
 *  stays selectable. In Free the teammates' container covers the screen, so
 *  there the three drawn cards are the targets instead of the container. */
export function hitTest(design: HudDesign, side: Side, ux: number, uy: number): string | null {
  let best: { id: string; area: number } | null = null;
  for (const el of visibleElements(side)) {
    const r = rectFor(design, el.id);
    if (!r.visible) continue;
    const targets = el.id === 'teamColumn' && isFreeTeam(design) ? teamCardRects(design, design.aspect).slice(0, TEAM_CARDS) : [r];
    for (const t of targets) {
      if (!inside(t, ux, uy)) continue;
      const area = t.w * t.h;
      if (!best || area < best.area) best = { id: el.id, area };
    }
  }
  return best ? best.id : null;
}

/**
 * The smallest teammate-card child under the point, in whichever of the
 * three drawn cards it falls, or null. A child counts only where the card
 * and the container both let it show (VGUI clips to both), only when the
 * preview draws it in `state`, and only when the registry lists it. Decor
 * (the splatter, the card background) is the lowest priority: a real piece
 * on top always wins, but where no real piece is under the point, a decor
 * piece there is picked instead of leaving the point to mean the card, so
 * the splatter is reachable by a plain click, not only from Layers. The
 * card background is never a target either way, since it carries no
 * registry entry (`teamChild` returns nothing for it). The rects come from
 * the generated tree through childRects, like everything the canvas draws.
 */
export function childAt(
  design: HudDesign, state: CardState, ux: number, uy: number,
): { name: string; card: number } | null {
  const container = rectFor(design, 'teamColumn');
  if (!container.visible || !inside(container, ux, uy)) return null;
  let best: { name: string; card: number; area: number } | null = null;
  let decor: { name: string; card: number; area: number } | null = null;
  for (const [i, c] of teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).entries()) {
    if (!inside(c, ux, uy)) continue;
    for (const r of childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1)) {
      const def = teamChild(r.name);
      if (!def || !r.visible || hiddenInState('teamColumn', r.name, state) || !inside(r, ux, uy)) continue;
      const area = r.w * r.h;
      if (def.role === 'decor') { if (!decor || area < decor.area) decor = { name: r.name, card: i, area }; continue; }
      if (!best || area < best.area) best = { name: r.name, card: i, area };
    }
  }
  const hit = best ?? decor;
  return hit && { name: hit.name, card: hit.card };
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

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, colour: string, weight = ''): void {
  ctx.fillStyle = colour;
  ctx.font = `${weight} ${size}px sans-serif`.trim();
  ctx.fillText(s, x, y);
}

// --- painters, one per element id ---

/**
 * The panel a file's children really live in, read from the generator's own
 * tree: its offset inside the element and its size, in canvas pixels. VGUI
 * clips every child to that parent, not to the hudlayout element around it,
 * so the preview clips to the same rect or it shows what the game cuts off.
 */
function parentPanel(design: HudDesign, file: string, key: string, k: number): Rect {
  const n = kvFind(buildTrees(design)(file), [key]);
  if (!n) throw new Error(`${file}: no panel ${key}`);
  const v = (name: string) => { const f = parseFloat(kvGet(n, name) ?? ''); return Number.isFinite(f) ? f * k : 0; };
  return { x: v('xpos'), y: v('ypos'), w: v('wide'), h: v('tall') };
}

/** The player's own health panel lives in LocalPlayer, which localplayerdisplay.res places inside the element. */
function paintOwnHealth(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  const p = parentPanel(design, 'resource/ui/hud/localplayerdisplay.res', 'LocalPlayer', k);
  const local = { x: r.x + p.x, y: r.y + p.y, w: p.w, h: p.h };
  clipToRect(ctx, r, () => clipToRect(ctx, local, () => drawPanel(ctx, design, 'ownHealth', { x: local.x, y: local.y }, k, { onAsset })));
}

interface CardRect { x: number; y: number; w: number; h: number }

/**
 * Card rects for the infected row, in canvas pixels. Now that
 * `paintTeamColumn` draws the survivor cards from `teamCardRects`, this
 * serves the infected row only: its cards have no fit offset (the game
 * places them itself), so there is no file to agree with and each card is
 * fitted to the element's own rect instead.
 */
function teamCards(design: HudDesign, id: string, r: Rect, k: number): CardRect[] {
  const t = teamLayout(design, elementById(id)!);
  const spacing = t.spacing * k;
  const w = t.card ? t.card.w * k : (t.dir === 'row' ? Math.min(spacing, r.w / TEAM_CARDS) : r.w);
  const h = t.card ? t.card.h * k : (t.dir === 'row' ? r.h : Math.min(spacing, r.h / TEAM_CARDS));
  return Array.from({ length: TEAM_CARDS }, (_, i) => ({
    x: r.x + (t.dir === 'row' ? spacing * i : 0),
    y: r.y + (t.dir === 'column' ? spacing * i : 0),
    w, h,
  }));
}

/** The real container clips its children, and `elementRect` reports that same
 *  container once the generator has written one, so clipping here shows the
 *  player exactly what the game will cut off. Without it a card could be
 *  drawn where the real HUD would never show one, and be clicked through. */
function clipToRect(ctx: CanvasRenderingContext2D, r: Rect, draw: () => void) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  draw();
  ctx.restore();
}

/**
 * Each teammate card is drawn where the generated teamdisplayhud.res puts
 * it, at its own size, clipped to that card (VGUI clips a card's children to
 * the card) and to the container. All three draw from the one card file.
 */
function paintTeamColumn(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  clipToRect(ctx, r, () => {
    for (const [i, c] of teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).entries()) {
      const card = { x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k };
      clipToRect(ctx, card, () => drawPanel(ctx, design, 'teamColumn', { x: card.x, y: card.y }, k, { card: i, onAsset, state: view.state }));
    }
  });
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

function paintInfectedRow(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  clipToRect(ctx, r, () => {
    for (const [i, c] of teamCards(design, 'infectedRow', r, k).entries()) {
      drawPanel(ctx, design, 'infectedRow', { x: c.x, y: c.y }, k, { card: i, onAsset });
    }
  });
}

/** Six infected share one card at six placements; the preview shows the Hunter's. */
function paintSiHealth(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  clipToRect(ctx, r, () => drawPanel(ctx, design, 'siHealth', { x: r.x, y: r.y }, k, { onAsset }));
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

const PAINTERS: Record<string, (ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view?: HudView) => void> = {
  ownHealth: paintOwnHealth,
  teamColumn: paintTeamColumn,
  weaponSelection: paintWeaponSelection,
  chat: paintChat,
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

function drawHiddenOutline(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

/** Handles are a fixed size on screen, whatever the canvas scale. */
const HANDLE_PX = 7;
const GUIDE = '#ff4fa3';
const MARQUEE = 'rgba(153,204,255,0.9)';
const MARQUEE_FILL = 'rgba(153,204,255,0.13)';

function drawFrames(ctx: CanvasRenderingContext2D, frames: Box[], k: number, accent: string) {
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  for (const f of frames) ctx.strokeRect(f.x * k, f.y * k, f.w * k, f.h * k);
  ctx.restore();
}

/** The selection's box, thin, and a white square with an accent edge on each handle point. */
function drawHandles(ctx: CanvasRenderingContext2D, box: Box | null, points: { x: number; y: number }[], k: number, accent: string) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = accent;
  if (box) ctx.strokeRect(box.x * k, box.y * k, box.w * k, box.h * k);
  for (const p of points) {
    const x = p.x * k - HANDLE_PX / 2, y = p.y * k - HANDLE_PX / 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, HANDLE_PX, HANDLE_PX);
    ctx.strokeRect(x, y, HANDLE_PX, HANDLE_PX);
  }
  ctx.restore();
}

/** What a click would pick: a dashed white outline and its name in a small label above the first rect. */
function drawHover(ctx: CanvasRenderingContext2D, hover: { rects: Box[]; label: string }, k: number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const r of hover.rects) ctx.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
  ctx.setLineDash([]);
  const first = hover.rects[0];
  if (first && hover.label) {
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const w = ctx.measureText(hover.label).width + 8;
    const x = first.x * k, y = Math.max(0, first.y * k - 16);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(x, y, w, 14);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(hover.label, x + 4, y + 11);
  }
  ctx.restore();
}

function drawMarquee(ctx: CanvasRenderingContext2D, m: Box, k: number) {
  ctx.save();
  ctx.fillStyle = MARQUEE_FILL;
  ctx.fillRect(m.x * k, m.y * k, m.w * k, m.h * k);
  ctx.strokeStyle = MARQUEE;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(m.x * k, m.y * k, m.w * k, m.h * k);
  ctx.restore();
}

function drawGuides(ctx: CanvasRenderingContext2D, guides: Guide[], k: number) {
  ctx.save();
  ctx.strokeStyle = GUIDE;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const g of guides) {
    ctx.beginPath();
    if (g.axis === 'x') { ctx.moveTo(g.at * k, g.from * k); ctx.lineTo(g.at * k, g.to * k); }
    else { ctx.moveTo(g.from * k, g.at * k); ctx.lineTo(g.to * k, g.at * k); }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draws the HUD mock over whatever is already on the canvas.
 *
 * The caller is responsible for painting the backdrop first: this function
 * does not clear the canvas, it draws on top of it. Every translucent mock
 * element (the weapon boxes, chat, the progress bar track, the team cards)
 * is designed to read against that backdrop, not against a blank canvas.
 *
 * ownHealth, teamColumn, infectedRow and siHealth are drawn from the
 * generated .res files by render.ts, not as stand-ins here; the rest are
 * hand-made approximations. `onAsset` is passed through to every drawPanel
 * call so a texture that finishes loading after this call returns can
 * trigger a redraw. `view` carries what the page shows beyond the design:
 * the teammate card state and the selection chrome, drawn over everything else.
 */
export function drawHud(
  ctx: CanvasRenderingContext2D, pxW: number, pxH: number, design: HudDesign, side: Side,
  selected: string | readonly string[] | null, onAsset?: () => void, view: HudView = {},
): void {
  const k = pxH / SCREEN_H;
  const accent = accentColour(ctx);
  // A hidden element is still drawn, dimmed, while it is selected, so the
  // player can see what they are editing; every outline comes from `view`.
  const picked: readonly string[] = selected === null ? [] : typeof selected === 'string' ? [selected] : selected;

  for (const el of visibleElements(side)) {
    const u = rectFor(design, el.id);
    const hidden = !u.visible;
    if (hidden && !picked.includes(el.id)) continue;

    const r: Rect = { x: u.x * k, y: u.y * k, w: u.w * k, h: u.h * k };
    const paint = PAINTERS[el.id];
    if (!paint) continue;

    if (hidden) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      paint(ctx, r, design, k, onAsset, view);
      ctx.restore();
      drawHiddenOutline(ctx, r);
    } else {
      paint(ctx, r, design, k, onAsset, view);
    }
  }

  if (view.frames?.length) drawFrames(ctx, view.frames, k, accent);
  if (view.box || view.handles?.length) drawHandles(ctx, view.box ?? null, view.handles ?? [], k, accent);
  if (view.hover) drawHover(ctx, view.hover, k);
  if (view.marquee) drawMarquee(ctx, view.marquee, k);
  if (view.guides?.length) drawGuides(ctx, view.guides, k);
}
