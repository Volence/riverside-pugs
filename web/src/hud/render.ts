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
 * The teammate card is the exception: the page can ask for the Down or Dead
 * state (DrawOpts.state), and each state draws what the game shows in it,
 * still from the same generated tree, so fitted, squared state art shows
 * exactly as the file will make the game draw it.
 *
 * The owner's in-game screenshot of the stock HUD at full health and the
 * probe caught two things game code decides that the .res files alone do not
 * say: the teammate card's splatter background is drawn only faintly at full
 * health (isTeamColumnHealthbarBg, drawn at SPLATTER_ALPHA), and the
 * own-health panel's scratch overlays are tinted with the health colour, not
 * drawn raw (the drawColor branch in drawImageChild, below).
 */
import type { HudDesign } from './design';
import { buildTrees } from './build';
import { kvFind, kvGet, type KvNode } from './kv';
import { artUrl, normaliseMaterial } from './art';
import { ICON_ADVANCE, ICON_SPACE } from './art/index';
import { parseColour } from './textures';
import { SLOTS } from './slots';
import { canvasFont, fontCell, importedFace, loadFace, type FontCell } from './fonts';
import { baseOf } from './base';
import { importedMaterial, _resetImportedArt } from './importArt';
import { addLinear } from './additive';

export type ChildKind = 'image' | 'label' | 'bar' | 'other';
export interface ChildRect { name: string; kind: ChildKind; x: number; y: number; w: number; h: number; visible: boolean }
export interface PanelBox { x: number; y: number }
/** The teammate card state the preview shows. Game code picks it at runtime; the page lets the player pick it. */
export type CardState = 'healthy' | 'down' | 'dead';
export interface DrawOpts { card?: number; onAsset?: () => void; state?: CardState }

const SCHEME = 'resource/clientscheme.res';

/** The file each inside-editable panel draws from. siHealth is five files that are one card at five placements; the Hunter's is the one shown. */
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
 * What the teammate card shows in each preview state, beyond what visible 0
 * hides. Game code decides this at runtime; these are a best reading of the
 * probe screenshots (a down teammate's portrait gives way to the
 * incapacitated art, a dead one keeps only the dead art and a dimmed name),
 * and the owner corrects them after seeing them. Voice shows only while
 * someone talks, so it is never drawn.
 */
const TEAM_HIDDEN: Record<CardState, ReadonlySet<string>> = {
  healthy: new Set(['incapacitated', 'dead', 'voice']),
  down: new Set(['head', 'dead', 'voice']),
  dead: new Set(['head', 'incapacitated', 'voice', 'health', 'healthnumber', 'items']),
};

/** Whether the preview leaves a child out in this state. Every panel but the teammate card shows the healthy, alive state. */
export function hiddenInState(panelId: string, name: string, state: CardState): boolean {
  const n = name.toLowerCase();
  return panelId === 'teamColumn' ? TEAM_HIDDEN[state].has(n) : STATE_CHILDREN.has(n);
}

/** A dead teammate's name stays on the card, dimmed. */
const DEAD_NAME_ALPHA = 0.5;

/**
 * The stock teammate card's BackgroundImage is a black splatter texture
 * (hud/healthbar_bg_N, one file per team colour) sitting at zpos -1 behind
 * the whole card. Probe T6 showed it faintly at full health, so it is drawn
 * at SPLATTER_ALPHA rather than hidden. Scoped to the teamColumn panel and to
 * images actually named healthbar_bg_*, so it never touches the infected
 * card's own infected_healthbar_bg_1 background, the Hunter card's
 * pz_healthbar frame, or the Modern preset (whose teammate card paints its
 * backgrounds with fillcolor and ships BackgroundImage as visible 0).
 *
 * The splatter is now an editable piece with its own drawColor tint
 * (drawImageChild's own drawColor branch, below): SPLATTER_ALPHA multiplies
 * on top of that tint's own alpha rather than standing in for it, so a
 * player's chosen colour still shows only at the game's faint strength, the
 * same way the tint and this alpha compose on the stock infected card.
 */
const SPLATTER_ALPHA = 0.35;

function isTeamColumnHealthbarBg(panelId: string, n: KvNode): boolean {
  if (panelId !== 'teamColumn') return false;
  const image = kvGet(n, 'image');
  if (!image) return false;
  return /\/healthbar_bg_\d+$/.test(normaliseMaterial(image));
}

