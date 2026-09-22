/**
 * Draws a panel's insides from the generator's own output.
 *
 * v1 drew each panel as a hand-made stand-in, honest about where the panel sat
 * and silent about what was inside it. This walks the panel's .res tree as the
 * generator left it (buildTrees), so every child is drawn where the file
 * says, at the size the file says, and an edit to the file is an edit to the
 * picture. Images come from the exported art, labels from the scheme's font
 * sizes, bars from the bar art. Nothing here decides a position: that is the
 * tree's job, which is the whole point.
 *
 * The preview shows the healthy, alive state, so children whose visibility
 * game code decides at runtime are not drawn: their positions are still
 * reported by childRects so a later editor can move them.
 *
 * The owner's in-game screenshot of the stock HUD at full health caught two
 * more things game code decides that the .res files alone do not say: the
 * teammate card's black splatter background is not shown at full health
 * (isTeamColumnHealthbarBg, below), and the own-health panel's scratch
 * overlays are tinted with the health colour, not drawn raw (the drawColor
 * branch in drawImageChild, below).
 */
import type { HudDesign } from './design';
import { buildTrees } from './build';
import { kvFind, kvGet, type KvNode } from './kv';
import { artUrl, normaliseMaterial } from './art';
import { parseColour } from './textures';
import { SLOTS } from './slots';

export type ChildKind = 'image' | 'label' | 'bar' | 'other';
export interface ChildRect { name: string; kind: ChildKind; x: number; y: number; w: number; h: number; visible: boolean }
export interface PanelBox { x: number; y: number }
export interface DrawOpts { card?: number; onAsset?: () => void }

const SCHEME = 'resource/clientscheme.res';

/** The file each inside-editable panel draws from. siHealth is six files that are one card at six placements; the Hunter's is the one shown. */
export const PANEL_FILE: Record<string, string> = {
  ownHealth: 'resource/ui/hud/localplayerpanel.res',
  teamColumn: 'resource/ui/hud/teammatepanel.res',
  siHealth: 'resource/ui/hud/hunterhealth.res',
  infectedRow: 'resource/ui/hud/zombieteamdisplayplayer.res',
};

/**
 * Game code decides when these show; the preview is the healthy, alive state.
 * The infected card's SpawnTimeLabel is one of them: the game shows the spawn
 * countdown only while that player is dead or a ghost, and in the stock file
 * it sits right over the live HealthPanel.
 */
const STATE_CHILDREN = new Set(['incapacitated', 'dead', 'voice', 'skulliconplacement', 'duckingicon', 'spawntimelabel']);

/**
 * The stock teammate card's BackgroundImage is a black splatter texture
 * (hud/healthbar_bg_N, one file per team colour) sitting at zpos -1 behind
 * the whole card. The owner's in-game screenshot at full health shows no
 * splatter behind a healthy teammate card at all, so like the other
 * STATE_CHILDREN this is a visibility game code decides at runtime, not one
 * the .res file states. Scoped to the teamColumn panel and to images
 * actually named healthbar_bg_*, so it never touches the infected card's own
 * infected_healthbar_bg_1 background, the Hunter card's pz_healthbar frame,
 * or the Modern preset (whose teammate card paints its backgrounds with
 * fillcolor, not this image, and already ships BackgroundImage as
 * visible 0).
 */
function isTeamColumnHealthbarBg(panelId: string, n: KvNode): boolean {
  if (panelId !== 'teamColumn') return false;
  const image = kvGet(n, 'image');
  if (!image) return false;
  return /\/healthbar_bg_\d+$/.test(normaliseMaterial(image));
}

/**
 * The own-health panel's scratch overlays (HealthbarTextureTop/Bottom, the
 * detail_scratches_top_1/bottom_1 art) have no drawColor in the .res file,
 * but the owner's in-game screenshot at full health shows them tinted the
 * same bright green as the health number and bar, not drawn raw grey/black.
 * Unique to localplayerpanel.res in both presets (Modern ships them
 * visible 0, so this never fires there).
 */
