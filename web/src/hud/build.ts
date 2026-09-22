/**
 * HudDesign in, addon files out.
 *
 * Every file is a real base file with a few values changed. `Work` parses a
 * file the first time a pass asks for it and remembers that it was touched;
 * at the end only touched files, plus the files the preset itself overrides,
 * are written. An untouched stock file is never shipped, because the game
 * already has it and shipping it would only widen what this addon can break.
 */
import type { VpkFile } from '../vpk';
import { baseFile, presetOverrides, BASE_PATHS, type Preset } from './base';
import { parseKv, writeKv, kvFind, kvGet, kvSet, type KvNode } from './kv';
import { parsePos, parseSize, formatPos, scaleToken, screenW, SCREEN_H, type Aspect } from './units';
import { ELEMENTS, elementById, type HudElement } from './elements';
import type { HudDesign, ElementOverride } from './design';

/** Uploaded images and fonts, already decoded, keyed by slot id. Tasks 8 and 9 read these; Task 7 does not. */
export interface BuildAssets { fonts?: { regular: Uint8Array; bold: Uint8Array }; images?: Record<string, Uint8ClampedArray> }

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);   // latin-1, as the game reads it
const LAYOUT = 'scripts/hudlayout.res';
const ANIMS = 'scripts/hudanimations.txt';
const SCHEME = 'resource/clientscheme.res';
const POSITIONAL = ['xpos', 'ypos', 'wide', 'tall'];

