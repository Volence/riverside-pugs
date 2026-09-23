/**
 * A player's HUD design: a preset plus the few things they changed.
 *
 * Designs arrive from three places (localStorage, a share link someone pasted
 * in Discord, a .json file) and all three are untrusted, so everything goes
 * through validateDesign, which rebuilds the object field by field rather than
 * trusting its shape. It never throws: a bad field is dropped, a bad design
 * becomes the defaults.
 */
import { baseFile, baseOf, type Preset, type BaseKey } from './base';
import type { Aspect } from './units';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { elementById } from './elements';
import { SLOTS } from './slots';
import { TEAM_PANEL, CONTENT_CHILDREN, type ChildDef } from './children';
import { MAX_IMAGE_B64, MAX_IMAGE_SIDE } from './limits';
import { readArt, type CrosshairArt } from '../crosshair/model';

export type TeamDir = 'row' | 'column' | 'free';
/**
 * One Free teammate card's unfitted origin on screen, in units, like an
 * element's x/y: where the top-left of the file's full-size card sits. A
 * fitted card is drawn the fit offset in from it, so toggling fit leaves the
 * content where it was.
 */
export interface CardSlot { x: number; y: number }

export interface ElementOverride {
  visible?: boolean;
  x?: number; y?: number;
  w?: number; h?: number;
  scale?: number;
  /** 'free' is the survivor team's only; validateDesign keeps it only with four `slots`. */
  dir?: TeamDir;
  /**
   * The infected row's HorizPanelSpacing, final units. The survivor team used
   * this too before `gap`; validateDesign migrates it and never keeps it there.
   */
  spacing?: number;
  /** Survivor team, Row and Column: units between two cards at scale 1. */
  gap?: number;
  /** Survivor team: shrink the card to its content. Absent means off, so a saved design renders as it was. */
  fit?: boolean;
  /** Survivor team, Free: the four cards' positions. Kept when leaving Free, so coming back restores them. */
  slots?: CardSlot[];
  /**
   * Validated and reserved, not live. The spec's own HudDesign declares these
   * three, so they are validated and clamped here and a design that carries
   * them survives a round trip, but no pass in build.ts reads any of them and
   * no registry entry in elements.ts lists them as a prop, so no control
   * writes them either.
   */
  color?: string; bg?: string;
  fontSize?: number;
}
/**
 * One child of a card file (v2 spec, "The data model"). Numbers are unscaled,
 * in the card file's own unfitted frame: fitPass shifts them and the element's
 * scale multiplies them afterwards. Phase 1 accepts the teammate card only.
 */
export interface ChildOverride {
  visible?: boolean;
  x?: number; y?: number;
  w?: number; h?: number;
  /** Labels: the tall of a HudEd_<font>_t<size> copy of the label's font. */
  fontSize?: number;
  /** Labels: raw "r g b a", written as fgcolor_override. */
  color?: string;
  /** Addable children: present in the file or not. Absent means as the preset's file has it. */
  on?: boolean;
}
export interface StyleOverride { kind: 'stock' | 'flat' | 'rounded' | 'image'; color?: string }

/**
 * The weapon selection's boxes, the active slot's and the rest: as the game
 * draws them, not at all, or a generated flat or rounded texture in a colour.
 * Written by repointing mod_textures.txt's rounded_background_glow and
 * rounded_background_noborder, which works from a normal addon (probe B,
 * 2026-09-23). No 'stock' is ever stored: absent means stock.
 */
export interface WeaponBoxStyle { kind: 'hidden' | 'flat' | 'rounded'; color?: string }
/** Box colours when a flat or rounded box carries none: the old Advanced weapon box slots' defaults. */
export const WEAPON_BOX_COLOUR = { boxActive: '40 40 40 215', boxInactive: '0 0 0 130' } as const;

