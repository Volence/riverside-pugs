/**
 * The Tab screen, drawn as the game draws it while you hold Tab in versus
 * (tab screen spec, docs/superpowers/specs/2026-09-25-hud-editor-tab-screen-design.md,
 * sections 3.2 and 3.3; probe answers in section 7 and
 * /home/volence/l4d/hud/probe-tab/RESULTS.md). mock.ts drawHud calls it over
 * the HUD while PreviewState.tab is on, or while a Tab element or piece is
 * picked.
 *
 * Everything is read from the design's generated trees (buildTrees), as the
 * rest of the preview is, through the PC-aware block list (kv.ts pcBlocks):
 * scoreboard.res places the backdrop, the title, the rows and the versus
 * panel; versusmodescoreboard.res is read through each child's if_embedded
 * block, and its stat line through its pin chain (tablayout.ts). Each block
 * is drawn by its ControlName, as VGUI draws it:
 *
 * - Panel: its bgcolor_override (render.ts paintPanelBox), in linear light.
 * - ImagePanel: its image stretched, or its fillcolor (render.ts
 *   drawImageChild, so a slot style, a Modern flat panel and the stock art
 *   draw as everywhere else), laid over the scene in linear light.
 * - ScalableImagePanel: its texture nine-sliced with the file's src_corner
 *   (texels) and draw_corner (units), in linear light; it takes no tint.
 * - Label: its text in its font, colour and alignment (paintPanelLabel), a
 *   Label with no font in the scheme's Default, as VGUI's Label.
 * - HealthPanel: the bar (render.ts drawBar), full, in monochrome_color.
 *
 * The game blends the Tab screen in linear light: Modern's team box, 95 22
 * 22 at 205 over the backdrop, reads 86 22 21 (spec 1.6), which only the
 * linear blend gives, and the backdrop's 230 alpha looks very different
 * blended in gamma.
 *
 * What game code decides, not the file, is the CODE table below and the
 * row rules, each with its evidence.
 */
import type { Box, HudDesign } from './design';
import { elementById } from './elements';
import { panelChildren } from './children';
import { buildTrees, elementRect } from './build';
import { kvGet, type KvNode } from './kv';
import { layoutBlocks, type LaidBlock } from './tablayout';
import { screenW, SCREEN_H } from './units';
import { normaliseMaterial } from './art';
import { MODERN_ART } from './build';
import { baseOf } from './base';
import {
  artImage, drawBar, drawImageChild, drawItems, fontFace, labelColour, paintLinearOver, paintPanelBox, paintPanelLabel,
  panelColour, previewOf, setFont, DEFAULT_PREVIEW, type ChildRect, type PreviewState, type SurvivorState,
} from './render';
import { drawNineSlice } from './weapons';

type Side = 'survivor' | 'infected';
interface Rect { x: number; y: number; w: number; h: number }

const BOARD = 'resource/ui/scoreboard.res';
const VERSUS = 'resource/ui/versusmodescoreboard.res';
const SURVIVOR_ROW = 'resource/ui/scoreboardsurvivor.res';
const INFECTED_ROW = 'resource/ui/scoreboardinfectedplayer.res';

/**
 * The sample texts and the colours code gives (spec 3.3; section 7 for the
 * scores and the survivor names). The ping glyph is a GameUIButtons bitmap
 * the editor does not export, so it is drawn from its measured shape: a
 * dark 16-unit square with three green bars (stock tab-a.png, 630..665 x
 * 390..425 px, box 38 36 35, bars 67 121 52).
 */
export const TAB_SAMPLES = {
  title: 'No Mercy, Versus Mode',
  yourScore: '262', enemyScore: 'N/A', distance: '1%', healthBonus: '200', survivalMult: 'x1',
  you: 'Player', ping: '25', infectedScore: '0',
  /** TS2 failed: 262 and N/A are grey (146 in stock and Modern) whatever the file says. MediumGray. */
  scoreColour: 'rgba(145,145,145,1)',
  /** TS6: the survivor names, and "DOWN" (RESULTS.md, Other), are white whatever the file says. */
  nameColour: 'rgba(255,255,255,1)',
  /** The Steam picture code puts in the avatar: a grey square in the preview. */
  avatar: 'rgba(128,128,128,1)',
  pingBox: 'rgba(38,36,35,1)',
  pingBar: 'rgba(67,121,52,1)',
} as const;

