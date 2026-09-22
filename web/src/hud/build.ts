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
import type { HudDesign, ElementOverride } from './design';

/** Uploaded images and fonts, already decoded, keyed by slot id. Tasks 8 and 9 read these; Task 7 does not. */
export interface BuildAssets { fonts?: { regular: Uint8Array; bold: Uint8Array }; images?: Record<string, Uint8ClampedArray> }

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);   // latin-1, as the game reads it
const LAYOUT = 'scripts/hudlayout.res';
const ANIMS = 'scripts/hudanimations.txt';
const SCHEME = 'resource/clientscheme.res';
const CHATSCHEME = 'resource/chatscheme.res';
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

export interface TeamLayout {
  dir: 'row' | 'column';
  /**
   * Units between two neighbouring cards, the element's own scale already
   * applied: the exact number `teamPass` writes into the file, and the exact
   * number the canvas steps each card by.
   */
  spacing: number;
  /**
   * One teammate card, and the container that has to cover four of them, both
   * with the scale already applied. Present only when `teamWrites` is true,
   * because these are the values `teamPass` writes; an element whose team
   * geometry the generator is not rewriting has no such promise to keep, and
   * the preview falls back to the registry's `mockSize`. An element with no
   * per-player file (the infected row, whose cards the game places itself)
   * never has them.
   */
  card?: { w: number; h: number };
  container?: { w: number; h: number };
}

/**
 * Does the generator's team pass rewrite this element's team geometry? A
 * direction, a spacing or a scale all make it do so, and nothing else does.
 * `teamPass` and `elementRect` both ask, which is what stops the canvas
 * reporting a container size the file contradicts.
 */