/**
 * The HudWeaponSelection keys the game's paint reads (weapons.ts's header,
 * from client.dll, and the owner's probes of 2026-09-23), one field each.
 * `size` fields are 0..200, `offset` fields -200..200, and `pull` -40..200:
 * PistolBoxTall may go below 0, because the game starts the pistol row two
 * 640-units under the gun's box whatever its size, and a negative pistol box
 * is the one key that lifts the row back onto the clip's line (the owner's
 * test 3, 2026-09-23; drawn with a hidden box, a negative one shows nothing).
 * The generator writes
 * each present field into that key; the preview reads the key back.
 */
export const WEAPON_KEYS = {
  primaryY: { key: 'PrimaryWeaponsYPos', range: 'offset' },
  indent: { key: 'RightSideIndent', range: 'offset' },
  primaryBoxW: { key: 'PrimaryWeaponBoxWide', range: 'size' },
  primaryBoxH: { key: 'PrimaryWeaponBoxTall', range: 'size' },
  pistolBoxW: { key: 'PistolBoxWide', range: 'size' },
  pistolBoxH: { key: 'PistolBoxTall', range: 'pull' },
  iconTall: { key: 'PrimaryWeaponTall', range: 'size' },
  itemSize: { key: 'IconSize', range: 'size' },
  ammoX: { key: 'PrimaryWeaponAmmoX', range: 'offset' },
  reserveY: { key: 'ReserveAmmoYPos', range: 'offset' },
} as const;
export type WeaponNumKey = keyof typeof WEAPON_KEYS;
const WEAPON_RANGES = { size: [0, 200], offset: [-200, 200], pull: [-40, 200], font: [6, 64] } as const;