/** The #L4D_VSScoreboard_* tokens in English (resource/left4dead_english.txt). */
const STRINGS: Record<string, string> = {
  '#l4d_vsscoreboard_yourteam': 'Your Team',
  '#l4d_vsscoreboard_enemyteam': 'Enemy Team',
  '#l4d_vsscoreboard_distanceshort': 'Average Distance:',
  '#l4d_vsscoreboard_health': 'Health Bonus:',
  '#l4d_vsscoreboard_survivalmult': 'Survival Multiplier:',
};

/**
 * What code hides in versus, whatever the file says (spec 1.3, 1.4, 1.7 and
 * 3.3): nothing of these drew in any versus shot. The dialog block itself
 * (scores) is not a piece; code puts it at 0,0, the full screen (spec 1.1).
 */
const BOARD_HIDDEN = new Set(['scores', 'servername', 'missionobjective', 'imggoldmedal', 'lblgoldmedaltime', 'imgsilvermedal',
  'lblsilvermedaltime', 'imgbronzemedal', 'lblbronzemedaltime', 'map1', 'map2', 'map3', 'map4', 'map5', 'currentmap',
  'currentmaparrow', 'opponentmap', 'rescuemap', 'rescuemaparrow', 'spectators', 'thirdpartyserverpanel']);

/**
 * The versus panel's pieces code hides in the first half the preview shows:
 * the survival multiplier line (later in a round) and the round-end
 * animations; and one team's box: code shows your team's box to the
 * survivors and the enemy's to the infected (TAB-1 tab-a against tab-c).
 */
const VERSUS_HIDDEN = new Set(['survivalmultlabel', 'survivalmultamount', 'statanimationbreakdownlabel', 'teamwinlabel', 'teamflipexplanationlabel']);
const OTHER_TEAM_BOX: Record<Side, string> = { survivor: 'enemyteamhighlightimage', infected: 'yourteamhighlightimage' };

/** One row of the sample team: who, whether it is you, and the portrait code gives them. */
export interface TabRow { name: string; self: boolean; portrait?: string }

/**
 * Which rows each side sees (spec 3.3; TAB-1 tab-a, tab-c, tab-d): the
 * survivors list on both sides, you first on the survivor side, then three
 * bots; the infected list only on the infected side, and there only your
 * own row (an AI special gets none). The portraits are the HUD cards' art.
 */
export function tabRows(side: Side): { survivors: TabRow[]; infected: TabRow[] } {
  const bots: TabRow[] = [
    { name: 'Francis', self: false, portrait: 'vgui/s_panel_biker' },
    { name: 'Louis', self: false, portrait: 'vgui/s_panel_manager' },
    { name: 'Zoey', self: false, portrait: 'vgui/s_panel_teenangst' },
  ];
  if (side === 'survivor') return { survivors: [{ name: TAB_SAMPLES.you, self: true, portrait: 'vgui/s_panel_namvet' }, ...bots], infected: [] };
  return { survivors: [{ name: 'Bill', self: false, portrait: 'vgui/s_panel_namvet' }, ...bots], infected: [{ name: TAB_SAMPLES.you, self: true }] };
}

/**
 * Whether code shows a row piece: false hides it, true leaves it to the
 * file's visible, 'force' shows it though the file says visible 0 (code
 * sets it; a hidden piece's 0 x 0 still draws nothing). From the shots: your
 * row shows PlayerBackground_Selected in place of the fade, the Steam
 * picture and Name beside it, and the ping; a bot's row the fade and
 * NoAvatarName at x 30 ("Bill" at 112 px against "Mal" at 157), no ping.
 * The status text is blank at full health; the survival record never shows
 * in versus. An infected row's Status is code's too: "SPAWNING" as a ghost
 * (tab-c), the class once spawned ("HUNTER", tab-d).
 */