function teamWrites(el: HudElement, o: ElementOverride | undefined): boolean {
  if (!el.team || !o) return false;
  const scaled = el.resize === 'scale' && o.scale !== undefined && o.scale !== 1;
  return o.dir !== undefined || o.spacing !== undefined || scaled;
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
 * exactly these numbers, `elementRect` reports exactly this container and
 * `mock.ts` draws exactly these cards, so the three cannot drift apart.
 *
 * An explicit `dir`/`spacing` in the design wins outright, and a spacing the
 * player typed is taken as final units (what they typed is what they see and
 * what the file gets), not as something to scale again. Failing that: for an
 * element with a `team.file` (the survivor team), direction comes from
 * whether the base file's TeamPlayer1 and TeamPlayer2 share a ypos, and
 * spacing is the real delta between them along whichever axis that direction
 * implies, both read straight out of that preset's real file and then scaled.
 * For an element with only a `spacingKey` and no `team.file` (the infected
 * row, whose players the game positions itself, so there is no per-player
 * panel to read), spacing comes from that key's own value on the element's
 * hudlayout.res panel, and direction is simply the element's first supported
 * direction. A hardcoded constant is a last resort for when a base file
 * yields nothing usable; it is unreachable for both team elements the HUD
 * actually ships.
 */
export function teamLayout(design: HudDesign, el: HudElement): TeamLayout {
  const o = design.elements[el.id];
  const k = el.resize === 'scale' ? o?.scale ?? 1 : 1;
  // Parsed on demand: the survivor team needs it only to size its container,
  // and this runs on every canvas repaint.
  const layoutPanel = () => kvFind(parseKv(baseFile(design.preset, LAYOUT))[0].value as KvNode[], [el.key]);
  let baseDir: 'row' | 'column' | undefined;
  let baseSpacing: number | undefined;
  let card: { w: number; h: number } | undefined;
  if (el.team?.file) {
    const tree = parseKv(baseFile(design.preset, el.team.file))[0].value as KvNode[];
    const first = kvFind(tree, ['TeamPlayer1']);
    const second = kvFind(tree, ['TeamPlayer2']);
    if (first) {
      const cw = parseFloat(kvGet(first, 'wide') ?? ''), ch = parseFloat(kvGet(first, 'tall') ?? '');
      card = { w: (Number.isFinite(cw) ? cw : 150) * k, h: (Number.isFinite(ch) ? ch : 150) * k };
    }
    if (first && second) {
      baseDir = (kvGet(second, 'ypos') ?? '0') === (kvGet(first, 'ypos') ?? '0') ? 'row' : 'column';
      const axis = baseDir === 'row' ? 'xpos' : 'ypos';
      const a = parseFloat(kvGet(first, axis) ?? ''), b = parseFloat(kvGet(second, axis) ?? '');
      if (!Number.isNaN(a) && !Number.isNaN(b)) baseSpacing = Math.abs(b - a);
    }
  } else if (el.team?.spacingKey) {
    baseDir = el.team.dirs[0];
    const panel = layoutPanel();
    const v = panel ? kvGet(panel, el.team.spacingKey) : undefined;
    if (v !== undefined) { const n = parseFloat(v); if (!Number.isNaN(n)) baseSpacing = n; }
  }
  const dir = o?.dir ?? baseDir ?? 'row';
  const spacing = Math.round(o?.spacing ?? (baseSpacing ?? (dir === 'row' ? 140 : 45)) * k);
  const out: TeamLayout = { dir, spacing };
  if (!card || !teamWrites(el, o)) return out;
  const panel = layoutPanel();
  if (!panel) return out;
  out.card = card;
  // The container clips its children, so along the direction it has to cover
  // all four cards. Across the direction it keeps its own size, scaled; a
  // fill token has no fixed size, and teamPass replaces it with one card's
  // width rather than leave a column loose across the whole screen.
  const tall = kvGet(panel, 'tall') ?? '0';
  out.container = dir === 'column'
    ? { w: fixedExtent(kvGet(panel, 'wide'), k) ?? card.w, h: spacing * 3 + card.h }
    : { w: spacing * 3 + card.w, h: fixedExtent(tall, k) ?? parseSize(tall, SCREEN_H) };
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
    if (!team.file || !t.card || !t.container) continue;
    for (let n = 1; n <= 4; n++) {
      const p = work.panel(team.file, [`TeamPlayer${n}`]);
      kvSet(p, 'xpos', String(t.dir === 'row' ? t.spacing * (n - 1) : 0));
      kvSet(p, 'ypos', String(t.dir === 'row' ? 0 : t.spacing * (n - 1)));
      kvSet(p, 'wide', String(Math.round(t.card.w)));
      kvSet(p, 'tall', String(Math.round(t.card.h)));
    }
    kvSet(container, 'wide', String(Math.round(t.container.w)));
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

function scalePass(work: Work, design: HudDesign) {
  // One map for the whole pass, keyed by the scaled entry's own name: two
  // elements scaled to the same rounded percent that share a font would
  // otherwise each push their own HudEd_<font>_<tag> block, a duplicate key
  // in a shipped file.
  const renamed = new Map<string, string | null>();      // scaled entry name -> that name, or null when the scheme lacks the font
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
    // element whose children reference no font at all must leave
    // clientscheme.res completely alone rather than pull it into the
    // working set only to re-serialise it unchanged (dropping its comments).
    if (fontLeaves.length === 0) continue;
    // Second walk: for every font leaf collected above, look it up in the
    // scheme once per distinct name (a font can be used by more than one
    // leaf, in more than one file) and rename the leaf only once that
    // lookup has succeeded and a scaled entry exists to point at.
    const schemeFonts = work.panel(SCHEME, ['Fonts']);
    for (const leaf of fontLeaves) {
      const name = leaf.value as string;
      const newName = `HudEd_${name}_${tag}`;
      if (!renamed.has(newName)) {
        const src = kvFind(schemeFonts.value as KvNode[], [name]);
        if (!src) {
          renamed.set(newName, null);                    // an icon font the scheme defines elsewhere: leave it alone
        } else {
          const copy = structuredClone(src);
          copy.key = newName;
          for (const size of copy.value as KvNode[]) {
            if (typeof size.value === 'string') continue;
            const tall = kvGet(size, 'tall');
            if (tall !== undefined) kvSet(size, 'tall', String(Math.round(parseFloat(tall) * k)));
          }
          (schemeFonts.value as KvNode[]).push(copy);
          renamed.set(newName, newName);
        }
      }
      if (renamed.get(newName)) leaf.value = newName;
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
 * no `targets` (the health bar fills, which the game code names directly).
 */
function stylePass(work: Work, design: HudDesign, assets: BuildAssets, out: VpkFile[]) {
  for (const slot of SLOTS) {
    const s = design.styles[slot.id];
    if (!s || s.kind === 'stock') continue;
    if (slot.advancedOnly && !design.advanced) continue;
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
 * The pass order is not load bearing anywhere here.
 *
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
  // Once teamPass has written a concrete container, that is the container the
  // player's game will have, so the preview reports it rather than the
  // registry's mockSize. mockSize stands in only while the file is untouched
  // and the real container is wider than anything it shows.
  const box = (el.team ? teamLayout(design, el).container : undefined) ?? { w: p.w * k, h: p.h * k };
  return { x: parsePos(xTok, screenW(aspect)), y: parsePos(yTok, SCREEN_H), w: box.w, h: box.h, visible };
}