const HEALTH_TINT_CHILDREN = new Set(['healthbartexturetop', 'healthbartexturebottom']);

/** Sample people for the cards: the three teammates, and Bill for the player's own panel. */
const CARD_NAMES = ['Francis', 'Louis', 'Zoey'];
const CARD_PORTRAITS = ['vgui/s_panel_biker', 'vgui/s_panel_manager', 'vgui/s_panel_teenangst'];
const OWN_PORTRAIT = 'vgui/s_panel_namvet';
const PREVIEW_FONT = '"Roboto Condensed", "Arial Narrow", sans-serif';

function kindOf(n: KvNode): ChildKind {
  const c = (kvGet(n, 'ControlName') ?? '').toLowerCase();
  if (c === 'imagepanel') return 'image';
  if (c === 'label') return 'label';
  if (c === 'healthpanel') return 'bar';
  return 'other';
}

const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };

/** Children in draw order: file order, then zpos ascending, as VGUI paints them. */
function orderedChildren(nodes: KvNode[]): KvNode[] {
  return nodes.filter((n) => typeof n.value !== 'string')
    .map((n, i) => ({ n, i, z: num(kvGet(n, 'zpos')) }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((x) => x.n);
}

export function childRects(design: HudDesign, panelId: string, origin: PanelBox, k: number): ChildRect[] {
  const file = PANEL_FILE[panelId];
  if (!file) throw new Error(`No inside-editable panel ${panelId}`);
  return orderedChildren(buildTrees(design)(file)).map((n) => ({
    name: n.key, kind: kindOf(n),
    x: origin.x + num(kvGet(n, 'xpos')) * k, y: origin.y + num(kvGet(n, 'ypos')) * k,
    w: num(kvGet(n, 'wide')) * k, h: num(kvGet(n, 'tall')) * k,
    visible: (kvGet(n, 'visible') ?? '1') !== '0',
  }));
}

// --- scheme lookups: a font's size and weight, a named colour ---

/**
 * A font's size and whether it is bold. Stock faces are "Trade Gothic Bold"
 * at weight 0 or 400: the boldness lives in the face itself, not the weight,
 * so a face named Bold counts as bold whatever its weight says. buildTrees
 * skips fontPass, which on the stock preset with Roboto renames both Trade
 * Gothic faces to plain "Roboto Condensed", so that rename is applied here.
 */
function fontFace(design: HudDesign, name: string): { tall: number; bold: boolean } {
  const fonts = kvFind(buildTrees(design)(SCHEME), ['Fonts', name]);
  const first = fonts && typeof fonts.value !== 'string' ? fonts.value.find((s) => typeof s.value !== 'string') : undefined;
  if (!first) return { tall: 12, bold: false };
  let face = kvGet(first, 'name') ?? '';
  if (design.font === 'roboto' && /^Trade Gothic( Bold)?$/i.test(face)) face = 'Roboto Condensed';
  const bold = num(kvGet(first, 'weight')) >= 700 || /\bbold\b/i.test(face);
  return { tall: num(kvGet(first, 'tall'), 12), bold };
}

/** Base files use scheme colour names; the generator never writes one, but the preview has to read them. */
function colourOf(design: HudDesign, value: string | undefined): string {
  if (!value) return 'rgba(255,255,255,1)';
  let raw = value.trim();
  if (!/^\d+ \d+ \d+ \d+$/.test(raw)) {
    const named = kvFind(buildTrees(design)(SCHEME), ['Colors', raw]);
    raw = named && typeof named.value === 'string' ? named.value : '255 255 255 255';
  }
  const [r, g, b, a] = parseColour(raw);
  return `rgba(${r},${g},${b},${a / 255})`;
}

/**
 * The health colour for the own-health panel's scratch overlays
 * (HEALTH_TINT_CHILDREN, above). clientscheme.res names it explicitly under
 * its TERROR (the game's internal name for this HUD) colours block, right
 * alongside HealthHurtRed: "HealthGreen" "0 200 0 255". Nothing in the .res
 * files points a child at it directly (the game applies it at runtime by
 * health percentage, the same way it colours the health number), but it is
 * the one named green in that block and it matches the bright green in the
 * owner's screenshot, so it is used here rather than a guessed colour.
 */
function healthGreenRgb(design: HudDesign): [number, number, number] {
  const named = kvFind(buildTrees(design)(SCHEME), ['Colors', 'HealthGreen']);
  const raw = named && typeof named.value === 'string' ? named.value : '0 200 0 255';
  const [r, g, b] = parseColour(raw);
  return [r, g, b];
}

// --- images: the exported art, or a slot texture the design generated ---

let imageFactory: (url: string) => HTMLImageElement = (url) => { const i = new Image(); i.src = url; return i; };
export function _setImageFactory(f: ((url: string) => HTMLImageElement) | null): void {
  imageFactory = f ?? ((url) => { const i = new Image(); i.src = url; return i; });
}
const images = new Map<string, HTMLImageElement>();
const missing = new Set<string>();

function markMissing(material: string, why: string) {
  if (!missing.has(material)) { missing.add(material); console.warn(`HUD preview: ${why} ${material}`); }
}

/**
 * The art for a material, once loaded; undefined while it loads (onAsset
 * fires then) or when it is missing. A material is missing when the index
 * lacks it or its file failed to load: a failed image would otherwise sit in
 * the cache incomplete and draw nothing for ever, so the error marks it
 * missing (the child hatches instead) and asks for a redraw to show that.
 */
function artImage(material: string, onAsset?: () => void): HTMLImageElement | undefined {
  if (missing.has(material)) return undefined;
  let img = images.get(material);
  if (!img) {
    const url = artUrl(material);
    if (!url) { markMissing(material, 'no art for'); return undefined; }
    img = imageFactory(url);
    img.onload = () => onAsset?.();
    img.onerror = () => { markMissing(material, 'art failed to load for'); onAsset?.(); };
    images.set(material, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : undefined;
}

/**
 * A restyled slot, drawn straight from the design's colour rather than from a
 * generated texture. stylePass makes a flat or rounded texture in that colour
 * and the game stretches it over the panel, so a filled (or rounded) rect in
 * the same colour is the same picture, and it needs no offscreen canvas,
 * which happy-dom does not have. Uploads (kind image) are not drawn yet: this
 * returns false for them, as it does for a slot that is not restyled, and the
 * caller decides what shows instead. The health bar falls back to its stock
 * art; an image the generator repointed at the upload draws nothing.
 */
export function drawSlotStyle(ctx: CanvasRenderingContext2D, design: HudDesign, slotId: string, r: ChildRect): boolean {
  const slot = SLOTS.find((s) => s.id.toLowerCase() === slotId);
  const style = slot && design.styles[slot.id];
  if (!slot || !style || style.kind === 'stock' || style.kind === 'image') return false;
  const [cr, cg, cb, ca] = parseColour(style.color ?? slot.defaultColor);
  ctx.fillStyle = `rgba(${cr},${cg},${cb},${ca / 255})`;
  if (style.kind === 'rounded') {
    const radius = Math.min(8, r.w / 4, r.h / 4);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(r.x, r.y, r.w, r.h, radius); else ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill();
  } else {
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  return true;
}

/**
 * An ImagePanel's drawColor multiplies its texture: the stock infected card
 * draws its frame at 64 64 64, about a quarter brightness. Canvas 2D has no
 * tinted drawImage, and a multiply fill over the child's rect on the page
 * would also darken whatever shows through the texture's transparent parts
 * (most of that frame), so the tint is made once on a scratch canvas:
 * multiply by the colour, then cut back to the texture's own alpha. Where
 * there is no scratch canvas (happy-dom has none) the texture draws untinted.
 */
let canvasFactory: (w: number, h: number) => HTMLCanvasElement | null = defaultCanvas;
function defaultCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
export function _setCanvasFactory(f: ((w: number, h: number) => HTMLCanvasElement | null) | null): void { canvasFactory = f ?? defaultCanvas; }
const tints = new Map<string, CanvasImageSource>();

function tinted(img: HTMLImageElement, material: string, r: number, g: number, b: number): CanvasImageSource {
  const key = `${material}|${r},${g},${b}`;
  const cached = tints.get(key);
  if (cached) return cached;
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = canvasFactory(w, h);
  const t = c?.getContext('2d');
  if (!c || !t) return img;
  t.drawImage(img, 0, 0, w, h);
  t.globalCompositeOperation = 'multiply';
  t.fillStyle = `rgb(${r},${g},${b})`;
  t.fillRect(0, 0, w, h);
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(img, 0, 0, w, h);
  t.globalCompositeOperation = 'source-over';
  tints.set(key, c);
  return c;
}

/** Test seam: forget every loaded image, tint and warned-about material. */
export function _resetAssetCache(): void { images.clear(); missing.clear(); tints.clear(); }

function hatch(ctx: CanvasRenderingContext2D, r: ChildRect) {
  ctx.save();
  ctx.fillStyle = 'rgba(128,128,128,0.35)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

/**
 * The infected card's head. Game code shows the class icon of whichever
 * special infected the player is, which the preview does not know, so it
 * draws a plain head-and-shoulders shape inside the file's rect instead.
 */
function silhouette(ctx: CanvasRenderingContext2D, r: ChildRect) {
  const cx = r.x + r.w / 2;
  const unit = Math.min(r.w, r.h);
  ctx.save();
  ctx.fillStyle = 'rgba(150,150,150,0.55)';
  ctx.beginPath();
  ctx.arc(cx, r.y + r.h * 0.38, unit * 0.22, 0, Math.PI * 2);          // head
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, r.y + r.h, unit * 0.4, Math.PI, 0);                      // shoulders, cut by the rect's bottom edge
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawImageChild(ctx: CanvasRenderingContext2D, design: HudDesign, n: KvNode, r: ChildRect, k: number, opts: DrawOpts) {
  const image = kvGet(n, 'image');
  const fill = kvGet(n, 'fillcolor');
  const lname = n.key.toLowerCase();
  if (lname === 'playerimage') { silhouette(ctx, r); return; }      // the special infected's own head: no survivor portrait
  if (lname === 'head') {
    // Game code picks the portrait; the preview picks a fixed one per card.
    const material = opts.card === undefined ? OWN_PORTRAIT : CARD_PORTRAITS[opts.card % CARD_PORTRAITS.length];
    const img = artImage(material, opts.onAsset);
    if (!img) { if (missing.has(material)) hatch(ctx, r); return; }
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    return;
  }
  if (image) {
    const material = normaliseMaterial(image);
    if (material.startsWith('vgui/hud/hudeditor/')) {
      drawSlotStyle(ctx, design, material.slice('vgui/hud/hudeditor/'.length), r);   // false: an upload; the game shows it, we cannot yet
      return;
    }
    const img = artImage(material, opts.onAsset);
    if (!img) { if (missing.has(material)) hatch(ctx, r); return; }   // loading: draw nothing yet; missing: say so
    const rawDrawColor = kvGet(n, 'drawColor');
    let [tr, tg, tb, ta] = parseColour(rawDrawColor ?? '255 255 255 255');
    if (!rawDrawColor && HEALTH_TINT_CHILDREN.has(n.key.toLowerCase())) [tr, tg, tb] = healthGreenRgb(design);
    const src = tr < 255 || tg < 255 || tb < 255 ? tinted(img, material, tr, tg, tb) : img;
    ctx.save();
    ctx.globalAlpha *= ta / 255;
    if ((kvGet(n, 'scaleImage') ?? '0') !== '0') ctx.drawImage(src, r.x, r.y, r.w, r.h);
    else ctx.drawImage(src, r.x, r.y, img.naturalWidth * k, img.naturalHeight * k);   // unscaled: texture pixels are HUD units
    ctx.restore();
    return;
  }
  if (fill) { ctx.fillStyle = colourOf(design, fill); ctx.fillRect(r.x, r.y, r.w, r.h); }
}

function sampleText(n: KvNode, opts: DrawOpts): string {
  const t = kvGet(n, 'labelText') ?? '';
  if (t === '%HealthNumber%') return '100';
  const lname = n.key.toLowerCase();
  if (t === '' && (lname === 'name' || lname === 'namelabel')) return opts.card === undefined ? 'Bill' : CARD_NAMES[opts.card % CARD_NAMES.length];
  if (lname === 'healthicon') return '+';                          // the real glyph lives in a Valve icon font
  return t;
}

function drawLabel(ctx: CanvasRenderingContext2D, design: HudDesign, n: KvNode, r: ChildRect, k: number, opts: DrawOpts) {
  const s = sampleText(n, opts);
  if (!s) return;
  const face = fontFace(design, kvGet(n, 'font') ?? '');
  const px = face.tall * k;                                          // scheme tall is already scaled by scalePass when the parent was
  ctx.save();
  ctx.font = `${face.bold ? 'bold ' : ''}${px}px ${PREVIEW_FONT}`;
  ctx.fillStyle = colourOf(design, kvGet(n, 'fgcolor_override'));
  const align = (kvGet(n, 'textAlignment') ?? 'west').toLowerCase();
  ctx.textBaseline = 'middle';
  let x = r.x;
  if (align.includes('east')) { ctx.textAlign = 'right'; x = r.x + r.w; }
  else if (align.includes('center')) { ctx.textAlign = 'center'; x = r.x + r.w / 2; }
  else ctx.textAlign = 'left';
  ctx.fillText(s, x, r.y + r.h / 2);
  ctx.restore();
}

/**
 * The health bar at 100 health: the whole rect, green. In advanced mode a
 * restyled barGreen slot overwrites vgui/healthbar_green itself (stylePass
 * writes the stock name too), so the game fills the bar with the design's
 * colour and the preview must as well. Otherwise it is the stock art.
 */
function drawBar(ctx: CanvasRenderingContext2D, design: HudDesign, r: ChildRect, opts: DrawOpts) {
  if (design.advanced && drawSlotStyle(ctx, design, 'bargreen', r)) return;
  const img = artImage('vgui/healthbar_green', opts.onAsset);
  if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
  else { ctx.fillStyle = 'rgba(76,217,100,0.9)'; ctx.fillRect(r.x, r.y, r.w, r.h); }
}

export function drawPanel(ctx: CanvasRenderingContext2D, design: HudDesign, panelId: string, origin: PanelBox, k: number, opts: DrawOpts = {}): void {
  const nodes = orderedChildren(buildTrees(design)(PANEL_FILE[panelId]));
  const rects = childRects(design, panelId, origin, k);
  for (const [i, n] of nodes.entries()) {
    const r = rects[i];
    if (!r.visible || STATE_CHILDREN.has(n.key.toLowerCase()) || isTeamColumnHealthbarBg(panelId, n)) continue;
    switch (r.kind) {
      case 'image': drawImageChild(ctx, design, n, r, k, opts); break;
      case 'label': drawLabel(ctx, design, n, r, k, opts); break;
      case 'bar': drawBar(ctx, design, r, opts); break;
      default: break;                                                // Panel, CircularProgressBar: nothing to show
    }
  }
}