function survivorPiece(name: string, row: TabRow): boolean | 'force' {
  switch (name) {
    case 'playerbackground': return !row.self;
    case 'playerbackground_selected': return row.self ? 'force' : false;
    case 'survivorstatsavatar': case 'survivorstatsname': case 'pingimage': case 'pinglabel': return row.self;
    case 'survivorstatsnoavatarname': case 'survivorstatsitems': return !row.self;
    case 'survivorstatsstatus': case 'survivorstatsnoavatarstatus': case 'survivorholdoutrecordimage': case 'survivorholdoutrecord': case 'voice': return false;
    default: return true;
  }
}
function infectedPiece(name: string, row: TabRow): boolean | 'force' {
  switch (name) {
    case 'playerbackground': return !row.self;
    case 'playerbackground_selected': return row.self ? 'force' : false;
    case 'avatar': case 'name': case 'pingimage': case 'pinglabel': return row.self;
    case 'noavatarname': return !row.self;
    case 'status': return 'force';
    case 'noavatarstatus': return false;
    default: return true;
  }
}

export interface TabDrawOpts {
  onAsset?: () => void;
  state?: SurvivorState | PreviewState;
  /** The page's selection: a hidden versus panel is drawn dimmed while it is picked. */
  picked?: readonly string[];
}

/** The rows' bars are drawn full, at full health, whatever the page's survivor state (spec 3.3). */
const ROW_STATE: PreviewState = { ...DEFAULT_PREVIEW };

/**
 * Draws the Tab screen over whatever is on the canvas, k canvas pixels to a
 * HUD unit, the dialog at the canvas's top-left corner: the board's pieces,
 * the rows and the versus panel, in the board's zpos order.
 */
export function drawTabScreen(ctx: CanvasRenderingContext2D, design: HudDesign, side: Side, k: number, opts: TabDrawOpts = {}): void {
  const trees = buildTrees(design);
  const W = screenW(design.aspect);
  const measure = measurer(ctx, design, k, opts.onAsset);
  const screen = { x: 0, y: 0, w: W * k, h: SCREEN_H * k };
  const rows = tabRows(side);
  const board = ordered(layoutBlocks(trees(BOARD), { w: W, h: SCREEN_H, textOf: (n) => boardText(n), measure }));
  ctx.save();
  for (const b of board) {
    const name = b.name.toLowerCase();
    const surv = /^survivor(\d)$/.exec(name), inf = /^infected(\d)$/.exec(name);
    if (surv || inf) {
      const row = (surv ? rows.survivors : rows.infected)[Number((surv ?? inf)![1]) - 1];
      if (row && b.visible) drawRow(ctx, design, b, k, row, !!surv, previewOf(opts.state), measure, opts.onAsset);
      continue;
    }
    if (name === 'cversusmodescoreboard') { drawVersus(ctx, design, side, k, measure, opts); continue; }
    if (BOARD_HIDDEN.has(name) || !b.visible) continue;
    drawPiece(ctx, design, b, { x: 0, y: 0 }, k, boardText(b.node), labelColour(design, b.node), screen, opts.onAsset);
  }
  ctx.restore();
}

/** A label's width in HUD units, in its own font (the scheme's Default when it names none). */
function measurer(ctx: CanvasRenderingContext2D, design: HudDesign, k: number, onAsset?: () => void) {
  return (n: KvNode, text: string): number => {
    if (!text) return 0;
    ctx.save();
    setFont(ctx, design, kvGet(n, 'font') ?? 'Default', k, onAsset);
    const w = ctx.measureText(text).width;
    ctx.restore();
    return w / k;
  };
}

/** Blocks in draw order: zpos ascending, then file order, as VGUI paints them. */
function ordered(laid: LaidBlock[]): LaidBlock[] {
  const z = (b: LaidBlock) => { const v = parseFloat(kvGet(b.node, 'zpos') ?? ''); return Number.isFinite(v) ? v : 0; };
  return laid.map((b, i) => ({ b, i })).sort((p, q) => z(p.b) - z(q.b) || p.i - q.i).map((p) => p.b);
}

const boardText = (n: KvNode): string => (n.key.toLowerCase() === 'missiontitle' ? TAB_SAMPLES.title : token(kvGet(n, 'labelText') ?? ''));
const token = (t: string): string => STRINGS[t.toLowerCase()] ?? (t.startsWith('#') ? '' : t);

/**
 * The versus panel: at its element's place (it moves, TS4), clipped to its
 * own 354 x 120 (TL5: it clips its children), each child read through its
 * if_embedded block and the stat line laid down its pin chain. Hidden, it
 * draws nothing, unless it is picked: then dimmed, as a hidden element is.
 */
