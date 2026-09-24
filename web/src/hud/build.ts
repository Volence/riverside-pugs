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
import { baseFile, baseOf, baseTree, importedFiles, isCommunityImport, presetOverrides, BASE_PATHS, type BaseKey } from './base';
import { hudFileProblem, hudPathProblem } from '../../../src/hudFiles';

export { baseTree };
import { parseKv, writeKv, kvFind, kvGet, kvSet, pcApplies, type KvNode } from './kv';
import { parsePos, parseSize, formatPos, scaleToken, screenW, SCREEN_H, type Aspect } from './units';
import { ELEMENTS, elementById, type HudElement } from './elements';
import { SLOTS } from './slots';
import { flatTexture, roundedTexture, vmtFor } from './textures';
import { decodeText, encodeText } from './text';
import {
  baseTeam, contentBox, WEAPON_KEYS, WEAPON_BOX_COLOUR, type Box, type HudDesign, type ElementOverride, type ChildOverride, type TeamDir,
  type WeaponNumKey,
} from './design';
import { panelChildren, teamChild, TEAM_PANEL, type ChildDef } from './children';
import { crosshairFiles } from '../crosshair/vpk';
import { TEX } from '../crosshair/draw';

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
    const panel = work.panel(LAYOUT, [el.key]);
    if (o.visible !== undefined) kvSet(panel, 'visible', o.visible ? '1' : '0');
    const moved = el.move && (o.x !== undefined || o.y !== undefined);
    const sized = el.resize === 'free' && (o.w !== undefined || o.h !== undefined);
    if (!moved && !sized) continue;
    const p = placed(o, baseRect(panel, el, work.key, design.aspect), el, design.aspect);
    if (moved) { kvSet(panel, 'xpos', p.xpos); kvSet(panel, 'ypos', p.ypos); }
    if (sized) { kvSet(panel, 'wide', String(Math.round(p.w))); kvSet(panel, 'tall', String(Math.round(p.h))); }
    if (el.id === 'chat' && moved) {
      // Three animation events hard-code the chat position and would snap a moved chat box back.
      work.setText(ANIMS, work.text(ANIMS).replace(/(Animate\s+HudChat\s+Position\s+")[^"]*(")/g, `$1${p.xpos} ${p.ypos}$2`));
    }
    // Resized in place, the chat keeps hudlayout's own tokens, as elementRect does.
    if (el.id === 'chat') chatWindow(work, moved ? p : { ...p, xpos: kvGet(panel, 'xpos') ?? '0', ypos: kvGet(panel, 'ypos') ?? '0' });
  }
  const chat = design.elements.chat;
  if (chat?.visible === false && baseHasElement(work.key, elementById('chat')!)) {
    // hudlayout's own HudChat is only a background panel (chatWindow's own
    // doc comment), but game code opens and shows the chat itself, the same
    // trap hidePass works around for the teammate card: visible 0 alone may
    // not be enough to keep it hidden.
    hardHide(work.panel(LAYOUT, ['HudChat']));
    for (const name of ['HudChat', 'HudChatHistory']) { const p = work.optional(BASECHAT, [name]); if (p) hardHide(p); }
  }
  const killNotices = design.elements.killNotices;
  if (killNotices?.visible === false && baseHasElement(work.key, elementById('killNotices')!)) {
    // CHudPZDamageRecordPanel is the game's kill/incap feed: its rows are
    // filled in by game code, the same trap as the chat window above, so
    // visible 0 in the file alone may not survive that. hardHide also zeros
    // its size.
    hardHide(work.panel(LAYOUT, ['HudPZDamageRecord']));
  }
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
      const nodes = work.tree(panel.file);
      let block = kvFind(nodes, [name]);
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
      if (!block) { if (work.imported) continue; throw new Error(`${panel.file}: no child ${name}`); }
      applyChild(work, panel.file, def, block, o);
    }
  }
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
  const square = (name: string, side: number) => {
    const n = at(name);
    if (!n) return undefined;
    const e = edits[name] ?? {};
    const s = e.w ?? side;
    kvSet(n, 'wide', String(Math.round(s))); kvSet(n, 'tall', String(Math.round(s)));
    return { n, e, s };
  };
  const BAND_CENTRE = 95 / 256;
  for (const name of ['Incapacitated', 'Dead']) {
    const piece = square(name, card.w);
    if (!piece) continue;
    if (piece.e.x === undefined) kvSet(piece.n, 'xpos', '0');
    if (piece.e.y === undefined) kvSet(piece.n, 'ypos', String(Math.round(card.h / 2 - BAND_CENTRE * piece.s)));
  }
  const voice = Math.min(card.h, 16);
  const voicePiece = square('Voice', voice);
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
  const fill = at('ModBg');
  if (fill) {
    kvSet(fill, 'xpos', '0'); kvSet(fill, 'ypos', '0');
    kvSet(fill, 'wide', String(card.w)); kvSet(fill, 'tall', String(card.h));
  }
}

