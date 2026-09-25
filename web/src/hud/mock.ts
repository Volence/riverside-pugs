/**
 * The canvas preview. `elementRect` is the only source of where an element
 * sits, and the generated .res trees the only source of where anything
 * inside one sits, so this file never computes a position on its own;
 * disagreeing with the generator here would defeat the point of a preview.
 *
 * Four elements (ownHealth, teamColumn, infectedRow, siHealth) are drawn
 * straight from the generated .res files by render.ts's drawPanel, with the
 * real exported game art, so an edit to a slot or a scale is an edit to the
 * picture. The weapon selection is drawn by weapons.ts from its hudlayout.res
 * keys, the way the game's own code lays it out. Every other element here is
 * still a hand-made stand-in drawn from plain shapes and text.
 */
import { NOTICE_BOX_COLOUR, type Box, type HudDesign } from './design';
import { ELEMENTS, elementById, type HudElement } from './elements';
import type { Guide } from './guides';
import { buildTrees, elementRect, teamLayout, teamCardRects, isFreeTeam, baseHasElement, pcGet, MARKER_PX_PER_UNIT, NOTICE_BOX_TEXTURE, MODERN_ART } from './build';
import { baseOf } from './base';
import { kvFind, kvGet, type KvNode } from './kv';
import { SCREEN_H, parseSize, parsePos, screenW } from './units';
import { PROGRESS_LABEL, labelTextColour, labelColour, paintPanelBox, paintPanelLabel, paintLinearOver, drawPanel, childRects, hiddenInState, labelDrawsNothing, urlImage, storedImage, artImage, colourOf, rgbaOf, tinted, previewOf, fontFace, setFont, fillFontText, type PreviewState, type SurvivorState } from './render';
import { normaliseMaterial, HEALING_ICON, CROSSHAIR_OPEN, tipImage } from './art';
import { barGeometry, clampBarKeys } from './progress';
import { canvasFont, fontCell, importedFace, loadFace, setLetterSpacing, synthBoldSpacing } from './fonts';
import { drawArt } from '../crosshair/model';
import { childDef, panelChildren } from './children';
import { probe } from './probes';
import { drawWeapons, drawNineSlice, type WeaponHeld } from './weapons';
import { drawTabScreen, tabPicked } from './tabscreen';

export type Side = 'survivor' | 'infected';

/**
 * The elements the side shows, for this design: an imported HUD that lacks
 * or renamed an element's panel does not offer it, so no control, outline or
 * hit test reaches a panel the file does not have. Stock and Modern offer
 * every one.
 *
 * The Tab screen elements (HudElement.tab) are left out: drawHud draws the
 * Tab screen itself (tabscreen.ts), and they join Layers, the snap targets
 * and the hit test once the page lists them (tab screen spec tasks 15 and
 * 16).
 */
export function visibleElements(side: Side, design: HudDesign): HudElement[] {
  const key = baseOf(design);
  return ELEMENTS.filter((e) => !e.tab && (e.side === side || e.side === 'both') && baseHasElement(key, e));
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
  state?: SurvivorState | PreviewState;
  /** The weapon slot the preview survivor holds (weapons.ts's WeaponHeld); the gun when absent. */
  held?: WeaponHeld;
  frames?: Box[];
  box?: Box | null;
  handles?: { x: number; y: number }[];
  hover?: { rects: Box[]; label: string } | null;
  marquee?: Box | null;
  guides?: Guide[];
  /**
   * Device pixels per CSS pixel of the canvas (window.devicePixelRatio, capped
   * by the page). The HUD itself is drawn at whatever size the canvas is; only
   * the editor's own chrome (outlines, handles, the hover label, guides) is a
   * fixed size on screen, so it is scaled by this. 1 when absent.
   */
  dpr?: number;
}

/** Whether a point is on a box, edges included. */
export const inside = (r: Rect, ux: number, uy: number) => ux >= r.x && ux <= r.x + r.w && uy >= r.y && uy <= r.y + r.h;

function rectFor(design: HudDesign, id: string): Rect & { visible: boolean } {
  return elementRect(design, id, design.aspect);
}

/**
 * Whether the preview shows an element in the page's state: an infected one
 * the game shows only as a ghost, say (HudElement.shownIn). A Tab screen
 * element shows only while the preview holds Tab (PreviewState.tab), or
 * while it is selected, as an occasional panel does (tab screen spec 3.1).
 */
export function shownInState(el: HudElement, state?: SurvivorState | PreviewState, picked = false): boolean {
  const v = previewOf(state);
  return (!el.shownIn || el.shownIn.includes(v.infected)) && (!el.shownFor || el.shownFor.includes(v.siClass))
    && (!el.occasional || !!v.occasional || picked) && (!el.tab || !!v.tab || picked);
}

/** Card 4 shows only while spectating a full team: never drawn, never a target. */
export const TEAM_CARDS = 3;

/** Smallest-area element under the point wins, so a small element sitting
 *  inside a larger container (the crosshair inside the whole screen, say)
 *  stays selectable. In Free the teammates' container covers the screen, so
 *  there the three drawn cards are the targets instead of the container. */
export function hitTest(design: HudDesign, side: Side, ux: number, uy: number, state?: SurvivorState | PreviewState): string | null {
  let best: { id: string; area: number } | null = null;
  for (const el of visibleElements(side, design)) {
    const r = rectFor(design, el.id);
    if (!r.visible || !shownInState(el, state)) continue;
    const targets = elementTargets(design, el.id, r);
    for (const t of targets) {
      if (!inside(t, ux, uy)) continue;
      const area = t.w * t.h;
      if (!best || area < best.area) best = { id: el.id, area };
    }
  }
  return best ? best.id : null;
}

/**
 * Where an element is on screen for a click, a box select and a snap: the
 * three drawn cards for the Free teammates (their container covers the
 * screen), the fitted panel for a single panel that is fitted (your own
 * health: fit re-places LocalPlayer inside an unchanged container, and the
 * cut-away part of the container draws nothing), else the element's rect.
 */
export function elementTargets(design: HudDesign, id: string, r: Box = rectFor(design, id)): Box[] {
  if (id === 'teamColumn') return isFreeTeam(design) ? teamCardRects(design, design.aspect).slice(0, TEAM_CARDS) : [r];
  if (design.elements[id]?.fit) {
    const boxes = panelBoxes(design, id);
    if (boxes.length) return boxes;
  }
  return [r];
}

/**
 * The screen boxes a panel's file is drawn in, HUD units: the three drawn
 * teammate cards, or a single panel's frame block (its xpos, ypos, wide and
 * tall inside the element, from the generated tree, so already scaled),
 * which is the rect the painter clips that panel's children to, or the
 * element's own rect for a panel framed by its hudlayout.res block. A panel
 * the registry does not have gives none.
 */
export function panelBoxes(design: HudDesign, panelId: string): Box[] {
  if (panelId === 'teamColumn') return teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).map(({ x, y, w, h }) => ({ x, y, w, h }));
  if (panelId === 'infectedRow') return infectedCardRects(design);
  const panel = panelChildren(panelId);
  if (!panel || panel.repeat !== 'single' || !panel.frame) return [];
  const r = rectFor(design, panelId);
  // Framed by its own hudlayout.res block (your infected health): the element's rect is the panel, fitted or not.
  // An element whose rect is a stand-in for picking (mockSize: the use bar) frames its pieces in the real block.
  if (panel.frame === 'hudlayout') return [{ x: r.x, y: r.y, ...(elementById(panelId)?.mockSize ? layoutSize(design, panelId) : { w: r.w, h: r.h }) }];
  const p = parentPanel(design, panel.frame.file, panel.frame.block, 1);
  return [{ x: r.x + p.x, y: r.y + p.y, w: p.w, h: p.h }];
}

/**
 * An element's hudlayout.res block size as the generator wrote it (scaled
 * with the element): the rect VGUI clips its children to, which a
 * registry mockSize, sized to the stock content for picking, is not.
 */
export function layoutSize(design: HudDesign, id: string): { w: number; h: number } {
  const el = elementById(id)!;
  const n = kvFind(buildTrees(design)('scripts/hudlayout.res'), [el.key]);
  const W = screenW(design.aspect);
  return { w: parseSize((n && pcGet(n, 'wide')) ?? '0', W), h: parseSize((n && pcGet(n, 'tall')) ?? '0', SCREEN_H) };
}

const ZCARD_FILE = 'resource/ui/hud/zombieteamdisplayplayer.res';

/**
 * The three infected cards, in HUD units, where the game puts them: code
 * places card i at (i x HorizPanelSpacing, 0) inside CHudZombieTeamDisplay
 * (client.dll 0x10247a70), with the spacing the generator writes
 * (teamLayout), and makes exactly three card panels (0x10247f01). Each is
 * its file's ZombieTeamDisplayPlayer block in size (256 x 128 on stock,
 * 133 x 64 fitted), the rect it clips its children to (probe Q17,
 * /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/bl-abe.png);
 * code sets its position, so the block's own xpos and ypos are not read.
 */