function drawVersus(ctx: CanvasRenderingContext2D, design: HudDesign, side: Side, k: number, measure: (n: KvNode, t: string) => number, opts: TabDrawOpts) {
  const el = elementRect(design, 'tabVersus', design.aspect);
  if (!el.visible && !opts.picked?.includes('tabVersus')) return;
  const text = (n: KvNode): string => versusText(n, side);
  const laid = ordered(layoutBlocks(buildTrees(design)(VERSUS), { w: el.w, h: el.h, embedded: true, textOf: text, measure }));
  const box = { x: el.x * k, y: el.y * k, w: el.w * k, h: el.h * k };
  ctx.save();
  if (!el.visible) ctx.globalAlpha *= 0.25;
  clip(ctx, box);
  for (const b of laid) {
    const name = b.name.toLowerCase();
    if (!b.visible || VERSUS_HIDDEN.has(name) || name === OTHER_TEAM_BOX[side]) continue;
    const score = name === 'teamyourscoresurvivors' || name === 'teamenemyscoresurvivors';
    drawPiece(ctx, design, b, box, k, text(b.node), score ? TAB_SAMPLES.scoreColour : labelColour(design, b.node), box, opts.onAsset);
  }
  ctx.restore();
}

/** What a versus label shows: its token in English, or the sample for the value code writes (the scores swap sides for the infected). */
function versusText(n: KvNode, side: Side): string {
  const t = (kvGet(n, 'labelText') ?? '').toLowerCase();
  const [yours, theirs] = side === 'survivor' ? [TAB_SAMPLES.yourScore, TAB_SAMPLES.enemyScore] : [TAB_SAMPLES.enemyScore, TAB_SAMPLES.yourScore];
  switch (t) {
    case '%yoursurvivor%': return yours;
    case '%enemysurvivor%': return theirs;
    case '%distance%': return TAB_SAMPLES.distance;
    case '%healthbonus%': return TAB_SAMPLES.healthBonus;
    case '%survivalmult%': return TAB_SAMPLES.survivalMult;
    default: return token(kvGet(n, 'labelText') ?? '');
  }
}

/**
 * One row panel at its scoreboard.res block (clipped to it, as VGUI clips a
 * panel's children), drawn from its row file with code's rules for who the
 * row is: survivorPiece and infectedPiece.
 */
function drawRow(ctx: CanvasRenderingContext2D, design: HudDesign, at: LaidBlock, k: number, row: TabRow, survivor: boolean,
  state: PreviewState, measure: (n: KvNode, t: string) => number, onAsset?: () => void) {
  const file = survivor ? SURVIVOR_ROW : INFECTED_ROW;
  const laid = ordered(layoutBlocks(buildTrees(design)(file), { w: at.w, h: at.h, textOf: (n) => rowText(n, row, state), measure }));
  const origin = { x: at.x * k, y: at.y * k, w: at.w * k, h: at.h * k };
  ctx.save();
  clip(ctx, origin);
  for (const b of laid) {
    const name = b.name.toLowerCase();
    const shown = (survivor ? survivorPiece : infectedPiece)(name, row);
    if (shown === false || (shown === true && !b.visible)) continue;
    const r = { x: origin.x + b.x * k, y: origin.y + b.y * k, w: b.w * k, h: b.h * k };
    if (r.w <= 0 || r.h <= 0) continue;
    if (name === 'survivorstatshead') { portrait(ctx, row, r, onAsset); continue; }
    if (name === 'survivorstatsavatar' || name === 'avatar') { ctx.fillStyle = TAB_SAMPLES.avatar; ctx.fillRect(r.x, r.y, r.w, r.h); continue; }
    if (name === 'pingimage') { pingGlyph(ctx, r); continue; }
    if (name === 'survivorstatsitems') { drawItems(ctx, design, b.node, childRect(b, r), k, { onAsset, state: ROW_STATE }); continue; }
    const white = survivor && (name === 'survivorstatsname' || name === 'survivorstatsnoavatarname' || name.includes('status'));
    drawPiece(ctx, design, b, origin, k, rowText(b.node, row, state), white ? TAB_SAMPLES.nameColour : labelColour(design, b.node), origin, onAsset, survivor ? 'tabSurvivors' : undefined);
  }
  ctx.restore();
}