/**
 * The own-health panel's scratch overlays (HealthbarTextureTop/Bottom, the
 * detail_scratches_top_1/bottom_1 art): game code sets their draw colour to
 * the health colour (healthRgb, below) on every update, whatever the .res
 * file gives, which is why the owner's screenshot at full health shows them
 * green. Unique to localplayerpanel.res in both presets (Modern ships them
 * visible 0, so this never fires there).
 */
const HEALTH_TINT_CHILDREN = new Set(['healthbartexturetop', 'healthbartexturebottom']);

/** Sample people for the cards: the three teammates, and Bill for the player's own panel. */
const CARD_NAMES = ['Francis', 'Louis', 'Zoey'];
const CARD_PORTRAITS = ['vgui/s_panel_biker', 'vgui/s_panel_manager', 'vgui/s_panel_teenangst'];
const OWN_PORTRAIT = 'vgui/s_panel_namvet';

const portraitFor = (opts: DrawOpts) => (opts.card === undefined ? OWN_PORTRAIT : CARD_PORTRAITS[opts.card % CARD_PORTRAITS.length]);

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
 * A scheme font: its tall, the face it names and the weight it asks for.
 * buildTrees skips fontPass, which on the stock preset with Roboto renames
 * both Trade Gothic faces to plain "Roboto Condensed", so that rename is
 * applied here. Stock faces are "Trade Gothic Bold" at weight 0 or 400: the
 * boldness lives in the face itself, which the preview draws in the exported
 * font of that name, so the weight is kept as the file says.
 */
export function fontFace(design: HudDesign, name: string): { tall: number; face: string; weight: number; additive: boolean } {
  const fonts = kvFind(buildTrees(design)(SCHEME), ['Fonts', name]);
  const first = fonts && typeof fonts.value !== 'string' ? fonts.value.find((s) => typeof s.value !== 'string') : undefined;
  if (!first) return { tall: 12, face: '', weight: 0, additive: false };
  let face = kvGet(first, 'name') ?? '';
  if (design.font === 'roboto' && /^Trade Gothic( Bold)?$/i.test(face)) face = 'Roboto Condensed';
  return { tall: num(kvGet(first, 'tall'), 12), face, weight: num(kvGet(first, 'weight')), additive: num(kvGet(first, 'additive')) !== 0 };
}

/**
 * Sets the canvas up to draw a scheme font at k canvas pixels to a HUD unit:
 * its own face at its weight, at the size the game gets for that tall
 * (fonts.ts), with an alphabetic baseline. Returns the cell in pixels: the
 * game draws text from the cell's top, so the caller puts the baseline the
 * ascent below that. Asks for the face too; onAsset redraws once it is in.
 * Also says whether the font is additive, for fillFontText.
 */
export function setFont(ctx: CanvasRenderingContext2D, design: HudDesign, name: string, k: number, onAsset?: () => void): FontCell & { additive: boolean } {
  const f = fontFace(design, name);
  // An imported HUD's own face, when the upload carries it, under the alias
  // fonts.ts registered it as; otherwise the face as named, as before.
  const face = design.preset === 'imported' ? importedFace(baseOf(design), f.face) ?? f.face : f.face;
  loadFace(face, onAsset);
  ctx.font = canvasFont(face, f.weight, f.tall * k);
  ctx.textBaseline = 'alphabetic';
  return { ...fontCell(face, f.tall * k), additive: f.additive };
}

/**
 * Draws what paint draws the way the game draws an additive font (see
 * additive.ts): the glyphs alone on a clear canvas the size of box (canvas
 * pixels, widened to whole ones), with the scene's font, colour, alignment
 * and alpha, then added onto the scene's pixels under the box in linear
 * light and written back. paint draws in the scene's own coordinates and
 * sets nothing but what it needs beyond those (a clip, say).
 *
 * Where the pixels cannot be read (a context without getImageData, as in
 * the tests, or no canvas to draw on) it falls back to the canvas's own
 * 'lighter' composite, the same sum on the sRGB numbers, which overshoots
 * but still reads as additive.
 */