const CARD_BG = 'HudEdCardBg';

/**
 * The panelBg style as the card background child carries it. Flat is a
 * plain fillcolor (the Modern ModBg pattern), so no texture ships; Rounded
 * and Image point at the generated texture. An Image style with no stored
 * upload has nothing to show and adds nothing. Stock adds nothing: the stock
 * s_panel_background was never painted either.
 */
function cardBackground(design: HudDesign): { fill: string } | { image: string } | null {
  const s = design.styles.panelBg;
  if (!s || s.kind === 'stock') return null;
  if (s.kind === 'image' && !design.images.panelBg) return null;
  if (s.kind === 'flat') return { fill: s.color ?? SLOTS.find((x) => x.id === 'panelBg')!.defaultColor };
  return { image: 'hud/hudeditor/panelbg' };
}

/** The background child, unscaled at the card's size: scalePass scales it with everything else in the card file. */
function cardBgBlock(bg: { fill: string } | { image: string }, size: { w: number; h: number }): KvNode {
  const pairs: [string, string][] = [
    ['ControlName', 'ImagePanel'], ['fieldName', CARD_BG], ['xpos', '0'], ['ypos', '0'], ['zpos', '-2'],
    ['wide', String(size.w)], ['tall', String(size.h)], ['visible', '1'], ['enabled', '1'],
    ...('fill' in bg ? [['fillcolor', bg.fill]] as [string, string][] : [['scaleImage', '1'], ['image', bg.image]] as [string, string][]),
  ];
  return { key: CARD_BG, value: pairs.map(([key, value]) => ({ key, value })) };
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
function fitPass(work: Work, design: HudDesign) {
  const fit = design.elements.teamColumn?.fit === true;
  const bg = cardBackground(design);
  if (!fit && !bg) return;
  const nodes = work.tree(CARD);
  let size = baseTeam(baseOf(design)).card;
  const box = fit ? contentBox(nodes) : null;
  if (box) {
    for (const n of nodes) {
      if (typeof n.value === 'string') continue;
      for (const [key, d] of [['xpos', box.x], ['ypos', box.y]] as const) {
        const v = parseFloat(kvGet(n, key) ?? '');
        if (Number.isFinite(v)) kvSet(n, key, String(v - d));
      }
    }
    size = { w: box.w, h: box.h };
    fitStateArt(nodes, design.children?.teamColumn ?? {}, size);
  }
  if (bg) nodes.unshift(cardBgBlock(bg, size));
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
 * Not part of cardWork: the side panel keeps showing a hidden piece's real
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
      const block = kvFind(nodes, [name]);
      if (!block) continue;                            // an addable child that is off is not in the file at all
      hardHide(block);
    }
  }
}

/**
 * The hard hide hidePass gives a piece, for any block: visible 0, a 0 x 0
 * size, and for an ImagePanel a drawColor with alpha 0 (its RGB kept). The
 * chat window gets it too (layoutPass): game code opens and shows the chat
 * itself, so its visible key alone may not keep it hidden, the same trap as
 * the splatter. Sizes are set on every entry the PC reads, so a [$WIN32]
 * value is zeroed as well as a plain one.
 */