export function infectedCardRects(design: HudDesign): Box[] {
  const r = rectFor(design, 'infectedRow');
  const t = teamLayout(design, elementById('infectedRow')!);
  const self = kvFind(buildTrees(design)(ZCARD_FILE), ['ZombieTeamDisplayPlayer']);
  const num = (key: string, d: number) => { const f = parseFloat((self && kvGet(self, key)) ?? ''); return Number.isFinite(f) ? f : d; };
  const w = num('wide', t.card?.w ?? 0), h = num('tall', t.card?.h ?? 0);
  return Array.from({ length: TEAM_CARDS }, (_, i) => ({ x: r.x + i * t.spacing, y: r.y, w, h }));
}

/**
 * The class of each infected card the preview draws: a sample team of a
 * Smoker, a Boomer and a Hunter (bots never get a card, so the game can show
 * these only for human teammates), or with Show yourself you first, as the
 * class the page picks, and the Hunter sample dropped: still three.
 */
export function infectedCardClasses(state?: SurvivorState | PreviewState): PreviewState['siClass'][] {
  const v = previewOf(state);
  return v.showSelf ? [v.siClass, 'smoker', 'boomer'] : ['smoker', 'boomer', 'hunter'];
}

/** What the card at `i` of a panel is, for the state rules: an infected card's class and whether it is you. */
function cardOpts(panel: string, i: number, state: SurvivorState | PreviewState): { cls?: PreviewState['siClass']; self?: boolean } {
  if (panel !== 'infectedRow') return {};
  return { cls: infectedCardClasses(state)[i], self: !!previewOf(state).showSelf && i === 0 };
}

/**
 * The smallest registered child of a panel under the point (the teammate
 * card by default), in whichever of its drawn boxes (panelBoxes: the three
 * teammate cards, or a single panel's one) it falls, or null. A child counts only where the card
 * and the container both let it show (VGUI clips to both), only when the
 * preview draws it in `state`, and only when the registry lists it. Decor
 * (the splatter, the card background) is the lowest priority: a real piece
 * on top always wins, but where no real piece is under the point, a decor
 * piece there is picked instead of leaving the point to mean the card, so
 * the splatter is reachable by a plain click, not only from Layers. The
 * card background is never a target either way, since it carries no
 * registry entry (`childDef` returns nothing for it). Nor is a label with
 * nothing drawn in it (the stock and Modern Status text, blank in every
 * preview state): a click cannot land on words that are not there, so it
 * counts for neither `best` nor `decor`, and the point falls through to
 * whatever real piece or decor is under it instead (labelDrawsNothing, in
 * render.ts). A label that does draw something, though, still hits on its
 * whole box, not just its drawn text's own width: Name's box is 120 wide
 * and a short name leaves most of it blank, but measuring real text extent
 * needs a canvas context this pure hit test does not have (and should not
 * gain, matching every other file in Phase 1, which measures nothing of
 * its own), and a label's box is what every other piece's hit rect already
 * is, its full box, not its drawn content's. The rects come from the
 * generated tree through childRects, like everything the canvas draws.
 */