export function paintAdditive(ctx: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number }, paint: (c: CanvasRenderingContext2D) => void): void {
  // A real 2D context: pixels it can read and a canvas of known size (a test stub may have neither).
  const readable = typeof ctx.getImageData === 'function' && Number.isFinite(ctx.canvas?.width) && Number.isFinite(ctx.canvas?.height);
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = readable ? Math.min(ctx.canvas.width, Math.ceil(box.x + box.w)) : 0;
  const y1 = readable ? Math.min(ctx.canvas.height, Math.ceil(box.y + box.h)) : 0;
  if (readable && (x1 <= x0 || y1 <= y0)) return;                   // wholly off the canvas: nothing to add onto
  const off = readable ? canvasFactory(x1 - x0, y1 - y0) : null;
  const octx = off?.getContext('2d') as CanvasRenderingContext2D | null | undefined;
  if (!octx) {
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    paint(ctx);
    ctx.globalCompositeOperation = prev;
    return;
  }
  octx.font = ctx.font; octx.fillStyle = ctx.fillStyle; octx.textAlign = ctx.textAlign;
  octx.textBaseline = ctx.textBaseline; octx.globalAlpha = ctx.globalAlpha;
  octx.translate(-x0, -y0);
  paint(octx);
  const glyphs = octx.getImageData(0, 0, x1 - x0, y1 - y0);
  const scene = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  addLinear(scene.data, glyphs.data);
  ctx.putImageData(scene, x0, y0);
}

/**
 * Draws one line of text at (x, y) (the baseline, with ctx's alignment
 * already set): through paintAdditive when its font is additive, over the
 * box the text covers (measured, one cell tall from cellTop, with a cell's
 * width of slack either side for glyphs that overhang their advance),
 * plainly otherwise. clip, when the caller clips the text to a rect, cuts
 * the box down to it too: the pixels paintAdditive writes back ignore the
 * canvas's clip.
 */
export function fillFontText(ctx: CanvasRenderingContext2D, cell: FontCell & { additive: boolean }, s: string, x: number, y: number, cellTop: number, clip?: { x: number; y: number; w: number; h: number }): void {
  if (!cell.additive) { ctx.fillText(s, x, y); return; }
  const w = ctx.measureText(s).width;
  const left = ctx.textAlign === 'right' || ctx.textAlign === 'end' ? x - w : ctx.textAlign === 'center' ? x - w / 2 : x;
  let bx = left - cell.cell, by = cellTop - cell.cell / 4, bx2 = left + w + cell.cell, by2 = cellTop + cell.cell * 1.25;
  if (clip) { bx = Math.max(bx, clip.x); by = Math.max(by, clip.y); bx2 = Math.min(bx2, clip.x + clip.w); by2 = Math.min(by2, clip.y + clip.h); }
  paintAdditive(ctx, { x: bx, y: by, w: bx2 - bx, h: by2 - by }, (c) => c.fillText(s, x, y));
}

/** Base files use scheme colour names; the generator never writes one, but the preview has to read them. */
export function colourOf(design: HudDesign, value: string | undefined): string {
  const [r, g, b, a] = rgbaOf(design, value);
  return `rgba(${r},${g},${b},${a / 255})`;
}

/** The same colour as numbers: a literal "r g b a", or a scheme colour name, white when there is none. */
export function rgbaOf(design: HudDesign, value: string | undefined): [number, number, number, number] {
  if (!value) return [255, 255, 255, 255];
  let raw = value.trim();
  if (!/^\d+ \d+ \d+ \d+$/.test(raw)) {
    const named = kvFind(buildTrees(design)(SCHEME), ['Colors', raw]);
    raw = named && typeof named.value === 'string' ? named.value : '255 255 255 255';
  }
  return parseColour(raw);
}

/**
 * The health colour, as client.dll works it out for the survivor panel (one
 * class draws both the own health panel and each teammate card; its update,
 * at 0x1023f6e0, asks the HealthPanel for this colour at 0x1022a1a0 and sets
 * it as the fgcolor of HealthNumber and HealthIcon and the draw colour of
 * HealthbarTextureTop and HealthbarTextureBottom, every update, so the .res
 * files' own colours for those four never show). Health over max health,
 * clamped to 0..1: over 0.5 green, over 0.15 orange, else red, and red while
 * incapacitated. The two thresholds are floats at 0x10516de4 and 0x10516de8
 * and the colours a table at 0x10516dec (0x1021260e and 0x10212630).
 * cl_colorblind 2 swaps in a second table (0x10516df8); the preview draws
 * the default. The health used is the real health only, not the temporary
 * health the number adds on.
 */