/** The same clamp validateDesign applies, for the weapon number boxes and sliders. */
export function clampWeapon(key: WeaponNumKey | 'clipFont' | 'pistolFont', value: number): number {
  const [lo, hi] = WEAPON_RANGES[key === 'clipFont' || key === 'pistolFont' ? 'font' : WEAPON_KEYS[key].range];
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The player's weapon selection edits. Every field is optional and absent
 * means the preset's own value, so a design that never touched the weapons
 * builds exactly the files it did before.
 */
export type WeaponsOverride = { [K in WeaponNumKey]?: number } & {
  /** The clip number's size: a HudEd_ copy of PrimaryAmmoFont at this tall. */
  clipFont?: number;
  /** The reserve and pistol clip size: a HudEd_ copy of PistolAmmoFont (HudAmmo) at this tall. */
  pistolFont?: number;
  /** Raw "r g b a": ReserveAmmoColor and InactiveItemColor. */
  reserveColor?: string; inactiveColor?: string;
  boxActive?: WeaponBoxStyle; boxInactive?: WeaponBoxStyle;
  /** false hides the gun and pistol pictures; absent or true draws them. */
  weaponIcons?: boolean;
  /** false hides the throwable, medkit and pills pictures. */
  itemIcons?: boolean;
};
export interface UploadedImage { w: number; h: number; png: string }
/**
 * Where the crosshair comes from. 'bundle' (Custom, in the editor) ships the
 * xHair element plus the design's own `xhairArt` as its texture; 'none'
 * (Game default) ships no element, so the game's own crosshair is all there
 * is. 'addon' ships only the element, for a separate crosshair addon to
 * supply the texture: it is legacy, kept so a design saved with it builds
 * the same file, and offered only while a design has it.
 */
export type CrosshairChoice = 'bundle' | 'addon' | 'none';
/**
 * The imported HUD a design is built on: its content hash (upload.ts's
 * hudId) and the name the upload gave it. The files themselves are never in
 * the design, so a share link or an exported file carries only this, and
 * opens on another browser with the missing-import banner until the same
 * HUD is imported there.
 */
export interface ImportedRef { id: string; name: string }
export interface HudDesign {
  v: 1;
  name: string;
  preset: Preset;
  /** Only with preset 'imported': which import. validateDesign drops it anywhere else. */
  imported?: ImportedRef;
  advanced: boolean;
  aspect: Aspect;
  font: 'preset' | 'roboto';
  crosshair: CrosshairChoice;
  /**
   * The crosshair this HUD carries, built or an image: what a 'bundle'
   * draws and packs. Kept while the choice is something else, so going
   * back to Custom brings it back. A 'bundle' always has one (usableCrosshair).
   */
  xhairArt?: CrosshairArt;
  elements: Record<string, ElementOverride>;
  styles: Record<string, StyleOverride>;
  images: Record<string, UploadedImage>;
  /** panelId -> child name -> override. Only teamColumn in this phase. */
  children: Record<string, Record<string, ChildOverride>>;
  /** Write never_draw on HudCrosshair so an image crosshair can replace the game's own (probe T2). */
  hideGameCrosshair?: boolean;
  /** The weapon selection's own keys, boxes and icons. Absent means the preset's. */
  weapons?: WeaponsOverride;
}

/**
 * A new design, and what "Reset" returns an element to. The teammate card
 * starts fitted: a saved design without `fit` stays unfitted (validateDesign
 * never adds it), so only designs made from here on start with it.
 */
export const DEFAULT_DESIGN: HudDesign = {
  v: 1, name: 'my_hud', preset: 'stock', advanced: false, aspect: '16:9', font: 'preset',
  crosshair: 'none', elements: { teamColumn: { fit: true } }, styles: {}, images: {}, children: {},
};

/**
 * A design made from nothing. DEFAULT_DESIGN stays static; the crosshair
 * saved on the Crosshair page lives in this browser's storage, so the page
 * reads it and passes it in, and a new design carries a copy of it. From
 * then on the design is self-contained: a share link or an exported file
 * takes the crosshair with it.
 */
export function newDesign(saved: CrosshairArt | null): HudDesign {
  const d = structuredClone(DEFAULT_DESIGN);
  if (saved) { d.crosshair = 'bundle'; d.xhairArt = structuredClone(saved); }
  return d;
}

/**
 * A design the page can build: a 'bundle' needs a crosshair. A design
 * saved before the design carried its own (it bundled the Crosshair page's
 * saved one at download time) adopts the one saved in this browser, once,
 * since from then on it has its own. With nothing saved either it becomes
 * 'none', which ships no xHair element to show the missing-texture checker.
 * The page runs every design it takes in (storage, a share link, an
 * imported file) through this.
 */
export function usableCrosshair(d: HudDesign, saved: CrosshairArt | null): HudDesign {
  if (d.crosshair !== 'bundle' || d.xhairArt) return d;
  return saved ? { ...d, xhairArt: structuredClone(saved) } : { ...d, crosshair: 'none' };
}

const ID = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const COLOUR = /^(\d{1,3}) (\d{1,3}) (\d{1,3}) (\d{1,3})$/;

const RANGES = {
  x: [-200, 1000], y: [-200, 680], w: [4, 853], h: [4, 480],
  scale: [0.5, 2], spacing: [0, 400], gap: [0, 200], fontSize: [6, 64],
} as const;

export type RangeKey = keyof typeof RANGES;

/**
 * The one place that clamps an override number, shared by validateDesign
 * (on load, share-link decode and download) and the editor's number boxes.
 * Reusing RANGES here instead of a second table means a typed value can
 * never be drawn on the canvas unclamped while the downloaded file clamps
 * it: the box snaps to the same cap the file would have carried anyway.
 */
export function clampOverride(key: RangeKey, value: number): number {
  const [lo, hi] = RANGES[key];
  return Math.min(hi, Math.max(lo, value));
}

const CHILD_RANGES = { x: [-64, 512], y: [-64, 512], w: [1, 512], h: [1, 512], fontSize: [6, 64] } as const;
export type ChildRangeKey = keyof typeof CHILD_RANGES;

/** clampOverride's twin for a child's numbers, shared by validateDesign and the child number boxes for the same reason. */
export function clampChild(key: ChildRangeKey, value: number): number {
  const [lo, hi] = CHILD_RANGES[key];
  return Math.min(hi, Math.max(lo, value));
}

/**
 * One child override, rebuilt field by field from what its registry entry
 * offers: a colour on the health number, a size on the item icons or a text
 * size on the splatter is dropped here, so the build only ever sees edits it
 * can write. Square art keeps both sides equal, the smaller winning when a
 * hand-edited design disagrees.
 */
function childOverride(def: ChildDef, raw: unknown): ChildOverride {
  const out: ChildOverride = {};
  if (!isObj(raw)) return out;
  const n = (k: ChildRangeKey) => {
    const v = raw[k];
    return typeof v === 'number' && Number.isFinite(v) ? clampChild(k, v) : undefined;
  };
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  if (def.move) {
    const x = n('x'), y = n('y');
    if (x !== undefined) out.x = x;
    if (y !== undefined) out.y = y;
  }
  if (def.box === 'wh') {
    const w = n('w'), h = n('h');
    if (w !== undefined) out.w = w;
    if (h !== undefined) out.h = h;
  }
  if (def.box === 'square') {
    const w = n('w'), h = n('h');
    const side = w !== undefined && h !== undefined ? Math.min(w, h) : w ?? h;
    if (side !== undefined) { out.w = side; out.h = side; }
  }
  if (def.font) { const f = n('fontSize'); if (f !== undefined) out.fontSize = f; }
  if (def.colour) { const c = colour(raw.color); if (c) out.color = c; }
  if (def.addable && typeof raw.on === 'boolean') out.on = raw.on;
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
const colour = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const m = COLOUR.exec(v);
  return m && m.slice(1).every((n) => +n <= 255) ? v : undefined;
};

export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_ -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'my_hud';
}