export function childAt(
  design: HudDesign, state: SurvivorState | PreviewState, ux: number, uy: number, panel = 'teamColumn',
): { name: string; card: number } | null {
  const container = rectFor(design, panel);
  // The pieces may reach past a stand-in rect (the use bar's mockSize) into their real frame.
  if (!container.visible || (!inside(container, ux, uy) && !panelBoxes(design, panel).some((b) => inside(b, ux, uy)))) return null;
  let best: { name: string; card: number; area: number } | null = null;
  let decor: { name: string; card: number; area: number } | null = null;
  for (const [i, c] of panelBoxes(design, panel).entries()) {
    if (!inside(c, ux, uy)) continue;
    const card = cardOpts(panel, i, state);
    for (const r of childRects(design, panel, { x: c.x, y: c.y }, 1, state)) {
      const def = childDef(panel, r.name);
      if (!def || (def.gate && !probe(def.gate)) || !r.visible || hiddenInState(panel, r.name, state, card.cls, card.self) || !inside(r, ux, uy)) continue;
      // The painter numbers the teammate cards; a single panel draws with no card.
      if (labelDrawsNothing(design, panel, r.name, panel === 'teamColumn' || panel === 'infectedRow' ? { state, card: i, ...card } : { state })) continue;
      const area = r.w * r.h;
      if (def.role === 'decor') { if (!decor || area < decor.area) decor = { name: r.name, card: i, area }; continue; }
      if (!best || area < best.area) best = { name: r.name, card: i, area };
    }
  }
  const hit = best ?? decor;
  return hit && { name: hit.name, card: hit.card };
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, colour: string, weight = ''): void {
  ctx.fillStyle = colour;
  ctx.font = `${weight} ${size}px sans-serif`.trim();
  setLetterSpacing(ctx, 0);
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
function paintOwnHealth(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  // The same box the hit test and the outline use (panelBoxes), in canvas pixels.
  const [p] = panelBoxes(design, 'ownHealth');
  const local = { x: p.x * k, y: p.y * k, w: p.w * k, h: p.h * k };
  clipToRect(ctx, r, () => clipToRect(ctx, local, () => drawPanel(ctx, design, 'ownHealth', { x: local.x, y: local.y }, k, { onAsset, state: view.state })));
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

/**
 * The weapon slots, drawn as the game paints them (weapons.ts) with the
 * sample loadout. The game paints inside the HudWeaponSelection panel and
 * VGUI clips that paint to the panel, so the preview clips to the element's
 * rect: the top of the shotgun, which the game centres on its box's top edge,
 * is cut where the panel starts, as in game.
 */
/**
 * The game clips the slots' numbers and icons at the panel. The generator
 * grows the panel to its column (build.ts fitWeaponPanel), to the left with
 * its right edge kept, so the preview draws and clips in the panel as the
 * file has it: the element's own rect (what the player moves) grown by the
 * same amount to the left and down.
 */
function paintWeaponSelection(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  const panel = kvFind(buildTrees(design)('scripts/hudlayout.res'), ['HudWeaponSelection']);
  const wide = panel ? parseSize(pcGet(panel, 'wide') ?? '0', screenW(design.aspect)) * k : 0;
  const tall = panel ? parseSize(pcGet(panel, 'tall') ?? '0', SCREEN_H) * k : 0;
  const box = { x: r.x + r.w - Math.max(r.w, wide), y: r.y, w: Math.max(r.w, wide), h: Math.max(r.h, tall) };
  clipToRect(ctx, box, () => drawWeapons(ctx, design, { x: box.x, y: box.y }, k, box.w / k, onAsset, view.held));
}

const BASECHAT = 'resource/ui/basechat.res';
const CHATSCHEME = 'resource/chatscheme.res';

/**
 * Where the RichText starts its first line inside HudChatHistory, in HUD
 * units, measured in probe-phase2/b2/shots/b2/b2-e.png: the history's
 * top-left is x 45, y 657 px (HudChat 10, r205 plus the history's 10, 17),
 * the "M" of "Mal : probe" inks from x 53 (origin about 51.7, the M's side
 * bearing about 1.3 px) and its cap top at y 663, so with Tahoma's 16.6 px
 * ascent the line's cell starts at y 658.5: 6.75 px (3 units) and 1.5 px
 * (2/3 unit) in.
 */
const CHAT_INSET = { x: 3, y: 2 / 3 };
/**
 * The chat's colours are code's, not any file's: the speaker's name in the
 * survivor team colour and the message in the chat text colour, as b2-e
 * measured them (139 183 221 and 210 200 152, flat).
 */
const CHAT_NAME = 'rgba(139,183,221,1)';
const CHAT_TEXT = 'rgba(210,200,152,1)';
const CHAT_LINES: [string, string][] = [['Zoey', 'watch the closet'], ['Francis', 'got it']];
/** The screen the preview assumes when a scheme font gives sizes per resolution: 1080 lines, the probes' own. */
const PREVIEW_SCREEN_LINES = 1080;

/**
 * ChatFont from the generated chatscheme.res: the entry whose yres range
 * holds the screen's line count, as the game picks one. Those entries give
 * tall in real pixels at that resolution, not in HUD units, so it is turned
 * into units at PREVIEW_SCREEN_LINES (Tahoma 20 at 1080 on stock: the ink in
 * b2-e is 16 px from cap top to descender, a 20-pixel cell).
 */
function chatFont(design: HudDesign): { face: string; weight: number; tallUnits: number } {
  const font = kvFind(buildTrees(design)(CHATSCHEME), ['Fonts', 'ChatFont']);
  const entries = font && typeof font.value !== 'string' ? font.value.filter((e) => typeof e.value !== 'string') : [];
  const inRange = (e: typeof entries[number]) => {
    const [lo, hi] = (pcGet(e, 'yres') ?? '').split(/\s+/).map(Number);
    return Number.isFinite(lo) && Number.isFinite(hi) && PREVIEW_SCREEN_LINES >= lo && PREVIEW_SCREEN_LINES <= hi;
  };
  const e = entries.find(inRange) ?? entries[0];
  if (!e) return { face: 'Tahoma', weight: 700, tallUnits: 12 };
  const tall = parseFloat(pcGet(e, 'tall') ?? '12');
  const scaled = pcGet(e, 'yres') !== undefined;
  return {
    face: pcGet(e, 'name') ?? 'Tahoma',
    weight: parseFloat(pcGet(e, 'weight') ?? '0'),
    tallUnits: scaled ? (tall * SCREEN_H) / PREVIEW_SCREEN_LINES : tall,
  };
}

/**
 * The chat as the game shows it closed (decision 8 of the 2.F plan): only
 * the history's lines, no box behind them (probe-phase2/b2/shots/b2/b2-e.png).
 * The history is basechat.res's HudChatHistory, placed inside the chat
 * window (the element's rect, which chatWindow in build.ts writes for a moved
 * or resized chat), and the lines start at its top-left plus the RichText's
 * inset, one ChatFont cell apart, "Name : text" as the game formats a line,
 * each with the font's one-pixel drop shadow. Clipped to the history, as
 * VGUI clips a RichText, and to the window. The open chat (typing) is a
 * state no probe has shot.
 */
function paintChat(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  const hist = kvFind(buildTrees(design)(BASECHAT), ['HudChatHistory']);
  const W = r.w / k, H = r.h / k;
  const hx = hist ? parsePos(pcGet(hist, 'xpos') ?? '0', W) : 0;
  const hy = hist ? parsePos(pcGet(hist, 'ypos') ?? '0', H) : 0;
  const hw = hist ? parseSize(pcGet(hist, 'wide') ?? '0', W) : W;
  const hh = hist ? parseSize(pcGet(hist, 'tall') ?? '0', H) : H;
  const box = { x: r.x + hx * k, y: r.y + hy * k, w: hw * k, h: hh * k };
  const f = chatFont(design);
  const face = design.preset === 'imported' ? importedFace(baseOf(design), f.face) ?? f.face : f.face;
  loadFace(face, onAsset);
  const cell = fontCell(face, f.tallUnits * k);
  clipToRect(ctx, r, () => clipToRect(ctx, box, () => {
    ctx.save();
    ctx.font = canvasFont(face, f.weight, f.tallUnits * k);
    setLetterSpacing(ctx, synthBoldSpacing(face, f.weight) * k / (1080 / 480));
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    CHAT_LINES.forEach(([who, said], i) => {
      const x = box.x + CHAT_INSET.x * k;
      const y = box.y + CHAT_INSET.y * k + i * cell.cell + cell.ascent;
      const name = `${who} : `;
      const at = x + ctx.measureText(name).width;
      for (const [t, tx, colour] of [[name, x, CHAT_NAME], [said, at, CHAT_TEXT]] as const) {
        ctx.fillStyle = 'rgba(0,0,0,1)';
        ctx.fillText(t, tx + 1, y + 1);
        ctx.fillStyle = colour;
        ctx.fillText(t, tx, y);
      }
    });
    ctx.restore();
  }));
}

const PROGRESS = 'resource/ui/hud/progressbar.res';
/**
 * The sample fill: 0.4, what probe-phase2/b13/b13-stock/heal/mid-heal.png
 * shows (fill x 771 to 946 of an inner 771 to 1210).
 */
const PROGRESS_SAMPLE = 0.4;

/**
 * The use/heal bar drawn from its file (progressbar.res through buildTrees),
 * as the game draws it in probe-phase2/b13/b13-stock/heal/mid-heal.png:
 * AwardIcon's icon_healing (code sets the icon by action; the preview shows
 * the self-heal the B13 shots show), BarLabel's "HEALING YOURSELF" (code
 * fills it with #L4D_progress_heal from resource/left4dead_english.txt) in
 * its font, centred in its row as a Label centres it, and Bar through
 * progress.ts's barGeometry at PROGRESS_SAMPLE. Subtext is blank.
 *
 * The content is the file's, not the element's: the owner's HUD makes
 * HudProgressBar 300 wide and ships no progressbar.res, so the stock one's
 * 228 units of content draw inside it (b13-owner/heal/mid-heal.png, bar
 * x 63 to 510 px), which the old slab, filling the element, got wrong.
 *
 * Each thickness is cut to whole pixels, as the game draws it (1 unit is
 * 2 px at 1080, not 2.25). Stock and Modern keys go through clampBarKeys
 * first (the editor keeps its own files inside probe Q22's rule); an
 * imported file is drawn as written, so a border and gap that eat the bar
 * show the border alone, as they do in game (b1/shots/crops/bar-d.png).
 * Clipped to the element, as VGUI clips the children to their panel.
 */
function paintProgressBar(ctx: CanvasRenderingContext2D, el: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  const nodes = buildTrees(design)(PROGRESS);
  // The pieces live in the real HudProgressBar block (scaled with the
  // element), which VGUI clips them to, not the registry's picking
  // stand-in: a moved icon past it still draws (probe P3, r1/shots/crops/bar-e-icon.png).
  const real = layoutSize(design, 'progressBar');
  const r = { x: el.x, y: el.y, w: real.w * k, h: real.h * k };
  const rectOf = (name: string) => {
    const n = kvFind(nodes, [name]);
    if (!n) return null;
    const W = r.w / k;
    const u = { x: parsePos(pcGet(n, 'xpos') ?? '0', W), y: parsePos(pcGet(n, 'ypos') ?? '0', SCREEN_H), w: parseSize(pcGet(n, 'wide') ?? '0', W), h: parseSize(pcGet(n, 'tall') ?? '0', SCREEN_H) };
    return { n, u, px: { x: r.x + u.x * k, y: r.y + u.y * k, w: u.w * k, h: u.h * k } };
  };
  clipToRect(ctx, r, () => {
    ctx.save();
    const icon = rectOf('AwardIcon');
    if (icon && pcGet(icon.n, 'visible') !== '0') {
      const img = artImage(HEALING_ICON, onAsset);
      if (img) ctx.drawImage(img, icon.px.x, icon.px.y, icon.px.w, icon.px.h);
    }
    const label = rectOf('BarLabel');
    if (label && pcGet(label.n, 'visible') !== '0') {
      const font = pcGet(label.n, 'font') ?? '';
      const cell = setFont(ctx, design, font, k, onAsset);
      ctx.textAlign = 'left';
      const top = label.px.y + (label.px.h - cell.cell) / 2;
      const text = PROGRESS_LABEL;
      if (fontFace(design, font).dropShadow) {
        ctx.fillStyle = 'rgba(0,0,0,1)';
        fillFontText(ctx, cell, text, label.px.x + 1, top + cell.ascent + 1, top + 1, r);
      }
      ctx.fillStyle = colourOf(design, pcGet(label.n, 'fgcolor_override'));
      fillFontText(ctx, cell, text, label.px.x, top + cell.ascent, top, r);
    }
    const bar = rectOf('Bar');
    if (bar && pcGet(bar.n, 'visible') !== '0') {
      const key = (name: string, d: number) => { const v = parseFloat(pcGet(bar.n, name) ?? ''); return Number.isFinite(v) ? v : d; };
      const raw = { border: key('border_thickness', 1), gap: key('gap', 1), shadow: key('shadow_thickness', 1) };
      const keys = design.preset === 'imported' ? raw : clampBarKeys(raw, bar.u.h);
      const px = (v: number) => Math.floor(v * k + 1e-9);
      // The game places the bar on whole pixels (the panel's, then the child's offset, each cut), so its
      // one- and two-pixel lines land crisp: mid-heal.png's ring starts at y 595 = 562 + 33, not 596.25.
      const at = { x: Math.floor(r.x) + px(bar.u.x), y: Math.floor(r.y) + px(bar.u.y), w: bar.px.w, h: bar.px.h };
      const g = barGeometry(at, { border: px(keys.border), gap: px(keys.gap), shadow: px(keys.shadow) }, PROGRESS_SAMPLE);
      const fillRect = (b: { x: number; y: number; w: number; h: number }, colour: string | undefined) => {
        ctx.fillStyle = colourOf(design, colour);
        ctx.fillRect(b.x, b.y, b.w, b.h);
      };
      for (const s of g.shadow) fillRect(s, pcGet(bar.n, 'shadow_color') ?? '0 0 0 255');
      if (g.border) {
        const { x, y, w, h } = g.border, t = g.borderWidth, c = pcGet(bar.n, 'border_color');
        fillRect({ x, y, w, h: t }, c);
        fillRect({ x, y: y + h - t, w, h: t }, c);
        fillRect({ x, y: y + t, w: t, h: h - 2 * t }, c);
        fillRect({ x: x + w - t, y: y + t, w: t, h: h - 2 * t }, c);
      }
      if (g.fill) fillRect(g.fill, pcGet(bar.n, 'fill_color'));
      if (g.empty) fillRect(g.empty, pcGet(bar.n, 'empty_color') ?? '0 0 0 0');
    }
    ctx.restore();
  });
}

const PZ_RECORD = 'resource/ui/hud/pzdamagerecordpanel.res';

/**
 * The notice box's pad either side of the text's advance, in HUD units,
 * measured in probe-phase2/b2/shots-kill/b2-killnotice/b2-f.png. The box
 * art (scalablepanel_bgblack_outlinegrey) has 9 texels of soft shadow
 * outside its 3-texel grey rim, so with the file's 8-unit corners (18 px for
 * 16 texels) the rim sits 10.1 px inside the drawn box. The game's rim runs
 * from x 30 to 333 px around text whose origin is x 45 and whose advance
 * ends about x 319: the drawn box runs from about x 19.9 to 343.6, 25.1 px
 * left of the text and 24.1 right of it, about 11 units either side. The
 * rim's top and bottom (y 382 and 416) fit the file's label4background tall
 * of 25 units centred on the 15-unit row (y 371.25 to 427.5 px drawn).
 */
const NOTICE_PAD = 11;

/**
 * The kill/incap notices (HudPZDamageRecord). Its rows (recordlabel0..4)
 * are blank and hidden in the base files and filled in by game code, so the
 * preview shows one sample notice (decision 7 of the 2.F plan): row 0,
 * "Hunter incapacitated Francis", the notice probe B2 shot
 * (probe-phase2/b2/shots-kill/b2-killnotice/b2-f.png: first ink x 46 px,
 * box x 30 to 333, y 382 to 416). Everything is read from the generated
 * trees (buildTrees): the row's place, tall, font and fgcolor_override from
 * pzdamagerecordpanel.res, and the alignment from hudlayout.res's
 * label_textalign, which the game applies to every row over the row's own
 * textAlignment (the stock rows say east; the shot is at the left, as the
 * stock block's west says). Behind the text, the label4background art
 * nine-sliced with the file's src_corner (texels) and draw_corner (units),
 * its own tall centred on the row, the text's width plus NOTICE_PAD. How a second notice
 * stacks is probe B12's to settle. Clipped to the element, as VGUI clips the
 * rows to their container.
 */
function paintKillNotices(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  const trees = buildTrees(design);
  const nodes = trees(PZ_RECORD);
  const n = kvFind(nodes, ['recordlabel0']);
  if (!n) return;
  const layout = kvFind(trees('scripts/hudlayout.res'), ['HudPZDamageRecord']);
  const align = ((layout && pcGet(layout, 'label_textalign')) ?? 'west').toLowerCase();
  const line = 'Hunter incapacitated Francis';
  clipToRect(ctx, r, () => {
    ctx.save();
    const xpos = parseFloat(kvGet(n, 'xpos') ?? '0');
    const ypos = parseFloat(kvGet(n, 'ypos') ?? '0');
    const tall = parseFloat(kvGet(n, 'tall') ?? '15');
    // An 'f' wide is the screen's width less the number, not the panel's
    // (VGUI's alignScreenWide): in game the east notice ends at the row's
    // right edge, 10 + 10 + (853.33 - 40) units, x 1875 px
    // (/home/volence/l4d/hud/probe-phase2-rest/k-verify/measure.txt, k-f).
    const wide = parseSize(kvGet(n, 'wide') ?? '0', screenW(design.aspect));
    // The row's font at its own size, its cell centred in the row as a
    // Label centres it, the glyphs hanging from the cell's top.
    const cell = setFont(ctx, design, kvGet(n, 'font') ?? '', k, onAsset);
    const textW = ctx.measureText(line).width;
    let x = r.x + xpos * k, left = x;
    if (align.includes('east')) { ctx.textAlign = 'right'; x = r.x + (xpos + wide) * k; left = x - textW; }
    else if (align.includes('center')) { ctx.textAlign = 'center'; x = r.x + (xpos + wide / 2) * k; left = x - textW / 2; }
    else ctx.textAlign = 'left';
    const bg = kvFind(nodes, ['label4background']);
    const material = normaliseMaterial((bg && kvGet(bg, 'image')) ?? '');
    // The editor's own box (build.ts noticePass): a flat square of one
    // colour, or a clear one, so it nine-slices into a flat fill.
    // The Modern preset's box is one of its generated flat panels (MODERN_ART), drawn the same way.
    const modern = baseOf(design) === 'modern' ? MODERN_ART.find((t) => t.name === material) : undefined;
    const own = material === NOTICE_BOX_TEXTURE ? design.elements.killNotices?.noticeBox
      : modern ? { kind: 'flat' as const, color: modern.colour } : undefined;
    const img = bg && !own && artImage(material, onAsset);
    if (bg && (img || own)) {
      const pad = NOTICE_PAD * k;
      const src = parseFloat(kvGet(bg, 'src_corner_width') ?? '16');
      const corner = parseFloat(kvGet(bg, 'draw_corner_width') ?? '8') * k;
      const bgTall = parseFloat(kvGet(bg, 'tall') ?? '25') * k;
      const y = r.y + ypos * k + (tall * k - bgTall) / 2;
      if (img) drawNineSlice(ctx, img, img.naturalWidth, img.naturalHeight, left - pad, y, textW + 2 * pad, bgTall, corner, src);
      else if (own?.kind === 'flat') {
        // Blended in linear light, as the game does: 0 0 255 at 160 over
        // 105 88 61 drew 62 50 210 (/home/volence/l4d/hud/probe-phase2-rest/k-verify/shots/k/k-f.png).
        const box = { x: left - pad, y, w: textW + 2 * pad, h: bgTall };
        const fill = (c: CanvasRenderingContext2D) => { c.fillStyle = colourOf(design, own.color ?? NOTICE_BOX_COLOUR); c.fillRect(box.x, box.y, box.w, box.h); };
        paintLinearOver(ctx, box, fill, () => fill(ctx));
      }
    }
    ctx.fillStyle = colourOf(design, kvGet(n, 'fgcolor_override'));
    const top = r.y + ypos * k + (tall * k - cell.cell) / 2;
    fillFontText(ctx, cell, line, x, top + cell.ascent, top, r);
    ctx.restore();
  });
}

/**
 * The xHair element by the design's crosshair choice. 'bundle' draws the
 * design's own crosshair, the one the download packs, through drawArt, the
 * routine the texture is made with, into the element's rect: exactly as the
 * game draws the texture there. An image draws once decoded (onAsset asks
 * for the redraw). 'addon' cannot know what a crosshair addon draws, so it
 * shows a neutral dashed placeholder. 'none' writes no element, so drawHud
 * never gets here unless it is selected, and then shows the same
 * placeholder, dimmed.
 */
function paintXhair(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, _k: number, onAsset?: () => void) {
  const art = design.xhairArt;
  if (design.crosshair === 'bundle') {
    if (art) drawArt(ctx, r.x + r.w / 2, r.y + r.h / 2, r.w, art, art.kind === 'image' ? urlImage(art.png, onAsset) ?? null : null);
    return;
  }
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  ctx.lineWidth = Math.max(1, r.w / 13);
  ctx.beginPath();
  ctx.moveTo(r.x + r.w / 2, r.y + r.h * 0.3); ctx.lineTo(r.x + r.w / 2, r.y + r.h * 0.7);
  ctx.moveTo(r.x + r.w * 0.3, r.y + r.h / 2); ctx.lineTo(r.x + r.w * 0.7, r.y + r.h / 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * The infected cards where the game puts them (infectedCardRects), each
 * clipped to its own block and all to the container, as VGUI clips them;
 * later cards draw over earlier ones where an unfitted 256-wide block
 * overlaps the next. Each is drawn as its sample class (infectedCardClasses)
 * in the page's Alive, Ghost or Dead state.
 */
function paintInfectedRow(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  const state = previewOf(view.state);
  clipToRect(ctx, r, () => {
    for (const [i, c] of infectedCardRects(design).entries()) {
      const card = { x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k };
      clipToRect(ctx, card, () => drawPanel(ctx, design, 'infectedRow', { x: card.x, y: card.y }, k,
        { card: i, onAsset, state, ...cardOpts('infectedRow', i, state) }));
    }
  });
}

/**
 * Your infected health, drawn from the file of the class the page picks
 * (render.ts panelFile: the Hunter's for the Hunter and the Tank), clipped to
 * HudZombieHealth as the game clips it (probe Q11,
 * /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/br-bce.png).
 * Only on a spawned infected: the game shows none as a ghost or dead (probe
 * B14, b14/shots/b14/b14-a.png and b14-g.png).
 */
function paintSiHealth(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  if (previewOf(view.state).infected !== 'alive') return;
  clipToRect(ctx, r, () => drawPanel(ctx, design, 'siHealth', { x: r.x, y: r.y }, k, { onAsset, state: view.state }));
}

const ABILITY = 'resource/ui/hud/abilitytimerhud.res';
/**
 * The texture each class's ability code sets on AbilityImage (spec 1.4 item
 * 5: the strings sit beside CLunge, C_Tongue, CVomit and the Tank's throw).
 * The Hunter's is pz_charge_lunge, the one the game draws in
 * probe-phase2/b3/shots-rerun/b3-rerun/b3-b.png; pz_charge_pounce is unused.
 */
const ABILITY_ICON: Record<PreviewState['siClass'], string> = {
  hunter: 'vgui/hud/pz_charge_lunge', smoker: 'vgui/hud/pz_charge_smoker', boomer: 'vgui/hud/pz_charge_boomer', tank: 'vgui/hud/pz_charge_tank',
};
/**
 * The charging sample: the meter's lit share of its turn. Probe Q15 caught
 * a Smoker 1.3 s into a 3 s cooldown lit about 0.42 of the way round
 * (/home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/progress-f-zoom.png).
 */
const ABILITY_CHARGE = 0.4;

/**
 * The ability timer drawn from its file (AbilityTimerHud.res through
 * buildTrees), each child at the element's origin plus its own rect, in zpos
 * order: BackgroundImage with pz_charge_bg (code sets it over the file's
 * image, probe Q14, /home/volence/l4d/hud/probe-phase2-infected/b9/shots/crops/br-bcd.png),
 * AbilityImage with the class's icon, Progress with its fg_image,
 * pz_charge_meter. Measured in probe-phase2/b3/shots-rerun/b3-rerun/b3-b.png:
 * the icon's red rings (part of the texture) centred at (1847, 899), the
 * centre of the 80 x 80 background, not of the 80 x 70 element.
 *
 * Probe Q15 (/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md):
 * - the state colour tints the icon (magenta ready, cyan charging in
 *   b9/shots/crops/br-bcd.png) and the backdrop's ring art. client.dll
 *   (0x10228108 on) sets it on the meter as well, but the meter's material
 *   is UnlitTwoTexture, which draws no vertex colour: in B15
 *   (b15/shots/b15/b15-e.png, a Smoker recharging under the stock 127 grey)
 *   the lit arc samples 202 88 58, as bright as the ready meter (b15-d), so
 *   the preview draws it untinted. Q15's "R 101 charging" was a dark spot of
 *   the meter's turning glint, not a tint;
 * - ready, the meter is whole; recharging, it is lit from 12 o'clock
 *   counter-clockwise for the charged share (progress-f-zoom.png; a
 *   clockwise drain would draw the same shape, so this is exact either way);
 *   not ready with nothing to refill (a standing Hunter), it is not lit at
 *   all (b10/shots/crops/ring-b.png against ring-c.png, crouched);
 * - the meter's art is the product of its two textures, red (the export
 *   script's TWO_TEXTURE), not the base texture's orange;
 * - the ring shows only on a spawned infected: none as a ghost (b9-a) or
 *   dead (b9-e).
 * A Hunter is not ready while standing and ready while crouched; the Smoker,
 * Boomer and Tank spawn ready, and every class recharges after its ability. Modern hides BackgroundImage (0 x 0, visible
 * 0), so its ring has no splat, as its file says. Clipped to the element,
 * as VGUI clips a panel's children: the background's bottom 10 units fall
 * outside the 70-tall element.
 */
/** One piece of ability art, tinted by a state colour at its alpha, stretched to its box. */
function paintTintedArt(ctx: CanvasRenderingContext2D, material: string, box: Rect, rgba: [number, number, number, number], onAsset?: () => void) {
  const img = artImage(material, onAsset);
  if (!img) return;
  const [tr, tg, tb, ta] = rgba;
  ctx.save();
  ctx.globalAlpha *= ta / 255;
  const src = tr < 255 || tg < 255 || tb < 255 ? tinted(img, material, tr, tg, tb) : img;
  ctx.drawImage(src, box.x, box.y, box.w, box.h);
  ctx.restore();
}

/**
 * A CircularProgressBar's lit share: the box's art cut to a wedge from 12
 * o'clock counter-clockwise over `frac` of the turn, as the ability timer's
 * meter fills in game (probe Q15,
 * /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/progress-f-zoom.png).
 */
function inArc(ctx: CanvasRenderingContext2D, box: Rect, frac: number, draw: () => void) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, Math.max(box.w, box.h), -Math.PI / 2, -Math.PI / 2 - frac * 2 * Math.PI, true);
  ctx.closePath();
  ctx.clip();
  draw();
  ctx.restore();
}

function paintAbilityRing(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  const state = previewOf(view.state);
  if (state.infected !== 'alive') return;
  const trees = buildTrees(design);
  const layout = kvFind(trees('scripts/hudlayout.res'), ['CHudAbilityTimer']);
  const colourKey = state.ability === 'ready' ? 'ability_ready_color' : 'ability_charging_color';
  const rgba = rgbaOf(design, (layout && pcGet(layout, colourKey)) ?? '255 255 255 255');
  const kids = trees(ABILITY).filter((n) => typeof n.value !== 'string')
    .map((n, i) => ({ n, i, z: parseFloat(pcGet(n, 'zpos') ?? '0') || 0 }))
    .sort((a, b) => a.z - b.z || a.i - b.i);
  const paint = (material: string, box: Rect) => paintTintedArt(ctx, material, box, rgba, onAsset);
  clipToRect(ctx, r, () => {
    for (const { n } of kids) {
      if (pcGet(n, 'visible') === '0') continue;
      const w = parseFloat(pcGet(n, 'wide') ?? '0'), h = parseFloat(pcGet(n, 'tall') ?? '0');
      if (!(w > 0 && h > 0)) continue;
      const box = { x: r.x + parseFloat(pcGet(n, 'xpos') ?? '0') * k, y: r.y + parseFloat(pcGet(n, 'ypos') ?? '0') * k, w: w * k, h: h * k };
      const name = n.key.toLowerCase();
      if (name === 'backgroundimage') paint('vgui/hud/pz_charge_bg', box);
      else if (name === 'abilityimage') paint(ABILITY_ICON[state.siClass], box);
      else if (name === 'progress') {
        // Never tinted: see the note above.
        const material = normaliseMaterial(pcGet(n, 'fg_image') ?? 'HUD/PZ_charge_meter');
        const meter = () => paintTintedArt(ctx, material, box, [255, 255, 255, 255], onAsset);
        if (state.ability === 'notReady') continue;
        if (state.ability === 'ready') { meter(); continue; }
        inArc(ctx, box, ABILITY_CHARGE, meter);
      }
    }
  });
}

/**
 * The ability marker round the infected crosshair: PZ_charge_crosshair
 * stretched to the element's rect (build.ts markerBox, sized in screen
 * pixels at 1080p), tinted by HudCrosshair's state colour. client.dll's
 * update (0x1024124c on) shows it only for a spawned infected with an
 * ability, sets its progress to the ability's, and colours it: the
 * suppressed colour when suppressed, the charging colour below full
 * progress (so a standing Hunter, with none, draws nothing: probe Q16a,
 * /home/volence/l4d/hud/probe-phase2-infected/b9/shots-v2/crops/centre-af.png b),
 * else the ready colour, or the attack colour with a survivor in reach.
 * The preview's Recharging draws the ring's sample share. Never drawn with
 * the game's crosshair hidden: never_draw takes the whole HudCrosshair
 * (probe Q16b, b10/shots/crops/centre-bcef.png).
 */
function paintAbilityMarker(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, _k: number, onAsset?: () => void, view: HudView = {}) {
  const state = previewOf(view.state);
  if (design.hideGameCrosshair || state.infected !== 'alive' || state.ability === 'notReady') return;
  const c = kvFind(buildTrees(design)('scripts/hudlayout.res'), ['HudCrosshair']);
  const key = state.ability === 'ready' ? 'ability_ready_color' : 'ability_charging_color';
  const rgba = rgbaOf(design, (c && pcGet(c, key)) ?? '255 255 255 255');
  const paint = () => paintTintedArt(ctx, 'vgui/hud/pz_charge_crosshair', r, rgba, onAsset);
  if (state.ability === 'ready') paint(); else inArc(ctx, r, ABILITY_CHARGE, paint);
}

/**
 * The game's own infected crosshair, PZ_crosshair_open (a hud_textures.txt
 * cell of sprites/crosshairs, 32 texels), drawn untinted in a 34 px box on
 * the centre, as probe B9 v2 measured it at 1080p
 * (/home/volence/l4d/hud/probe-phase2-infected/b9/shots-v2/b9v2/b9v2-d.png:
 * the circle's texel 1 lands on x 944 and texel 29 on 973 to 975, so a
 * texel is about 1.07 px; a ghost has it too, b9v2-a). Not an element:
 * the only file control over it is Hide the game's crosshair. The owner's
 * own config has crosshair 0, under which the game draws neither this nor
 * the marker.
 */
const CROSSHAIR_PX = 34;
function paintGameCrosshair(ctx: CanvasRenderingContext2D, pxW: number, pxH: number, design: HudDesign, onAsset: (() => void) | undefined, view: HudView) {
  if (design.hideGameCrosshair || previewOf(view.state).infected === 'dead') return;
  const img = artImage(CROSSHAIR_OPEN, onAsset);
  if (!img) return;
  const s = (CROSSHAIR_PX / MARKER_PX_PER_UNIT) * (pxH / SCREEN_H);
  ctx.drawImage(img, pxW / 2 - s / 2, pxH / 2 - s / 2, s, s);
}

const GHOST = 'resource/ui/hudghostpanel.res';
/** A block of a status panel file, in canvas pixels inside `r`, from the generated tree (so already scaled). */
function blockRect(n: KvNode, r: Rect, k: number, W: number): Rect {
  return {
    x: r.x + parsePos(pcGet(n, 'xpos') ?? '0', W) * k, y: r.y + parsePos(pcGet(n, 'ypos') ?? '0', SCREEN_H) * k,
    w: parseSize(pcGet(n, 'wide') ?? '0', W) * k, h: parseSize(pcGet(n, 'tall') ?? '0', SCREEN_H) * k,
  };
}

/** The class a ghost or a too-far panel shows: the page's, but a Tank is never a ghost, so the Hunter stands in. */
const tipClass = (state: PreviewState): 'hunter' | 'smoker' | 'boomer' => (state.siClass === 'tank' ? 'hunter' : state.siClass);

/**
 * The lines the spawn panel shows in its sample state, the one the stock
 * ghost shot has (/home/volence/l4d/hud/probe-phase2/b13/b13-stock/infected/ghost.png):
 * the class, "Choose Spawn Location" and a spawn refused in a restricted
 * area. Code writes them (resource/left4dead_english.txt) and colours each
 * with the panel's WhiteText or RedText (probe G1, r3-a); SpawnLabel and
 * SpawnBind show only once you can spawn (r5-a), so the sample leaves them out.
 */
const GHOST_LINES: { name: string; text: (s: PreviewState) => string; red: boolean }[] = [
  { name: 'ClassName', text: (s) => tipClass(s).toUpperCase(), red: false },
  { name: 'SelectSpawn', text: () => 'Choose Spawn Location', red: false },
  { name: 'Ready', text: () => "Can't spawn here", red: true },
  { name: 'Info', text: () => 'This is a restricted area', red: true },
];

/**
 * The spawn (ghost) panel drawn from its files (hudghostpanel.res and
 * HudGhostPanel's two colour keys, through buildTrees), only while you are
 * a ghost: the backdrop box (paintPanelBox), the class picture (tip_<class>,
 * stretched as scaleImage 1 has it) and the sample lines. Clipped to the
 * element, as VGUI clips a panel's children.
 */
function paintGhostPanel(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  const state = previewOf(view.state);
  const trees = buildTrees(design);
  const nodes = trees(GHOST);
  const layout = kvFind(trees('scripts/hudlayout.res'), ['HudGhostPanel']);
  const white = colourOf(design, (layout && pcGet(layout, 'WhiteText')) ?? '255 255 255 255');
  const red = colourOf(design, (layout && pcGet(layout, 'RedText')) ?? '255 0 0 255');
  const W = screenW(design.aspect);
  const shown = (name: string) => { const n = kvFind(nodes, [name]); return n && pcGet(n, 'visible') !== '0' ? n : undefined; };
  clipToRect(ctx, r, () => {
    ctx.save();
    const bg = shown('Background');
    if (bg) paintPanelBox(ctx, design, bg, blockRect(bg, r, k, W), k);
    const pic = shown('ClassImage');
    const img = pic && artImage(tipImage(tipClass(state)), onAsset);
    if (pic && img) { const b = blockRect(pic, r, k, W); ctx.drawImage(img, b.x, b.y, b.w, b.h); }
    for (const line of GHOST_LINES) {
      const n = shown(line.name);
      if (n) paintPanelLabel(ctx, design, n, blockRect(n, r, k, W), k, line.text(state), line.red ? red : white, r, onAsset);
    }
    ctx.restore();
  });
}

const ZPANEL = 'resource/ui/zombiepanel.res';
/**
 * Where code puts the too-far line: it has no xpos in the file, and the
 * game draws it after the key, from 116 units into the box (ink from
 * x 884 px with the box at 622.5, r6/shots/r6/r6-a.png), 29 units past
 * UseBind's 87.
 */
const TOO_FAR_TEXT_AFTER_BIND = 29;

/**
 * A key as CBindPanel draws it: a light key cap with the key's letter. The
 * game draws the player's own binding (E by default, r6-a: the cap at
 * x 827 to 863 px, y 230 to 265, from UseBind's 818 px); the preview
 * draws E.
 */
function paintKeyCap(ctx: CanvasRenderingContext2D, x: number, y: number, k: number) {
  const s = 16 * k, at = { x: x + 4 * k, y: y - s / 2 };
  ctx.fillStyle = 'rgba(200,200,200,1)';
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(at.x, at.y, s, s, 2 * k); ctx.fill(); } else ctx.fillRect(at.x, at.y, s, s);
  ctx.fillStyle = 'rgba(40,40,40,1)';
  ctx.textAlign = 'center';
  ctx.font = `${Math.round(10 * k)}px sans-serif`;
  setLetterSpacing(ctx, 0);
  ctx.fillText('E', at.x + s / 2, at.y + s * 0.72);
}

/**
 * The too-far box drawn from zombiepanel.res (through buildTrees), only
 * while you are spawned: TooFarFromSurvivors placed inside the element and
 * clipping its pieces, as an EditablePanel does; its Background box
 * (paintPanelBox: navy 0 0 128 200 over black drew 0 0 115 in r6-a, the
 * linear blend), the class picture code puts in SurvivorsImage (a Smoker's
 * in r6-a, not the file's tip_crouch), the title and the line in their
 * file colours and fonts (#L4D_Zombie_UI_Too_Far and _To_Be_Moved), and
 * the key. The Tank offer box is not drawn: no probe has seen it.
 */
function paintZombiePanel(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  const state = previewOf(view.state);
  const nodes = buildTrees(design)(ZPANEL);
  const frame = kvFind(nodes, ['TooFarFromSurvivors']);
  if (!frame) return;
  const W = screenW(design.aspect);
  const f = blockRect(frame, r, k, W);
  const shown = (name: string) => { const n = kvFind(nodes, ['TooFarFromSurvivors', name]); return n && pcGet(n, 'visible') !== '0' ? n : undefined; };
  clipToRect(ctx, r, () => clipToRect(ctx, f, () => {
    ctx.save();
    const bg = shown('Background');
    if (bg) paintPanelBox(ctx, design, bg, blockRect(bg, f, k, W), k);
    const pic = shown('SurvivorsImage');
    const img = pic && artImage(tipImage(tipClass(state)), onAsset);
    if (pic && img) { const b = blockRect(pic, f, k, W); ctx.drawImage(img, b.x, b.y, b.w, b.h); }
    const title = shown('TooFarTitle');
    if (title) paintPanelLabel(ctx, design, title, blockRect(title, f, k, W), k, 'TOO FAR FROM THE SURVIVORS', labelColour(design, title), f, onAsset);
    const bind = shown('UseBind');
    const line = shown('TooFarText');
    if (line) {
      const b = blockRect(line, f, k, W);
      const bindX = bind ? parsePos(pcGet(bind, 'xpos') ?? '0', W) : 0;
      const at = { ...b, x: f.x + (bindX + TOO_FAR_TEXT_AFTER_BIND) * k, w: f.w };
      paintPanelLabel(ctx, design, line, at, k, 'Move closer to the Survivors', labelColour(design, line), f, onAsset);
      if (bind) paintKeyCap(ctx, f.x + bindX * k, at.y + at.h / 2, k);
    }
    ctx.restore();
  }));
}


const FRUST = 'resource/ui/hud/frustrationmeter.res';
/** The sample frustration: half, as the old stand-in showed. */
const FRUST_SAMPLE = 0.5;
/**
 * The frustration meter drawn from frustrationmeter.res (through
 * buildTrees), for a spawned Tank only: the three lines code fills from
 * resource/left4dead_english.txt (#L4D_tank_attack_survivors,
 * _lose_control, _lose_control_1), the CONTROL label, all in their file
 * colours and fonts, and the bar at FRUST_SAMPLE, filled from the right
 * while east_aligned is 1 (the stock file's). The bar as the game draws it
 * (probe V1f, /home/volence/l4d/hud/probe-phase2-rest/v1/crops/v1f-frustration-stock-d.png,
 * and V1d's east_aligned 0, v1d-frustration-d.png): a 1 px white outline on
 * the block, no track, and a white fill FRUST_FILL_INSET px inside it.
 * Whatever gate T1 says, this reads the file as it is: a closed gate only
 * keeps edits out of it.
 */
const FRUST_WHITE = 'rgba(255,255,255,1)';
const FRUST_FILL_INSET = 2;
const FRUST_LINES: [string, string][] = [
  ['Countdown', 'ATTACK THE SURVIVORS'], ['Warning', 'You must attack or you will'], ['Warning2', 'lose control of the Tank'], ['FrustrationLabel', 'CONTROL'],
];
function paintTankPanel(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  const nodes = buildTrees(design)(FRUST);
  const W = screenW(design.aspect);
  const shown = (name: string) => { const n = kvFind(nodes, [name]); return n && pcGet(n, 'visible') !== '0' ? n : undefined; };
  clipToRect(ctx, r, () => {
    ctx.save();
    const bar = shown('FrustrationBar');
    if (bar) {
      const b = blockRect(bar, r, k, W);
      ctx.fillStyle = FRUST_WHITE;
      ctx.fillRect(b.x, b.y, b.w, 1);
      ctx.fillRect(b.x, b.y + b.h - 1, b.w, 1);
      ctx.fillRect(b.x, b.y, 1, b.h);
      ctx.fillRect(b.x + b.w - 1, b.y, 1, b.h);
      const inner = b.w - 2 * FRUST_FILL_INSET;
      const w = inner * FRUST_SAMPLE;
      const x = pcGet(bar, 'east_aligned') === '0' ? b.x + FRUST_FILL_INSET : b.x + b.w - FRUST_FILL_INSET - w;
      ctx.fillRect(x, b.y + FRUST_FILL_INSET, w, b.h - 2 * FRUST_FILL_INSET);
    }
    for (const [name, s] of FRUST_LINES) {
      const n = shown(name);
      if (n) paintPanelLabel(ctx, design, n, blockRect(n, r, k, W), k, s, labelColour(design, n), r, onAsset);
    }
    ctx.restore();
  });
}

const SPECTATOR = 'resource/ui/spectatorinfected.res';
/**
 * The dead infected's spawn countdown drawn from spectatorinfected.res
 * (through buildTrees), only while you are dead: SpawnModeLabel's "YOU ARE
 * DEAD" (#L4D_pz_spectator_title) and InfectedState's countdown
 * (#L4D_pz_spawn_countdown, a sample 12 seconds), each where the file puts
 * it on the screen (the file's panel is the whole screen), in its font and
 * colour; b9-e (probe-phase2-infected) shows the title so. The file's
 * dark title band (ghost_title_bg) is left out.
 */
function paintSpawnCountdown(ctx: CanvasRenderingContext2D, _r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  const nodes = buildTrees(design)(SPECTATOR);
  const W = screenW(design.aspect);
  const screen = { x: 0, y: 0, w: W * k, h: SCREEN_H * k };
  ctx.save();
  for (const [name, s] of [['SpawnModeLabel', 'YOU ARE DEAD'], ['InfectedState', 'You will enter Spawn Mode in 12 seconds']]) {
    const n = kvFind(nodes, [name]);
    if (n && pcGet(n, 'visible') !== '0') paintPanelLabel(ctx, design, n, blockRect(n, screen, k, W), k, s, labelColour(design, n), screen, onAsset);
  }
  ctx.restore();
}

/**
 * Your microphone as the game draws it while you talk: voice_self, a white
 * microphone glyph (L4D_Icons_large "V") in the element's box. The preview
 * draws a plain microphone shape as tall as the box's shorter side, at its
 * top left.
 */
function paintOwnMic(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, _k: number, onAsset?: () => void) {
  // An upload (plan task T2) fills the box, as the repointed cell did in probe V1 (r1/shots/crops/voice-g.png: 48 x 48 units).
  const own = design.images.voiceSelf;
  if (own) {
    const img = storedImage(own, onAsset);
    if (img) ctx.drawImage(img.img, r.x, r.y, r.w, r.h);
    return;
  }
  const s = Math.min(r.w, r.h);
  const cx = r.x + s / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = Math.max(1, s * 0.08);
  const head = { w: s * 0.36, h: s * 0.56 };
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(cx - head.w / 2, r.y + s * 0.05, head.w, head.h, head.w / 2);
  else ctx.rect(cx - head.w / 2, r.y + s * 0.05, head.w, head.h);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, r.y + s * 0.4, s * 0.3, 0, Math.PI);
  ctx.moveTo(cx, r.y + s * 0.7);
  ctx.lineTo(cx, r.y + s * 0.9);
  ctx.moveTo(cx - s * 0.2, r.y + s * 0.92);
  ctx.lineTo(cx + s * 0.2, r.y + s * 0.92);
  ctx.stroke();
  ctx.restore();
}