function hardHide(block: KvNode) {
  pcSet(block, 'visible', '0');
  pcSet(block, 'wide', '0');
  pcSet(block, 'tall', '0');
  if ((kvGet(block, 'ControlName') ?? '').toLowerCase() === 'imagepanel') {
    const [r, g, b] = (kvGet(block, 'drawColor') ?? '255 255 255 255').split(' ');
    kvSet(block, 'drawColor', `${r} ${g} ${b} 0`);
  }
}

/**
 * childPass then fitPass on a scratch Work, once per design object, with the
 * content box taken between the two. teamLayout asks for the fitted size on
 * every repaint and the side panel for a child's numbers, and both must be
 * the build's own numbers.
 */
const CARD_WORK = new WeakMap<HudDesign, { work: Work; box: Box | null }>();
function cardWork(design: HudDesign) {
  let w = CARD_WORK.get(design);
  if (!w) {
    const work = new Work(baseOf(design));
    childPass(work, design);
    const box = contentBox(work.tree(CARD));
    fitPass(work, design);
    w = { work, box };
    CARD_WORK.set(design, w);
  }
  return w;
}

/** The teammate card's content box after the design's child edits, fit on or off. */
function cardFit(design: HudDesign): Box | null {
  return cardWork(design).box;
}

/** How a teammate-card child's stored numbers land on screen. */
export interface CardFrame { shift: { x: number; y: number }; k: number }

/**
 * The frame the generator draws a teammate-card child in: fitPass shifts
 * every child by the content box's top-left (when fitted), then scalePass
 * multiplies by the element's scale. A child stored at (x, y) is drawn in
 * card c at (c.x + (x - shift.x) * k, c.y + (y - shift.y) * k). The page
 * uses it to turn a pointer delta into stored units and to draw a piece's
 * snap guides where the piece is drawn, from the generator's own numbers.
 */
export function cardFrame(design: HudDesign): CardFrame {
  const { box } = cardWork(design);
  const shift = design.elements.teamColumn?.fit && box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
  return { shift, k: design.elements.teamColumn?.scale ?? 1 };
}

export interface CardChild { x: number; y: number; w: number; h: number; visible: boolean; fontTall?: number; color?: string }

/**
 * One teammate-card child as the side panel shows it and a drag starts
 * from: after the player's edits and the fit rule, before scale, in the card
 * file's own unfitted frame, which is the frame a ChildOverride is stored
 * in. Fit shifts every top-level child of the card by the content box's
 * top-left, and this adds it back: for a child the fit rule leaves alone
 * (the content, a state picture the player placed) that is the edited
 * block, and for the state art it places, where it put it.
 * Null when the block is not in the file (an addable child that is off).
 */
export function cardChild(design: HudDesign, name: string): CardChild | null {
  const { work, box } = cardWork(design);
  const n = kvFind(work.tree(CARD), [name]);
  if (!n) return null;
  const shift = design.elements.teamColumn?.fit && box ? box : { x: 0, y: 0 };
  const font = kvGet(n, 'font');
  const size = font ? kvFind(work.tree(SCHEME), ['Fonts', font, '1']) : undefined;
  const tall = size ? parseFloat(kvGet(size, 'tall') ?? '') : NaN;
  const def = teamChild(name);
  // Reads by kind whenever the name is registered, regardless of that
  // child's own colour flag: HealthNumber has no colour control (the game
  // colours it by health) but its raw fgcolor_override is still reported
  // here, as this did before the image/label split. A name outside the
  // registry (cardChild takes any node the file has, not only registered
  // ones) now always reports no colour, unlike before the split, when it
  // read raw fgcolor_override off whatever node it found; nothing in this
  // codebase passes such a name in today, so nothing depends on that.
  const raw = def ? kvGet(n, colourKey(def)) : undefined;
  return {
    x: num(kvGet(n, 'xpos')) + shift.x, y: num(kvGet(n, 'ypos')) + shift.y,
    w: num(kvGet(n, 'wide')), h: num(kvGet(n, 'tall')),
    visible: (kvGet(n, 'visible') ?? '1') !== '0',
    ...(Number.isFinite(tall) ? { fontTall: tall } : {}),
    ...(raw && /^\d+ \d+ \d+ \d+$/.test(raw) ? { color: raw } : {}),
  };
}