/** A stored reference, or nothing: an id is exactly hudId's 64 lower-case hex characters. */
function importedRef(v: unknown): ImportedRef | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || !/^[0-9a-f]{64}$/.test(v.id) || typeof v.name !== 'string') return undefined;
  return { id: v.id, name: safeName(v.name) };
}

const TEAM_FILE = 'resource/ui/hud/teamdisplayhud.res';
export interface BaseTeam { dir: 'row' | 'column'; pitch: number; card: { w: number; h: number } }
const BASE_TEAMS = new Map<BaseKey, BaseTeam>();

/**
 * The survivor team as the preset's own teamdisplayhud.res lays it out: the
 * direction (a row when TeamPlayer1 and TeamPlayer2 share a ypos), the pitch
 * between their origins along it, and one card's size before any fit. Stock
 * is a row at pitch 140 of 150 x 150 cards, Modern a column at pitch 34 of
 * 120 x 34 cards. The spacing migration, the default gap and the child drag
 * clamp all start here, which is why it reads the real file, not constants.
 */
export function baseTeam(key: BaseKey): BaseTeam {
  const hit = BASE_TEAMS.get(key);
  if (hit) return hit;
  const tree = parseKv(baseFile(key, TEAM_FILE))[0].value as KvNode[];
  const first = kvFind(tree, ['TeamPlayer1']);
  const second = kvFind(tree, ['TeamPlayer2']);
  const n = (p: KvNode | undefined, key: string, d: number) => {
    const v = parseFloat((p && kvGet(p, key)) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const dir: 'row' | 'column' = first && second && (kvGet(second, 'ypos') ?? '0') !== (kvGet(first, 'ypos') ?? '0') ? 'column' : 'row';
  const axis = dir === 'row' ? 'xpos' : 'ypos';
  const pitch = Math.abs(n(second, axis, dir === 'row' ? 140 : 45) - n(first, axis, 0));
  const out: BaseTeam = { dir, pitch, card: { w: n(first, 'wide', 150), h: n(first, 'tall', 150) } };
  BASE_TEAMS.set(key, out);
  return out;
}

export interface Box { x: number; y: number; w: number; h: number }

/**
 * The teammate card's content: the union of the visible steady-state
 * children (Head, Health, Name, Items, and HealthNumber and Status when
 * present). State art and decoration never count. Null when every one is
 * hidden, which fitPass treats as "keep the file's card" rather than write a
 * 0 x 0 card. On stock this is x 13..134, y 36..72: 121 x 36. It lives here,
 * not in build.ts, because the spacing migration below needs the preset's
 * own fitted card too.
 */
export function contentBox(nodes: KvNode[]): Box | null {
  const content = new Set(CONTENT_CHILDREN.map((n) => n.toLowerCase()));
  const num = (v: string | undefined) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : 0; };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (typeof n.value === 'string' || !content.has(n.key.toLowerCase())) continue;
    if ((kvGet(n, 'visible') ?? '1') === '0') continue;
    const x = num(kvGet(n, 'xpos')), y = num(kvGet(n, 'ypos')), w = num(kvGet(n, 'wide')), h = num(kvGet(n, 'tall'));
    if (w <= 0 || h <= 0) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const BASE_CONTENT = new Map<BaseKey, Box | null>();
/** The base's own card, fitted with no inside edits: stock 121 x 36, Modern 113 x 26. */
export function baseContent(key: BaseKey): Box | null {
  if (!BASE_CONTENT.has(key)) {
    BASE_CONTENT.set(key, contentBox(parseKv(baseFile(key, TEAM_PANEL.file))[0].value as KvNode[]));
  }
  return BASE_CONTENT.get(key)!;
}

/** Four finite points, each clamped like an element's x/y, or nothing: a Free layout is all four cards or none. */
function cardSlots(v: unknown): CardSlot[] | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const out: CardSlot[] = [];
  for (const s of v) {
    if (!isObj(s) || typeof s.x !== 'number' || typeof s.y !== 'number' || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return undefined;
    out.push({ x: clampOverride('x', s.x), y: clampOverride('y', s.y) });
  }
  return out;
}

/**
 * The survivor team's own fields. `fit` is kept only as a real boolean, so a
 * design saved before fit existed stays unfitted. Free needs its four card
 * positions, so it survives only with them.
 *
 * A saved `spacing` (the old origin-to-origin pitch, final units) becomes the
 * `gap` that gives the same pitch: held to its old 0..400 first, divided by
 * the scale, minus the card along the direction. A gap cannot be negative,
 * so a design whose unfitted cards overlapped (stock's own row at 140, or a
 * column at 40 with 150-tall cards) is fitted instead and measured against
 * the fitted card: the fitted card sits the content box's offset in, so the
 * same pitch leaves every piece of content where it was (a column at 40
 * becomes gap 4 over a 36-tall card). A design already fitted is measured
 * against the fitted card the same way. Only a pitch tighter than even the
 * fitted card, or an overlap with fit explicitly off, is clamped at 0 and
 * moves.
 */
function teamFields(raw: Record<string, unknown>, out: ElementOverride, key: BaseKey) {
  if (typeof raw.fit === 'boolean') out.fit = raw.fit;
  const slots = cardSlots(raw.slots);
  if (slots) out.slots = slots;
  if (raw.dir === 'free' && slots) out.dir = 'free';
  // `spacing` is from before designs had `gap`, long before imports existed,
  // so an imported design never carries it: it is dropped rather than
  // migrated, which also keeps validation off the import's files, which may
  // not be loaded yet.
  if (!key.startsWith('imported:') && out.gap === undefined && typeof raw.spacing === 'number' && Number.isFinite(raw.spacing)) {
    const base = baseTeam(key);
    const dir = out.dir === 'row' || out.dir === 'column' ? out.dir : base.dir;
    const along = (c: { w: number; h: number }) => (dir === 'row' ? c.w : c.h);
    const pitch = clampOverride('spacing', raw.spacing) / (out.scale ?? 1);
    const fitted = baseContent(key);
    let gap = pitch - along(base.card);
    if (fitted && (out.fit === true || (out.fit === undefined && gap < 0))) {
      out.fit = true;
      gap = pitch - along(fitted);
    }
    out.gap = clampOverride('gap', gap);
  }
}

function element(id: string, raw: unknown, key: BaseKey): ElementOverride {
  const out: ElementOverride = {};
  if (!isObj(raw)) return out;
  const team = id === 'teamColumn';
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  for (const k of Object.keys(RANGES) as RangeKey[]) {
    // The survivor team's spacing is migrated to gap in teamFields; gap means nothing anywhere else.
    if ((team && k === 'spacing') || (!team && k === 'gap')) continue;
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampOverride(k, v);
  }
  if (raw.dir === 'row' || raw.dir === 'column') out.dir = raw.dir;
  if (team) teamFields(raw, out, key);
  const c = colour(raw.color); if (c) out.color = c;
  const b = colour(raw.bg); if (b) out.bg = b;
  return out;
}

function boxStyle(v: unknown): WeaponBoxStyle | undefined {
  if (!isObj(v) || (v.kind !== 'hidden' && v.kind !== 'flat' && v.kind !== 'rounded')) return undefined;
  const out: WeaponBoxStyle = { kind: v.kind };
  const c = colour(v.color);
  if (c && v.kind !== 'hidden') out.color = c;
  return out;
}

/**
 * The weapon edits, rebuilt field by field, or nothing when none survive.
 * An advanced design's old weaponBoxActive/Inactive style (the slots that
 * overwrote the pak01 box textures by name) becomes the matching box
 * setting, carrying the colour it drew with; a new setting wins over it, and
 * an uploaded image, which the new setting cannot carry, is dropped. A design
 * not in advanced mode never shipped those styles, so they are dropped too.
 */
function weaponsOf(raw: unknown, oldStyles: unknown, advanced: boolean): WeaponsOverride | undefined {
  const w = isObj(raw) ? raw : {};
  const out: WeaponsOverride = {};
  for (const k of [...Object.keys(WEAPON_KEYS), 'clipFont', 'pistolFont'] as (WeaponNumKey | 'clipFont' | 'pistolFont')[]) {
    const v = w[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampWeapon(k, v);
  }
  const rc = colour(w.reserveColor); if (rc) out.reserveColor = rc;
  const ic = colour(w.inactiveColor); if (ic) out.inactiveColor = ic;
  const old = advanced && isObj(oldStyles) ? oldStyles : {};
  for (const [box, slot] of [['boxActive', 'weaponBoxActive'], ['boxInactive', 'weaponBoxInactive']] as const) {
    const style = boxStyle(w[box]);
    const was = old[slot];
    if (style) out[box] = style;
    else if (isObj(was) && (was.kind === 'flat' || was.kind === 'rounded')) out[box] = { kind: was.kind, color: colour(was.color) ?? WEAPON_BOX_COLOUR[box] };
  }
  if (typeof w.weaponIcons === 'boolean') out.weaponIcons = w.weaponIcons;
  if (typeof w.itemIcons === 'boolean') out.itemIcons = w.itemIcons;
  return Object.keys(out).length ? out : undefined;
}

export function validateDesign(raw: unknown): HudDesign {
  if (!isObj(raw) || raw.v !== 1) return structuredClone(DEFAULT_DESIGN);
  const d: HudDesign = structuredClone(DEFAULT_DESIGN);
  // A stored design lists everything it changed. Starting from DEFAULT_DESIGN's
  // own elements would fit the teammate card of every design saved before fit
  // existed, and those must render exactly as they did.
  d.elements = {};
  if (typeof raw.name === 'string') d.name = safeName(raw.name);
  d.preset = oneOf(raw.preset, ['stock', 'modern', 'imported'] as const, 'stock');
  if (d.preset === 'imported') {
    const ref = importedRef(raw.imported);
    if (ref) d.imported = ref; else d.preset = 'stock';
  }
  d.aspect = oneOf(raw.aspect, ['16:9', '16:10', '4:3'] as const, '16:9');
  // An imported HUD brings its own fonts: Roboto's CustomFontFiles entries
  // would overwrite the upload's own entries 7 and 8.
  d.font = d.preset === 'imported' ? 'preset' : oneOf(raw.font, ['preset', 'roboto'] as const, 'preset');
  d.advanced = raw.advanced === true;
  // Designs saved before the choice carry the `xhair` boolean, where absent
  // meant true: true kept writing the xHair element for a crosshair addon, so
  // it becomes 'addon'. The boolean is read here and never kept.
  d.crosshair = oneOf(raw.crosshair, ['bundle', 'addon', 'none'] as const, raw.xhair === false ? 'none' : 'addon');
  if (raw.hideGameCrosshair === true) d.hideGameCrosshair = true;
  const art = readArt(raw.xhairArt);
  if (art) d.xhairArt = art;
  if (isObj(raw.elements)) for (const [id, v] of Object.entries(raw.elements)) {
    // An element the registry no longer has (the kill feed, say) has nothing to apply to.
    if (!ID.test(id) || !elementById(id)) continue;
    const e = element(id, v, baseOf(d));
    if (Object.keys(e).length) d.elements[id] = e;
  }
  // A slot the editor no longer has (the removed health bar slots) has nothing to restyle.
  const isSlot = (id: string) => SLOTS.some((s) => s.id === id);
  if (isObj(raw.styles)) for (const [id, v] of Object.entries(raw.styles)) {
    if (!ID.test(id) || !isSlot(id) || !isObj(v)) continue;
    const s: StyleOverride = { kind: oneOf(v.kind, ['stock', 'flat', 'rounded', 'image'] as const, 'stock') };
    const c = colour(v.color); if (c) s.color = c;
    d.styles[id] = s;
  }
  if (isObj(raw.images)) for (const [id, v] of Object.entries(raw.images)) {
    if (!ID.test(id) || !isSlot(id) || !isObj(v)) continue;
    const { w, h, png } = v;
    if (typeof w !== 'number' || typeof h !== 'number' || typeof png !== 'string') continue;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) continue;
    if (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE || png.length > MAX_IMAGE_B64) continue;
    if (!/^[A-Za-z0-9+/=]+$/.test(png)) continue;
    d.images[id] = { w, h, png };
  }
  const weapons = weaponsOf(raw.weapons, raw.styles, d.advanced);
  if (weapons) d.weapons = weapons;
  const team = isObj(raw.children) ? raw.children[TEAM_PANEL.panelId] : undefined;
  if (isObj(team)) {
    const kids: Record<string, ChildOverride> = {};
    for (const [name, v] of Object.entries(team)) {
      const def = TEAM_PANEL.children.find((c) => c.name === name);
      if (!def) continue;
      const o = childOverride(def, v);
      if (Object.keys(o).length) kids[name] = o;
    }
    if (Object.keys(kids).length) d.children[TEAM_PANEL.panelId] = kids;
  }
  return d;
}

const KEY = 'hud';
/** The saved design, or `fresh()` when there is none this browser can read. */
export function loadDesign(fresh: () => HudDesign = () => structuredClone(DEFAULT_DESIGN)): HudDesign {
  try { const raw = localStorage.getItem(KEY); return raw ? validateDesign(JSON.parse(raw)) : fresh(); }
  catch { return fresh(); }
}
export function saveDesign(d: HudDesign): void {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* a convenience, not worth surfacing */ }
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const toUrl = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrl = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/**
 * Images never go in a link: one upload is bigger than any chat client will
 * carry. The crosshair does: a built one is a few numbers, and an uploaded
 * one is stored as the 128-pixel texture it becomes, a few kilobytes.
 */
export async function encodeShare(d: HudDesign): Promise<string> {
  const json = JSON.stringify({ ...d, images: {} });
  return toUrl(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
}
export async function decodeShare(s: string): Promise<HudDesign | null> {
  try {
    const bytes = await pipe(fromUrl(s), new DecompressionStream('deflate-raw'));
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    return isObj(raw) && raw.v === 1 ? validateDesign(raw) : null;
  } catch { return null; }
}