const VOTEHUD = 'resource/ui/hud/votehud.res';
/**
 * The lines the vote box shows in r4-e
 * (/home/volence/l4d/hud/probe-phase2-rest/r4/shots/r4/r4-e.png, after
 * `callvote ChangeDifficulty Normal`): code fills them from
 * resource/left4dead_english.txt. The caller's own YES is the selected row.
 */
const VOTE_LINES: [string, string][] = [
  ['Header', 'VOTE:'], ['Issue', 'Change difficulty to Normal?'],
  ['YesPCLabel', 'Press F1 to vote YES'], ['NoPCLabel', 'Press F2 to vote NO'], ['VoteCountLabel', 'Current vote count:'],
];

/**
 * The vote box drawn from votehud.res (through buildTrees): VoteActive at
 * the element's corner, which code shows while a vote runs (its file
 * visible 0 is the resting state), its box in its colour (paintPanelBox,
 * rounded: r4-e's purple box x 735 to 1185), the two dividers and the
 * selected YES row in their fill colours, and the lines in their own file
 * colours and fonts.
 */
function paintVote(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  const nodes = buildTrees(design)(VOTEHUD);
  const frame = kvFind(nodes, ['VoteActive']);
  if (!frame) return;
  const W = screenW(design.aspect);
  const f = blockRect(frame, r, k, W);
  const inside = (name: string) => { const n = kvFind(nodes, ['VoteActive', name]); return n && pcGet(n, 'visible') !== '0' ? n : undefined; };
  clipToRect(ctx, f, () => {
    ctx.save();
    paintPanelBox(ctx, design, frame, f, k);
    for (const name of ['Divider', 'YesBackground_Selected', 'Divider2']) {
      const n = inside(name);
      const fill = n && pcGet(n, 'fillcolor');
      if (!n || !fill) continue;
      const b = blockRect(n, f, k, W);
      ctx.fillStyle = colourOf(design, fill);
      ctx.fillRect(b.x, b.y, b.w, Math.max(1, b.h));
    }
    for (const [name, line] of VOTE_LINES) {
      const n = inside(name);
      if (n) paintPanelLabel(ctx, design, n, blockRect(n, f, k, W), k, line, labelColour(design, n), f, onAsset);
    }
    ctx.restore();
  });
}

