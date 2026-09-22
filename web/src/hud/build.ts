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
import { parsePos, parseSize, formatPos, screenW, SCREEN_H, type Aspect } from './units';
import { ELEMENTS, elementById, type HudElement } from './elements';
import type { HudDesign, ElementOverride } from './design';

/** Uploaded images and fonts, already decoded, keyed by slot id. Tasks 8 and 9 read these; Task 7 does not. */
export interface BuildAssets { fonts?: { regular: Uint8Array; bold: Uint8Array }; images?: Record<string, Uint8ClampedArray> }

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);   // latin-1, as the game reads it
const LAYOUT = 'scripts/hudlayout.res';
const ANIMS = 'scripts/hudanimations.txt';

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

function addonInfo(name: string): string {
  return `"AddonInfo"\n{\n\taddonSteamAppID\t\t500\n\taddontitle\t\t"${name.replace(/"/g, '')}"\n\taddonversion\t\t1.0\n\taddontagline\t\t"Custom HUD (riversidepug.com)"\n\taddonauthor\t\t"HUD editor"\n\taddonDescription\t\t"Custom HUD layout."\n}\n`;
}

export function buildHud(design: HudDesign, assets: BuildAssets = {}): VpkFile[] {
  const work = new Work(design.preset);
  layoutPass(work, design);
  return [...work.files(), { path: 'addoninfo.txt', data: enc(addonInfo(design.name)) }];
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