export function healthRgb(health: number, maxHealth: number, incap: boolean): [number, number, number] {
  if (incap) return [161, 25, 25];
  const f = Math.min(1, Math.max(0, health / maxHealth));
  if (f > 0.5) return [10, 177, 50];
  if (f > 0.15) return [216, 146, 12];
  return [161, 25, 25];
}

/** The panels drawn by that class, and the children it colours by health. */
const HEALTH_PANELS = new Set(['ownHealth', 'teamColumn']);
const HEALTH_LABELS = new Set(['healthnumber', 'healthicon']);

/** The preview's sample: full health, or down (incapacitated) on a teammate card shown down. */
function sampleHealthRgb(opts: DrawOpts): [number, number, number] {
  return healthRgb(100, 100, opts.state === 'down');
}

// --- images: the exported art, or a slot texture the design generated ---

let imageFactory: (url: string) => HTMLImageElement = (url) => { const i = new Image(); i.src = url; return i; };
export function _setImageFactory(f: ((url: string) => HTMLImageElement) | null): void {
  imageFactory = f ?? ((url) => { const i = new Image(); i.src = url; return i; });
}
const images = new Map<string, HTMLImageElement>();
const missing = new Set<string>();

/** Whether a material's art is missing (not in the index, or its file failed to load), as opposed to still loading. */
export const isMissing = (material: string): boolean => missing.has(material);

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
export function artImage(material: string, onAsset?: () => void): HTMLImageElement | undefined {
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

const urls = new Map<string, { img: HTMLImageElement; waiting: Set<() => void> }>();
/**
 * An image the design itself carries (an uploaded crosshair's data URL),
 * once decoded; undefined while it loads. Several views ask for the same
 * image (the main canvas and the side panel's zoom), and each needs its own
 * redraw when it arrives, so every caller's onAsset is kept until the load
 * and all of them are called then; keeping only the first left the main
 * canvas blank for ever when the zoom asked first. Only the latest few
 * images are kept: each upload or undo step can bring a new one, and the
 * old ones are never drawn again.
 */
export function urlImage(url: string, onAsset?: () => void): HTMLImageElement | undefined {
  let hit = urls.get(url);
  if (!hit) {
    if (urls.size >= 8) urls.delete(urls.keys().next().value!);
    const entry = { img: imageFactory(url), waiting: new Set<() => void>() };
    entry.img.onload = () => {
      const fns = [...entry.waiting];
      entry.waiting.clear();
      for (const fn of fns) fn();
    };
    urls.set(url, entry);
    hit = entry;
  }
  if (hit.img.complete && hit.img.naturalWidth > 0) return hit.img;
  if (onAsset) hit.waiting.add(onAsset);
  return undefined;
}

/**
 * A restyled slot, drawn straight from the design's colour rather than from a
 * generated texture. stylePass makes a flat or rounded texture in that colour
 * and the game stretches it over the panel, so a filled (or rounded) rect in
 * the same colour is the same picture, and it needs no offscreen canvas,
 * which happy-dom does not have. Uploads (kind image) are not drawn yet: this
 * returns false for them, as it does for a slot that is not restyled, and the
 * caller decides what shows instead.
 */
function drawSlotStyle(ctx: CanvasRenderingContext2D, design: HudDesign, slotId: string, r: ChildRect): boolean {
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
/** A scratch canvas from the same factory tests replace: importArt.ts decodes an imported texture into one. */
export function scratchCanvas(w: number, h: number): HTMLCanvasElement | null { return canvasFactory(w, h); }
const tints = new Map<string, CanvasImageSource>();

/**
 * `key` names the source for the cache: a stock material, or an import's
 * base key and material (a decoded texture is a canvas, with no natural
 * size, so its size comes in as w and h).
 */
export function tinted(img: CanvasImageSource, key: string, r: number, g: number, b: number,
  w = (img as HTMLImageElement).naturalWidth, h = (img as HTMLImageElement).naturalHeight): CanvasImageSource {
  const id = `${key}|${r},${g},${b}`;
  const cached = tints.get(id);
  if (cached) return cached;
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
  tints.set(id, c);
  return c;
}

/** Test seam: forget every loaded image, tint and warned-about material. */
export function _resetAssetCache(): void { images.clear(); missing.clear(); tints.clear(); urls.clear(); warnedNoIcons = false; _resetImportedArt(); }

export function hatch(ctx: CanvasRenderingContext2D, r: ChildRect) {
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
    const material = portraitFor(opts);
    const img = artImage(material, opts.onAsset);
    if (!img) { if (missing.has(material)) hatch(ctx, r); return; }
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    return;
  }
  if (lname === 'incapacitated' || lname === 'dead') {
    // Game code picks this art too: the character's own _incap panel, or the
    // one dead panel. Drawn stretched to the rect, as scaleImage 1 has the
    // game draw it, which is why the fit rule keeps the rect square.
    const material = lname === 'dead' ? 'vgui/s_panel_dead' : `${portraitFor(opts)}_incap`;
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
    // An imported HUD's own material first; the stock art where it has none.
    const key = baseOf(design);
    const own = design.preset === 'imported' ? importedMaterial(key, material, canvasFactory) : null;
    if (own && 'src' in own) { drawTexture(ctx, n, r, k, opts, own.src, own.w, own.h, `${key}|${material}`, own.additive); return; }
    const stock = own && 'stock' in own ? own.stock : material;
    const img = artImage(stock, opts.onAsset);
    if (!img) { if (missing.has(stock)) hatch(ctx, r); return; }   // loading: draw nothing yet; missing: say so
    drawTexture(ctx, n, r, k, opts, img, img.naturalWidth, img.naturalHeight, stock, own !== null && own.additive);
    return;
  }
  if (fill) { ctx.fillStyle = colourOf(design, fill); ctx.fillRect(r.x, r.y, r.w, r.h); }
}

/**
 * A texture drawn as an ImagePanel draws it: tinted by drawColor (or the
 * health colour), stretched to the rect or unscaled, and added onto the
 * scene when its material is additive. Stock art and an imported HUD's own
 * decoded texture both come through here, so they draw alike.
 */
function drawTexture(ctx: CanvasRenderingContext2D, n: KvNode, r: ChildRect, k: number, opts: DrawOpts,
  src0: CanvasImageSource, w: number, h: number, key: string, additive: boolean) {
  let [tr, tg, tb, ta] = parseColour(kvGet(n, 'drawColor') ?? '255 255 255 255');
  if (HEALTH_TINT_CHILDREN.has(n.key.toLowerCase())) [tr, tg, tb] = sampleHealthRgb(opts);   // game code's colour, over the file's
  const src = tr < 255 || tg < 255 || tb < 255 ? tinted(src0, key, tr, tg, tb, w, h) : src0;
  const dest = (kvGet(n, 'scaleImage') ?? '0') !== '0' ? r : { ...r, w: w * k, h: h * k };   // unscaled: texture pixels are HUD units
  const paint = (c: CanvasRenderingContext2D) => c.drawImage(src, dest.x, dest.y, dest.w, dest.h);
  ctx.save();
  ctx.globalAlpha *= ta / 255;
  if (additive) paintAdditive(ctx, dest, paint); else paint(ctx);
  ctx.restore();
}

function sampleText(n: KvNode, opts: DrawOpts): string {
  const t = kvGet(n, 'labelText') ?? '';
  if (t === '%HealthNumber%') return opts.state === 'down' ? '299' : '100';   // down, the number is the incap health (probe T7)
  const lname = n.key.toLowerCase();
  if (t === '' && (lname === 'name' || lname === 'namelabel')) return opts.card === undefined ? 'Bill' : CARD_NAMES[opts.card % CARD_NAMES.length];
  return t;
}

/**
 * Whether a teammate-card child draws no text at all in the preview: a
 * label (Status, in both presets) whose own labelText is blank and has no
 * stand-in of its own (unlike Name, which falls back to a sample name, or
 * HealthNumber, whose labelText is the literal "%HealthNumber%" token, so
 * neither is ever blank). Items is a label too but draws its item icons
 * regardless of its own text, so it is never counted empty. Every other
 * kind (image, bar) always draws something. mock.ts's childAt uses this so
 * a click cannot land on words that are not there: an empty label is not a
 * hit target, so the card's own dead space falls through to whatever real
 * piece or decor sits under it instead. The row is still there in Layers,
 * which needs no drawn text to click.
 */
export function labelDrawsNothing(design: HudDesign, panelId: string, name: string, opts: DrawOpts): boolean {
  const n = kvFind(buildTrees(design)(PANEL_FILE[panelId]), [name]);
  if (!n || kindOf(n) !== 'label' || n.key.toLowerCase() === 'items') return false;
  return !sampleText(n, opts);
}

/**
 * The row the preview shows: a full loadout, in the order the game writes it.
 * client.dll builds the Items label's text as the medkit ('!'), the pills
 * ('"'), then one throwable (the pipe bomb '$', or the molotov '#' when that
 * is what is carried), with a space between each; a teammate carries one
 * throwable, so the row shows the pipe bomb.
 */
export const ITEM_ROW: readonly string[] = ['icon/item/medkit', 'icon/item/pills', 'icon/item/pipebomb'];

/** How wide the row is at s canvas pixels tall: each glyph's advance, and a space between two. */
function itemRowWidth(s: number): number {
  return ITEM_ROW.reduce((w, name, i) => w + (ICON_ADVANCE[name] ?? 1) * s + (i ? ICON_SPACE * s : 0), 0);
}

/** Where the row starts in a label at x, w wide: the label's textAlignment places the whole row, as it would the text. */
export function itemRowStart(x: number, w: number, s: number, align: string): number {
  const a = align.toLowerCase();
  if (a.includes('east')) return x + w - itemRowWidth(s);
  if (a.includes('west')) return x;
  // center, and a bare north or south: VGUI centres those across the label.
  if (a === 'center' || a === 'north' || a === 'south') return x + (w - itemRowWidth(s)) / 2;
  return x;
}

let warnedNoIcons = false;

/**
 * The teammate's item icons, drawn from the ToolBox glyphs the export script
 * made into PNGs (preview only, like the rest of the art). Each is scaled so
 * the font's cell is the label's font tall in canvas pixels, which puts the
 * glyph where the font puts it, and the row is laid glyph, space, glyph, as
 * the game writes it. They are white: the font is additive, so on the HUD
 * they show as white, dimmed only by the label's own colour when the file
 * gives it one. The game draws the glyphs inside the label and nowhere else,
 * so they are clipped to the label's rect: an icon taller than its label
 * (Modern's 16-tall icons in a 13-tall label just under the name) would
 * otherwise spill over the text beside it.
 *
 * While the icons load nothing is drawn (onAsset asks for a redraw). If one
 * is not in the art index or fails to load, the row falls back to
 * drawItemStandIns, so the preview never loses the row.
 */
function drawItems(ctx: CanvasRenderingContext2D, design: HudDesign, n: KvNode, r: ChildRect, k: number, opts: DrawOpts) {
  const s = fontFace(design, kvGet(n, 'font') ?? '').tall * k;
  const y = r.y + (r.h - s) / 2;
  if (ITEM_ROW.some((name) => !artUrl(name))) {
    if (!warnedNoIcons) { warnedNoIcons = true; console.warn('HUD preview: no item icon art, drawing stand-ins'); }
    drawItemStandIns(ctx, r, s, y);
    return;
  }
  const imgs = ITEM_ROW.map((name) => artImage(name, opts.onAsset));
  if (ITEM_ROW.some((name) => missing.has(name))) { drawItemStandIns(ctx, r, s, y); return; }
  if (imgs.some((img) => !img)) return;                            // still loading
  const [cr, cg, cb, ca] = rgbaOf(design, kvGet(n, 'fgcolor_override'));
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.globalAlpha *= ca / 255;
  const row = (c: CanvasRenderingContext2D) => {
    let x = itemRowStart(r.x, r.w, s, kvGet(n, 'textAlignment') ?? 'west');
    for (const [i, name] of ITEM_ROW.entries()) {
      const img = imgs[i]!;
      const src = cr < 255 || cg < 255 || cb < 255 ? tinted(img, name, cr, cg, cb) : img;
      c.drawImage(src, x, y, (img.naturalWidth / img.naturalHeight) * s, s);
      x += ((ICON_ADVANCE[name] ?? 1) + ICON_SPACE) * s;
    }
  };
  // The icons are glyphs of the label's font, so they are laid on the scene
  // the way that font is: added, for the stock ToolBox icon fonts. The box
  // is the label's rect, which also clips them there.
  if (fontFace(design, kvGet(n, 'font') ?? '').additive) paintAdditive(ctx, r, row);
  else row(ctx);
  ctx.restore();
}

/**
 * The fallback when the icon art is missing: two neutral outlines, a medkit
 * and a pill bottle, each one icon tall at the label's font size, clipped to
 * the label's rect like the real icons.
 */
function drawItemStandIns(ctx: CanvasRenderingContext2D, r: ChildRect, s: number, y: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = Math.max(1, s / 12);
  ctx.strokeRect(r.x, y, s, s);                                     // medkit
  ctx.beginPath();
  ctx.moveTo(r.x + s / 2, y + s * 0.25); ctx.lineTo(r.x + s / 2, y + s * 0.75);
  ctx.moveTo(r.x + s * 0.25, y + s / 2); ctx.lineTo(r.x + s * 0.75, y + s / 2);
  ctx.stroke();
  ctx.strokeRect(r.x + s * 1.25, y + s * 0.2, s * 0.5, s * 0.8);     // pill bottle
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, design: HudDesign, panelId: string, n: KvNode, r: ChildRect, k: number, opts: DrawOpts) {
  if (n.key.toLowerCase() === 'items') { drawItems(ctx, design, n, r, k, opts); return; }
  const s = sampleText(n, opts);
  if (!s) return;
  ctx.save();
  // Scheme tall is already scaled by scalePass when the parent was.
  const cell = setFont(ctx, design, kvGet(n, 'font') ?? '', k, opts.onAsset);
  // The health number and its + are coloured by game code (healthRgb), not the file: red when down (probe T7).
  const byHealth = HEALTH_PANELS.has(panelId) && HEALTH_LABELS.has(n.key.toLowerCase());
  ctx.fillStyle = byHealth ? `rgba(${sampleHealthRgb(opts).join(',')},1)` : colourOf(design, kvGet(n, 'fgcolor_override'));
  const align = (kvGet(n, 'textAlignment') ?? 'west').toLowerCase();
  let x = r.x;
  if (align.includes('east')) { ctx.textAlign = 'right'; x = r.x + r.w; }
  else if (align.includes('center')) { ctx.textAlign = 'center'; x = r.x + r.w / 2; }
  else ctx.textAlign = 'left';
  // A Label puts its text's cell at the top for north, the bottom for
  // south, and centres it otherwise; the glyphs hang from the cell's top.
  const top = align.startsWith('north') ? r.y : align.startsWith('south') ? r.y + r.h - cell.cell : r.y + (r.h - cell.cell) / 2;
  fillFontText(ctx, cell, s, x, top + cell.ascent, top);
  ctx.restore();
}

/**
 * The health bar: the whole rect, stock green at 100 health, or red at the
 * incap sample when the preview shows a down teammate. The game draws bar
 * fills in code and never reads the healthbar_* textures (probe T8), so
 * there is nothing a design can restyle here.
 */
function drawBar(ctx: CanvasRenderingContext2D, r: ChildRect, opts: DrawOpts) {
  const down = opts.state === 'down';
  const img = artImage(down ? 'vgui/healthbar_red' : 'vgui/healthbar_green', opts.onAsset);
  if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
  else { ctx.fillStyle = down ? 'rgba(192,28,0,0.9)' : 'rgba(76,217,100,0.9)'; ctx.fillRect(r.x, r.y, r.w, r.h); }
}

export function drawPanel(ctx: CanvasRenderingContext2D, design: HudDesign, panelId: string, origin: PanelBox, k: number, opts: DrawOpts = {}): void {
  const state = opts.state ?? 'healthy';
  const nodes = orderedChildren(buildTrees(design)(PANEL_FILE[panelId]));
  const rects = childRects(design, panelId, origin, k);
  for (const [i, n] of nodes.entries()) {
    const r = rects[i];
    const lname = n.key.toLowerCase();
    if (!r.visible || hiddenInState(panelId, lname, state)) continue;
    let alpha = 1;
    if (isTeamColumnHealthbarBg(panelId, n)) alpha = SPLATTER_ALPHA;
    if (panelId === 'teamColumn' && state === 'dead' && lname === 'name') alpha = DEAD_NAME_ALPHA;
    if (alpha !== 1) { ctx.save(); ctx.globalAlpha *= alpha; }
    switch (r.kind) {
      case 'image': drawImageChild(ctx, design, n, r, k, opts); break;
      case 'label': drawLabel(ctx, design, panelId, n, r, k, opts); break;
      case 'bar': drawBar(ctx, r, opts); break;
      default: break;                                                // Panel, CircularProgressBar: nothing to show
    }
    if (alpha !== 1) ctx.restore();
  }
}