const HOLDOUT = 'resource/ui/hud/hudholdouttimer.res';
/** The two times and the goal as r2-g (/home/volence/l4d/hud/probe-phase2-rest/r2/shots/r2/r2-g.png) shows them, half a second into a round. */
const HOLDOUT_LINES: [string, string][] = [['CurrentTimeDigits', '00:00.50'], ['TargetTimeDigits', '04:00.00'], ['NextGoalDescriptor', 'Bronze Standard']];

/**
 * The survival timer drawn from hudholdouttimer.res (through buildTrees):
 * its two dark boxes (ScalablePanel_bgMidGrey_glow, nine-sliced with 16
 * texel corners drawn draw_corner_width units wide), the stopwatch as a
 * white disc (its size measured in the M-verify launch), and the times and the goal in their fonts, where r2-g has
 * them. The red splash behind (HoldoutTimerBackground) is left out: the
 * preview has no art for it.
 */
function paintHoldoutTimer(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void) {
  const nodes = buildTrees(design)(HOLDOUT);
  const W = screenW(design.aspect);
  const shown = (name: string) => { const n = kvFind(nodes, [name]); return n && pcGet(n, 'visible') !== '0' ? n : undefined; };
  clipToRect(ctx, r, () => {
    ctx.save();
    const glow = artImage('vgui/hud/scalablepanel_bgmidgrey_glow', onAsset);
    for (const name of ['CurrentTimeBackground', 'HoldoutTargetTimeBackgroundImage']) {
      const n = shown(name);
      if (!n) continue;
      const b = blockRect(n, r, k, W);
      const corner = parseFloat(pcGet(n, 'draw_corner_width') ?? '8') * k;
      if (glow) drawNineSlice(ctx, glow, glow.naturalWidth || 64, glow.naturalHeight || 64, b.x, b.y, b.w, b.h, corner);
      else { ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(b.x, b.y, b.w, b.h); }
    }
    const timer = shown('Timer');
    if (timer) {
      const b = blockRect(timer, r, k, W);
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.beginPath();
      // The clock face fills 0.3 of the Timer's side each way: 78 px across in its 130 px at 1080p
      // (/home/volence/l4d/hud/probe-phase2-rest/m-verify/crops/m-e-game-over-preview.png).
      ctx.arc(b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.3, 0, 2 * Math.PI);
      ctx.fill();
    }
    for (const [name, line] of HOLDOUT_LINES) {
      const n = shown(name);
      if (n) paintPanelLabel(ctx, design, n, blockRect(n, r, k, W), k, line, labelColour(design, n), r, onAsset);
    }
    ctx.restore();
  });
}

