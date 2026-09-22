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
import { baseFile, presetOverrides, BASE_PATHS, type Preset } from './base';
import { parseKv, writeKv, kvFind, kvGet, kvSet, type KvNode } from './kv';
import { parsePos, parseSize, formatPos, scaleToken, screenW, SCREEN_H, type Aspect } from './units';
import { ELEMENTS, elementById, type HudElement } from './elements';
import { SLOTS } from './slots';
import { flatTexture, roundedTexture, vmtFor } from './textures';
import { baseTeam, contentBox, type Box, type HudDesign, type ElementOverride, type ChildOverride, type TeamDir } from './design';
import { panelChildren, TEAM_PANEL, type ChildDef } from './children';

/** Uploaded images and fonts, already decoded, keyed by slot id. Tasks 8 and 9 read these; Task 7 does not. */
export interface BuildAssets { fonts?: { regular: Uint8Array; bold: Uint8Array }; images?: Record<string, Uint8ClampedArray> }

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);   // latin-1, as the game reads it
const LAYOUT = 'scripts/hudlayout.res';
const ANIMS = 'scripts/hudanimations.txt';
const SCHEME = 'resource/clientscheme.res';
const CHATSCHEME = 'resource/chatscheme.res';
const CARD = TEAM_PANEL.file;
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
  constructor(readonly preset: Preset) {}
  /** The children of the file's single root block. */
  tree(path: string): KvNode[] {
    let t = this.trees.get(path);
    if (!t) {
      try { t = parseKv(baseFile(this.preset, path)); }
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
  text(path: string): string { return this.texts.get(path) ?? baseFile(this.preset, path); }
  setText(path: string, s: string) { this.texts.set(path, s); }
  files(): VpkFile[] {
    const out: VpkFile[] = [];
    const paths = new Set([...this.trees.keys(), ...this.texts.keys(), ...BASE_PATHS.filter((p) => presetOverrides(this.preset, p))]);
    for (const path of [...paths].sort()) {
      if (this.texts.has(path) || path === ANIMS) { out.push({ path, data: enc(this.text(path)) }); continue; }
      this.tree(path);
      out.push({ path, data: enc(writeKv(this.trees.get(path)!)) });
    }
    return out;
  }
}

const XHAIR: KvNode = { key: 'xHair', value: [
  ['ControlName', 'ImagePanel'], ['fieldName', 'xHair'], ['xpos', 'c-13'], ['ypos', 'c-13'], ['zpos', '-2'],
  ['wide', '26'], ['tall', '26'], ['visible', '1'], ['enabled', '1'], ['image', 'hud/altcrosshair'], ['scaleImage', '1'],
].map(([key, value]) => ({ key, value })) };

function baseRect(panel: KvNode, el: HudElement, preset: Preset, aspect: Aspect) {
  const W = screenW(aspect);
  const w = el.mockSize?.[preset]?.w ?? parseSize(kvGet(panel, 'wide') ?? '0', W);
  const h = el.mockSize?.[preset]?.h ?? parseSize(kvGet(panel, 'tall') ?? '0', SCREEN_H);
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
  if (design.xhair && !has) layout.unshift(structuredClone(XHAIR));
  if (!design.xhair && has) layout.splice(layout.indexOf(has), 1);

  // Probe T2: the engine crosshair honours never_draw, so a player with an
  // image crosshair can hide the game's own one underneath it.
  if (design.hideGameCrosshair) kvSet(work.panel(LAYOUT, ['HudCrosshair']), 'never_draw', '1');

  for (const el of ELEMENTS) {
    const o = design.elements[el.id];
    if (!o || el.id === 'xhair') continue;
    const panel = work.panel(LAYOUT, [el.key]);
    if (o.visible !== undefined) kvSet(panel, 'visible', o.visible ? '1' : '0');
    const moved = el.move && (o.x !== undefined || o.y !== undefined);
    const sized = el.resize === 'free' && (o.w !== undefined || o.h !== undefined);
    if (!moved && !sized) continue;
    const p = placed(o, baseRect(panel, el, work.preset, design.aspect), el, design.aspect);
    if (moved) { kvSet(panel, 'xpos', p.xpos); kvSet(panel, 'ypos', p.ypos); }
    if (sized) { kvSet(panel, 'wide', String(Math.round(p.w))); kvSet(panel, 'tall', String(Math.round(p.h))); }
    if (el.id === 'chat' && moved) {
      // Three animation events hard-code the chat position and would snap a moved chat box back.
      work.setText(ANIMS, work.text(ANIMS).replace(/(Animate\s+HudChat\s+Position\s+")[^"]*(")/g, `$1${p.xpos} ${p.ypos}$2`));
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
          if (at < 0) throw new Error(`${panel.file}: no ${def.addable.after} to add ${name} after`);
          block = structuredClone(def.addable.template);
          nodes.splice(at + 1, 0, block);
        }
        if (!block) continue;
      }
      if (!block) throw new Error(`${panel.file}: no child ${name}`);
      applyChild(work, panel.file, def, block, o);
    }
  }
}

function applyChild(work: Work, file: string, def: ChildDef, block: KvNode, o: ChildOverride) {
  if (o.color !== undefined && !def.colour) throw new Error(`${file}: ${def.name} takes no colour`);
  if (o.fontSize !== undefined && !def.font) throw new Error(`${file}: ${def.name} takes no text size`);
  if ((o.w !== undefined || o.h !== undefined) && def.box === 'none') throw new Error(`${file}: ${def.name} takes no size`);
  if ((o.x !== undefined || o.y !== undefined) && !def.move) throw new Error(`${file}: ${def.name} cannot move`);
  if (o.visible !== undefined) kvSet(block, 'visible', o.visible ? '1' : '0');
  const set = (key: string, v: number | undefined) => { if (v !== undefined) kvSet(block, key, String(Math.round(v))); };
  set('xpos', o.x); set('ypos', o.y); set('wide', o.w); set('tall', o.h);
  if (o.color !== undefined) kvSet(block, 'fgcolor_override', o.color);
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
 * aspect rule). Incapacitated and Dead become squares of the card height at
 * the Head's x and y 0; Voice a square of min(height, 16) at the right edge;
 * the splatter keeps its 2:1 shape at the card width, clipped by the card.
 * Modern's ModBg, the fill that paints its whole card, covers the fitted
 * card exactly, so a card that grew past the file's still has a background
 * all the way across. A state picture the player moved or sized keeps those
 * fields, which childPass already wrote and the shift already moved into the
 * fitted frame.
 */
function fitStateArt(nodes: KvNode[], edits: Record<string, ChildOverride>, card: { w: number; h: number }) {
  const at = (name: string) => kvFind(nodes, [name]);
  const head = at('Head');
  const headX = head ? num(kvGet(head, 'xpos')) : 0;
  const place = (name: string, side: number, x: number) => {
    const n = at(name);
    if (!n) return;
    const e = edits[name] ?? {};
    const s = String(Math.round(e.w ?? side));
    kvSet(n, 'wide', s); kvSet(n, 'tall', s);
    if (e.x === undefined) kvSet(n, 'xpos', String(x));
    if (e.y === undefined) kvSet(n, 'ypos', '0');
  };
  place('Incapacitated', card.h, headX);
  place('Dead', card.h, headX);
  const voice = Math.min(card.h, 16);
  place('Voice', voice, card.w - (edits.Voice?.w ?? voice));
  const splatter = at('BackgroundImage');
  if (splatter) {
    kvSet(splatter, 'xpos', '0'); kvSet(splatter, 'ypos', '0');
    kvSet(splatter, 'wide', String(card.w)); kvSet(splatter, 'tall', String(Math.round(card.w / 2)));
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
  let size = baseTeam(design.preset).card;
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
 * childPass then fitPass on a scratch Work, once per design object, with the
 * content box taken between the two. teamLayout asks for the fitted size on
 * every repaint and the side panel for a child's numbers, and both must be
 * the build's own numbers.
 */
const CARD_WORK = new WeakMap<HudDesign, { work: Work; box: Box | null }>();
function cardWork(design: HudDesign) {
  let w = CARD_WORK.get(design);
  if (!w) {
    const work = new Work(design.preset);
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
  const raw = kvGet(n, 'fgcolor_override');
  return {
    x: num(kvGet(n, 'xpos')) + shift.x, y: num(kvGet(n, 'ypos')) + shift.y,
    w: num(kvGet(n, 'wide')), h: num(kvGet(n, 'tall')),
    visible: (kvGet(n, 'visible') ?? '1') !== '0',
    ...(Number.isFinite(tall) ? { fontTall: tall } : {}),
    ...(raw && /^\d+ \d+ \d+ \d+$/.test(raw) ? { color: raw } : {}),
  };
}

/** Whether the preset's own card file has this child: an addable child it lacks shows as a checkbox. */
export function baseHasChild(preset: Preset, name: string): boolean {
  return kvFind(parseKv(baseFile(preset, CARD))[0].value as KvNode[], [name]) !== undefined;
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
  // Parsed on demand: it is needed only to size a container, and this runs on every canvas repaint.
  const layoutPanel = () => kvFind(parseKv(baseFile(design.preset, LAYOUT))[0].value as KvNode[], [el.key]);
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
  const base = baseTeam(design.preset);
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
    if (!el.team || !teamWrites(el, o)) continue;
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
    if (el.resize !== 'scale' || k === undefined || k === 1) continue;
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
 * no `targets` (the weapon boxes and the state panels, which game code names directly).
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
    for (const t of slot.targets) kvSet(work.panel(t.file, t.path), t.key, `hud/hudeditor/${slot.id.toLowerCase()}`);
  }
}

function addonInfo(name: string): string {
  return `"AddonInfo"\n{\n\taddonSteamAppID\t\t500\n\taddontitle\t\t"${name.replace(/"/g, '')}"\n\taddonversion\t\t1.0\n\taddontagline\t\t"Custom HUD (riversidepug.com)"\n\taddonauthor\t\t"HUD editor"\n\taddonDescription\t\t"Custom HUD layout."\n}\n`;
}

/**
 * Where the pass order matters, and where it does not.
 *
 * - `childPass` runs after `layoutPass` and before `scalePass`: it writes the
 *   stored unscaled numbers and scalePass multiplies them with the rest of
 *   the card file. A HudEd_<font>_t<size> copy it makes is a font leaf that
 *   scalePass then clones again as HudEd_HudEd_<font>_t<size>_<pct>.
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
 */
export function buildHud(design: HudDesign, assets: BuildAssets = {}): VpkFile[] {
  const work = new Work(design.preset);
  const extra: VpkFile[] = [];
  layoutPass(work, design);
  childPass(work, design);
  fitPass(work, design);
  teamPass(work, design);
  scalePass(work, design);
  fontPass(work, design, assets, extra);
  stylePass(work, design, assets, extra);
  return [...work.files(), ...extra, { path: 'addoninfo.txt', data: enc(addonInfo(design.name)) }];
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
export function packHud(design: HudDesign, assets: BuildAssets = {}) {
  const vpk = encodeVPK(buildHud(design, assets));
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
 * the preview draws every label in Roboto Condensed regardless. buildHud is
 * unchanged and still runs all six passes.
 */
const BUILD_TREES = new WeakMap<HudDesign, Work>();

export function buildTrees(design: HudDesign): (path: string) => KvNode[] {
  let work = BUILD_TREES.get(design);
  if (!work) {
    work = new Work(design.preset);
    const discard: VpkFile[] = [];
    layoutPass(work, design);
    childPass(work, design);
    fitPass(work, design);
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
  const work = new Work(design.preset);
  const o = design.elements[id] ?? {};
  if (id === 'xhair') return { x: screenW(aspect) / 2 - 13, y: SCREEN_H / 2 - 13, w: 26, h: 26, visible: design.xhair };
  const panel = work.panel(LAYOUT, [el.key]);
  const base = baseRect(panel, el, design.preset, design.aspect);
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