/** What code writes in a row's label. */
function rowText(n: KvNode, row: TabRow, state: PreviewState): string {
  switch (n.key.toLowerCase()) {
    case 'survivorstatsname': case 'survivorstatsnoavatarname': case 'name': case 'noavatarname': return row.name;
    case 'pinglabel': return TAB_SAMPLES.ping;
    case 'score': return TAB_SAMPLES.infectedScore;
    case 'status': return state.infected === 'ghost' ? 'SPAWNING' : state.infected === 'dead' ? 'DEAD' : state.siClass.toUpperCase();
    default: return '';
  }
}

/** The portrait code gives the row's survivor, stretched to SurvivorStatsHead (scaleImage 1). */
function portrait(ctx: CanvasRenderingContext2D, row: TabRow, r: Rect, onAsset?: () => void) {
  if (!row.portrait) return;
  const img = artImage(row.portrait, onAsset);
  if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
}

/**
 * The ping glyph, from stock tab-a.png's 36-pixel glyph: a dark rounded
 * square, and three bars 5 of 36 wide at 7, 15 and 22 across, rising from
 * 31 down to 19, 11 and 3.
 */
function pingGlyph(ctx: CanvasRenderingContext2D, r: Rect) {
  const s = Math.min(r.w, r.h) / 36;
  const x = r.x + r.w - 36 * s, y = r.y;             // east-aligned in its block, as the file's textAlignment has it
  ctx.fillStyle = TAB_SAMPLES.pingBox;
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, 36 * s, 36 * s, 3 * s); ctx.fill(); }
  else ctx.fillRect(x, y, 36 * s, 36 * s);
  ctx.fillStyle = TAB_SAMPLES.pingBar;
  for (const [bx, top] of [[7, 19], [15, 11], [22, 3]]) ctx.fillRect(x + bx * s, y + top * s, 5 * s, (31 - top) * s);
}

function clip(ctx: CanvasRenderingContext2D, r: Rect) {
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
}

const childRect = (b: LaidBlock, r: Rect): ChildRect => ({ name: b.name, kind: 'other', ...r, visible: true });

/**
 * One block drawn by its ControlName, at its laid place inside `origin`
 * (canvas pixels). A block of no size paints nothing (VGUI clips a panel's
 * paint to its own size).
 */
function drawPiece(ctx: CanvasRenderingContext2D, design: HudDesign, b: LaidBlock, origin: { x: number; y: number }, k: number,
  text: string, colour: string, clipTo: Rect, onAsset?: () => void, panelId?: string) {
  const r = { x: origin.x + b.x * k, y: origin.y + b.y * k, w: b.w * k, h: b.h * k };
  if (r.w <= 0 || r.h <= 0) return;
  const n = b.node;
  switch ((kvGet(n, 'ControlName') ?? '').toLowerCase()) {
    case 'panel': paintPanelBox(ctx, design, n, r, k); return;
    case 'imagepanel': {
      const cr = childRect(b, r);
      const opts = { onAsset, state: ROW_STATE };
      linear(ctx, r, (c) => drawImageChild(c, design, n, cr, k, opts, panelId));
      return;
    }
    case 'scalableimagepanel': scalable(ctx, design, n, childRect(b, r), k, onAsset); return;
    case 'label': if (text) paintPanelLabel(ctx, design, n, r, k, text, colour, clipTo, onAsset, { font: 'Default', shadow: true }); return;
    case 'healthpanel': {
      const rgb = panelId ? panelColour(design, panelId, ROW_STATE) : undefined;
      drawBar(ctx, n, childRect(b, r), k, { onAsset, state: ROW_STATE, panelRgb: rgb }, panelId);
      return;
    }
    default: return;
  }
}

/** Paints something over the scene in linear light (render.ts paintLinearOver), or plainly where pixels cannot be read. */
function linear(ctx: CanvasRenderingContext2D, r: Rect, paint: (c: CanvasRenderingContext2D) => void) {
  paintLinearOver(ctx, r, paint, () => paint(ctx));
}

/**
 * A ScalableImagePanel: its texture nine-sliced (src_corner_* texels drawn
 * draw_corner_* units square), no tint (its run has no colour key, spec
 * 1.6). A slot's style or one of Modern's flat panels is one colour, so it
 * nine-slices to a flat fill: drawImageChild draws those, stretched.
 */