/**
 * A panel no probe has seen (plan decision 3): a dark box with the words
 * the game puts in it, so the player can see where it lands.
 */
const framePainter = (words: string) => (ctx: CanvasRenderingContext2D, r: Rect, _d: HudDesign, k: number) => {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
  const size = Math.max(6, Math.min(r.h * 0.6, 10 * k));
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  clipToRect(ctx, r, () => text(ctx, words, r.x + r.w / 2, r.y + r.h / 2, size, 'rgba(230,230,230,1)'));
  ctx.restore();
};

/** Sample talkers for the voice list. */
const VOICE_NAMES = ['Zoey', 'Francis'];
/**
 * The voice list: its rows as HudVoiceStatus lays them out from its own
 * keys (through buildTrees): each item_tall high, item_spacing apart from
 * the panel's top, a speaker icon at icon_xpos and the name at text_xpos.
 */
function paintVoiceList(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number) {
  const n = kvFind(buildTrees(design)('scripts/hudlayout.res'), ['HudVoiceStatus']);
  if (!n) return;
  const key = (name: string, d: number) => { const v = parseFloat(pcGet(n, name) ?? ''); return Number.isFinite(v) ? v : d; };
  const tall = key('item_tall', 15), wide = key('item_wide', 120), gap = key('item_spacing', 2);
  const icon = { x: key('icon_xpos', 0), w: key('icon_wide', 16), h: key('icon_tall', 16) }, textX = key('text_xpos', 18);
  ctx.textAlign = 'left';
  clipToRect(ctx, r, () => {
    VOICE_NAMES.forEach((name, i) => {
      const top = r.y + i * (tall + gap) * k;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(r.x, top, wide * k, tall * k);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(r.x + icon.x * k + 3 * k, top + (tall - icon.h) / 2 * k + 3 * k, Math.max(1, (icon.w - 6) * k), Math.max(1, (icon.h - 6) * k));
      ctx.restore();
      text(ctx, name, r.x + textX * k, top + tall * k * 0.75, Math.max(6, Math.min(tall * 0.8, 12) * k), 'rgba(230,230,230,1)');
    });
  });
}

