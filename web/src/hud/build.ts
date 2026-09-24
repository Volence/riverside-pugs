/**
 * HudDesign in, addon files out.
 *
 * Every file is a real base file with a few values changed. `Work` parses a
 * file the first time a pass asks for it and remembers that it was touched;
 * at the end only touched files, plus the files the preset itself overrides,
 * are written. An untouched stock file is never shipped, because the game
 * already has it and shipping it would only widen what this addon can break.
 */
import { encodeVTF, encodeVPK, encodeZip, type VpkFile } from '../vpk';
import { baseFile, baseOf, baseTree, importedFiles, presetOverrides, BASE_PATHS, type BaseKey } from './base';

export { baseTree };
import { parseKv, writeKv, kvFind, kvGet, kvSet, pcApplies, type KvNode } from './kv';
import { parsePos, parseSize, formatPos, scaleToken, screenW, SCREEN_H, type Aspect } from './units';
import { ELEMENTS, elementById, type HudElement } from './elements';
import { SLOTS } from './slots';
import { flatTexture, roundedTexture, vmtFor, parseColour } from './textures';
import { decodeText, encodeText } from './text';
import {
  baseTeam, contentBox, drawnBarX, isBar, NOTICE_BOX_COLOUR, WEAPON_KEYS, WEAPON_BOX_COLOUR, type Box, type HudDesign, type ElementOverride, type ChildOverride, type TeamDir,
  type WeaponNumKey, WEAPON_ICONS, ITEM_ICONS, WEAPON_BOX_IMAGE, weaponImageKind, VOICE_ICONS, VOICE_ICON_TEXELS, voiceIconOpen,
} from './design';
import {
  panelChildren, panelOfFile, childDef, childPath, maxInset, linkedValue, TEAM_PANEL, OWN_PANEL, SI_PANEL, ZCARD_PANEL, type ChildDef, type PanelChildren, type LinkRect, type LinkRule,
} from './children';
import { crosshairFiles } from '../crosshair/vpk';
import {
  SPLATTERS, SPLAT_STAND_IN, splatterDef, splatterActive, splatterImageKey, splatterMaterial, fadePixels, type SplatterDef, type SplatterId,
} from './splatter';
import { TEX } from '../crosshair/draw';
import { columnExtent, WEAPON_KEY_DEFAULTS } from './weaponColumn';
import { probe } from './probes';
import { clampBarKeys } from './progress';

/**
 * Uploaded images and fonts, already decoded, keyed by slot id, and for a
 * bundled crosshair its texture pixels (TEX x TEX RGBA), which the page
 * draws from the design's own `xhairArt` with artPixels.
 */
export interface BuildAssets {
  fonts?: { regular: Uint8Array; bold: Uint8Array };
  images?: Record<string, Uint8ClampedArray>;
  crosshair?: Uint8ClampedArray;
  /**
   * The design's crosshair is still the imported HUD's own altcrosshair
   * texture, exactly as the import made it (the page compares the two). The
   * upload's own texture files then ship untouched instead of a copy
   * redrawn at TEX, so a download with no edits is the upload byte for byte.
   */
  ownCrosshair?: boolean;
}

/** A generated text file's bytes: latin-1, as the game reads it. */
const enc = (s: string) => encodeText(s, 'latin1');
const LAYOUT = 'scripts/hudlayout.res';
const ANIMS = 'scripts/hudanimations.txt';
const SCHEME = 'resource/clientscheme.res';
const CHATSCHEME = 'resource/chatscheme.res';
const BASECHAT = 'resource/ui/basechat.res';
const CARD = TEAM_PANEL.file;
const MODTEX = 'scripts/mod_textures.txt';
const PZ_RECORD = 'resource/ui/hud/pzdamagerecordpanel.res';
const POSITIONAL = ['xpos', 'ypos', 'wide', 'tall'];
const num = (v: string | undefined) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : 0; };

class Work {
  private trees = new Map<string, KvNode[]>();
  private texts = new Map<string, string>();
  /**
   * HudEd_ font copies made so far, by the copy's own name: that name, or
   * null when the scheme does not define the font. One map for the whole
   * build, shared by scalePass and childPass, so two asks for the same copy
   * never push a duplicate key into a shipped scheme.
   */
  readonly fonts = new Map<string, string | null>();
  constructor(readonly key: BaseKey) {}
  /** The children of the file's single root block. */
  tree(path: string): KvNode[] {
    let t = this.trees.get(path);
    if (!t) {
      try { t = parseKv(baseFile(this.key, path)); }
      catch (e) { throw new Error(`${path}: ${(e as Error).message}`); }
      this.trees.set(path, t);
    }
    const root = t[0];
    if (!root || typeof root.value === 'string') throw new Error(`${path}: no root block`);
    return root.value;
  }
  panel(path: string, keys: string[]): KvNode {
    const p = kvFind(this.tree(path), keys);
    if (!p) throw new Error(`${path}: no panel ${keys.join('/')}`);
    return p;
  }
  /** Whether this build is on an imported HUD. */
  get imported(): boolean { return this.key.startsWith('imported:'); }
  /**
   * A panel an edit lands on, when the base has it. An imported HUD may lack
   * or rename a panel the editor models (the spec's "When the upload lacks an
   * expected piece"): its controls are hidden and a stored edit for it has
   * nothing to land on, so it is skipped. Stock and Modern have every panel,
   * so there a missing one is still a bug and fails loudly, as panel() does.
   */
  optional(path: string, keys: string[]): KvNode | undefined {
    const p = kvFind(this.tree(path), keys);
    if (!p && !this.imported) throw new Error(`${path}: no panel ${keys.join('/')}`);
    return p;
  }
  /** Whether a pass has parsed this file, so the build writes it. */
  parsed(path: string): boolean { return this.trees.has(path); }
  /** The parsed file, its root block included, as writeKv takes it. */
  rootOf(path: string): KvNode[] { this.tree(path); return this.trees.get(path)!; }
  text(path: string): string { return this.texts.get(path) ?? baseFile(this.key, path); }
  setText(path: string, s: string) { this.texts.set(path, s); }
  /**
   * The files this build touched. For an imported HUD, a file the passes
   * parsed but left as they found it goes back as the upload's own bytes:
   * writeKv would drop its comments and reformat it, and a HUD author's file
   * should reach the game exactly as they wrote it unless an edit is in it.
   * "Left as found" is measured by writing both trees the same way. An
   * edited file is written back in the encoding it came in.
   */
  files(): VpkFile[] {
    const out: VpkFile[] = [];
    const layer = importedFiles(this.key);
    const paths = new Set([...this.trees.keys(), ...this.texts.keys(), ...BASE_PATHS.filter((p) => presetOverrides(this.key, p))]);
    for (const path of [...paths].sort()) {
      const own = layer?.get(path);
      const write = (text: string) => (own ? encodeText(text, decodeText(own).encoding) : enc(text));
      if (this.texts.has(path) || path === ANIMS) { out.push({ path, data: write(this.text(path)) }); continue; }
      this.tree(path);
      const now = writeKv(this.trees.get(path)!);
      if (own && now === writeKv(parseKv(baseFile(this.key, path)))) { out.push({ path, data: own }); continue; }
      out.push({ path, data: write(now) });
    }
    return out;
  }
}

const XHAIR: KvNode = { key: 'xHair', value: [
  ['ControlName', 'ImagePanel'], ['fieldName', 'xHair'], ['xpos', 'c-13'], ['ypos', 'c-13'], ['zpos', '-2'],
  ['wide', '26'], ['tall', '26'], ['visible', '1'], ['enabled', '1'], ['image', 'hud/altcrosshair'], ['scaleImage', '1'],
].map(([key, value]) => ({ key, value })) };

/**
 * The chat window's own size: basechat.res's HudChat as the PC reads it
 * (280 x 120 on both presets). hudlayout's HudChat is only the background
 * panel (probe T4), 320 wide on stock, so taking the size from there would
 * make a chat that only moved 40 units wider than the game's.
 */
function chatBaseSize(key: BaseKey, W: number): { w: number; h: number } {
  const chat = kvFind(baseTree(key, BASECHAT), ['HudChat']);
  if (!chat) throw new Error(`${BASECHAT}: no panel HudChat`);
  return { w: parseSize(pcGet(chat, 'wide') ?? '0', W), h: parseSize(pcGet(chat, 'tall') ?? '0', SCREEN_H) };
}

function baseRect(panel: KvNode, el: HudElement, key: BaseKey, aspect: Aspect) {
  const W = screenW(aspect);
  const chat = el.id === 'chat' ? chatBaseSize(key, W) : undefined;
  // mockSize is measured on the two built-in presets; an import is sized by its own file.
  const mock = key === 'stock' || key === 'modern' ? el.mockSize?.[key] : undefined;
  const w = chat?.w ?? mock?.w ?? parseSize(kvGet(panel, 'wide') ?? '0', W);
  const h = chat?.h ?? mock?.h ?? parseSize(kvGet(panel, 'tall') ?? '0', SCREEN_H);
  return { x: parsePos(kvGet(panel, 'xpos') ?? '0', W), y: parsePos(kvGet(panel, 'ypos') ?? '0', SCREEN_H), w, h };
}

/** The tokens an override produces. The anchor comes from where the element sat at the aspect it was placed at. */
function placed(o: ElementOverride, base: { x: number; y: number; w: number; h: number }, el: HudElement, designAspect: Aspect) {
  const w = el.resize === 'free' && o.w !== undefined ? o.w : base.w;
  const h = el.resize === 'free' && o.h !== undefined ? o.h : base.h;
  const x = o.x ?? base.x, y = o.y ?? base.y;
  return { xpos: formatPos(x, w, screenW(designAspect)), ypos: formatPos(y, h, SCREEN_H), w, h };
}

/** The file whose block places an element: hudlayout.res, or its own (the spawn countdown's spectatorinfected.res). */
const layoutOf = (el: HudElement): string => el.file ?? LAYOUT;

/**
 * The blocks an element's move takes along (HudElement.moveWith), each
 * placed by the same offset from its own base place, as a token anchored
 * the way formatPos picks for it.
 */
function moveAlong(work: Work, el: HudElement, from: { x: number; y: number }, to: { x: number; y: number }, aspect: Aspect) {
  const W = screenW(aspect);
  for (const name of el.moveWith ?? []) {
    const b = work.optional(layoutOf(el), [name]);
    const base = kvFind(baseTree(work.key, layoutOf(el)), [name]);
    if (!b || !base) continue;
    const w = parseSize(pcGet(base, 'wide') ?? '0', W), h = parseSize(pcGet(base, 'tall') ?? '0', SCREEN_H);
    const x = parsePos(pcGet(base, 'xpos') ?? '0', W) + to.x - from.x, y = parsePos(pcGet(base, 'ypos') ?? '0', SCREEN_H) + to.y - from.y;
    pcSet(b, 'xpos', formatPos(x, w, W));
    pcSet(b, 'ypos', formatPos(y, h, SCREEN_H));
  }
}