function scalable(ctx: CanvasRenderingContext2D, design: HudDesign, n: KvNode, r: ChildRect, k: number, onAsset?: () => void) {
  const image = kvGet(n, 'image');
  if (!image) return;
  const material = normaliseMaterial(image);
  const flat = material.startsWith('vgui/hud/hudeditor/') || (baseOf(design) === 'modern' && MODERN_ART.some((t) => t.name === material));
  if (flat) { linear(ctx, r, (c) => drawImageChild(c, design, n, r, k, { onAsset }, undefined)); return; }
  const img = artImage(material, onAsset);
  if (!img) return;
  const src = parseFloat(kvGet(n, 'src_corner_width') ?? '16');
  const corner = parseFloat(kvGet(n, 'draw_corner_width') ?? '8') * k;
  linear(ctx, r, (c) => drawNineSlice(c, img, img.naturalWidth, img.naturalHeight, r.x, r.y, r.w, r.h, corner, src));
}

/** The Tab elements, for drawHud: whether any is in the selection. */
export const tabPicked = (picked: readonly string[]): boolean => picked.some((id) => !!elementById(id)?.tab);


/**
 * A registered Tab piece where the painter puts it, in HUD units on the
 * screen: `visible` as the laid-out file has it (a piece pinned to a hidden
 * one is hidden too), `drawn` whether the painter draws it at all (code's
 * rules for the row and the side, a label with no text, a piece of no size).
 */
export interface TabPiece extends Box { name: string; visible: boolean; drawn: boolean }
/** One box a Tab panel draws its pieces in: the board's screen, the versus panel, or one row (its PlayerBackground, as the rows overlap). */
export interface TabBox { box: Box; pieces: TabPiece[] }

/**
 * Where each registered piece of a Tab panel is, box by box, as
 * drawTabScreen lays it out: the board's pieces on the screen, the versus
 * panel's at its element's place through if_embedded and the pin chain, a
 * row panel's in each row the side sees (tabRows). For hit tests, outlines
 * and snaps, which have no canvas: a label as wide as its text is measured
 * on a canvas of the page's own when there is one, else estimated from its
 * font size. `side` says which team's box and rows are drawn.
 */
export function tabBoxes(design: HudDesign, side: Side, panel: string): TabBox[] {
  const reg = panelChildren(panel);
  if (!reg || !elementById(panel)?.tab) return [];
  const byName = new Map(reg.children.map((c) => [c.name.toLowerCase(), c.name]));
  const measure = unitMeasurer(design);
  const trees = buildTrees(design);
  const W = screenW(design.aspect);
  // Each piece is cut to its panel, as VGUI clips a panel's children (the row's 300 x 80, the versus panel's 354 x 120).
  const pieces = (laid: LaidBlock[], at: Box, shown: (b: LaidBlock) => boolean, text: (n: KvNode) => string,
    visible: (b: LaidBlock) => boolean = (b) => b.visible): TabPiece[] =>
    laid.flatMap((b) => {
      const name = byName.get(b.name.toLowerCase());
      if (!name) return [];
      const label = (kvGet(b.node, 'ControlName') ?? '').toLowerCase() === 'label' && b.name.toLowerCase() !== 'pingimage';
      const x = Math.max(at.x, at.x + b.x), y = Math.max(at.y, at.y + b.y);
      const w = Math.min(at.x + at.w, at.x + b.x + b.w) - x, h = Math.min(at.y + at.h, at.y + b.y + b.h) - y;
      const drawn = shown(b) && w > 0 && h > 0 && (!label || text(b.node) !== '');
      return [{ name, x, y, w: Math.max(0, w), h: Math.max(0, h), visible: visible(b), drawn }];
    });
  const board = layoutBlocks(trees(BOARD), { w: W, h: SCREEN_H, textOf: boardText, measure });
  if (panel === 'tabBoard') {
    const shown = (b: LaidBlock) => b.visible && !BOARD_HIDDEN.has(b.name.toLowerCase());
    return [{ box: { x: 0, y: 0, w: W, h: SCREEN_H }, pieces: pieces(board, { x: 0, y: 0, w: W, h: SCREEN_H }, shown, boardText) }];
  }
  if (panel === 'tabVersus') {
    const el = elementRect(design, 'tabVersus', design.aspect);
    const text = (n: KvNode) => versusText(n, side);
    const laid = layoutBlocks(trees(VERSUS), { w: el.w, h: el.h, embedded: true, textOf: text, measure });
    const shown = (b: LaidBlock) => el.visible && b.visible && !VERSUS_HIDDEN.has(b.name.toLowerCase()) && b.name.toLowerCase() !== OTHER_TEAM_BOX[side];
    return [{ box: { x: el.x, y: el.y, w: el.w, h: el.h }, pieces: pieces(laid, el, shown, text) }];
  }
  const survivor = panel === 'tabSurvivors';
  const rows = survivor ? tabRows(side).survivors : tabRows(side).infected;
  const file = survivor ? SURVIVOR_ROW : INFECTED_ROW;
  return rows.flatMap((row, i) => {
    const at = board.find((b) => b.name.toLowerCase() === `${survivor ? 'survivor' : 'infected'}${i + 1}`);
    if (!at || !at.visible) return [];
    const text = (n: KvNode) => rowText(n, row, ROW_STATE);
    const laid = layoutBlocks(trees(file), { w: at.w, h: at.h, textOf: text, measure });
    const rule = survivor ? survivorPiece : infectedPiece;
    const shown = (b: LaidBlock) => { const s = rule(b.name.toLowerCase(), row); return s === 'force' || (s && b.visible); };
    const bg = laid.find((b) => b.name.toLowerCase() === 'playerbackground');
    const box = bg ? { x: at.x + bg.x, y: at.y + bg.y, w: bg.w, h: bg.h } : { x: at.x, y: at.y, w: at.w, h: at.h };
    // Code shows your row's own background whatever its visible says (survivorPiece's 'force').
    return [{ box, pieces: pieces(laid, at, shown, text, (b) => rule(b.name.toLowerCase(), row) === 'force' || b.visible) }];
  });
}