const PAINTERS: Record<string, (ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view?: HudView) => void> = {
  ownHealth: paintOwnHealth,
  teamColumn: paintTeamColumn,
  weaponSelection: paintWeaponSelection,
  chat: paintChat,
  progressBar: paintProgressBar,
  killNotices: paintKillNotices,
  xhair: paintXhair,
  infectedRow: paintInfectedRow,
  siHealth: paintSiHealth,
  abilityRing: paintAbilityRing,
  abilityMarker: paintAbilityMarker,
  ghostPanel: paintGhostPanel,
  zombiePanel: paintZombiePanel,
  spawnCountdown: paintSpawnCountdown,
  tankPanel: paintTankPanel,
  ownMic: paintOwnMic,
  vote: paintVote,
  holdoutTimer: paintHoldoutTimer,
  voiceList: paintVoiceList,
  infectedVoice: framePainter('Infected voice'),
  finaleMeter: framePainter('Finale'),
  perilNotice: framePainter('A TEAMMATE IS IN TROUBLE'),
  leavingArea: framePainter('PLEASE WAIT FOR YOUR TEAMMATES'),
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

function drawHiddenOutline(ctx: CanvasRenderingContext2D, r: Rect, d = 1) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = d;
  ctx.setLineDash([4 * d, 4 * d]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

/** Handles are a fixed size on screen, whatever the canvas scale. */
export const HANDLE_PX = 7;
const GUIDE = '#ff4fa3';
const MARQUEE = 'rgba(153,204,255,0.9)';
const MARQUEE_FILL = 'rgba(153,204,255,0.13)';

function drawFrames(ctx: CanvasRenderingContext2D, frames: Box[], k: number, accent: string, d = 1) {
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5 * d;
  ctx.setLineDash([]);
  for (const f of frames) ctx.strokeRect(f.x * k, f.y * k, f.w * k, f.h * k);
  ctx.restore();
}

/** The selection's box, thin, and a white square with an accent edge on each handle point. */
function drawHandles(ctx: CanvasRenderingContext2D, box: Box | null, points: { x: number; y: number }[], k: number, accent: string, d = 1) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = d;
  ctx.strokeStyle = accent;
  if (box) ctx.strokeRect(box.x * k, box.y * k, box.w * k, box.h * k);
  const size = HANDLE_PX * d;
  for (const p of points) {
    const x = p.x * k - size / 2, y = p.y * k - size / 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, size, size);
    ctx.strokeRect(x, y, size, size);
  }
  ctx.restore();
}