class Work {
  private trees = new Map<string, KvNode[]>();
  private texts = new Map<string, string>();
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

export interface TeamLayout { dir: 'row' | 'column'; spacing: number }

/**
 * The direction and per-card spacing a team element will actually use: the
 * design's own override where it set one, otherwise whatever the base file's
 * real TeamPlayer1/TeamPlayer2 panels already lay out (row for the stock
 * team files, column for the modern preset's). Both the generator's team
 * pass and the canvas preview call this, so the preview can never disagree
 * with the file the generator writes.
 */
export function teamLayout(design: HudDesign, el: HudElement): TeamLayout {
  const o = design.elements[el.id];
  let wasRow = true;
  if (el.team?.file) {
    const tree = parseKv(baseFile(design.preset, el.team.file))[0].value as KvNode[];
    const first = kvFind(tree, ['TeamPlayer1']);
    const second = kvFind(tree, ['TeamPlayer2']);
    if (first && second) wasRow = (kvGet(second, 'ypos') ?? '0') === (kvGet(first, 'ypos') ?? '0');
  }
  const dir = o?.dir ?? (wasRow ? 'row' : 'column');
  const spacing = Math.round(o?.spacing ?? (dir === 'row' ? 140 : 45));
  return { dir, spacing };
}

function teamPass(work: Work, design: HudDesign) {
  for (const el of ELEMENTS) {
    const o = design.elements[el.id];
    if (!el.team || !o) continue;
    if (el.team.spacingKey && o.spacing !== undefined) {
      kvSet(work.panel(LAYOUT, [el.key]), el.team.spacingKey, String(Math.round(o.spacing)));
    }
    if (!el.team.file || (o.dir === undefined && o.spacing === undefined)) continue;
    const { dir, spacing: gap } = teamLayout(design, el);
    const first = work.panel(el.team.file, ['TeamPlayer1']);
    const pw = parseFloat(kvGet(first, 'wide') ?? '150'), ph = parseFloat(kvGet(first, 'tall') ?? '150');
    for (let n = 1; n <= 4; n++) {
      const p = work.panel(el.team.file, [`TeamPlayer${n}`]);
      kvSet(p, 'xpos', String(dir === 'row' ? gap * (n - 1) : 0));
      kvSet(p, 'ypos', String(dir === 'row' ? 0 : gap * (n - 1)));
    }
    // The container clips its children, so it has to cover the last panel.
    const container = work.panel(LAYOUT, [el.key]);
    if (dir === 'column') {
      kvSet(container, 'tall', String(Math.round(gap * 3 + ph)));
      if ((kvGet(container, 'wide') ?? '').toLowerCase().startsWith('f')) kvSet(container, 'wide', String(Math.round(pw)));
    } else {
      kvSet(container, 'wide', String(Math.round(gap * 3 + pw)));
    }
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

function scalePass(work: Work, design: HudDesign) {
  for (const el of ELEMENTS) {
    const k = design.elements[el.id]?.scale;
    if (el.resize !== 'scale' || k === undefined || k === 1) continue;
    const tag = String(Math.round(k * 100));
    const fontLeaves: KvNode[] = [];
    const container = work.panel(LAYOUT, [el.key]);
    for (const key of ['wide', 'tall']) { const v = kvGet(container, key); if (v !== undefined) kvSet(container, key, scaleToken(v, k)); }
    for (const file of [...el.children, ...(el.team?.file ? [el.team.file] : [])]) scaleBlock(work.tree(file), k, fontLeaves);
    if (el.team?.spacingKey) {
      const v = kvGet(container, el.team.spacingKey);
      if (v !== undefined) kvSet(container, el.team.spacingKey, scaleToken(v, k));
    }
    // Second walk: for every font leaf collected above, look it up in the
    // scheme once per distinct name (a font can be used by more than one
    // leaf, in more than one file) and rename the leaf only once that
    // lookup has succeeded and a scaled entry exists to point at.
    const schemeFonts = work.panel(SCHEME, ['Fonts']);
    const renamed = new Map<string, string | null>();   // base font name -> new name, or null when the scheme lacks it
    for (const leaf of fontLeaves) {
      const name = leaf.value as string;
      if (!renamed.has(name)) {
        const src = kvFind(schemeFonts.value as KvNode[], [name]);
        if (!src) {
          renamed.set(name, null);                       // an icon font the scheme defines elsewhere: leave it alone
        } else {
          const newName = `HudEd_${name}_${tag}`;
          const copy = structuredClone(src);
          copy.key = newName;
          for (const size of copy.value as KvNode[]) {
            if (typeof size.value === 'string') continue;
            const tall = kvGet(size, 'tall');
            if (tall !== undefined) kvSet(size, 'tall', String(Math.round(parseFloat(tall) * k)));
          }
          (schemeFonts.value as KvNode[]).push(copy);
          renamed.set(name, newName);
        }
      }
      const newName = renamed.get(name);
      if (newName) leaf.value = newName;
    }
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
    rename(work.tree(SCHEME));
  }
  // VPK lookups from an addon are case sensitive. The modern preset's own
  // clientscheme.res already names these fonts, but with capitals, so its
  // CustomFontFiles entries need the same lower-case fix as the stock preset.
  const custom = work.panel(SCHEME, ['CustomFontFiles']);
  kvSet(custom, '7', 'resource/robotocondensed-regular.ttf');
  kvSet(custom, '8', 'resource/robotocondensed-bold.ttf');
  out.push({ path: 'resource/robotocondensed-regular.ttf', data: assets.fonts.regular },
           { path: 'resource/robotocondensed-bold.ttf', data: assets.fonts.bold });
}

function addonInfo(name: string): string {
  return `"AddonInfo"\n{\n\taddonSteamAppID\t\t500\n\taddontitle\t\t"${name.replace(/"/g, '')}"\n\taddonversion\t\t1.0\n\taddontagline\t\t"Custom HUD (riversidepug.com)"\n\taddonauthor\t\t"HUD editor"\n\taddonDescription\t\t"Custom HUD layout."\n}\n`;
}

export function buildHud(design: HudDesign, assets: BuildAssets = {}): VpkFile[] {
  const work = new Work(design.preset);
  const extra: VpkFile[] = [];
  layoutPass(work, design);
  teamPass(work, design);
  scalePass(work, design);
  fontPass(work, design, assets, extra);
  return [...work.files(), ...extra, { path: 'addoninfo.txt', data: enc(addonInfo(design.name)) }];
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
  const moved = el.move && (o.x !== undefined || o.y !== undefined);
  const xTok = el.mockPos?.x ?? (moved ? p.xpos : kvGet(panel, 'xpos') ?? '0');
  const yTok = el.mockPos?.y ?? (moved ? p.ypos : kvGet(panel, 'ypos') ?? '0');
  return { x: parsePos(xTok, screenW(aspect)), y: parsePos(yTok, SCREEN_H), w: p.w * k, h: p.h * k, visible };
}