/** The side a Tab panel's boxes are measured for when no side is given: the infected rows' own, else the survivors'. */
export const tabSideOf = (panel: string): Side => (elementById(panel)?.side === 'infected' ? 'infected' : 'survivor');

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** A label's width in HUD units without the page's canvas: measured at 4 px a unit on a canvas of its own, or estimated where there is none. */
function unitMeasurer(design: HudDesign) {
  if (measureCtx === undefined) {
    try { measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'); } catch { measureCtx = null; }
  }
  const ctx = measureCtx;
  if (ctx) return measurer(ctx, design, 4);
  return (n: KvNode, text: string): number => text.length * fontFace(design, kvGet(n, 'font') ?? 'Default').tall * 0.5;
}

/** The design with the player's hides on one Tab panel taken off, kept per design so its trees are built once. */
const UNHIDDEN = new WeakMap<HudDesign, Map<string, HudDesign>>();
function unhidden(design: HudDesign, panel: string): HudDesign {
  const kids = design.children[panel];
  const hides = kids && Object.values(kids).some((o) => o.visible !== undefined);
  if (!hides && design.elements[panel]?.visible === undefined) return design;
  let per = UNHIDDEN.get(design);
  if (!per) UNHIDDEN.set(design, per = new Map());
  let d = per.get(panel);
  if (!d) {
    const children = { ...design.children };
    if (kids) children[panel] = Object.fromEntries(Object.entries(kids).map(([n, o]) => { const { visible: _v, ...rest } = o; return [n, rest]; }));
    const elements = { ...design.elements };
    if (elements[panel]) { const { visible: _v, ...rest } = elements[panel]; elements[panel] = rest; }
    d = { ...design, children, elements };
    per.set(panel, d);
  }
  return d;
}

/**
 * Where the selection outlines Tab pieces: in each box where the painter
 * would draw the piece were the player's own hides taken off (so a hidden
 * piece, and one hidden with it, keeps its outline at its place), or, for a
 * piece code never draws on this side (the enemy box to the survivors, the
 * other infected rows), in every box.
 */
export function tabFrames(design: HudDesign, side: Side, panel: string, names: readonly string[]): { card: number; box: Box }[] {
  const boxes = tabBoxes(unhidden(design, panel), side, panel);
  return names.flatMap((name) => {
    const at = boxes.map((b, card) => ({ card, p: b.pieces.find((p) => p.name === name) })).filter((x) => x.p);
    const drawn = at.filter((x) => x.p!.drawn);
    return (drawn.length ? drawn : at).map(({ card, p }) => ({ card, box: { x: p!.x, y: p!.y, w: p!.w, h: p!.h } }));
  });
}