function layoutPass(work: Work, design: HudDesign) {
  const layout = work.tree(LAYOUT);
  const has = kvFind(layout, ['xHair']);
  const wants = design.crosshair !== 'none';
  if (wants && !has) layout.unshift(structuredClone(XHAIR));
  // Game default takes out the xHair element Modern ships. An imported HUD's
  // own xHair is part of the HUD and stays as the upload has it (spec,
  // "Crosshair"): there Game default only means the editor adds none.
  if (!wants && has && !work.imported) layout.splice(layout.indexOf(has), 1);

  // Probe T2: the engine crosshair honours never_draw, so a player with an
  // image crosshair can hide the game's own one underneath it.
  if (design.hideGameCrosshair) { const c = work.optional(LAYOUT, ['HudCrosshair']); if (c) kvSet(c, 'never_draw', '1'); }

  for (const el of ELEMENTS) {
    const o = design.elements[el.id];
    // An element the base lacks is skipped whole: an imported HUD that has
    // no panel for it offers no control for it, so a stored edit (from
    // before the switch) has nothing to land on.
    if (!o || el.id === 'xhair' || !baseHasElement(work.key, el)) continue;
    const panel = work.panel(layoutOf(el), [el.key]);
    // The marker's block is the game's crosshair: its visible stays the
    // crosshair's, and elementHidePass hides the marker by its own keys.
    if (o.visible !== undefined && el.id !== MARKER) kvSet(panel, 'visible', o.visible ? '1' : '0');
    if (o.keys) {
      for (const key of Object.keys(o.keys)) {
        if (!el.keys?.some((k) => k.key === key)) throw new Error(`${LAYOUT}: ${el.key} takes no key ${key}`);
      }
      // A key waiting on a closed probe is never written, even if one slipped past validation.
      const open = Object.fromEntries(Object.entries(o.keys).filter(([key]) => {
        const gate = el.keys!.find((k) => k.key === key)!.gate;
        return !gate || probe(gate);
      }));
      writeKeys(panel, open);
    }
    const moved = el.move && (o.x !== undefined || o.y !== undefined);
    const sized = el.resize === 'free' && (o.w !== undefined || o.h !== undefined);
    if (!moved && !sized) continue;
    const base = baseRect(panel, el, work.key, design.aspect);
    const p = placed(o, base, el, design.aspect);
    // A block with only a ypos (the peril notice) is placed across by the game: no xpos is added.
    if (moved) { if (el.moveAxis !== 'y') kvSet(panel, 'xpos', p.xpos); kvSet(panel, 'ypos', p.ypos); }
    if (moved && el.moveWith) moveAlong(work, el, base, { x: parsePos(p.xpos, screenW(design.aspect)), y: parsePos(p.ypos, SCREEN_H) }, design.aspect);
    if (sized) { kvSet(panel, 'wide', String(Math.round(p.w))); kvSet(panel, 'tall', String(Math.round(p.h))); }
    if (el.id === 'chat' && moved) {
      // Three animation events hard-code the chat position and would snap a moved chat box back.
      work.setText(ANIMS, work.text(ANIMS).replace(/(Animate\s+HudChat\s+Position\s+")[^"]*(")/g, `$1${p.xpos} ${p.ypos}$2`));
    }
    // Resized in place, the chat keeps hudlayout's own tokens, as elementRect does.
    if (el.id === 'chat') chatWindow(work, moved ? p : { ...p, xpos: kvGet(panel, 'xpos') ?? '0', ypos: kvGet(panel, 'ypos') ?? '0' });
  }
}

/**
 * The item pickup fly-in off (plan task M3): each StartItemPickupN event in
 * hudanimations.txt, which fades the picked-up item's icon in at the centre
 * and flies it to the weapon selection, is cut to one line holding that
 * image clear. Probe F1 (/home/volence/l4d/hud/probe-phase2-rest/RESULTS.md,
 * r1-b) showed the addon's copy of the file is read and a rewritten event is
 * what the game plays. The file's own line ending is kept; an event a HUD's
 * file lacks is left alone.
 */
function pickupPass(work: Work, design: HudDesign) {
  if (design.pickupFlyIn !== false) return;
  const src = work.text(ANIMS);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const out = src.replace(/(event[ \t]+StartItemPickup([123])[ \t]*\r?\n?[ \t]*\{)[^}]*(\})/gi,
    (_m, head: string, n: string, close: string) => `${head}${eol}\tAnimate image${n} Alpha 0 Linear 0.0 0.001${eol}${close}`);
  if (out !== src) work.setText(ANIMS, out);
}

/**
 * The chat's text size and the open chat's box (plan task C1). The
 * history's own `font` key is ignored in game
 * (/home/volence/l4d/hud/probe-phase2-rest/r1/shots/crops/chat-h.png), but
 * ChatFont in chatscheme.res sets the size (r4/shots/crops/chat-d.png), so
 * the size goes there: every size range's PC tall, scaled from the first
 * (480 to 599 lines) range's by size / that tall, the way a HudEd_ copy
 * scales, the console's own lines left alone. The box colour is basechat.res
 * HudChat's bgcolor_override, behind gate C2 (the probe never got the chat
 * open). A size equal to the first range's own writes nothing.
 */
function chatPass(work: Work, design: HudDesign) {
  const o = design.elements.chat;
  if (!o || !baseHasElement(work.key, elementById('chat')!)) return;
  if (o.fontSize !== undefined) {
    const font = work.optional(CHATSCHEME, ['Fonts', 'ChatFont']);
    const ranges = font && typeof font.value !== 'string' ? font.value.filter((n) => typeof n.value !== 'string') : [];
    const first = ranges[0] ? num(pcGet(ranges[0], 'tall')) : 0;
    const size = Math.round(o.fontSize);
    if (first > 0 && size !== first) {
      for (const r of ranges) {
        const t = pcGet(r, 'tall');
        if (t !== undefined) pcSet(r, 'tall', String(Math.max(1, Math.round(num(t) * size / first))));
      }
    }
  }
  if (o.bg !== undefined && probe('C2')) {
    const chat = work.optional(BASECHAT, ['HudChat']);
    if (chat) pcSet(chat, 'bgcolor_override', o.bg);
  }
}

/**
 * The kill notice box's texture (plan task K2): label4background is a
 * ScalableImagePanel whose `image` the game honours, though code shows it
 * and moves it to row 0 itself (/home/volence/l4d/hud/probe-phase2-rest/RESULTS.md
 * K4, r1/shots/crops/notices-ijkl.png). A flat box is a 32-texel square of
 * the colour, which nine-slices into the same flat colour at any size; None
 * is the same square fully clear, since a hard hide may not hold against
 * code that shows and sizes the box.
 */
export const NOTICE_BOX_TEXTURE = 'vgui/hud/hudeditor/noticebg';
const NOTICE_BOX_TEXELS = 32;

/**
 * The kill notices' own look, in pzdamagerecordpanel.res (plan tasks K1,
 * K2). Game code fills the rows: a kill notice replaces the last in
 * recordlabel0 (/home/volence/l4d/hud/probe-phase2-rest/r1/shots/crops/notices-ijkl.png),
 * but saves stack on rows 0 and 1 at once (v1/crops/v1a-s-b-notice.png), so
 * the colour goes on all five rows (plan decision 2). The text size points
 * every row at a HudEd_ copy of its font, and waits on gate K5, which V1a
 * passed (the notices drew at size 24, v1/crops/v1a-k-b-notice.png). A row
 * an imported file lacks is skipped. The box
 * (NOTICE_BOX_TEXTURE) ships its texture only into a download (`out`).
 */
function noticePass(work: Work, design: HudDesign, out: VpkFile[] | null) {
  const o = design.elements.killNotices;
  const el = elementById('killNotices')!;
  if (!o || !baseHasElement(work.key, el)) return;
  const size = probe('K5') ? o.fontSize : undefined;
  if (o.color === undefined && size === undefined && !o.noticeBox) return;
  const nodes = work.tree(PZ_RECORD);
  if (o.noticeBox) {
    const bg = kvFind(nodes, ['label4background']);
    if (!bg && !work.imported) throw new Error(`${PZ_RECORD}: no label4background`);
    if (bg) {
      // The same form as the stock path; probe K4 drew ../vgui/hud/hudeditor/probe_blue so.
      kvSet(bg, 'image', `../${NOTICE_BOX_TEXTURE}`);
      const colour = o.noticeBox.kind === 'none' ? '0 0 0 0' : o.noticeBox.color ?? NOTICE_BOX_COLOUR;
      out?.push({ path: `materials/${NOTICE_BOX_TEXTURE}.vtf`, data: encodeVTF(NOTICE_BOX_TEXELS, NOTICE_BOX_TEXELS, flatTexture(NOTICE_BOX_TEXELS, NOTICE_BOX_TEXELS, colour)) },
        { path: `materials/${NOTICE_BOX_TEXTURE}.vmt`, data: enc(vmtFor(NOTICE_BOX_TEXTURE)) });
    }
  }
  for (let i = 0; i < 5; i++) {
    const row = kvFind(nodes, [`recordlabel${i}`]);
    if (!row) { if (work.imported) continue; throw new Error(`${PZ_RECORD}: no recordlabel${i}`); }
    if (o.color !== undefined) kvSet(row, 'fgcolor_override', o.color);
    if (size !== undefined) {
      const leaf = (row.value as KvNode[]).find((n) => n.key.toLowerCase() === 'font' && typeof n.value === 'string');
      if (leaf) { const tall = Math.round(size); useFontCopy(work, leaf, `t${tall}`, () => tall); }
    }
  }
}

/**
 * The spawn countdown's look (plan task M4): its colour and text size on
 * spectatorinfected.res's InfectedState, the line code writes the countdown
 * into, not on the "YOU ARE DEAD" title above it. The addon copy of the
 * file is read (probe Q23,
 * /home/volence/l4d/hud/probe-phase2-infected/b9/shots/b9/b9-e.png); these
 * are the plain Label keys. An imported file lacking the block is skipped.
 */
function countdownPass(work: Work, design: HudDesign) {
  const o = design.elements.spawnCountdown;
  const el = elementById('spawnCountdown')!;
  if (!o || (o.color === undefined && o.fontSize === undefined) || !baseHasElement(work.key, el)) return;
  const line = work.panel(layoutOf(el), [el.key]);
  if (o.color !== undefined) kvSet(line, 'fgcolor_override', o.color);
  if (o.fontSize !== undefined) {
    const leaf = (line.value as KvNode[]).find((n) => n.key.toLowerCase() === 'font' && typeof n.value === 'string');
    if (leaf) { const tall = Math.round(o.fontSize); useFontCopy(work, leaf, `t${tall}`, () => tall); }
  }
}

const VOTEHUD = 'resource/ui/hud/votehud.res';
/**
 * The vote panel's colour (plan task M1): the element's `bg` on votehud.res
 * VoteActive, the box shown while a vote runs. Probe VO
 * (/home/volence/l4d/hud/probe-phase2-rest/r4/shots/r4/r4-e.png) saw it
 * honoured (purple). The passed and failed boxes were never seen, so they
 * keep the file's colour. An imported file lacking the block is skipped.
 */
function votePass(work: Work, design: HudDesign) {
  const o = design.elements.vote;
  if (o?.bg === undefined || !baseHasElement(work.key, elementById('vote')!)) return;
  const box = work.optional(VOTEHUD, ['VoteActive']);
  if (box) pcSet(box, 'bgcolor_override', o.bg);
}

/**
 * The entries of a key the PC reads: the plain one and any whose conditional
 * holds on the PC ([$WIN32], [$WINDOWS], kv.ts's pcApplies). basechat.res
 * gives several keys a second value for the console ([$X360]), and some
 * files a Mac one ([$OSX]); the PC ignores those, and they are left exactly
 * as they were.
 */
function pcEntries(block: KvNode, key: string): KvNode[] {
  if (typeof block.value === 'string') throw new Error(`KeyValues: ${block.key} is not a block`);
  return block.value.filter((n) => n.key.toLowerCase() === key.toLowerCase() && typeof n.value === 'string' && pcApplies(n.cond));
}
export function pcGet(block: KvNode, key: string): string | undefined { return pcEntries(block, key)[0]?.value as string | undefined; }
/** Set every entry the PC reads; with none, add a plain one, never overwriting a console-only ([$X360]) entry. */
export function pcSet(block: KvNode, key: string, value: string) {
  const hits = pcEntries(block, key);
  if (hits.length) for (const n of hits) n.value = value;
  else (block.value as KvNode[]).push({ key, value });
}

/**
 * A child's or an element's typed file keys (KeyDef), each through pcSet: a
 * block that carries a key twice, for the Mac and for the PC, gets the PC's
 * line replaced rather than a plain third line the game would never read.
 */
export function writeKeys(block: KvNode, keys: Record<string, string>) {
  for (const [key, value] of Object.entries(keys)) pcSet(block, key, value);
}

/**
 * The chat window itself. Probe T4 showed the box you type into and its
 * history are placed and sized by basechat.res's HudChat, not by
 * hudlayout.res's, which is only a background panel the animation file
 * places. So a moved or resized chat writes the same tokens and size here as
 * it does to hudlayout, which is also the rect elementRect reports and the
 * preview draws. Every other basechat child (HudChatHistory, ChatInputLine,
 * KeyStateLabel, ChatFiltersButton) keeps the share of the box it has in the
 * base file (stock and Modern both: the history at 10, 17, 260 x 75 in a
 * 280 x 120 box), so a bigger box shows more lines and a wider typing line
 * rather than the same few, in a corner, at the base size. The file is
 * untouched, and so not shipped on stock, until the chat moves, resizes or
 * hides.
 */
function chatWindow(work: Work, p: { xpos: string; ypos: string; w: number; h: number }) {
  const chat = work.optional(BASECHAT, ['HudChat']);
  if (!chat) return;
  const baseW = num(pcGet(chat, 'wide')), baseH = num(pcGet(chat, 'tall'));
  const w = Math.round(p.w), h = Math.round(p.h);
  pcSet(chat, 'xpos', p.xpos);
  pcSet(chat, 'ypos', p.ypos);
  pcSet(chat, 'wide', String(w));
  pcSet(chat, 'tall', String(h));
  if (baseW > 0 && baseH > 0 && (w !== baseW || h !== baseH)) {
    const sx = w / baseW, sy = h / baseH;
    // wide and tall are never let round down to 0: the game's size-0
    // semantics (probe on 2026-09-23, hidePass below) would hide a shrunk
    // child outright, which a resize never asked for.
    for (const child of work.tree(BASECHAT)) {
      if (child.key === 'HudChat' || typeof child.value === 'string') continue;
      for (const [key, k, isSize] of [['xpos', sx, false], ['ypos', sy, false], ['wide', sx, true], ['tall', sy, true]] as const) {
        if (pcGet(child, key) === undefined) continue;
        const v = Math.round(num(pcGet(child, key)) * k);
        pcSet(child, key, String(isSize ? Math.max(1, v) : v));
      }
    }
  }
}

/**
 * Write the player's edits inside a card file (the v2 spec's child pass,
 * teammate card only in this phase). Values are the stored unscaled numbers,
 * written before fitPass, which fits the card around what this pass left,
 * and before scalePass, which multiplies them with the rest of the file.
 *
 * An addable child (the stock card's health number) is cloned from its
 * template after its sibling when turned on and removed when turned off. An
 * addable child that is absent and not turned on has nothing to edit yet, so
 * its other fields wait: that is what lets a design switch presets without
 * pruning. Anything else missing, or an edit the child cannot take, fails the
 * build naming the file and child, before any of it is written.
 */
function childPass(work: Work, design: HudDesign) {
  for (const [panelId, kids] of Object.entries(design.children)) {
    const panel = panelChildren(panelId);
    if (!panel) throw new Error(`No inside-editable panel ${panelId}`);
    for (const [name, o] of Object.entries(kids)) {
      const def = panel.children.find((c) => c.name === name);
      if (!def) throw new Error(`${panel.file}: ${name} is not an editable child`);
      // A piece waiting on a closed probe is never written (validateDesign drops it too).
      if (def.gate && !probe(def.gate)) continue;
      const nodes = work.tree(panel.file);
      let block = kvFind(nodes, childPath(name));
      if (def.addable) {
        if (o.on === false) { if (block) nodes.splice(nodes.indexOf(block), 1); continue; }
        if (o.on === true && !block) {
          const after = def.addable.after.toLowerCase();
          const at = nodes.findIndex((n) => n.key.toLowerCase() === after);
          // An imported card may lack the sibling an addable child goes after
          // (or the child itself, below): the side panel offers no such
          // child there, so a stored edit for it is skipped, not a failure.
          if (at < 0) { if (work.imported) continue; throw new Error(`${panel.file}: no ${def.addable.after} to add ${name} after`); }
          block = structuredClone(def.addable.template);
          nodes.splice(at + 1, 0, block);
        }
        if (!block) continue;
      }
      // An imported panel file may lack a piece its linked files have (a
      // Hunter file with no number the Smoker's and Boomer's carry): the
      // edit still lands in each of those, as linkedBlocks allows.
      if (!block && !work.imported) throw new Error(`${panel.file}: no child ${name}`);
      if (block) applyChild(work, panel.file, def, block, o);
      for (const link of linkedBlocks(work, design, panel, name)) applyChild(work, link.file, def, link.block, linkedOverride(o, link));
    }
  }
}

/**
 * The same block in each of a panel's linked files (your infected health:
 * the Smoker's and the Boomer's, plan decision 3), with the block's rect in
 * the panel's base file and in the linked base file, which is what the
 * linked rule maps a stored number between. Bases are read from the base
 * files, never from the tree an edit already changed. A linked file an
 * imported HUD lacks the block in is skipped, as childPass skips a missing
 * block on imports. A 'delta' file whose panel base file lacks the block
 * (an import's Hunter file) has no rect to move from: it comes back with
 * no rects, and linkedOverride leaves its place and size alone.
 */
interface LinkedBlock { file: string; rule: LinkRule; block: KvNode; from: LinkRect | null; to: LinkRect | null }
function linkedBlocks(work: Work, design: HudDesign, panel: PanelChildren, name: string): LinkedBlock[] {
  if (!panel.linked) return [];
  const rectOf = (file: string): LinkRect | null => {
    const n = kvFind(baseTree(baseOf(design), file), childPath(name));
    return n ? { x: num(pcGet(n, 'xpos')), y: num(pcGet(n, 'ypos')), w: num(pcGet(n, 'wide')), h: num(pcGet(n, 'tall')) } : null;
  };
  const from = rectOf(panel.file);
  const out: LinkedBlock[] = [];
  for (const { file, rule } of panel.linked) {
    const block = work.optional(file, [name]);
    const to = rectOf(file);
    if (!block || ((!to || !from) && !work.imported)) { if (work.imported) continue; throw new Error(`${file}: no child ${name}`); }
    out.push({ file, rule, block, from, to });
  }
  return out;
}

/**
 * How one of a panel's linked files takes a piece: the rule and the piece's
 * rect in the panel's base file and in the linked base file, which edit.ts
 * maps a value seen in that file back through (unlinkedValue). Null for the
 * panel's own file, a file it does not link, or a piece either base lacks.
 */
export function panelLink(design: HudDesign, panelId: string, name: string, file: string): { rule: LinkRule; from: LinkRect; to: LinkRect } | null {
  const panel = panelChildren(panelId);
  const link = panel?.linked?.find((l) => l.file === file);
  if (!panel || !link) return null;
  const rectOf = (f: string): LinkRect | null => {
    const n = kvFind(baseTree(baseOf(design), f), childPath(name));
    return n ? { x: num(pcGet(n, 'xpos')), y: num(pcGet(n, 'ypos')), w: num(pcGet(n, 'wide')), h: num(pcGet(n, 'tall')) } : null;
  };
  const from = rectOf(panel.file), to = rectOf(file);
  return from && to ? { rule: link.rule, from, to } : null;
}

/**
 * A child's stored edit as a linked file takes it: places and sizes through
 * linkedValue, the rest as stored. A 'delta' file with no rects to map
 * between (linkedBlocks) keeps its own place and size.
 */
function linkedOverride(o: ChildOverride, link: LinkedBlock): ChildOverride {
  const out: ChildOverride = { ...o };
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    if (o[k] === undefined) continue;
    if (link.from && link.to) out[k] = linkedValue(link.rule, k, o[k]!, link.from, link.to) as number;
    else if (link.rule === 'delta') delete out[k];
  }
  return out;
}

/**
 * Whether a piece seen in `file` can be moved and sized there: always on
 * the panel's own file and on a 'same' file (its frame is the stored one),
 * and on a 'delta' file only when both base files have the piece, since
 * the delta rule moves it from the panel file's rect. An imported Hunter
 * file may lack a number the Boomer's has: there the Boomer view can still
 * show, hide and colour it, but its place and size are the file's own
 * (edit.ts patchChild drops them, the side panel says why).
 */
export function pieceMovableIn(design: HudDesign, panelId: string, name: string, file?: string): boolean {
  const link = file ? panelChildren(panelId)?.linked?.find((l) => l.file === file) : undefined;
  return !link || link.rule === 'same' || panelLink(design, panelId, name, file!) !== null;
}

/**
 * Which key a child's colour override becomes: an image's is a tint the
 * ImagePanel multiplies its texture by (drawColor, the key the stock
 * infected card's own frame already carries), a label's is its text colour
 * (fgcolor_override). Read by both the writer (applyChild) and the reader
 * (cardChild), so the two can never disagree about which key a child's
 * colour lives in.
 */
function colourKey(def: ChildDef): 'drawColor' | 'fgcolor_override' {
  return def.kind === 'image' ? 'drawColor' : 'fgcolor_override';
}

/**
 * There is no "cannot move" guard here any more (there was, through the
 * splatter, until it became a wh piece): every registered child moves
 * today, so nothing can reach it, and childOverride (design.ts) still only
 * ever sets x or y for a child whose registry entry has `move`, so a
 * validated design can never carry a move on one that cannot take it. If a
 * future child ever ships with `move: false`, this guard comes back with
 * it, alongside a real registry entry to test it against.
 */
function applyChild(work: Work, file: string, def: ChildDef, block: KvNode, o: ChildOverride) {
  if (o.color !== undefined && !def.colour) throw new Error(`${file}: ${def.name} takes no colour`);
  if (o.fontSize !== undefined && !def.font) throw new Error(`${file}: ${def.name} takes no text size`);
  if ((o.w !== undefined || o.h !== undefined) && def.box === 'none') throw new Error(`${file}: ${def.name} takes no size`);
  for (const key of Object.keys(o.keys ?? {})) {
    if (!def.keys?.some((k) => k.key === key)) throw new Error(`${file}: ${def.name} takes no key ${key}`);
  }
  if (o.visible !== undefined) kvSet(block, 'visible', o.visible ? '1' : '0');
  const set = (key: string, v: number | undefined) => { if (v !== undefined) kvSet(block, key, String(Math.round(v))); };
  set('xpos', o.x); set('ypos', o.y); set('wide', o.w); set('tall', o.h);
  if (o.color !== undefined) kvSet(block, colourKey(def), o.color);
  if (o.fontSize !== undefined) {
    const leaf = typeof block.value === 'string' ? undefined
      : block.value.find((n) => n.key.toLowerCase() === 'font' && typeof n.value === 'string');
    if (!leaf) throw new Error(`${file}: ${def.name} has no font`);
    const size = Math.round(o.fontSize);
    // Read before the leaf is repointed: the size the file's own font draws at.
    const baseSize = kvFind(work.tree(SCHEME), ['Fonts', leaf.value as string, '1']);
    const baseTall = baseSize ? num(kvGet(baseSize, 'tall')) : 0;
    useFontCopy(work, leaf, `t${size}`, () => size);
    // The item icons are glyphs in their font with no size of their own: the
    // label's tall follows the font, and its wide grows in step (stock's 50 at
    // an 18-tall font is 100 at 36), so the icons are not cut off on either
    // side and the fitted card grows with them.
    if (def.box === 'none') {
      kvSet(block, 'tall', String(size));
      if (baseTall > 0) kvSet(block, 'wide', String(Math.round(num(kvGet(block, 'wide')) * size / baseTall)));
    }
  }
  if (o.z !== undefined) kvSet(block, 'zpos', String(o.z));
  if (o.keys) writeKeys(block, insetFor(def, block, o.keys));
}

/**
 * A bar's keys with the inset cut to leave a unit of fill (maxInset) at the
 * tall the block has now, the player's size edit included; the same rule
 * validateDesign applies, here so a live edit (a bar made shorter under an
 * inset) never ships a bar that is all border either. Only the design's
 * own inset is cut; a file's is left as the file has it.
 */
function insetFor(def: ChildDef, block: KvNode, keys: Record<string, string>): Record<string, string> {
  // The use bar's border and gap: probe Q22's rule (progress.ts clampBarKeys) at the tall the block has now.
  if (def.keys?.some((k) => k.key === 'border_thickness') && (keys.gap !== undefined || keys.border_thickness !== undefined)) {
    const tall = parseFloat(pcGet(block, 'tall') ?? '');
    if (!Number.isFinite(tall)) return keys;
    const n = (key: string, d: number) => { const v = parseFloat(keys[key] ?? pcGet(block, key) ?? ''); return Number.isFinite(v) ? v : d; };
    const cut = clampBarKeys({ border: n('border_thickness', 1), gap: n('gap', 1), shadow: n('shadow_thickness', 1) }, tall);
    return { ...keys,
      ...(keys.border_thickness !== undefined ? { border_thickness: String(cut.border) } : {}),
      ...(keys.gap !== undefined ? { gap: String(cut.gap) } : {}) };
  }
  if (def.kind !== 'bar' || keys.inset === undefined) return keys;
  const tall = parseFloat(pcGet(block, 'tall') ?? '');
  if (!Number.isFinite(tall)) return keys;
  return { ...keys, inset: String(Math.min(Number(keys.inset), maxInset(tall))) };
}

/**
 * Square the state art and fit the splatter, after the shift (the spec's
 * aspect rule). Voice is a square of min(height, 16) at the right edge; the
 * splatter keeps its 2:1 shape at the card width, clipped by the card.
 * Modern's ModBg, the fill that paints its whole card, covers the fitted
 * card exactly, so a card that grew past the file's still has a background
 * all the way across. A state picture the player moved or sized keeps those
 * fields, which childPass already wrote and the shift already moved into the
 * fitted frame; the splatter follows the same rule field by field (it is a
 * wh piece, not square art, so its x, y, w and h each keep the player's own
 * value where there is one, and take the fit rule's only where there is not).
 *
 * Incapacitated and Dead (s_panel_*_incap, s_panel_dead) are 256 x 256
 * textures whose visible art is a wide strip, its red/black band centred at
 * texture y ~95 of 256 (the owner's in-game screenshot, 2026-09-23: on an
 * unfitted card the game draws these at 96 x 96 and the strip spans the
 * card). Squaring at the card height, as this used to, left only a sliver of
 * that strip on screen. Squaring at the card WIDTH instead, at x 0, with the
 * band's own centre landing on the card's vertical centre, spans the strip
 * across the card the way the unfitted HUD does; the square runs above and
 * below the card, and the card clips those empty rows.
 */
function fitStateArt(nodes: KvNode[], edits: Record<string, ChildOverride>, card: { w: number; h: number }) {
  const at = (name: string) => kvFind(nodes, [name]);
  for (const name of ['Incapacitated', 'Dead']) squareBand(nodes, edits, name, card);
  const voice = Math.min(card.h, 16);
  const voicePiece = squarePiece(nodes, edits, 'Voice', voice);
  if (voicePiece) {
    if (voicePiece.e.x === undefined) kvSet(voicePiece.n, 'xpos', String(Math.round(card.w - voicePiece.s)));
    if (voicePiece.e.y === undefined) kvSet(voicePiece.n, 'ypos', '0');
  }
  const splatter = at('BackgroundImage');
  if (splatter) {
    const e = edits.BackgroundImage ?? {};
    if (e.x === undefined) kvSet(splatter, 'xpos', '0');
    if (e.y === undefined) kvSet(splatter, 'ypos', '0');
    if (e.w === undefined) kvSet(splatter, 'wide', String(card.w));
    if (e.h === undefined) kvSet(splatter, 'tall', String(Math.round(card.w / 2)));
  }
  stretchFill(nodes, card);
}

/** A state picture squared at `side`, or the player's own width when they sized it. */
function squarePiece(nodes: KvNode[], edits: Record<string, ChildOverride>, name: string, side: number) {
  const n = kvFind(nodes, [name]);
  if (!n) return undefined;
  const e = edits[name] ?? {};
  const s = e.w ?? side;
  kvSet(n, 'wide', String(Math.round(s))); kvSet(n, 'tall', String(Math.round(s)));
  return { n, e, s };
}

/**
 * The Down or Dead picture of a fitted panel, the band rule above: a square
 * at the panel width, at x 0, its band (texture y ~95 of 256) on the
 * panel's vertical centre. Shared by the teammate card and your own health.
 */
function squareBand(nodes: KvNode[], edits: Record<string, ChildOverride>, name: string, panel: { w: number; h: number }, left = 0) {
  const BAND_CENTRE = 95 / 256;
  const piece = squarePiece(nodes, edits, name, panel.w - left);
  if (!piece) return;
  if (piece.e.x === undefined) kvSet(piece.n, 'xpos', String(left));
  if (piece.e.y === undefined) kvSet(piece.n, 'ypos', String(Math.round(panel.h / 2 - BAND_CENTRE * piece.s)));
}

/** Modern's ModBg, the fill that paints a whole panel, over the fitted panel exactly. */
function stretchFill(nodes: KvNode[], panel: { w: number; h: number }) {
  const fill = kvFind(nodes, ['ModBg']);
  if (!fill) return;
  kvSet(fill, 'xpos', '0'); kvSet(fill, 'ypos', '0');
  kvSet(fill, 'wide', String(panel.w)); kvSet(fill, 'tall', String(panel.h));
}

/** Every top-level child moved up and left by `by`: the fit shift, on the lines the PC reads. */
function shiftNodes(nodes: KvNode[], by: { x: number; y: number }) {
  for (const n of nodes) {
    if (typeof n.value === 'string') continue;
    for (const [key, d] of [['xpos', by.x], ['ypos', by.y]] as const) {
      const v = parseFloat(kvGet(n, key) ?? '');
      if (Number.isFinite(v)) kvSet(n, key, String(v - d));
    }
  }
}

/**
 * The box a panel fits to: the union of its visible content children and
 * of its visible `fitPlace: 'keep'` children, each keep piece cut to
 * `frame` first (the file's own panel rect), so a decoration can never grow
 * the panel past what the game showed before (plan decision 1). A piece cut
 * to nothing counts nothing. Null when nothing is left. The teammate card
 * has no keep pieces, so its box is contentBox's, as it always was.
 */
function fitBox(nodes: KvNode[], panel: PanelChildren, frame: Box | null): Box | null {
  const content = panel.children.filter((c) => c.role === 'content').map((c) => c.name);
  const boxes: Box[] = [];
  const main = contentBox(nodes, content, panel);
  if (main) boxes.push(main);
  for (const def of panel.children) {
    if (def.fitPlace !== 'keep') continue;
    const piece = contentBox(nodes, [def.name], panel);
    if (!piece) continue;
    const cut = frame ? intersect(piece, frame) : piece;
    if (cut) boxes.push(cut);
  }
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function intersect(a: Box, b: Box): Box | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A single panel's frame block as the base file has it (LocalPlayer: stock 0, 0, 130 x 85). */
function baseFrameRect(design: HudDesign, panel: PanelChildren): Box | null {
  if (!panel.frame || panel.frame === 'hudlayout') return null;
  const n = kvFind(baseTree(baseOf(design), panel.frame.file), [panel.frame.block]);
  if (!n) return null;
  return { x: num(kvGet(n, 'xpos')), y: num(kvGet(n, 'ypos')), w: num(kvGet(n, 'wide')), h: num(kvGet(n, 'tall')) };
}

/** Your own health's fit box, on the panel file as the edits left it; the keep pieces are cut to the file's LocalPlayer. */
function ownContent(work: Work, design: HudDesign): Box | null {
  const frame = baseFrameRect(design, OWN_PANEL);
  // The keep pieces are in the panel file's own frame, which starts at the
  // frame block's top-left, so the cut is the frame's size at 0, 0.
  return fitBox(work.tree(OWN_PANEL.file), OWN_PANEL, frame && { x: 0, y: 0, w: frame.w, h: frame.h });
}

/**
 * Fit your own health panel (plan decisions 1 and 2). Every child shifts
 * by the box's top-left and LocalPlayer, in localplayerdisplay.res, is
 * placed at that same offset and sized to the box, so fitting alone moves
 * nothing on screen. The container, hudlayout.res's
 * CHudLocalPlayerDisplay, is not touched: a stored element position means
 * the same with fit on and off, as the teammate card's container does.
 * LocalPlayer is written unscaled: scalePass scales the whole file, since
 * the element lists it. Probe Q2 (B1 a) showed LocalPlayer clips its
 * children, which is what makes the smaller panel cut what it no longer
 * covers.
 *
 * Then the "Your health background" child, the teammate card's pattern:
 * injected even when fit is off, at the file's LocalPlayer size then.
 */
function fitOwn(work: Work, design: HudDesign) {
  const fit = design.elements.ownHealth?.fit === true;
  const bg = panelBackground(design, OWN_BG.slot);
  if (!fit && !bg) return;
  const base = baseFrameRect(design, OWN_PANEL);
  let size = base ? { w: base.w, h: base.h } : null;
  const nodes = work.tree(OWN_PANEL.file);
  const frame = OWN_PANEL.frame !== 'hudlayout' ? OWN_PANEL.frame : undefined;
  const box = fit ? ownContent(work, design) : null;
  const block = box && frame ? work.optional(frame.file, [frame.block]) : undefined;
  if (box && block) {                                              // else nothing to fit to: the file's panel stays
    shiftNodes(nodes, box);
    size = { w: box.w, h: box.h };
    squareBand(nodes, design.children.ownHealth ?? {}, 'Incapacitated', size, downLeft(nodes, size.w));
    stretchFill(nodes, size);
    const at = base ?? { x: 0, y: 0 };
    kvSet(block, 'xpos', String(at.x + box.x)); kvSet(block, 'ypos', String(at.y + box.y));
    kvSet(block, 'wide', String(box.w)); kvSet(block, 'tall', String(box.h));
  }
  // The background, as the card's: injected first, after the shift, at the panel's size.
  if (bg && size) nodes.unshift(panelBgBlock(bg, size, OWN_BG));
}

/**
 * Where a fitted own panel's down picture starts: at the health bar's x.
 * client.dll (the player panel's update, 1023f5df to 1023f6da) moves Health
 * to Incapacitated's x the moment the down picture shows, y kept, so a down
 * picture that starts anywhere else moves the bar while the player is down
 * (launch R, parity/x12-incap-own.png: squared at x 0, the bar jumped 26
 * units left). Stock has both at 26 and so never moves it. The square runs
 * from the bar to the panel's right edge. A bar that is not in the tree, or
 * sits outside the panel, leaves the picture at x 0 as before.
 */
function downLeft(nodes: KvNode[], w: number): number {
  const bar = kvFind(nodes, ['Health']);
  const x = bar ? parseFloat(pcGet(bar, 'xpos') ?? '') : NaN;
  return Number.isFinite(x) && x >= 0 && x < w ? Math.round(x) : 0;
}

/**
 * The revive anchor. The same client.dll code puts Health
 * back at the x of the panel's "Items" child when the down picture hides
 * again (the revive), and leaves it at the down picture's x when there is no
 * Items child, which localplayerpanel.res never has. So on any own panel
 * whose bar and down picture do not share an x (a dragged bar or down
 * picture, Modern as it ships: bar 34, down picture 0) the bar stayed where
 * the down picture was for the rest of the map. This adds a hidden Items
 * Label at the bar's final x (after scalePass), so a revive puts the bar
 * back where the file and the preview have it. It runs in buildTrees too,
 * so the preview's trees stay the download's; the preview never draws it
 * (visible 0) and never picks it (no registry entry). A Label,
 * because the game calls Label methods on Items (GetFont, SetText with the
 * item glyphs); visible 0, so those glyphs never draw. An imported HUD's
 * panel is anchored only when the design edited it, so an untouched upload
 * still goes back byte for byte, and a panel that already has an Items child
 * keeps its own.
 */
function reviveAnchorPass(work: Work) {
  const file = OWN_PANEL.file;
  const layer = importedFiles(work.key);
  if (!work.parsed(file) && (layer || !presetOverrides(work.key, file))) return;   // a file the build does not ship
  const nodes = work.tree(file);
  if (layer && writeKv(parseKv(baseFile(work.key, file))) === writeKv(work.rootOf(file))) return;
  const bar = kvFind(nodes, ['Health']), down = kvFind(nodes, ['Incapacitated']);
  if (!bar || !down || kvFind(nodes, ['Items'])) return;
  const x = pcGet(bar, 'xpos'), dx = pcGet(down, 'xpos');
  if (x === undefined || x.trim() === (dx ?? '').trim()) return;
  nodes.push({ key: 'Items', value: [
    ['ControlName', 'Label'], ['fieldName', 'Items'], ['xpos', x.trim()], ['ypos', (pcGet(bar, 'ypos') ?? '0').trim()],
    ['wide', '1'], ['tall', '1'], ['visible', '0'], ['enabled', '1'], ['labelText', ''],
  ].map(([key, value]) => ({ key, value })) });
}

/** Your infected health's three live files: the Hunter's (the Tank reads it too), then its linked Smoker and Boomer files. */
const SI_FILES = [SI_PANEL.file, ...(SI_PANEL.linked ?? []).map((l) => l.file)];

/**
 * HudZombieHealth as the base file sizes it (stock 400 x 100, Modern
 * 150 x 34), at 0, 0: the frame the three files' pieces sit in, which is what
 * a keep piece is cut to. Null when the base lacks the block (an import).
 */
function siContainer(design: HudDesign): Box | null {
  const el = elementById(SI_PANEL.panelId)!;
  const n = kvFind(baseTree(baseOf(design), LAYOUT), [el.key]);
  if (!n) return null;
  return { x: 0, y: 0, w: parseSize(kvGet(n, 'wide') ?? '0', screenW(design.aspect)), h: parseSize(kvGet(n, 'tall') ?? '0', SCREEN_H) };
}

/**
 * Your infected health's fit box: the union of the three live files' boxes
 * (fitBox, the keep pieces, the frame and the crouch icon, cut to the base
 * container), on the files as the edits left them. Stock: the Hunter frame
 * at 250,0 200 x 100 cut to 400 wide, the Boomer frame at 320, the bars,
 * numbers and crouch icon inside, so (250,0) 150 x 100 (plan decision 1).
 * The zombiehealthleft_* files are never child-edited and never counted.
 */
function siContent(work: Work, design: HudDesign): Box | null {
  const cut = siContainer(design);
  const boxes = SI_FILES.map((f) => fitBox(work.tree(f), SI_PANEL, cut)).filter((b): b is Box => !!b);
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Fit your infected health (plan decision 2). Every piece of the three live
 * files shifts by the box's top-left, Modern's fill is stretched over the
 * box as on your own panel, and the container, HudZombieHealth, is sized to
 * the box and moved right and down by the box's offset at the element's
 * scale, so fitting alone moves nothing on screen (stock r387 becomes r137).
 * The position starts from the token layoutPass left (the player's move, or
 * the file's own), and is written back through formatPos, the anchor rule
 * layoutPass uses. The size is written unscaled: scalePass multiplies the
 * container with the rest. The two zombiehealthleft_* files are not shifted:
 * they keep today's scale-only treatment. Probe Q11
 * (/home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/br-bce.png)
 * showed the container clips, which is what makes the smaller one cut what
 * it no longer covers. Opt-in: absent means off (unlike your own health,
 * the fit moves the container anchor players already placed).
 */
function fitSi(work: Work, design: HudDesign) {
  const o = design.elements[SI_PANEL.panelId];
  if (o?.fit !== true) return;
  const el = elementById(SI_PANEL.panelId)!;
  if (!baseHasElement(work.key, el)) return;
  const box = siContent(work, design);
  if (!box) return;                                                // nothing to fit to: the file's container stays
  const container = work.panel(LAYOUT, [el.key]);
  for (const f of SI_FILES) {
    const nodes = work.tree(f);
    shiftNodes(nodes, box);
    stretchFill(nodes, box);
  }
  const k = o.scale ?? 1, W = screenW(design.aspect);
  const shift = fitOffset(box, k);
  const x = parsePos(kvGet(container, 'xpos') ?? '0', W) + shift.x;
  const y = parsePos(kvGet(container, 'ypos') ?? '0', SCREEN_H) + shift.y;
  kvSet(container, 'xpos', formatPos(x, box.w * k, W));
  kvSet(container, 'ypos', formatPos(y, box.h * k, SCREEN_H));
  kvSet(container, 'wide', String(box.w));
  kvSet(container, 'tall', String(box.h));
}

/**
 * How far a fitted element's container is drawn from its stored position:
 * the fit box's offset at the element's scale, for a panel framed by its
 * own hudlayout.res block (your infected health) and for the infected row
 * (plan decision 4), else 0, 0. A stored x and
 * y mean the unfitted container's place, so fit on and off keep every piece
 * where it was; edit.ts's placeElement takes a drawn position and stores it
 * less this.
 */
export function elementFitShift(design: HudDesign, id: string): { x: number; y: number } {
  // The infected row's container moves by its fitted card's offset (rowLayout).
  if (id === ZCARD_PANEL.panelId) {
    const el = elementById(id)!;
    return design.elements[id]?.fit === true ? teamLayout(design, el).offset ?? { x: 0, y: 0 } : { x: 0, y: 0 };
  }
  if (!fitsContainer(design, id)) return { x: 0, y: 0 };
  return fitOffset(panelWork(design).boxes[id]!, design.elements[id]?.scale ?? 1);
}

/**
 * The fit box's offset at scale k, whole units: the one number fitSi moves
 * the container by and elementFitShift reports, so an edit subtracts
 * exactly what the build added (at 1.25 an unrounded 312.5 in the build
 * against a rounded 313 in the edit made arrow presses stall or jump 2).
 */
function fitOffset(box: Box, k: number): { x: number; y: number } {
  return { x: Math.round(box.x * k), y: Math.round(box.y * k) };
}

/**
 * Where an element stored at (sx, sy) is drawn, by the token arithmetic the
 * build applies, without building: layoutPass's anchor (placed, formatPos),
 * then for a fitted container fitSi's offset and second anchor, or the
 * infected row's fit offset. A centre token reads back at a half unit on
 * the 853-wide screen (c-126 is 300.5), which is why a stored number is not
 * simply its drawn place; edit.ts's placeElement inverts this, so a drawn
 * target lands on the stored number that draws nearest it. The team
 * layouts' on-screen clamps are not modelled: they only ever pull a team
 * back from an edge.
 */
export function drawnAt(design: HudDesign, id: string, sx: number, sy: number): { x: number; y: number } {
  const el = elementById(id);
  const key = baseOf(design);
  const panel = el && kvFind(baseTree(key, layoutOf(el)), [el.key]);
  if (!el || !panel) return { x: sx, y: sy };
  const W = screenW(design.aspect);
  const p = placed({ ...design.elements[id], x: sx, y: sy }, baseRect(panel, el, key, design.aspect), el, design.aspect);
  const x = parsePos(p.xpos, W), y = parsePos(p.ypos, SCREEN_H);
  if (fitsContainer(design, id)) {
    const box = panelWork(design).boxes[id]!;
    const k = design.elements[id]?.scale ?? 1;
    const shift = fitOffset(box, k);
    return { x: parsePos(formatPos(x + shift.x, box.w * k, W), W), y: parsePos(formatPos(y + shift.y, box.h * k, SCREEN_H), SCREEN_H) };
  }
  const shift = elementFitShift(design, id);
  return { x: x + shift.x, y: y + shift.y };
}

/** Whether a fit rule moves and sizes this element's own hudlayout.res block: fitted, framed by it, and with something to fit to. */
function fitsContainer(design: HudDesign, id: string): boolean {
  const panel = panelChildren(id);
  return !!panel && panel.frame === 'hudlayout' && design.elements[id]?.fit === true && !!panelWork(design).boxes[id];
}

/**
 * The background a fitted panel carries: the style slot that restyles it,
 * the child the build injects for it, and that child's zpos (under every
 * piece of its file). The card's sits at -2, under the splatter at -1; your
 * own health's at -5, Modern ModBg's own zpos, under the scratches at -3,
 * and injected first so it draws under ModBg too.
 */
interface PanelBg { slot: string; block: string; zpos: number }
const CARD_BG: PanelBg = { slot: 'panelBg', block: 'HudEdCardBg', zpos: -2 };
const OWN_BG: PanelBg = { slot: 'ownBg', block: 'HudEdOwnBg', zpos: -5 };

/**
 * A background slot's style as its child carries it. Flat is a plain
 * fillcolor (the Modern ModBg pattern), so no texture ships; Rounded and
 * Image point at the generated texture. An Image style with no stored
 * upload has nothing to show and adds nothing. Stock adds nothing: the
 * stock s_panel_background was never painted either.
 */
function panelBackground(design: HudDesign, slotId: string): { fill: string } | { image: string } | null {
  const s = design.styles[slotId];
  if (!s || s.kind === 'stock') return null;
  if (s.kind === 'image' && !design.images[slotId]) return null;
  if (s.kind === 'flat') return { fill: s.color ?? SLOTS.find((x) => x.id === slotId)!.defaultColor };
  return { image: `hud/hudeditor/${slotId.toLowerCase()}` };
}

/** The background child, unscaled at the panel's size: scalePass scales it with everything else in the panel file. */
function panelBgBlock(bg: { fill: string } | { image: string }, size: { w: number; h: number }, def: PanelBg): KvNode {
  const pairs: [string, string][] = [
    ['ControlName', 'ImagePanel'], ['fieldName', def.block], ['xpos', '0'], ['ypos', '0'], ['zpos', String(def.zpos)],
    ['wide', String(size.w)], ['tall', String(size.h)], ['visible', '1'], ['enabled', '1'],
    ...('fill' in bg ? [['fillcolor', bg.fill]] as [string, string][] : [['scaleImage', '1'], ['image', bg.image]] as [string, string][]),
  ];
  return { key: def.block, value: pairs.map(([key, value]) => ({ key, value })) };
}

/**
 * Shrink the teammate card to its content (probe T6: nothing is lost).
 * Every child is shifted so the content starts at the card's top-left, and
 * teamPass adds the same offset back to every card, so fitting alone moves
 * nothing on screen; only empty space goes. The card size itself is
 * teamPass's to write, from the same box through cardFit. Recomputed from
 * the tree on every build, so moving a child re-fits the card.
 *
 * Then the card background: a child the card really draws, injected first
 * so it sits under everything, sized to the card after fit (or the file's
 * card when fit is off or finds nothing), visible in every state.
 */
function fitTeam(work: Work, design: HudDesign) {
  const fit = design.elements.teamColumn?.fit === true;
  const bg = panelBackground(design, CARD_BG.slot);
  if (!fit && !bg) return;
  const nodes = work.tree(CARD);
  let size = baseTeam(baseOf(design)).card;
  const box = fit ? fitBox(nodes, TEAM_PANEL, null) : null;
  if (box) {
    shiftNodes(nodes, box);
    size = { w: box.w, h: box.h };
    fitStateArt(nodes, design.children?.teamColumn ?? {}, size);
  }
  if (bg) nodes.unshift(panelBgBlock(bg, size, CARD_BG));
}

/**
 * The infected card's fit box: its content (the class icon, the bar and the
 * name) and its backdrop, kept (plan decision 1) and cut to the file's own
 * ZombieTeamDisplayPlayer block first. Stock: (0,10) 133 x 64.
 */
function zcardContent(work: Work, design: HudDesign): Box | null {
  const frame = baseFrameRect(design, ZCARD_PANEL);
  return fitBox(work.tree(ZCARD_PANEL.file), ZCARD_PANEL, frame && { x: 0, y: 0, w: frame.w, h: frame.h });
}

/**
 * Fit the infected card (plan decisions 1 and 4). Every child shifts by the
 * box's top-left and the card's own block, ZombieTeamDisplayPlayer, which
 * clips it (probe Q17, /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/bl-abe.png),
 * is sized to the box, unscaled: scalePass scales the whole file. Code
 * places card i at (i x HorizPanelSpacing, 0) inside CHudZombieTeamDisplay
 * (dll 0x10247a70), so the offset cannot go on the card: teamLayout moves
 * the container by it instead, which is what keeps fitting alone from
 * moving anything on screen. Dead, which the game shows only when it has a
 * height (probe Q19), is spread over the fitted card when it has one, on
 * whatever the player did not set. The other state pieces shift with the
 * rest.
 */
function fitZcard(work: Work, design: HudDesign) {
  if (design.elements.infectedRow?.fit !== true) return;
  const box = zcardContent(work, design);
  if (!box) return;
  const nodes = work.tree(ZCARD_PANEL.file);
  shiftNodes(nodes, box);
  const self = kvFind(nodes, [(ZCARD_PANEL.frame as { block: string }).block]);
  if (self) { kvSet(self, 'wide', String(box.w)); kvSet(self, 'tall', String(box.h)); }
  const dead = kvFind(nodes, ['Dead']);
  if (dead && num(kvGet(dead, 'tall')) > 0) {
    const e = design.children.infectedRow?.Dead ?? {};
    if (e.x === undefined) kvSet(dead, 'xpos', '0');
    if (e.y === undefined) kvSet(dead, 'ypos', '0');
    if (e.w === undefined) kvSet(dead, 'wide', String(box.w));
    if (e.h === undefined) kvSet(dead, 'tall', String(box.h));
  }
}

/**
 * A panel's fit rule: `content` measures the box fit shrinks the panel to,
 * with the panel file as childPass left it (panelWork keeps it for panelFrame,
 * panelChild and teamLayout); `apply` is the rule's own fitPass step; `bg`
 * the background child it injects. One entry per panel that can be fitted,
 * keyed by panel id.
 */
interface FitRule { content: (work: Work, design: HudDesign) => Box | null; apply: (work: Work, design: HudDesign) => void; bg?: PanelBg }
const FIT_RULES: Record<string, FitRule> = {
  teamColumn: { content: (work) => fitBox(work.tree(CARD), TEAM_PANEL, null), apply: fitTeam, bg: CARD_BG },
  ownHealth: { content: ownContent, apply: fitOwn, bg: OWN_BG },
  // No background slot of its own (yet): nothing is injected.
  siHealth: { content: siContent, apply: fitSi },
  infectedRow: { content: zcardContent, apply: fitZcard },
};

/**
 * The zpos of the background child the build injects into a panel's file
 * (HudEdCardBg, HudEdOwnBg), whether or not this design has one: edit.ts's
 * Send to back keeps every piece above it, so a background added later
 * never covers a piece either.
 */
export const panelBgZpos = (panelId: string): number | undefined => FIT_RULES[panelId]?.bg?.zpos;

/** Every panel's fit rule, in turn. */
function fitPass(work: Work, design: HudDesign) {
  for (const rule of Object.values(FIT_RULES)) rule.apply(work, design);
}

/**
 * Make a piece the player hid impossible to see, not only switched off.
 * visible 0 is not enough on its own: a probe on 2026-09-23 showed the game
 * drawing the stock damage splatter with visible 0 in the file, because game
 * code calls SetVisible(true) on the pieces it manages (the splatter, and
 * most likely the Down and Dead pictures and the Voice icon too). It cannot
 * make a 0 x 0 piece show, nor an ImagePanel whose drawColor alpha is 0, so a
 * hidden piece is written with all three. The RGB of the drawColor is kept,
 * the file's own or the player's tint, so only the alpha changes.
 *
 * Runs after fitPass, whose fit rule would otherwise write the state art's
 * square back over the 0 size; the content box never counted a hidden piece
 * anyway, so the fitted card and its background are the same either way.
 * Not part of panelWork: the side panel keeps showing a hidden piece's real
 * size, which is what showing it again restores. Un-hiding writes nothing
 * here, so the file is exactly the default again.
 */
function hidePass(work: Work, design: HudDesign) {
  for (const [panelId, kids] of Object.entries(design.children)) {
    const panel = panelChildren(panelId);
    if (!panel) continue;
    const nodes = work.tree(panel.file);
    for (const [name, o] of Object.entries(kids)) {
      if (o.visible !== false) continue;
      const block = kvFind(nodes, childPath(name));
      if (!block) continue;                            // an addable child that is off is not in the file at all
      hardHide(block);
      for (const link of panel.linked ?? []) { const b = work.optional(link.file, [name]); if (b) hardHide(b); }
    }
  }
}

/**
 * The hard hide hidePass gives a piece, for any block: visible 0, a 0 x 0
 * size, and for an ImagePanel a drawColor with alpha 0 (its RGB kept).
 * Every hidden element gets it too (elementHidePass): probes B2 and B3
 * showed game code re-shows every element that has only visible 0, the same
 * trap as the splatter. Sizes are set on every entry the PC reads, so a
 * [$WIN32] value is zeroed as well as a plain one. A block that sizes itself
 * to its contents would grow back from 0, so an auto_wide_tocontents or
 * auto_tall_tocontents it carries is turned off; one it lacks is not added,
 * which is why no stock or Modern byte moves (none of their hidden blocks has
 * one). autoResize is left alone: it is VGUI's resize-with-parent flag (it
 * sits beside pinCorner, as in basechat.res HudChatHistory), which follows
 * the 0 x 0 parent down, not the contents up.
 */
export function hardHide(block: KvNode) {
  pcSet(block, 'visible', '0');
  pcSet(block, 'wide', '0');
  pcSet(block, 'tall', '0');
  for (const key of ['auto_wide_tocontents', 'auto_tall_tocontents']) {
    const v = pcGet(block, key);
    if (v !== undefined && v !== '0') pcSet(block, key, '0');
  }
  if ((kvGet(block, 'ControlName') ?? '').toLowerCase() === 'imagepanel') {
    kvSet(block, 'drawColor', clearOf(kvGet(block, 'drawColor') ?? '255 255 255 255'));
  }
}

/**
 * Blocks, besides the element's own hudlayout.res block, that hold its
 * content inside another file: hidden with it. Probe Q2
 * (/home/volence/l4d/hud/probe-phase2/b1/shots/crops/own-a.png) showed a
 * panel clips its children, so a 0 x 0 container alone should be enough;
 * these are the second line, for an element whose code sizes its own
 * container. The chat's two basechat.res blocks were hard-hidden before the
 * probes, and stay so.
 */
export const HIDE_FRAMES: Readonly<Record<string, readonly { file: string; blocks: readonly string[] }[]>> = {
  ownHealth: [{ file: 'resource/ui/hud/localplayerdisplay.res', blocks: ['LocalPlayer'] }],
  teamColumn: [{ file: 'resource/ui/hud/teamdisplayhud.res', blocks: ['TeamPlayer1', 'TeamPlayer2', 'TeamPlayer3', 'TeamPlayer4'] }],
  chat: [{ file: BASECHAT, blocks: ['HudChat', 'HudChatHistory'] }],
};

/**
 * Pieces game code shows and sizes itself, so a hidden one needs more than
 * hardHide. Launch P of the slice 2.F probes
 * (/home/volence/l4d/hud/probe-2f/p/shots/cards.png, from p-a.png and
 * p-f.png) wrote every card and own-panel piece visible 0 and 0 x 0: all
 * stayed gone except the teammate Name, whose text still drew at its place.
 * The game cannot undo its parent's clip (probe Q2,
 * /home/volence/l4d/hud/probe-phase2/b1/shots/crops/own-a.png), so
 * codeShownPass moves such a piece CODE_SHOWN_X units left of its panel,
 * further than any name is wide.
 */
export const CODE_SHOWN: Readonly<Record<string, readonly string[]>> = { teamColumn: ['Name'] };
const CODE_SHOWN_X = '-2000';

/**
 * Download-only, like elementHidePass and for the same reason: the side
 * panel and the preview read a hidden piece's place from buildTrees, and
 * must keep showing the file's own. It runs after scalePass, so no multiply
 * touches the number (it only has to be far out, not exact).
 */
function codeShownPass(work: Work, design: HudDesign) {
  for (const [panelId, names] of Object.entries(CODE_SHOWN)) {
    const panel = panelChildren(panelId);
    const kids = design.children[panelId];
    if (!panel || !kids) continue;
    for (const name of names) {
      if (kids[name]?.visible !== false) continue;
      const b = work.optional(panel.file, [name]);
      if (b) pcSet(b, 'xpos', CODE_SHOWN_X);
    }
  }
}

/**
 * Hard-hides every hidden element. Probes B2 and B3
 * (/home/volence/l4d/hud/probe-phase2/RESULTS.md; shots b2/shots/b2/b2-a.png
 * to e, b2/shots-kill/b2-killnotice/b2-f.png, b3/shots-rerun/b3-rerun/b3-a.png
 * to e) showed that visible 0 in hudlayout.res hides no element at all:
 * game code shows each one again. So a hidden element's hudlayout.res block,
 * and each HIDE_FRAMES block of it, is written at size 0 as well.
 *
 * It runs after teamPass and scalePass, which write the team container and
 * card sizes and multiply the rest: running last means neither can write a
 * size back over the hide. It is download-only, like fontPass: buildTrees
 * skips it, so the preview still has a hidden element whole and can paint
 * it dimmed while it is selected (a 0 x 0 LocalPlayer would paint nothing).
 */
function elementHidePass(work: Work, design: HudDesign) {
  for (const el of ELEMENTS) {
    if (el.id === 'xhair' || design.elements[el.id]?.visible !== false || !baseHasElement(work.key, el)) continue;
    if (el.id === MARKER) { markerHide(work.panel(LAYOUT, [el.key]), el); continue; }
    hardHide(work.panel(layoutOf(el), [el.key]));
    for (const name of el.moveWith ?? []) { const b = work.optional(layoutOf(el), [name]); if (b) hardHide(b); }
    for (const f of HIDE_FRAMES[el.id] ?? []) {
      for (const name of f.blocks) { const b = work.optional(f.file, [name]); if (b) hardHide(b); }
    }
  }
}

/** The ability marker's element id: its block is HudCrosshair, the game's crosshair itself. */
export const MARKER = 'abilityMarker';

/**
 * Hides the ability marker without touching the crosshair it shares a block
 * with: a 0 ability_size and every ability colour at alpha 0 (the RGB kept).
 * A hard hide of HudCrosshair (0 x 0, or never_draw, probe Q16b,
 * /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/centre-bcef.png)
 * would remove the game's crosshair as well. Colour keys the block lacks
 * (stock has no attack colours) are added clear, since the dll reads them
 * all. Not yet seen in game: the plan's Task 14 checks it.
 */
function markerHide(block: KvNode, el: HudElement) {
  for (const k of el.keys ?? []) {
    if (k.key === 'ability_size') pcSet(block, k.key, '0');
    else if (k.type === 'colour') pcSet(block, k.key, clearOf(pcGet(block, k.key) ?? '0 0 0 0'));
  }
}

/**
 * A drawColor at alpha 0 with its RGB kept. The value is split on any run of
 * whitespace, so doubled or padded spaces from a hand-written HUD read right.
 * A value that is not three or four numbers (a scheme colour name such as
 * "Black") has no RGB to keep, so it becomes fully clear black.
 */
function clearOf(colour: string): string {
  const parts = colour.trim().split(/\s+/);
  if ((parts.length !== 3 && parts.length !== 4) || !parts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) return '0 0 0 0';
  const [r, g, b] = parts;
  return `${r} ${g} ${b} 0`;
}

/**
 * The teammate splatter's stand-in, right after BackgroundImage, at its final
 * rect, zpos and tint; the stock one then draws at alpha 0. client.dll calls
 * SetImage("hud/healthbar_bg_N") on every card's BackgroundImage by card
 * slot, after the .res is applied, so its `image` key never wins, and an
 * addon cannot replace a pak01 texture (the splatter spec, "What the game
 * does"). So, as with the card background child HudEdCardBg, the editor adds
 * an ImagePanel of its own that the game does not know about and so leaves
 * alone. The stock one keeps its size and visibility, which game code
 * manages, and only loses its alpha: the same alpha 0 that hardHide relies on.
 * The stand-in draws white at the stock alpha (the player's own opacity edit
 * included, as childPass has run): the custom art carries its own colours,
 * and an imported HUD's dark tint (say 0 0 0 200) would multiply it to black
 * with no control on the row to undo it.
 */
function insertStandIn(nodes: KvNode[], stock: KvNode, def: SplatterDef) {
  const colour = kvGet(stock, 'drawColor') ?? '255 255 255 255';
  const pairs: [string, string][] = [
    ['ControlName', 'ImagePanel'], ['fieldName', SPLAT_STAND_IN],
    ['xpos', pcGet(stock, 'xpos') ?? '0'], ['ypos', pcGet(stock, 'ypos') ?? '0'],
    ['wide', pcGet(stock, 'wide') ?? '0'], ['tall', pcGet(stock, 'tall') ?? '0'],
    ['zpos', pcGet(stock, 'zpos') ?? '-1'], ['visible', '1'], ['enabled', '1'], ['scaleImage', '1'],
    ['image', splatterImageKey(def.id)], ['drawColor', `255 255 255 ${parseColour(colour)[3]}`],
  ];
  nodes.splice(nodes.indexOf(stock) + 1, 0, { key: SPLAT_STAND_IN, value: pairs.map(([key, value]) => ({ key, value })) });
  kvSet(stock, 'drawColor', clearOf(colour));
}

/**
 * The damage splatters (splatter.ts). The teammate splatter gets a stand-in
 * (insertStandIn); the own-health scratches are repointed, since their names
 * come only from localplayerpanel.res, and a scratch set to None gets the
 * hard hide. An active splatter ships its texture: Fade pixels generated here,
 * an Image from the page's decoded upload. Missing pixels fail the build, as
 * crosshairPass does, so a download never points at a texture it lacks.
 *
 * `out` null: the preview's trees only, no pixels needed (buildTrees).
 */
function splatterPass(work: Work, design: HudDesign, assets: BuildAssets, out: VpkFile[] | null) {
  for (const def of SPLATTERS) {
    const style = design.splatters?.[def.id];
    if (!style || style.kind === 'stock') continue;
    // A row splatterProblem disables (a preset switch can leave a stale entry
    // on it) ships nothing: the preset's own hide stands, with no texture.
    if (splatterProblem(design, def.id)) continue;
    // Every skip comes before work.optional: loading the file marks it
    // touched, so an inactive entry would ship an unchanged copy of it.
    if (style.kind !== 'none') {
      if (!splatterActive(design, def.id)) continue;                // an Image with no picture stored: stock
      // A splatter's None is its child's hide (plan decision 4), which
      // hidePass has already written: no art, no texture.
      const panel = panelOfFile(def.file);
      if (panel && design.children[panel.panelId]?.[def.block]?.visible === false) continue;
    }
    const block = work.optional(def.file, [def.block]);
    if (!block) continue;                                           // an imported HUD without it: the row is disabled
    // A loaded design never gets here: validateDesign turns a stored None
    // into the child hide. A design handed straight to buildHud still can.
    if (style.kind === 'none') { hardHide(block); continue; }
    if (def.route === 'standIn') {
      insertStandIn(work.tree(def.file), block, def);
    } else pcSet(block, 'image', splatterImageKey(def.id));
    if (!out) continue;
    const px = style.kind === 'fade' ? fadePixels(def, style) : assets.images?.[def.id];
    if (!px || px.length !== def.size.w * def.size.h * 4) {
      throw new Error(`${def.label}: the image could not be read. Pick it again, or choose Stock.`);
    }
    const name = splatterMaterial(def.id);
    out.push({ path: `materials/${name}.vtf`, data: encodeVTF(def.size.w, def.size.h, px) },
      { path: `materials/${name}.vmt`, data: enc(vmtFor(name, { vertexColor: !(def.healthTint && style.keepColours) })) });
  }
}

/**
 * Why a splatter row cannot be used on this design's base, or null: the base
 * lacks the block (an imported HUD), or a preset hides the scratches (Modern).
 */
export function splatterProblem(design: HudDesign, id: SplatterId): string | null {
  const def = splatterDef(id)!;
  const block = kvFind(baseTree(baseOf(design), def.file), [def.block]);
  if (!block) return `This HUD has no ${def.block} in ${def.file.split('/').pop()}, so there is nothing to restyle.`;
  if (def.route === 'repoint' && ((pcGet(block, 'visible') ?? '1') === '0' || !(parseFloat(pcGet(block, 'wide') ?? '0') > 0))) {
    return 'This preset hides the scratches.';
  }
  return null;
}

/**
 * childPass then fitPass on a scratch Work, once per design object, with
 * every fitted panel's content box taken between the two. teamLayout asks
 * for the fitted size on every repaint and the side panel for a child's
 * numbers, and both must be the build's own numbers.
 */
const PANEL_WORK = new WeakMap<HudDesign, { work: Work; boxes: Record<string, Box | null> }>();
export function panelWork(design: HudDesign) {
  let w = PANEL_WORK.get(design);
  if (!w) {
    const work = new Work(baseOf(design));
    childPass(work, design);
    const boxes: Record<string, Box | null> = {};
    for (const [id, rule] of Object.entries(FIT_RULES)) boxes[id] = rule.content(work, design);
    fitPass(work, design);
    w = { work, boxes };
    PANEL_WORK.set(design, w);
  }
  return w;
}

/** The teammate card's content box after the design's child edits, fit on or off. */
function cardFit(design: HudDesign): Box | null {
  return panelWork(design).boxes.teamColumn ?? null;
}

/** How a panel child's stored numbers land on screen. */
export interface PanelFrame { shift: { x: number; y: number }; k: number }
export type CardFrame = PanelFrame;

/**
 * The frame the generator draws a panel's child in: fitPass shifts every
 * child by the content box's top-left (when fitted), then scalePass
 * multiplies by the element's scale. A teammate child stored at (x, y) is
 * drawn in card c at (c.x + (x - shift.x) * k, c.y + (y - shift.y) * k). The
 * page uses it to turn a pointer delta into stored units and to draw a
 * piece's snap guides where the piece is drawn, from the generator's own
 * numbers. A panel with no fit rule is never shifted.
 */
export function panelFrame(design: HudDesign, panelId: string): PanelFrame {
  const box = panelWork(design).boxes[panelId];
  const shift = design.elements[panelId]?.fit && box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
  return { shift, k: design.elements[panelId]?.scale ?? 1 };
}

/** The teammate card's frame: panelFrame for 'teamColumn'. */
export function cardFrame(design: HudDesign): CardFrame {
  return panelFrame(design, 'teamColumn');
}

export interface CardChild { x: number; y: number; w: number; h: number; visible: boolean; fontTall?: number; color?: string }
/**
 * A panel child as cardChild reports one, plus its typed file keys and its
 * zpos as the file has them, and, for a health bar the game draws at its
 * panel's anchor's x (drawnBarX: a teammate card's bar, at its Items x),
 * the block's own x in `ownX`, `x` then being the drawn x.
 */
export interface PanelChild extends CardChild { keys?: Record<string, string>; z?: number; ownX?: number }

/**
 * One panel child as the side panel shows it and a drag starts from: after
 * the player's edits and the fit rule, before scale, in the panel file's own
 * unfitted frame, which is the frame a ChildOverride is stored in. Fit
 * shifts every top-level child of the panel by the content box's top-left,
 * and this adds it back: for a child the fit rule leaves alone (the content,
 * a state picture the player placed) that is the edited block, and for the
 * state art it places, where it put it. `keys` holds the value the PC reads
 * for each key the child's registry entry declares, where the file has one;
 * `z` the block's zpos when it is a number.
 * Null when the panel is not registered or the block is not in the file (an
 * addable child that is off).
 *
 * `file` reads the piece in one of the panel's linked files instead (your
 * infected health shown as the Smoker or the Boomer), in that file's own
 * frame: the numbers the game draws it at there, which edit.ts maps back to
 * the stored frame through unlinkedValue.
 */
export function panelChild(design: HudDesign, panelId: string, name: string, file?: string): PanelChild | null {
  const panel = panelChildren(panelId);
  if (!panel) return null;
  const { work, boxes } = panelWork(design);
  const src = file && panel.linked?.some((l) => l.file === file) ? file : panel.file;
  const n = kvFind(work.tree(src), childPath(name));
  if (!n) return null;
  const box = boxes[panelId];
  const shift = design.elements[panelId]?.fit && box ? box : { x: 0, y: 0 };
  const font = kvGet(n, 'font');
  const size = font ? kvFind(work.tree(SCHEME), ['Fonts', font, '1']) : undefined;
  const tall = size ? parseFloat(kvGet(size, 'tall') ?? '') : NaN;
  const def = childDef(panelId, name);
  // Reads by kind whenever the name is registered, regardless of that
  // child's own colour flag: HealthNumber has no colour control (the game
  // colours it by health) but its raw fgcolor_override is still reported
  // here, as this did before the image/label split. A name outside the
  // registry (panelChild takes any node the file has, not only registered
  // ones) always reports no colour.
  const raw = def ? kvGet(n, colourKey(def)) : undefined;
  const keys: Record<string, string> = {};
  for (const k of def?.keys ?? []) { const v = pcGet(n, k.key); if (v !== undefined) keys[k.key] = v; }
  const z = parseFloat(kvGet(n, 'zpos') ?? '');
  // A card's bar is drawn at its Items x (probe X15): that is the x the X box shows and a gesture starts from.
  const drawn = isBar(name) ? drawnBarX(work.tree(src), panel) : undefined;
  const own = num(kvGet(n, 'xpos')) + shift.x;
  return {
    x: drawn !== undefined ? drawn + shift.x : own, y: num(kvGet(n, 'ypos')) + shift.y,
    w: num(kvGet(n, 'wide')), h: num(kvGet(n, 'tall')),
    visible: (kvGet(n, 'visible') ?? '1') !== '0',
    ...(Number.isFinite(tall) ? { fontTall: tall } : {}),
    ...(raw && /^\d+ \d+ \d+ \d+$/.test(raw) ? { color: raw } : {}),
    ...(Object.keys(keys).length ? { keys } : {}),
    ...(Number.isFinite(z) ? { z } : {}),
    ...(drawn !== undefined ? { ownX: own } : {}),
  };
}

/** One teammate-card child: panelChild for 'teamColumn', without the keys and zpos. */
export function cardChild(design: HudDesign, name: string): CardChild | null {
  const c = panelChild(design, 'teamColumn', name);
  if (!c) return null;
  const { keys: _keys, z: _z, ...plain } = c;
  return plain;
}

/**
 * Whether the base has what the editor needs to offer an element: its
 * hudlayout.res panel and, for the survivor team, all four TeamPlayerN
 * cards. Always true on Stock and Modern. The crosshair is always offered:
 * layoutPass adds its panel whenever the design has one.
 */
export function baseHasElement(key: BaseKey, el: HudElement): boolean {
  if (el.id === 'xhair') return true;
  if (!kvFind(baseTree(key, layoutOf(el)), [el.key])) return false;
  if (!el.team?.file) return true;
  const team = baseTree(key, el.team.file);
  return [1, 2, 3, 4].every((n) => kvFind(team, [`TeamPlayer${n}`]) !== undefined);
}

/** Whether an imported HUD's own hudlayout.res has an xHair element: a HUD made to show a crosshair addon's texture. */
export function importedHasXhair(key: BaseKey): boolean {
  return kvFind(baseTree(key, LAYOUT), ['xHair']) !== undefined;
}

/** Whether the base's own panel file has this child: an addable child it lacks shows as a checkbox. */
export function baseHasChild(key: BaseKey, name: string, panelId = 'teamColumn'): boolean {
  const file = panelChildren(panelId)?.file;
  return file !== undefined && kvFind(baseTree(key, file), childPath(name)) !== undefined;
}

export interface TeamLayout {
  dir: TeamDir;
  /**
   * Units from one card's origin to the next, the element's own scale
   * already applied: one card plus the gap for the survivor team, the
   * HorizPanelSpacing for the infected row, whose cards the game places.
   */
  spacing: number;
  /** Survivor team: the gap between cards at scale 1, as the Gap slider shows it. Derived values can be negative (an overlapping base file). */
  gap?: number;
  /** Survivor team: where the first card sits inside the container, scaled. Non-zero only when fitted. */
  offset?: { x: number; y: number };
  /** Survivor team: one card, scaled. */
  card?: { w: number; h: number };
  /**
   * The container that has to cover four cards, scaled. Present only when
   * `teamWrites` is true, because it is a value `teamPass` writes; otherwise
   * the preview falls back to the registry's `mockSize`.
   */
  container?: { w: number; h: number };
  /** Survivor team: the four TeamPlayerN positions as teamPass writes them. */
  cards?: { xpos: string; ypos: string }[];
  /** Fit was asked for but every content child is hidden, so the card keeps its file size. */
  fitEmpty?: boolean;
  /**
   * The container's new position tokens, when it grew back toward the far
   * edge it is anchored to (growBack). Absent means it stays where the file
   * or the player put it.
   */
  at?: { xpos?: string; ypos?: string };
}

/**
 * Where a container that grew along one axis starts, measured along that
 * axis. Anchored to the near edge (top or left) it grows away from it and
 * `start` stands. Anchored to the far edge (bottom or right) it grows back
 * toward the screen instead: its start moves back by exactly what it grew
 * past `baseSize`, so the far edge stays where the file had it, then far
 * enough for the whole stack to fit on screen, but never off the near edge.
 * A container that did not grow never moves, so fitting a card, which only
 * shrinks it, still moves nothing.
 */
export function growBack(start: number, size: number, baseSize: number, extent: number, far: boolean): number {
  if (!far) return start;
  return Math.max(0, Math.min(start - Math.max(0, size - baseSize), extent - size));
}

/**
 * Where a team container starts along one axis so the whole team is on
 * screen: no further than `extent - reach`, which puts the team's far edge
 * on the screen's, and never before 0. `reach` is how far into the
 * container the drawn team extends, not the container's own size: stock's
 * container is 100 tall at r75 and so already hangs 25 off the bottom in the
 * untouched file, while its cards stop well short of that. Measuring the
 * cards is what keeps an untouched or unscaled design exactly where the
 * preset puts it, while a scaled Row, or a moved team switched to Column,
 * comes back on screen.
 */
export function keepOnScreen(start: number, reach: number, extent: number): number {
  return Math.max(0, Math.min(start, extent - reach));
}

/**
 * Does the generator's team pass rewrite this element's team geometry? A
 * direction, a spacing or a scale all make it do so. Fitting the card does
 * too: it changes the card's size and position. Nothing else does.
 * `teamPass` and `elementRect` both ask, which is what stops the canvas
 * reporting a container size the file contradicts.
 */
function teamWrites(el: HudElement, o: ElementOverride | undefined): boolean {
  if (!el.team || !o) return false;
  const scaled = el.resize === 'scale' && o.scale !== undefined && o.scale !== 1;
  return o.dir !== undefined || o.spacing !== undefined || o.gap !== undefined || o.fit === true || scaled;
}

/**
 * A container's own `wide`/`tall` as the generator leaves it. An "f" token
 * fills the screen on that axis and is never multiplied (`scaleToken` leaves
 * it alone), so it has no fixed size to report and the caller decides what to
 * do instead.
 */
function fixedExtent(token: string | undefined, k: number): number | undefined {
  const n = parseFloat((token ?? '').trim());
  return Number.isFinite(n) ? n * k : undefined;         // "f0" and anything unparsable: no fixed size
}

/**
 * Everything about a team element's layout that both the generator and the
 * canvas need, in final HUD units with the element's scale already applied.
 * This is the single source of truth for team geometry: `teamPass` writes
 * exactly these numbers, `elementRect` reports exactly this container, and
 * the canvas reads the cards back from the file teamPass wrote.
 *
 * The survivor team is placed by gap, not pitch: card n sits at
 * (n - 1) * (card + gap * scale) along the direction, after the fit offset.
 * With no stored gap it is the preset file's own pitch minus its card
 * (fitted or not) along the file's own direction, so a new design looks
 * like its preset (stock fitted: 140 - 121 = 19) and an unfitted one keeps
 * its exact pitch (140 - 150 = -10, which is why this one is not clamped).
 *
 * The infected row has no per-player file: the game places its players
 * HorizPanelSpacing apart, so its spacing comes from that key on its
 * hudlayout.res panel, and a hardcoded constant is only a last resort.
 */
export function teamLayout(design: HudDesign, el: HudElement): TeamLayout {
  const o = design.elements[el.id];
  const k = el.resize === 'scale' ? o?.scale ?? 1 : 1;
  // Read on demand from the parsed base: it is needed only to size a container, and this runs on every canvas repaint.
  const layoutPanel = () => kvFind(baseTree(baseOf(design), LAYOUT), [el.key]);
  if (!el.team?.file) return rowLayout(design, el, o, k, layoutPanel());
  const base = baseTeam(baseOf(design));
  // A fitted card is its content box and sits at the box's top-left, so
  // fitting alone moves nothing on screen.
  const box = o?.fit ? cardFit(design) : null;
  const size = box ?? base.card;
  const card = { w: size.w * k, h: size.h * k };
  const offset = box ? { x: Math.round(box.x * k), y: Math.round(box.y * k) } : { x: 0, y: 0 };
  // Free needs its four card positions; without them it is the preset's own direction.
  const free = o?.dir === 'free' && o.slots?.length === 4;
  const flow: 'row' | 'column' = o?.dir === 'row' || o?.dir === 'column' ? o.dir : base.dir;
  const dir: TeamDir = free ? 'free' : flow;
  const along = (d: 'row' | 'column', c: { w: number; h: number }) => (d === 'row' ? c.w : c.h);
  const gap = o?.gap ?? base.pitch - along(base.dir, size);
  const spacing = Math.round(along(flow, card) + gap * k);
  // In Free each card carries its own position, written with the same anchor
  // tokens elements use, so a card placed at the right edge stays there on
  // another aspect ratio. The container covers the screen, so the tokens
  // resolve against the screen. A slot is the card's unfitted origin, and the
  // fitted card is written the fit offset in from it, as in Row and Column:
  // that is what keeps fitting alone from moving anything in Free too.
  const cards = free
    ? o!.slots!.map((s) => ({
      xpos: formatPos(s.x + offset.x, card.w, screenW(design.aspect)),
      ypos: formatPos(s.y + offset.y, card.h, SCREEN_H),
    }))
    : [0, 1, 2, 3].map((i) => ({
      xpos: String(offset.x + (flow === 'row' ? spacing * i : 0)),
      ypos: String(offset.y + (flow === 'column' ? spacing * i : 0)),
    }));
  const out: TeamLayout = { dir, spacing, gap, offset, card, cards };
  if (o?.fit && !box) out.fitEmpty = true;
  if (!teamWrites(el, o)) return out;
  const panel = layoutPanel();
  if (!panel) return out;
  // The container clips its children, so along the direction it has to cover
  // the offset and all four cards. Across the direction it keeps its own
  // size, scaled; a fill token has no fixed size, and teamPass replaces it
  // with the offset plus one card rather than leave a column loose across
  // the whole screen.
  if (free) { out.container = { w: screenW(design.aspect), h: SCREEN_H }; return out; }
  const tall = kvGet(panel, 'tall') ?? '0';
  out.container = dir === 'column'
    ? { w: fixedExtent(kvGet(panel, 'wide'), k) ?? offset.x + card.w, h: offset.y + spacing * 3 + card.h }
    : { w: offset.x + spacing * 3 + card.w, h: fixedExtent(tall, k) ?? parseSize(tall, SCREEN_H) };
  // Both presets anchor the team to the bottom of the screen (stock r75,
  // Modern r148), and a column grows down from there: a stock fitted column
  // would put its cards at 441, 481 and 521 on a 480-tall screen. Along its
  // direction, a container the player has not moved that way and whose file
  // anchors it to the far edge (an r token, or a file rect ending in the last
  // third) grows back toward the screen instead, a column up and a row left
  // (growBack). One the
  // player moved along that axis stays exactly where they put it: that
  // position is what the canvas showed them and what a drag starts from.
  // Moving it across (the X box alone, for a column) leaves the growth be.
  // A fill width spans the screen and has no far edge to keep.
  const axis = dir === 'column'
    ? { pos: 'ypos', size: tall, extent: SCREEN_H, grown: out.container.h, moved: o?.y !== undefined }
    : { pos: 'xpos', size: kvGet(panel, 'wide') ?? '0', extent: screenW(design.aspect), grown: out.container.w, moved: o?.x !== undefined };
  if (!(el.move && axis.moved)) {
    const tok = (kvGet(panel, axis.pos) ?? '0').trim();
    const start = parsePos(tok, axis.extent);
    const baseSize = parseSize(axis.size, axis.extent);
    const far = !/^f/i.test(axis.size.trim()) && (/^r/i.test(tok) || start + baseSize > (axis.extent * 2) / 3);
    const at = growBack(start, axis.grown, baseSize, axis.extent, far);
    if (at !== start) out.at = { [axis.pos]: formatPos(at, axis.grown, axis.extent) };
  }
  // The whole team stays on screen, in both axes, after scaling and layout.
  // Along the direction the team reaches three pitches plus one card past its
  // offset; across it, one card. A fitted card is the content, so that is
  // the offset plus the card; an unfitted card reaches as far as its content
  // does, scaled, since the rest of the file card draws nothing. The start is
  // where teamPass would otherwise write the container: grown back, moved by
  // the player, or the file's own. Moving it is one more `at`, so the file,
  // elementRect and teamCardRects follow it together.
  const content = box ?? cardFit(design);
  const reach = (a: 'x' | 'y') => {
    const wh = a === 'x' ? 'w' : 'h';
    const pitches = (dir === 'row') === (a === 'x') ? spacing * 3 : 0;
    const last = box ? offset[a] + card[wh] : content ? (content[a] + content[wh]) * k : card[wh];
    return pitches + last;
  };
  for (const a of ['x', 'y'] as const) {
    const pos = a === 'x' ? 'xpos' : 'ypos';
    const extent = a === 'x' ? screenW(design.aspect) : SCREEN_H;
    const grown = out.at?.[pos];
    const start = grown !== undefined ? parsePos(grown, extent)
      : el.move && o?.[a] !== undefined ? o[a]! : parsePos(kvGet(panel, pos) ?? '0', extent);
    const kept = keepOnScreen(start, reach(a), extent);
    if (Math.round(kept) !== Math.round(start)) {
      out.at = { ...out.at, [pos]: formatPos(kept, a === 'x' ? out.container.w : out.container.h, extent) };
    }
  }
  return out;
}

/**
 * The infected row's layout (plan Task 11): code places card i at
 * (i x HorizPanelSpacing, 0) (dll 0x10247a70), so the pitch is the card
 * plus the gap, scaled, and a fitted card's offset moves the container
 * (plan decision 4): `at` holds the container's position moved by it, from
 * where layoutPass put it (the player's move or the file's own), written
 * through formatPos with the element's own base size, as layoutPass
 * writes a move. The card is the fitted box, or the file's own
 * ZombieTeamDisplayPlayer (stock 256 x 128, which overlaps at the stock
 * 140 pitch: the gap it implies is negative, as the survivor team's
 * unfitted one is). With no gap stored, a saved `spacing` (final units) or
 * the file's HorizPanelSpacing, scaled, stands.
 */
function rowLayout(design: HudDesign, el: HudElement, o: ElementOverride | undefined, k: number, panel: KvNode | undefined): TeamLayout {
  const key = el.team?.spacingKey;
  const v = panel && key ? parseFloat(kvGet(panel, key) ?? '') : NaN;
  const basePitch = Number.isFinite(v) ? v : 140;
  const box = o?.fit ? panelWork(design).boxes[el.id] ?? null : null;
  const self = baseFrameRect(design, ZCARD_PANEL);
  const size = box ?? (self ? { w: self.w, h: self.h } : { w: basePitch, h: 0 });
  const gap = o?.gap ?? (o?.spacing !== undefined ? o.spacing / k : basePitch) - size.w;
  // A negative gap (design.ts clampRowGap) still leaves a pitch of at least one unit.
  const spacing = o?.gap !== undefined ? Math.max(1, Math.round((size.w + o.gap) * k))
    : Math.round(o?.spacing ?? basePitch * k);
  const out: TeamLayout = { dir: 'row', spacing, gap, card: { w: size.w * k, h: size.h * k } };
  if (o?.fit && !box) out.fitEmpty = true;
  if (!box || !panel) return out;
  const offset = { x: Math.round(box.x * k), y: Math.round(box.y * k) };
  out.offset = offset;
  const base = baseRect(panel, el, baseOf(design), design.aspect);
  const W = screenW(design.aspect);
  const at: { xpos?: string; ypos?: string } = {};
  const start = (a: 'x' | 'y') => (el.move && o?.[a] !== undefined ? o[a]!
    : parsePos(kvGet(panel, a === 'x' ? 'xpos' : 'ypos') ?? '0', a === 'x' ? W : SCREEN_H));
  if (offset.x) at.xpos = formatPos(start('x') + offset.x, base.w, W);
  if (offset.y) at.ypos = formatPos(start('y') + offset.y, base.h, SCREEN_H);
  if (at.xpos || at.ypos) out.at = at;
  return out;
}

/**
 * Write the team geometry `teamLayout` decided. Every number here is already
 * scaled, which is why `scalePass` skips a team element's `team.file` and its
 * container size entirely: scaling them again would double the factor.
 */
function teamPass(work: Work, design: HudDesign) {
  for (const el of ELEMENTS) {
    const o = design.elements[el.id];
    if (!el.team || !teamWrites(el, o) || !baseHasElement(work.key, el)) continue;
    const team = el.team;
    const t = teamLayout(design, el);
    const container = work.panel(LAYOUT, [el.key]);
    if (team.spacingKey) kvSet(container, team.spacingKey, String(t.spacing));
    if (!team.file) {
      // The infected row: a fitted card's offset moves the container (rowLayout).
      if (t.at?.xpos) kvSet(container, 'xpos', t.at.xpos);
      if (t.at?.ypos) kvSet(container, 'ypos', t.at.ypos);
      continue;
    }
    if (!t.card || !t.container || !t.cards) continue;
    for (let n = 1; n <= 4; n++) {
      const p = work.panel(team.file, [`TeamPlayer${n}`]);
      kvSet(p, 'xpos', t.cards[n - 1].xpos);
      kvSet(p, 'ypos', t.cards[n - 1].ypos);
      kvSet(p, 'wide', String(Math.round(t.card.w)));
      kvSet(p, 'tall', String(Math.round(t.card.h)));
    }
    if (t.dir === 'free') {
      // The probe's setting: the container covers the screen and each card
      // carries its own anchored position.
      kvSet(container, 'xpos', '0'); kvSet(container, 'ypos', '0');
      kvSet(container, 'wide', 'f0'); kvSet(container, 'tall', 'f0');
      continue;
    }
    kvSet(container, 'wide', String(Math.round(t.container.w)));
    if (t.at?.xpos) kvSet(container, 'xpos', t.at.xpos);
    if (t.at?.ypos) kvSet(container, 'ypos', t.at.ypos);
    // A row leaves a fill `tall` alone: it already covers the cards, and
    // replacing it with a number would pin the panel to one screen height.
    const fillTall = /^f/i.test((kvGet(container, 'tall') ?? '').trim());
    if (t.dir === 'column' || !fillTall) kvSet(container, 'tall', String(Math.round(t.container.h)));
  }
}

/**
 * Scale every positioned value in a block, recursively, and collect the
 * `font` leaf nodes it uses. This is the first of scalePass's two walks: it
 * only scales and collects, it never renames. A font leaf gets renamed only
 * after scalePass has confirmed, against the scheme, that a scaled entry for
 * it exists to point at; a font the scheme does not define (an icon font
 * defined elsewhere, say) is left exactly as the base file had it, or the
 * child would lose its font.
 */
function scaleBlock(nodes: KvNode[], k: number, fontLeaves: KvNode[]) {
  for (const n of nodes) {
    if (typeof n.value !== 'string') { scaleBlock(n.value, k, fontLeaves); continue; }
    const key = n.key.toLowerCase();
    if (POSITIONAL.includes(key)) n.value = scaleToken(n.value, k);
    else if (key === 'font') fontLeaves.push(n);
  }
}

/**
 * Point a font leaf at a HudEd_<font>_<tag> copy of its scheme entry, every
 * size's `tall` rewritten by `tall`, creating the copy the first time any
 * pass asks for that name. scalePass tags by percent (`_150`), childPass by
 * size (`_t14`); the `t` is load bearing, or a size-60 label and a 0.60 scale
 * on the same font would collide on one key with two meanings. A font the
 * scheme does not define (an icon font defined elsewhere) is left exactly as
 * the base file had it, or the child would lose its font. The scheme is only
 * pulled into the build when a leaf actually asks.
 */
function useFontCopy(work: Work, leaf: KvNode, tag: string, tall: (t: number) => number) {
  const name = leaf.value as string;
  const newName = `HudEd_${name}_${tag}`;
  if (!work.fonts.has(newName)) {
    const schemeFonts = work.panel(SCHEME, ['Fonts']);
    const src = kvFind(schemeFonts.value as KvNode[], [name]);
    if (!src) {
      work.fonts.set(newName, null);
    } else {
      const copy = structuredClone(src);
      copy.key = newName;
      for (const size of copy.value as KvNode[]) {
        if (typeof size.value === 'string') continue;
        const t = kvGet(size, 'tall');
        if (t !== undefined) kvSet(size, 'tall', String(tall(parseFloat(t))));
      }
      (schemeFonts.value as KvNode[]).push(copy);
      work.fonts.set(newName, newName);
    }
  }
  if (work.fonts.get(newName)) leaf.value = newName;
}

function scalePass(work: Work, design: HudDesign) {
  for (const el of ELEMENTS) {
    const k = design.elements[el.id]?.scale;
    if (el.resize !== 'scale' || k === undefined || k === 1 || !baseHasElement(work.key, el)) continue;
    const tag = String(Math.round(k * 100));
    const fontLeaves: KvNode[] = [];
    // teamPass owns a team-file element's container size and the file that
    // holds its cards, and writes both already scaled. Scaling them here too
    // would square the factor.
    if (!el.team?.file) {
      const container = work.panel(LAYOUT, [el.key]);
      for (const key of ['wide', 'tall']) { const v = kvGet(container, key); if (v !== undefined) kvSet(container, key, scaleToken(v, k)); }
    }
    for (const file of el.children) scaleBlock(work.tree(file), k, fontLeaves);
    // The generator never writes a file the design did not change: an
    // element whose children reference no font at all leaves
    // clientscheme.res alone, since useFontCopy only opens it for a leaf.
    for (const leaf of fontLeaves) useFontCopy(work, leaf, tag, (t) => Math.round(t * k));
  }
}

function fontPass(work: Work, design: HudDesign, assets: BuildAssets, out: VpkFile[]) {
  const wantsRoboto = design.font === 'roboto' || design.preset === 'modern';
  if (!wantsRoboto) return;
  if (!assets.fonts) throw new Error('The Roboto Condensed font files were not loaded');
  if (design.font === 'roboto' && design.preset === 'stock') {
    const rename = (nodes: KvNode[]) => { for (const n of nodes) {
      if (typeof n.value !== 'string') rename(n.value);
      else if (n.key.toLowerCase() === 'name' && /^Trade Gothic( Bold)?$/i.test(n.value)) n.value = 'Roboto Condensed';
    } };
    // The chat box is drawn from its own scheme, which carries its own six
    // Trade Gothic faces. Renaming only clientscheme.res would move the whole
    // HUD to Roboto and leave the chat text behind, which is why the spec
    // lists chatscheme.res as an output whenever the font changes.
    rename(work.tree(SCHEME));
    rename(work.tree(CHATSCHEME));
  }
  // VPK lookups from an addon are case sensitive. The modern preset's own
  // schemes already name these fonts, but with capitals, so their
  // CustomFontFiles entries need the same lower-case fix as the stock preset.
  // Both schemes register the files: a face named in one scheme is not
  // reliably loaded by the other, which is why the Modern HUD lists the two
  // ttf files in both of its own.
  const custom = work.panel(SCHEME, ['CustomFontFiles']);
  kvSet(custom, '7', 'resource/robotocondensed-regular.ttf');
  kvSet(custom, '8', 'resource/robotocondensed-bold.ttf');
  const chatCustom = work.panel(CHATSCHEME, ['CustomFontFiles']);
  kvSet(chatCustom, '5', 'resource/robotocondensed-regular.ttf');
  kvSet(chatCustom, '6', 'resource/robotocondensed-bold.ttf');
  out.push({ path: 'resource/robotocondensed-regular.ttf', data: assets.fonts.regular },
           { path: 'resource/robotocondensed-bold.ttf', data: assets.fonts.bold });
}

/**
 * Restyle textures. An addon cannot replace a file that ships in pak01, so in
 * normal mode every restyled slot gets a new name under
 * `materials/vgui/hud/hudeditor/` and the .res `image` keys that show it are
 * repointed there. In advanced mode the VPK mounts ahead of pak01, so the
 * stock names are written too and nothing needs repointing for a slot with
 * no `targets` (the state panels, which game code names directly). The
 * weapon boxes are not slots: weaponsPass restyles them through mod_textures.txt.
 */
function stylePass(work: Work, design: HudDesign, assets: BuildAssets, out: VpkFile[]) {
  for (const slot of SLOTS) {
    const s = design.styles[slot.id];
    if (!s || s.kind === 'stock') continue;
    if (slot.advancedOnly && !design.advanced) continue;
    // A panel background (the card's, your own health's) is a child fitPass
    // injects: a flat one is a plain fillcolor and needs no texture, and one
    // fitPass did not inject (an Image style with no upload) has nothing to
    // point at.
    if (Object.values(FIT_RULES).some((r) => r.bg?.slot === slot.id)) {
      const bg = panelBackground(design, slot.id);
      if (!bg || 'fill' in bg) continue;
    }
    const { w, h } = slot.size;
    const colour = s.color ?? slot.defaultColor;
    const rgba = s.kind === 'image' ? assets.images?.[slot.id]
      : s.kind === 'rounded' ? roundedTexture(w, h, colour, Math.round(Math.min(w, h) / 4))
      : flatTexture(w, h, colour);
    if (!rgba) continue;                             // an image slot whose upload is missing falls back to stock
    const vtf = encodeVTF(w, h, rgba);
    const names = [`vgui/hud/hudeditor/${slot.id.toLowerCase()}`, ...(design.advanced ? slot.stockNames : [])];
    for (const name of names) {
      out.push({ path: `materials/${name}.vtf`, data: vtf }, { path: `materials/${name}.vmt`, data: enc(vmtFor(name)) });
    }
    for (const t of slot.targets) { const p = work.optional(t.file, t.path); if (p) kvSet(p, t.key, `hud/hudeditor/${slot.id.toLowerCase()}`); }
  }
}

/**
 * The weapon selection's material names in mod_textures.txt, and the
 * textures the editor points them at, all under vgui/hud/hudeditor/.
 *
 * The paint draws its boxes with rounded_background_glow (the active slot)
 * and rounded_background_noborder (the rest), and its pictures with the
 * icon_equip_* cells client.dll asks for by name (weapons.ts's header).
 * WEAPON_ICONS is every gun the primary and pistol slots can hold, so hiding
 * the pictures hides whatever the player carries, not only the preview's
 * pump shotgun. icon_equip_machinegun is the M16 and icon_equip_rifle the
 * hunting rifle: with icon_equip_rifle repointed the M16 stayed stock
 * (/home/volence/l4d/hud/probe-phase2-rest/r1/shots/crops/weap-a.png), and
 * with both repointed each gun drew its own upload
 * (/home/volence/l4d/hud/probe-phase2-rest/r4/shots/crops/weap-abc.png).
 * The flashlight cells are not the weapon selection's and are left alone.
 */
export const WEAPON_BOX_ENTRY = { boxActive: 'rounded_background_glow', boxInactive: 'rounded_background_noborder' } as const;
export { WEAPON_ICONS, ITEM_ICONS };
/** What the editor calls each item's icon entry. */
export const ITEM_ICON_LABELS: Record<string, string> = {
  icon_equip_molotov: 'Molotov', icon_equip_pipebomb: 'Pipe bomb', icon_equip_medkit: 'Medkit', icon_equip_pills: 'Pills',
};
/** What the editor calls each gun's icon entry (the names in WEAPON_ICONS' comment). */
export const WEAPON_ICON_LABELS: Record<string, string> = {
  icon_equip_pumpshotgun: 'Pump shotgun', icon_equip_uzi: 'Uzi', icon_equip_autoshotgun: 'Auto shotgun',
  icon_equip_rifle: 'Hunting rifle', icon_equip_machinegun: 'M16 (assault rifle)',
  icon_equip_dualpistols: 'Dual pistols', icon_equip_pistol: 'Pistol',
};
export const CLEAR_TEXTURE = 'vgui/hud/hudeditor/clear';
export const weaponBoxTexture = (box: 'boxActive' | 'boxInactive') => `vgui/hud/hudeditor/weapon${box.toLowerCase()}`;
/**
 * The stock box art is a 128-texel square the game nine-slices with
 * 16-texel corners, and the mod_textures.txt entry keeps its 0 0 128 128
 * rect, so a generated box is the same size: its corners land in the cells
 * the game keeps square, and a rounded box's radius is exactly one corner.
 */
const BOX_TEXELS = 128;
const BOX_CORNER = 16;
/**
 * Fully transparent. The VTF clamps S and T, and every texel is clear, so
 * any cell rect an entry keeps (the icon sheet's go up to 512) reads nothing
 * but clear: probe B's 512-texel clear texture was belt and braces.
 */
const CLEAR_TEXELS = 16;

/**
 * A scheme font's tall in the preset's own file, read without pulling the
 * scheme into the build: asking the Work for it would ship an untouched
 * clientscheme.res.
 */
function baseFontTall(key: BaseKey, font: string): number | undefined {
  const t = baseTree(key, SCHEME);
  const size = kvFind(t, ['Fonts', font, '1']);
  return size ? num(kvGet(size, 'tall')) : undefined;
}

/**
 * The player's weapon selection edits (HudDesign.weapons).
 *
 * Each number goes into the HudWeaponSelection key the paint reads, on
 * every entry the PC reads (pcSet), so the console's [$X360] values stay as
 * they were. A text size points PrimaryAmmoFont or PistolAmmoFont at a
 * HudEd_<font>_t<size> copy of the font it names, the same copies a child's
 * text size makes; neither preset gives PistolAmmoFont, so it is added,
 * starting from the dll's own default, HudAmmo. A size that is the font's
 * own tall names the font itself, so no copy ships for it.
 *
 * Boxes and pictures are restyled in scripts/mod_textures.txt, which no
 * preset ships and which the game reads from an addon (probe B,
 * 2026-09-23): the named entries are repointed at generated textures and
 * everything else, each entry's cell rect included, is the game's own file.
 * The file ships only when a box or a picture is not stock.
 */
/**
 * Point a mod_textures.txt entry at a whole texture of w x h texels: its
 * file and a rect from 0, 0 at the texture's own size, so the game cuts
 * exactly the upload (/home/volence/l4d/hud/probe-phase2-rest/r4/shots/crops/weap-abc.png).
 * A font glyph entry (font and character, as voice_self is) loses both and
 * gains the rect, the form probe V1 drew (r1/shots/crops/voice-g.png).
 */
export function pointCell(entry: KvNode, file: string, w: number, h: number) {
  const kids = (entry.value as KvNode[]).filter((n) => !['font', 'character'].includes(n.key.toLowerCase()));
  entry.value = kids;
  for (const [k, v] of [['file', file], ['x', '0'], ['y', '0'], ['width', String(w)], ['height', String(h)]]) kvSet(entry, k, v);
}

/**
 * What an upload's label is, for an error naming it.
 */
const uploadLabel = (entry: string) => WEAPON_ICON_LABELS[entry] ?? ITEM_ICON_LABELS[entry] ?? entry;

/**
 * `assets` null is the preview (buildTrees): the cells are pointed from the
 * stored size alone and no pixels are asked for, so the trees are the
 * download's.
 */
function weaponsPass(work: Work, design: HudDesign, assets: BuildAssets | null, out: VpkFile[]) {
  const w = design.weapons;
  if (!w) return;
  const panel = work.optional(LAYOUT, ['HudWeaponSelection']);
  if (!panel) return;
  for (const [field, { key }] of Object.entries(WEAPON_KEYS) as [WeaponNumKey, { key: string }][]) {
    const v = w[field];
    if (v !== undefined) pcSet(panel, key, String(Math.round(v)));
  }
  if (w.reserveColor) pcSet(panel, 'ReserveAmmoColor', w.reserveColor);
  if (w.inactiveColor) pcSet(panel, 'InactiveItemColor', w.inactiveColor);
  for (const [field, key, dllDefault] of [['clipFont', 'PrimaryAmmoFont', 'FrameTitle'], ['pistolFont', 'PistolAmmoFont', 'HudAmmo']] as const) {
    const size = w[field];
    if (size === undefined) continue;
    let leaves = pcEntries(panel, key);
    if (!leaves.length) { pcSet(panel, key, dllDefault); leaves = pcEntries(panel, key); }
    const tall = Math.round(size);
    if (baseFontTall(work.key, leaves[0].value as string) === tall) continue;
    for (const leaf of leaves) useFontCopy(work, leaf, `t${tall}`, () => tall);
  }

  // entry, texture, and for an upload its own w x h rect
  const repoint: [string, string, { w: number; h: number }?][] = [];
  /** An upload's texture under its entry's own name, or false with no stored picture. */
  const uploaded = (entry: string, id: string, name: string, label: string): boolean => {
    const stored = design.images[id];
    if (!stored) return false;
    if (assets) {
      const px = assets.images?.[id];
      if (!px || px.length !== stored.w * stored.h * 4) throw new Error(`${label}: the uploaded picture could not be read. Upload it again, or reset it.`);
      out.push({ path: `materials/${name}.vtf`, data: encodeVTF(stored.w, stored.h, px) }, { path: `materials/${name}.vmt`, data: enc(vmtFor(name)) });
    }
    repoint.push([entry, name, { w: stored.w, h: stored.h }]);
    return true;
  };
  for (const box of ['boxActive', 'boxInactive'] as const) {
    const s = w[box];
    if (!s) continue;
    if (s.kind === 'hidden') { repoint.push([WEAPON_BOX_ENTRY[box], CLEAR_TEXTURE]); continue; }
    if (s.kind === 'image') {
      uploaded(WEAPON_BOX_ENTRY[box], WEAPON_BOX_IMAGE[box], weaponBoxTexture(box), box === 'boxActive' ? 'Held box' : 'Other boxes');
      continue;
    }
    const colour = s.color ?? WEAPON_BOX_COLOUR[box];
    const rgba = s.kind === 'rounded' ? roundedTexture(BOX_TEXELS, BOX_TEXELS, colour, BOX_CORNER) : flatTexture(BOX_TEXELS, BOX_TEXELS, colour);
    const name = weaponBoxTexture(box);
    out.push({ path: `materials/${name}.vtf`, data: encodeVTF(BOX_TEXELS, BOX_TEXELS, rgba) }, { path: `materials/${name}.vmt`, data: enc(vmtFor(name)) });
    repoint.push([WEAPON_BOX_ENTRY[box], name]);
  }
  // A hide switch wins over the uploads it covers, which then ship nothing.
  for (const [list, on] of [[WEAPON_ICONS, w.weaponIcons !== false], [ITEM_ICONS, w.itemIcons !== false]] as const) {
    for (const n of list) {
      if (!on) { repoint.push([n, CLEAR_TEXTURE]); continue; }
      const id = w.icons?.[n];
      if (id) uploaded(n, id, `vgui/hud/hudeditor/${n}`, uploadLabel(n));
    }
  }
  let cells: KvNode | undefined;
  if (repoint.length) {
    cells = work.panel(MODTEX, ['TextureData']);
    for (const [entry, file, rect] of repoint) {
      const e = kvFind(cells.value as KvNode[], [entry]);
      if (!e) { if (work.imported) continue; throw new Error(`${MODTEX}: no ${entry}`); }
      if (rect) pointCell(e, file, rect.w, rect.h);
      else kvSet(e, 'file', file);
    }
    if (repoint.some(([, file]) => file === CLEAR_TEXTURE)) {
      out.push({ path: `materials/${CLEAR_TEXTURE}.vtf`, data: encodeVTF(CLEAR_TEXELS, CLEAR_TEXELS, new Uint8ClampedArray(CLEAR_TEXELS * CLEAR_TEXELS * 4)) },
        { path: `materials/${CLEAR_TEXTURE}.vmt`, data: enc(vmtFor(CLEAR_TEXTURE)) });
    }
  }
  fitWeaponPanel(work, design, panel, cells);
}

/** What each voice upload is called in an error naming it. */
const VOICE_LABELS: Record<string, string> = { voiceSelf: 'Your microphone icon', voicePlayer: 'Teammate talking icon' };

/**
 * The voice icon uploads (plan task T2): each stored picture ships as
 * materials/vgui/hud/hudeditor/<entry>.vtf and its mod_textures.txt entry
 * (a font glyph in every preset) becomes a 64 x 64 cell of it, the form
 * probe V1 drew (/home/volence/l4d/hud/probe-phase2-rest/r1/shots/crops/voice-g.png).
 * `assets` null is the preview: the entry is pointed and no pixels are
 * asked for. An imported HUD lacking the entry is skipped.
 */
function voicePass(work: Work, design: HudDesign, assets: BuildAssets | null, out: VpkFile[]) {
  for (const [id, entry] of Object.entries(VOICE_ICONS)) {
    const stored = design.images[id];
    if (!stored || !voiceIconOpen(id)) continue;
    const name = `vgui/hud/hudeditor/${entry}`;
    if (assets) {
      const px = assets.images?.[id];
      if (!px || px.length !== VOICE_ICON_TEXELS * VOICE_ICON_TEXELS * 4) throw new Error(`${VOICE_LABELS[id]}: the uploaded picture could not be read. Upload it again, or reset it.`);
      out.push({ path: `materials/${name}.vtf`, data: encodeVTF(VOICE_ICON_TEXELS, VOICE_ICON_TEXELS, px) }, { path: `materials/${name}.vmt`, data: enc(vmtFor(name)) });
    }
    const cells = work.optional(MODTEX, ['TextureData']);
    const e = cells && kvFind(cells.value as KvNode[], [entry]);
    if (!e) { if (work.imported) continue; throw new Error(`${MODTEX}: no ${entry}`); }
    pointCell(e, name, VOICE_ICON_TEXELS, VOICE_ICON_TEXELS);
  }
}

/**
 * Grow HudWeaponSelection to the column it draws (plan decision 1, task
 * W5): the game clips numbers and icons at the panel's edges
 * (/home/volence/l4d/hud/probe-phase2-rest/r2/shots/crops/weap-ab.png), and
 * a 4:1 gun upload was cut at the stock panel's left edge
 * (/home/volence/l4d/hud/probe-phase2-rest/w-verify/crops/game-0de.png). The
 * column is right-aligned, so the panel grows to the left by what the column
 * needs past its left edge and its xpos moves left by the same, keeping the
 * right edge (and so the column) where it was; it grows down to the lowest
 * slot. A column that fits changes nothing, so the preset's own panel stays.
 */
function fitWeaponPanel(work: Work, design: HudDesign, panel: KvNode, cells: KvNode | undefined) {
  const W = screenW(design.aspect);
  const key = (k: string) => pcGet(panel, k) ?? WEAPON_KEY_DEFAULTS[k];
  const n = (k: string) => { const v = parseFloat(key(k)); return Number.isFinite(v) ? v : parseFloat(WEAPON_KEY_DEFAULTS[k]); };
  // The widest gun the column can hold: each gun entry's cell as the file
  // the game reads has it (an upload's own rect), a cleared one drawing nothing.
  let entries: KvNode[] | undefined = cells?.value as KvNode[] | undefined;
  if (!entries) {
    try {
      const t = kvFind(baseTree(work.key, MODTEX), ['TextureData']);
      entries = t && typeof t.value !== 'string' ? t.value : undefined;
    } catch { /* an imported base without the file: the game's own cells */ }
  }
  let gunAspect = entries ? 0 : 3;
  for (const g of WEAPON_ICONS.filter((e) => weaponImageKind(e) === 'gun')) {
    const e = entries && kvFind(entries, [g]);
    if (!e || (kvGet(e, 'file') ?? '').toLowerCase() === CLEAR_TEXTURE) continue;
    const cw = parseFloat(kvGet(e, 'width') ?? ''), ch = parseFloat(kvGet(e, 'height') ?? '');
    if (cw > 0 && ch > 0) gunAspect = Math.max(gunAspect, cw / ch);
  }
  const tallOf = (size: number | undefined, font: string, fallback: number) => {
    if (size !== undefined) return size;
    try { return baseFontTall(work.key, font) ?? fallback; } catch { return fallback; }
  };
  const w = design.weapons ?? {};
  const wide = parseSize(key('wide') ?? '0', W);
  const tall = parseSize(key('tall') ?? '0', SCREEN_H);
  const { left, bottom } = columnExtent({
    n, panelWide: wide, u: W / 640, gunAspect,
    clipTall: tallOf(w.clipFont, key('PrimaryAmmoFont'), 24), pistolTall: tallOf(w.pistolFont, key('PistolAmmoFont'), 18),
  });
  // A hair of float noise is not a unit of growth.
  const grow = Math.ceil(-left - 1e-6);
  if (grow > 0) {
    pcSet(panel, 'wide', String(Math.round(wide) + grow));
    const m = /^\s*([rRcC]?)(-?[\d.]+)\s*$/.exec(key('xpos') ?? '0');
    if (m) {
      const at = parseFloat(m[2]);
      pcSet(panel, 'xpos', m[1].toLowerCase() === 'r' ? `${m[1]}${Math.round(at + grow)}` : `${m[1]}${Math.round(at - grow)}`);
    }
  }
  if (bottom > tall + 1e-6) pcSet(panel, 'tall', String(Math.ceil(bottom - 1e-6)));
}

/**
 * A bundled crosshair's texture and material, the Crosshair page's own
 * files (crosshairFiles), so the xHair element layoutPass wrote has
 * something to show. The page draws the pixels from the design's
 * `xhairArt` (crosshair/texture.ts's artPixels). vgui/hud/altcrosshair is in no pak01: an xHair with
 * nothing behind it draws the magenta and black missing-texture checker,
 * which is what a HUD without its crosshair addon showed in game on
 * 2026-09-23. So a bundle with no pixels fails the build, like missing
 * fonts, rather than ship that. Like fontPass it only adds files, so
 * buildTrees skips it.
 */
function crosshairPass(design: HudDesign, assets: BuildAssets, out: VpkFile[]) {
  if (design.crosshair !== 'bundle') return;
  if (assets.ownCrosshair && importedFiles(baseOf(design))?.has(OWN_XHAIR)) return;
  const px = assets.crosshair;
  if (!px || px.length !== TEX * TEX * 4) {
    throw new Error("This HUD's crosshair could not be drawn. Select Custom crosshair and pick it again, or choose Game default.");
  }
  out.push(...crosshairFiles(TEX, TEX, px));
}

/** Where an imported HUD keeps its own crosshair texture, the one crosshairFiles writes. */
const OWN_XHAIR = 'materials/vgui/hud/altcrosshair.vtf';

function addonInfo(name: string): string {
  return `"AddonInfo"\n{\n\taddonSteamAppID\t\t500\n\taddontitle\t\t"${name.replace(/"/g, '')}"\n\taddonversion\t\t1.0\n\taddontagline\t\t"Custom HUD (riversidepug.com)"\n\taddonauthor\t\t"HUD editor"\n\taddonDescription\t\t"Custom HUD layout."\n}\n`;
}

/** What a download did beyond the design: the upload files a generated file replaced, for the download note. */
export interface BuildReport { replaced: string[] }

/**
 * Where the pass order matters, and where it does not.
 *
 * - `childPass` runs after `layoutPass` and before `scalePass`: it writes the
 *   stored unscaled numbers and scalePass multiplies them with the rest of
 *   the card file. A HudEd_<font>_t<size> copy it makes is a font leaf that
 *   scalePass then clones again as HudEd_HudEd_<font>_t<size>_<pct>.
 * - `hidePass` runs after `fitPass`, whose fit rule would write the state
 *   art's square back over a hidden piece's 0 size, and before `scalePass`,
 *   which leaves a 0 at 0.
 * - `splatterPass` runs after `hidePass`, since it must see a hidden
 *   splatter and the fitted rect, and before `teamPass` and `scalePass`: the
 *   stand-in is a card child they place and scale like the rest. It writes
 *   only the splatter blocks it names, the stand-in and its own textures.
 * - `fitPass` runs after `childPass` (it fits the card around what the edits
 *   left), before `teamPass` (which places and sizes the fitted card, reading
 *   the same box through cardFit) and before `scalePass` (which multiplies
 *   the shifted, still unscaled values).
 * - `childPass` and `fontPass` are order independent, for the same reason as
 *   scalePass below: both edit the one memoised scheme tree.
 * - `scalePass` and `fontPass` can run in either order. scalePass pushes
 *   structuredClone copies of existing font entries into the scheme's Fonts
 *   block as HudEd_<font>_<tag>. Work.tree memoises the parsed scheme by
 *   path and kvFind/kvSet mutate the live nodes it returns, so whichever
 *   pass runs first, the other sees its writes: fontPass first leaves the
 *   base entries already renamed to "Roboto Condensed" before scalePass
 *   clones them, and scalePass first leaves clones for fontPass to rename
 *   alongside everything else. Both orders produce the same scheme.
 * - `teamPass` and `scalePass` are independent, and must stay that way.
 *   teamPass owns a team-file element's container size, its four player
 *   panels and the spacing between them, and writes all of them already
 *   scaled; scalePass skips those same values for that element. Neither pass
 *   reads what the other wrote.
 * - `layoutPass` only moves, hides and free-resizes panels. No team element
 *   is free-resize, so it never writes a container size teamPass then reads.
 * - `stylePass` only repoints image keys, which no other pass looks at.
 * - `weaponsPass` writes only HudWeaponSelection, which no other pass
 *   touches (it is neither a team nor a scaled element), mod_textures.txt,
 *   which only it opens, and HudEd_<font>_t<size> copies in the scheme,
 *   through the same shared font map as childPass, so it is order independent
 *   of childPass, scalePass and fontPass for the reasons given for those.
 * - `crosshairPass` only adds the texture files for the xHair element
 *   `layoutPass` wrote; it reads no tree.
 * - `elementHidePass` runs after `teamPass` and `scalePass`, since both write
 *   sizes it must zero, and only here: buildTrees skips it, so the preview
 *   keeps a hidden element whole (its own doc comment).
 * - `codeShownPass` runs after `scalePass` and only here, for the same
 *   reasons: it moves a hidden piece the game re-shows out of its panel.
 */
export function buildHud(design: HudDesign, assets: BuildAssets = {}, report?: BuildReport): VpkFile[] {
  const key = baseOf(design);
  const work = new Work(key);
  const extra: VpkFile[] = [];
  layoutPass(work, design);
  weaponsPass(work, design, assets, extra);
  voicePass(work, design, assets, extra);
  noticePass(work, design, extra);
  countdownPass(work, design);
  votePass(work, design);
  chatPass(work, design);
  pickupPass(work, design);
  childPass(work, design);
  fitPass(work, design);
  hidePass(work, design);
  splatterPass(work, design, assets, extra);
  teamPass(work, design);
  scalePass(work, design);
  reviveAnchorPass(work);
  elementHidePass(work, design);
  codeShownPass(work, design);
  fontPass(work, design, assets, extra);
  stylePass(work, design, assets, extra);
  crosshairPass(design, assets, extra);
  const edited = work.files();
  const layer = importedFiles(key);
  if (!layer) return [...edited, ...extra, { path: 'addoninfo.txt', data: enc(addonInfo(design.name)) }];
  // An imported HUD: every file of the upload, then the edited files over
  // them, then the generated ones (a font copy, a texture, the crosshair),
  // which replace an upload file at the same path and are reported. The
  // upload's own addoninfo.txt is kept; one without gets the editor's.
  const out = new Map<string, Uint8Array>(layer);
  for (const f of edited) out.set(f.path, f.data);
  const replaced = new Set<string>();
  for (const f of extra) { if (layer.has(f.path)) replaced.add(f.path); out.set(f.path, f.data); }
  if (!out.has('addoninfo.txt')) out.set('addoninfo.txt', enc(addonInfo(design.name)));
  if (report) report.replaced = [...replaced].sort();
  return [...out.keys()].sort().map((path) => ({ path, data: out.get(path)! }));
}

const README = (name: string) => `${name}: advanced install\r\n\r\n`
  + `1. Close the game.\r\n`
  + `2. Copy the "riversidehud" folder from this zip into your game folder, next to "left4dead":\r\n`
  + `   ...\\steamapps\\common\\left 4 dead\\riversidehud\\pak01_dir.vpk\r\n`
  + `3. Open ...\\left 4 dead\\left4dead\\gameinfo.txt in Notepad. Find the line "SearchPaths" and the "{" under it.\r\n`
  + `   Add this as the first line inside the braces:\r\n\r\n`
  + `\t\t\tGame\triversidehud\r\n\r\n`
  + `4. Save and start the game.\r\n\r\n`
  + `A rebuilt HUD only shows after a game restart.\r\n`
  + `To uninstall, remove that line and the folder. Steam's "verify integrity of game files" also undoes the edit.\r\n`
  + `Custom HUDs are allowed on the Riverside servers.\r\n`;

/**
 * Normal mode ships a VPK straight into left4dead/addons. Advanced mode
 * needs its own mount point ahead of pak01, which an addon VPK cannot give
 * it, so it ships as a zip holding a mod folder (README included) for the
 * player to drop next to left4dead and wire into gameinfo.txt by hand.
 * `addoninfo.txt` is harmless inside a gameinfo.txt mount and is left in.
 */
export function packHud(design: HudDesign, assets: BuildAssets = {}, report?: BuildReport) {
  const vpk = encodeVPK(buildHud(design, assets, report));
  if (!design.advanced) return { filename: `${design.name}.vpk`, mime: 'application/octet-stream', bytes: vpk };
  const zip = encodeZip([
    { path: 'riversidehud/pak01_dir.vpk', data: vpk },
    { path: 'README.txt', data: enc(README(design.name)) },
  ]);
  return { filename: `${design.name}.zip`, mime: 'application/zip', bytes: zip };
}

/**
 * The generator's own view of every file, for the preview.
 *
 * The canvas draws a panel's insides by walking the file the download would
 * contain, so it can never disagree with it. Running the passes per frame
 * would be wasteful, and designs are replaced rather than mutated on every
 * edit, so one Work per design object is enough: a WeakMap keyed on the
 * design gives exactly that, and lets an abandoned design be collected.
 *
 * fontPass is skipped. It only renames faces and demands the ttf bytes, and
 * the preview draws every label in Roboto Condensed regardless. So is
 * crosshairPass, which only adds texture files and demands the crosshair's
 * pixels. splatterPass runs without an output list: the trees get the
 * stand-in and the repointed scratches, and no pixels are asked for.
 * buildHud still runs every pass.
 */
const BUILD_TREES = new WeakMap<HudDesign, Work>();

export function buildTrees(design: HudDesign): (path: string) => KvNode[] {
  let work = BUILD_TREES.get(design);
  if (!work) {
    work = new Work(baseOf(design));
    const discard: VpkFile[] = [];
    layoutPass(work, design);
    weaponsPass(work, design, null, discard);
    voicePass(work, design, null, discard);
    noticePass(work, design, null);
    countdownPass(work, design);
    votePass(work, design);
    chatPass(work, design);
    pickupPass(work, design);
    childPass(work, design);
    fitPass(work, design);
    hidePass(work, design);
    splatterPass(work, design, {}, null);
    teamPass(work, design);
    scalePass(work, design);
    reviveAnchorPass(work);
    stylePass(work, design, {}, discard);
    BUILD_TREES.set(design, work);
  }
  const w = work;
  return (path) => w.tree(path);
}

export function elementRect(design: HudDesign, id: string, aspect: Aspect) {
  const el = elementById(id);
  if (!el) throw new Error(`No HUD element ${id}`);
  const work = new Work(baseOf(design));
  const o = design.elements[id] ?? {};
  if (id === 'xhair') return { x: screenW(aspect) / 2 - 13, y: SCREEN_H / 2 - 13, w: 26, h: 26, visible: design.crosshair !== 'none' };
  const panel = work.panel(layoutOf(el), [el.key]);
  if (id === MARKER) return { ...markerBox(design, aspect), visible: o.visible ?? true };
  const base = baseRect(panel, el, baseOf(design), design.aspect);
  const p = placed(o, base, el, design.aspect);
  const k = el.resize === 'scale' ? o.scale ?? 1 : 1;
  const visible = o.visible ?? (kvGet(panel, 'visible') ?? '1') !== '0';
  // In Free the container covers the screen and each card places itself.
  if (el.team?.file && teamLayout(design, el).dir === 'free') return { x: 0, y: 0, w: screenW(aspect), h: SCREEN_H, visible };
  const moved = el.move && (o.x !== undefined || o.y !== undefined);
  const t = el.team ? teamLayout(design, el) : undefined;
  // A team container that grew back toward its far edge is where teamPass wrote it.
  const xTok = el.mockPos?.x ?? t?.at?.xpos ?? (moved ? p.xpos : kvGet(panel, 'xpos') ?? '0');
  const yTok = el.mockPos?.y ?? t?.at?.ypos ?? (moved ? p.ypos : kvGet(panel, 'ypos') ?? '0');
  // Once teamPass has written a concrete container, that is the container the
  // player's game will have, so the preview reports it rather than the
  // registry's mockSize. mockSize stands in only while the file is untouched
  // and the real container is wider than anything it shows.
  const box = t?.container ?? { w: p.w * k, h: p.h * k };
  // A container its fit rule moved and sized (your infected health) is
  // where, and as big as, the generated file has it.
  if (fitsContainer(design, id)) {
    const c = kvFind(buildTrees(design)(LAYOUT), [el.key])!;
    const W = screenW(aspect);
    return {
      x: parsePos(kvGet(c, 'xpos') ?? '0', W), y: parsePos(kvGet(c, 'ypos') ?? '0', SCREEN_H),
      w: parseSize(kvGet(c, 'wide') ?? '0', W), h: parseSize(kvGet(c, 'tall') ?? '0', SCREEN_H), visible,
    };
  }
  return { x: parsePos(xTok, screenW(aspect)), y: parsePos(yTok, SCREEN_H), w: box.w, h: box.h, visible };
}

/**
 * Screen pixels per HUD unit on the 1920 x 1080 screen the preview stands
 * for (1080 / 480): the ability marker is sized in plain pixels (probe Q16a),
 * so its box in units depends on the resolution, and the preview picks this
 * one, the one every probe shot was taken at.
 */
export const MARKER_PX_PER_UNIT = 1080 / SCREEN_H;

/**
 * The ability marker's box in screen pixels for an ability_size. client.dll
 * (0x102410fc) sets the marker's bounds to the rect it is handed grown by
 * ability_size on every side: w + 2 x size. MARKER_BASE_PX is that rect's
 * width at 1080p: the crosshair's 32 px cell. Measured: the ring's outer
 * edge (half-intensity crossing through the centre) is 73.7 px across at
 * size 40 (/home/volence/l4d/hud/probe-phase2-infected/b9/shots-v2/b9v2/b9v2-d.png)
 * and 46.3 px at size 20 (b15/shots/b15/b15-c.png and -d); the texture's
 * ring is 0.657 of its box, so the boxes are 112 and 70.5 px: 32 + 2 x size
 * within a pixel. Whether the 32 grows with the resolution is not known
 * (both shots are 1080p).
 */
export const MARKER_BASE_PX = 32;
export const markerPx = (size: number): number => MARKER_BASE_PX + 2 * Math.max(0, size);

/**
 * The ability marker's box, HUD units, centred on the screen: markerPx of
 * the generated HudCrosshair's ability_size (plain screen pixels, probe
 * Q16a) at 1080p. The element's rect, so a click, a frame and the painter
 * all use the same box.
 */
export function markerBox(design: HudDesign, aspect: Aspect): { x: number; y: number; w: number; h: number } {
  const c = kvFind(buildTrees(design)(LAYOUT), ['HudCrosshair']);
  const size = parseFloat((c && pcGet(c, 'ability_size')) ?? '0') || 0;
  const s = markerPx(size) / MARKER_PX_PER_UNIT;
  return { x: screenW(aspect) / 2 - s / 2, y: SCREEN_H / 2 - s / 2, w: s, h: s };
}

/**
 * The four teammate cards on screen, in HUD units at `aspect`, read from the
 * generated teamdisplayhud.res and the container elementRect reports: where
 * the canvas draws each card, what hit testing and a Free drag use, and
 * what switching into Free copies into `slots`. Reading the file, not
 * teamLayout, is what keeps the picture the file.
 */
export function teamCardRects(design: HudDesign, aspect: Aspect): { x: number; y: number; w: number; h: number }[] {
  const c = elementRect(design, 'teamColumn', aspect);
  const team = buildTrees(design)('resource/ui/hud/teamdisplayhud.res');
  return [1, 2, 3, 4].map((n) => {
    const p = kvFind(team, [`TeamPlayer${n}`]);
    if (!p) throw new Error(`resource/ui/hud/teamdisplayhud.res: no panel TeamPlayer${n}`);
    return {
      x: c.x + parsePos(kvGet(p, 'xpos') ?? '0', c.w), y: c.y + parsePos(kvGet(p, 'ypos') ?? '0', c.h),
      w: num(kvGet(p, 'wide')), h: num(kvGet(p, 'tall')),
    };
  });
}

/** Whether the survivor team is laid out Free: the element's own X, Y and drag give way to each card's. */
export function isFreeTeam(design: HudDesign): boolean {
  return teamLayout(design, elementById('teamColumn')!).dir === 'free';
}