/** What a click would pick: a dashed white outline and its name in a small label above the first rect. */
function drawHover(ctx: CanvasRenderingContext2D, hover: { rects: Box[]; label: string }, k: number, d = 1) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = d;
  ctx.setLineDash([3 * d, 3 * d]);
  for (const r of hover.rects) ctx.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
  ctx.setLineDash([]);
  const first = hover.rects[0];
  if (first && hover.label) {
    ctx.font = `${11 * d}px sans-serif`;
    setLetterSpacing(ctx, 0);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const w = ctx.measureText(hover.label).width + 8 * d;
    const x = first.x * k, y = Math.max(0, first.y * k - 16 * d);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(x, y, w, 14 * d);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(hover.label, x + 4 * d, y + 11 * d);
  }
  ctx.restore();
}

function drawMarquee(ctx: CanvasRenderingContext2D, m: Box, k: number, d = 1) {
  ctx.save();
  ctx.fillStyle = MARQUEE_FILL;
  ctx.fillRect(m.x * k, m.y * k, m.w * k, m.h * k);
  ctx.strokeStyle = MARQUEE;
  ctx.lineWidth = d;
  ctx.setLineDash([4 * d, 3 * d]);
  ctx.strokeRect(m.x * k, m.y * k, m.w * k, m.h * k);
  ctx.restore();
}

function drawGuides(ctx: CanvasRenderingContext2D, guides: Guide[], k: number, d = 1) {
  ctx.save();
  ctx.strokeStyle = GUIDE;
  ctx.lineWidth = d;
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
 * generated .res files by render.ts, and the weapon selection by weapons.ts,
 * not as stand-ins here; the rest are hand-made approximations. `onAsset`
 * is passed through to every drawPanel call so a texture that finishes
 * loading after this call returns can trigger a redraw. `view` carries what
 * the page shows beyond the design: the teammate card state and the
 * selection chrome, drawn over everything else.
 */
export function drawHud(
  ctx: CanvasRenderingContext2D, pxW: number, pxH: number, design: HudDesign, side: Side,
  selected: string | readonly string[] | null, onAsset?: () => void, view: HudView = {},
): void {
  const k = pxH / SCREEN_H;
  const d = view.dpr ?? 1;
  const accent = accentColour(ctx);
  // A hidden element is still drawn, dimmed, while it is selected, so the
  // player can see what they are editing; every outline comes from `view`.
  const picked: readonly string[] = selected === null ? [] : typeof selected === 'string' ? [selected] : selected;
  if (side === 'infected') paintGameCrosshair(ctx, pxW, pxH, design, onAsset, view);
  // Tab held: the game takes some HUD elements off (the survivor teammate
  // cards, HudElement.underTab) and draws the Tab screen over the rest.
  const tabHeld = !!previewOf(view.state).tab;

  for (const el of visibleElements(side, design)) {
    if (tabHeld && el.underTab === 'hidden') continue;
    const u = rectFor(design, el.id);
    const hidden = !u.visible;
    if (hidden && !picked.includes(el.id)) continue;

    const r: Rect = { x: u.x * k, y: u.y * k, w: u.w * k, h: u.h * k };
    const paint = PAINTERS[el.id];
    // A selected occasional panel is drawn even with the toggle off, so picking it in Layers shows it.
    if (!paint || !shownInState(el, view.state, picked.includes(el.id))) continue;

    if (hidden) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      paint(ctx, r, design, k, onAsset, view);
      ctx.restore();
      drawHiddenOutline(ctx, r, d);
    } else {
      paint(ctx, r, design, k, onAsset, view);
    }
  }

  // The Tab screen (tabscreen.ts), with Tab held or while one of its elements
  // or pieces is picked, as a picked occasional panel is drawn (spec 3.1).
  if (tabHeld || tabPicked(picked)) {
    drawTabScreen(ctx, design, side, k, { onAsset, state: view.state, picked });
    const versus = rectFor(design, 'tabVersus');
    if (!versus.visible && picked.includes('tabVersus')) drawHiddenOutline(ctx, { x: versus.x * k, y: versus.y * k, w: versus.w * k, h: versus.h * k }, d);
  }

  if (view.frames?.length) drawFrames(ctx, view.frames, k, accent, d);
  if (view.box || view.handles?.length) drawHandles(ctx, view.box ?? null, view.handles ?? [], k, accent, d);
  if (view.hover) drawHover(ctx, view.hover, k, d);
  if (view.marquee) drawMarquee(ctx, view.marquee, k, d);
  if (view.guides?.length) drawGuides(ctx, view.guides, k, d);
}