/**
 * Whether the base has what the editor needs to offer an element: its
 * hudlayout.res panel and, for the survivor team, all four TeamPlayerN
 * cards. Always true on Stock and Modern. The crosshair is always offered:
 * layoutPass adds its panel whenever the design has one.
 */
export function baseHasElement(key: BaseKey, el: HudElement): boolean {
  if (el.id === 'xhair') return true;
  if (!kvFind(baseTree(key, LAYOUT), [el.key])) return false;
  if (!el.team?.file) return true;
  const team = baseTree(key, el.team.file);
  return [1, 2, 3, 4].every((n) => kvFind(team, [`TeamPlayer${n}`]) !== undefined);
}

/** Whether an imported HUD's own hudlayout.res has an xHair element: a HUD made to show a crosshair addon's texture. */
export function importedHasXhair(key: BaseKey): boolean {
  return kvFind(baseTree(key, LAYOUT), ['xHair']) !== undefined;
}

/** Whether the base's own card file has this child: an addable child it lacks shows as a checkbox. */
export function baseHasChild(key: BaseKey, name: string): boolean {
  return kvFind(baseTree(key, CARD), [name]) !== undefined;
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
  if (!el.team?.file) {
    const dir = el.team?.dirs[0] ?? 'row';
    let baseSpacing: number | undefined;
    if (el.team?.spacingKey) {
      const panel = layoutPanel();
      const v = panel ? kvGet(panel, el.team.spacingKey) : undefined;
      if (v !== undefined) { const n = parseFloat(v); if (!Number.isNaN(n)) baseSpacing = n; }
    }
    return { dir, spacing: Math.round(o?.spacing ?? (baseSpacing ?? (dir === 'row' ? 140 : 45)) * k) };
  }
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
    if (!team.file || !t.card || !t.container || !t.cards) continue;
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
    // The card background is a child fitPass injects: a flat one is a plain
    // fillcolor and needs no texture, and one fitPass did not inject (an
    // Image style with no upload) has nothing to point at.
    if (slot.id === 'panelBg') { const bg = cardBackground(design); if (!bg || 'fill' in bg) continue; }
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
 * pump shotgun; icon_equip_machinegun is the hunting rifle. The flashlight
 * cells are not the weapon selection's and are left alone.
 */
export const WEAPON_BOX_ENTRY = { boxActive: 'rounded_background_glow', boxInactive: 'rounded_background_noborder' } as const;
export const WEAPON_ICONS = ['icon_equip_pumpshotgun', 'icon_equip_uzi', 'icon_equip_autoshotgun', 'icon_equip_rifle',
  'icon_equip_machinegun', 'icon_equip_dualpistols', 'icon_equip_pistol'];
export const ITEM_ICONS = ['icon_equip_molotov', 'icon_equip_pipebomb', 'icon_equip_medkit', 'icon_equip_pills'];
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
function weaponsPass(work: Work, design: HudDesign, out: VpkFile[]) {
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

  const repoint: [string, string][] = [];
  for (const box of ['boxActive', 'boxInactive'] as const) {
    const s = w[box];
    if (!s) continue;
    if (s.kind === 'hidden') { repoint.push([WEAPON_BOX_ENTRY[box], CLEAR_TEXTURE]); continue; }
    const colour = s.color ?? WEAPON_BOX_COLOUR[box];
    const rgba = s.kind === 'rounded' ? roundedTexture(BOX_TEXELS, BOX_TEXELS, colour, BOX_CORNER) : flatTexture(BOX_TEXELS, BOX_TEXELS, colour);
    const name = weaponBoxTexture(box);
    out.push({ path: `materials/${name}.vtf`, data: encodeVTF(BOX_TEXELS, BOX_TEXELS, rgba) }, { path: `materials/${name}.vmt`, data: enc(vmtFor(name)) });
    repoint.push([WEAPON_BOX_ENTRY[box], name]);
  }
  if (w.weaponIcons === false) for (const n of WEAPON_ICONS) repoint.push([n, CLEAR_TEXTURE]);
  if (w.itemIcons === false) for (const n of ITEM_ICONS) repoint.push([n, CLEAR_TEXTURE]);
  if (!repoint.length) return;
  const cells = work.panel(MODTEX, ['TextureData']);
  for (const [entry, file] of repoint) {
    const e = kvFind(cells.value as KvNode[], [entry]);
    if (!e) { if (work.imported) continue; throw new Error(`${MODTEX}: no ${entry}`); }
    kvSet(e, 'file', file);
  }
  if (repoint.some(([, file]) => file === CLEAR_TEXTURE)) {
    out.push({ path: `materials/${CLEAR_TEXTURE}.vtf`, data: encodeVTF(CLEAR_TEXELS, CLEAR_TEXELS, new Uint8ClampedArray(CLEAR_TEXELS * CLEAR_TEXELS * 4)) },
      { path: `materials/${CLEAR_TEXTURE}.vmt`, data: enc(vmtFor(CLEAR_TEXTURE)) });
  }
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
 */
export function buildHud(design: HudDesign, assets: BuildAssets = {}, report?: BuildReport): VpkFile[] {
  const key = baseOf(design);
  const work = new Work(key);
  const extra: VpkFile[] = [];
  layoutPass(work, design);
  weaponsPass(work, design, extra);
  childPass(work, design);
  fitPass(work, design);
  hidePass(work, design);
  teamPass(work, design);
  scalePass(work, design);
  fontPass(work, design, assets, extra);
  stylePass(work, design, assets, extra);
  crosshairPass(design, assets, extra);
  const edited = work.files();
  const layer = importedFiles(key);
  if (!layer) return [...edited, ...extra, { path: 'addoninfo.txt', data: enc(addonInfo(design.name)) }];
  // An imported HUD: every file of the upload, then the edited files over
  // them, then the generated ones (a font copy, a texture, the crosshair),
  // which replace an upload file at the same path and are reported. The
  // upload's own addoninfo.txt is kept; one without gets the editor's. A
  // community HUD always gets the editor's: the allowlist refuses the
  // author's, so one found in the layer came from somewhere else.
  const community = isCommunityImport(key);
  const out = new Map<string, Uint8Array>(layer);
  for (const f of edited) out.set(f.path, f.data);
  const replaced = new Set<string>();
  for (const f of extra) { if (layer.has(f.path)) replaced.add(f.path); out.set(f.path, f.data); }
  if (community || !out.has('addoninfo.txt')) out.set('addoninfo.txt', enc(addonInfo(design.name)));
  if (report) report.replaced = [...replaced].sort();
  // A community HUD was checked against the allowlist on the way in; this is
  // the last line, so a generated path or a stale store can never put, say,
  // a cfg/ file into someone else's game. addoninfo.txt is the editor's own.
  // The contents are checked again too: the files the editor rewrote went
  // through its own KeyValues reader, which need not agree with the check
  // (or the game) about where a comment starts, so a key the upload had
  // commented out could come back live.
  if (community) {
    const bad = [...out.keys()].find((p) => p !== 'addoninfo.txt' && hudPathProblem(p) !== null);
    if (bad) throw new Error(`This community HUD would ship a file outside the HUD folders: ${bad}`);
    for (const [path, data] of out) {
      if (path === 'addoninfo.txt') continue;
      const problem = hudFileProblem(path, data);
      if (problem) throw new Error(`This community HUD would ship a file that is not allowed: ${problem}`);
    }
  }
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
 * pixels. buildHud still runs every pass.
 */
const BUILD_TREES = new WeakMap<HudDesign, Work>();

export function buildTrees(design: HudDesign): (path: string) => KvNode[] {
  let work = BUILD_TREES.get(design);
  if (!work) {
    work = new Work(baseOf(design));
    const discard: VpkFile[] = [];
    layoutPass(work, design);
    weaponsPass(work, design, discard);
    childPass(work, design);
    fitPass(work, design);
    hidePass(work, design);
    teamPass(work, design);
    scalePass(work, design);
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
  const panel = work.panel(LAYOUT, [el.key]);
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
  return { x: parsePos(xTok, screenW(aspect)), y: parsePos(yTok, SCREEN_H), w: box.w, h: box.h, visible };
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
