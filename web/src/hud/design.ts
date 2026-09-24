/**
 * A player's HUD design: a preset plus the few things they changed.
 *
 * Designs arrive from three places (localStorage, a share link someone pasted
 * in Discord, a .json file) and all three are untrusted, so everything goes
 * through validateDesign, which rebuilds the object field by field rather than
 * trusting its shape. It never throws: a bad field is dropped, a bad design
 * becomes the defaults.
 */
import { baseOf, baseTree, onUnregister, type Preset, type BaseKey } from './base';
import type { Aspect } from './units';
import { kvFind, kvGet, type KvNode } from './kv';
import { elementById } from './elements';
import { SLOTS } from './slots';
import { TEAM_PANEL, PANEL_CHILDREN, CONTENT_CHILDREN, panelOfFile, maxInset, type ChildDef, type KeyDef } from './children';
import { probe } from './probes';
import { MAX_IMAGE_B64, MAX_IMAGE_SIDE } from './limits';
import { clampBarKeys } from './progress';
import { readArt, type CrosshairArt } from '../crosshair/model';
import { SPLATTERS, splatterDef, type SplatterId, type SplatterStyle } from './splatter';

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
   * The infected row's HorizPanelSpacing, final units, from before the row
   * had `gap`: kept, byte for byte, until a gap replaces it. The survivor
   * team used this too; validateDesign migrates it there and never keeps it.
   */
  spacing?: number;
  /** Survivor team (Row and Column) and the infected row: units between two cards at scale 1. */
  gap?: number;
  /** Survivor team, the infected row: shrink the card to its content. Absent means off, so a saved design renders as it was. */
  fit?: boolean;
  /** Survivor team, Free: the four cards' positions. Kept when leaving Free, so coming back restores them. */
  slots?: CardSlot[];
  /**
   * Validated and reserved, not live, except on the kill notices. The spec's
   * own HudDesign declares these three, so they are validated and clamped
   * here and a design that carries them survives a round trip. The kill
   * notices' `color` (all five rows' fgcolor_override, plan decision 2) and
   * `fontSize` (their font, gate K5) are live: build.ts noticePass writes
   * them. The chat's `fontSize` (ChatFont's size) and `bg` (the open box,
   * gate C2) are live too: build.ts chatPass. No pass reads them on any
   * other element.
   */
  color?: string; bg?: string;
  fontSize?: number;
  /** Keys of the element's own hudlayout.res block that its registry entry declares, as the text the file takes. */
  keys?: Record<string, string>;
  /**
   * The kill notices' box (label4background): a flat colour, or none. Absent
   * means the preset's own art. Kept on killNotices only.
   */
  noticeBox?: NoticeBox;
}
/**
 * The kill notice box restyled: 'flat' a generated texture in `color`,
 * 'none' a clear one (build.ts noticePass).
 */
export interface NoticeBox { kind: 'flat' | 'none'; color?: string }
/** The flat notice box's colour when none is picked: black, about as dark as the stock box's middle. */
export const NOTICE_BOX_COLOUR = '0 0 0 160';
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
  /** Keys the child's registry entry declares (KeyDef), as the text the file takes. */
  keys?: Record<string, string>;
  /** The block's zpos, a whole number in -50..50. Absent means as the preset's file has it. */
  z?: number;
}
export interface StyleOverride { kind: 'stock' | 'flat' | 'rounded' | 'image'; color?: string }

/**
 * The weapon selection's boxes, the active slot's and the rest: as the game
 * draws them, not at all, or a generated flat or rounded texture in a colour.
 * Written by repointing mod_textures.txt's rounded_background_glow and
 * rounded_background_noborder, which works from a normal addon (probe B,
 * 2026-09-23). No 'stock' is ever stored: absent means stock.
 */
export interface WeaponBoxStyle { kind: 'hidden' | 'flat' | 'rounded' | 'image'; color?: string }

/**
 * The icon_equip_* entries of mod_textures.txt the weapon selection draws
 * (weapons.ts's header): WEAPON_ICONS every gun the primary and pistol slots
 * can hold, ITEM_ICONS the throwables, medkit and pills. build.ts re-exports
 * both; they live here so validateDesign can check an upload against them.
 */
export const WEAPON_ICONS = ['icon_equip_pumpshotgun', 'icon_equip_uzi', 'icon_equip_autoshotgun', 'icon_equip_rifle',
  'icon_equip_machinegun', 'icon_equip_dualpistols', 'icon_equip_pistol'];
export const ITEM_ICONS = ['icon_equip_molotov', 'icon_equip_pipebomb', 'icon_equip_medkit', 'icon_equip_pills'];
const PISTOL_ICONS = ['icon_equip_pistol', 'icon_equip_dualpistols'];
/**
 * How the game draws an entry's upload
 * (/home/volence/l4d/hud/probe-phase2-rest/r4/shots/r4/r4-a..c.png): a gun
 * PrimaryWeaponTall high at the upload's own aspect, a pistol a square as
 * tall as its box whatever its shape, an item an IconSize square.
 */
export type WeaponImageKind = 'gun' | 'pistol' | 'item';
export function weaponImageKind(entry: string): WeaponImageKind | undefined {
  if (PISTOL_ICONS.includes(entry)) return 'pistol';
  if (WEAPON_ICONS.includes(entry)) return 'gun';
  return ITEM_ICONS.includes(entry) ? 'item' : undefined;
}
/** The `images` id an entry's upload is stored under: icon_equip_machinegun is wiconMachinegun. */
export function weaponIconId(entry: string): string {
  const stem = entry.replace(/^icon_equip_/, '');
  return `wicon${stem[0].toUpperCase()}${stem.slice(1)}`;
}
/** The `images` ids of the two box uploads. */
export const WEAPON_BOX_IMAGE = { boxActive: 'weaponBoxActive', boxInactive: 'weaponBoxInactive' } as const;
/**
 * The texel sizes a weapon upload is redrawn at in the browser before it is
 * stored (plan decision 5): a gun 64 tall and as wide as its aspect, from a
 * quarter to four times its height (so a sliver cannot make a screen-wide
 * icon), a pistol or item 64 square, a box 128 square so its 16-texel
 * corners nine-slice as the stock art's do (r1/shots/crops/weap-d.png).
 */
export const WEAPON_ICON_TEXELS = 64;
export const WEAPON_GUN_MAX_W = 256;
export const WEAPON_GUN_MIN_W = 16;
export const WEAPON_BOX_TEXELS = 128;
/**
 * The texels an upload for `target` (a weapon icon entry, or a box) is
 * redrawn at, from the picked picture's own size: a gun keeps its aspect
 * at 64 tall, held between a quarter and four times as wide.
 */
export function weaponUploadSize(target: string, srcW: number, srcH: number): { w: number; h: number } {
  if (target === 'boxActive' || target === 'boxInactive') return { w: WEAPON_BOX_TEXELS, h: WEAPON_BOX_TEXELS };
  if (weaponImageKind(target) !== 'gun') return { w: WEAPON_ICON_TEXELS, h: WEAPON_ICON_TEXELS };
  const aspect = srcW > 0 && srcH > 0 ? srcW / srcH : 1;
  return { w: Math.min(WEAPON_GUN_MAX_W, Math.max(WEAPON_GUN_MIN_W, Math.round(WEAPON_ICON_TEXELS * aspect))), h: WEAPON_ICON_TEXELS };
}
/** Whether a stored picture under `id` is a weapon upload at a size the build takes; undefined for an id that is no weapon upload's. */
export function weaponImageFits(id: string, w: number, h: number): boolean | undefined {
  if (id === WEAPON_BOX_IMAGE.boxActive || id === WEAPON_BOX_IMAGE.boxInactive) return w === WEAPON_BOX_TEXELS && h === WEAPON_BOX_TEXELS;
  const entry = [...WEAPON_ICONS, ...ITEM_ICONS].find((e) => weaponIconId(e) === id);
  if (!entry) return undefined;
  if (weaponImageKind(entry) === 'gun') return h === WEAPON_ICON_TEXELS && w >= WEAPON_GUN_MIN_W && w <= WEAPON_GUN_MAX_W;
  return w === WEAPON_ICON_TEXELS && h === WEAPON_ICON_TEXELS;
}
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
  /**
   * Uploaded pictures: a WEAPON_ICONS or ITEM_ICONS entry to its picture's
   * id in `images` (always weaponIconId(entry)). weaponIcons or itemIcons
   * false still hides them; the uploads stay, for when the pictures return.
   */
  icons?: Record<string, string>;
};
export interface UploadedImage { w: number; h: number; png: string }
/**
 * Where the crosshair comes from. 'bundle' (Custom, in the editor) ships the
 * xHair element plus the design's own `xhairArt` as its texture; 'none'
 * (Game default) ships no element of the editor's, so the game's own
 * crosshair is all there is (an imported HUD's own xHair element is its
 * author's, and stays as the upload has it). 'addon' ships only the element, for a separate crosshair addon to
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
  /**
   * The damage splatters (splatter.ts): kind 'stock', 'none', 'fade' or
   * 'image', a Fade colour, and Keep my colours (the scratches only).
   * splatTeam never stores 'none': its None is the BackgroundImage child's
   * hide. An Image's picture lives in `images` under the same id. Absent
   * means every splatter is stock.
   */
  splatters?: Partial<Record<SplatterId, SplatterStyle>>;
  /**
   * false switches off the item pickup fly-in (the picked-up item's icon
   * flying to the weapon selection): build.ts pickupPass. Absent means the
   * game's own animation; true is never stored.
   */
  pickupFlyIn?: false;
}

/**
 * A new design, and what "Reset" returns an element to. The teammate card
 * starts fitted: a saved design without `fit` stays unfitted (validateDesign
 * never adds it), so only designs made from here on start with it.
 */
/**
 * A new design fits the teammate cards and your own health panel. Your own
 * fit came with probe Q2 (slice 2.F G2, /home/volence/l4d/hud/probe-phase2/
 * RESULTS.md: LocalPlayer clips its children and never paints its image,
 * b1/shots/crops/own-a.png), and moves nothing on screen; a design saved
 * without it stays as saved. It was held back once (ccc87af7): launch R
 * showed a fitted bar moved after an incap, because game code puts the bar
 * at the down picture's x. The fit rule now starts the down picture at the
 * bar (build.ts downLeft), and launch X14 (/home/volence/l4d/hud/probe-2f/
 * x14, parity/x14-incap-own.png) showed a fitted bar in place through two
 * incap and revive cycles, so the default came back.
 */
export const DEFAULT_DESIGN: HudDesign = {
  v: 1, name: 'my_hud', preset: 'stock', advanced: false, aspect: '16:9', font: 'preset',
  crosshair: 'none', elements: { teamColumn: { fit: true }, ownHealth: { fit: true } }, styles: {}, images: {}, children: {},
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

/**
 * The stored x and y of an element whose fit moves its own container (your
 * infected health, fitted: build.ts fitSi; the fitted infected row). Those
 * numbers are the unfitted container's, which is drawn the fit offset away,
 * so the drag's on-screen clamp can store far below -200 (a fitted infected
 * health at the left edge stores its drawn 8 - w less the offset, up to the
 * whole screen at scale 2). The floor leaves room for an offset of the
 * widest scale across the whole screen; placeElement clamps where it is
 * drawn, and this only keeps what that stores.
 */
const FIT_POS_RANGES = { x: [RANGES.x[0] - 2 * 853, RANGES.x[1]], y: [RANGES.y[0] - 2 * 480, RANGES.y[1]] } as const;

/**
 * The infected row's gap, which unlike the survivor team's may be negative:
 * code places card i at i x HorizPanelSpacing, and the stock card, 256 wide
 * at a 140 pitch, overlaps its neighbour by 116 (gap -116). The floor is a
 * pitch of one unit for the widest card a piece can make (512); the Gap
 * slider stops at the viewed card's own (edit.ts rowGapSlider), and
 * build.ts's rowLayout never writes a pitch below 1.
 */
const ROW_GAP = [1 - 512, RANGES.gap[1]] as const;
export const clampRowGap = (v: number): number => Math.min(ROW_GAP[1], Math.max(ROW_GAP[0], v));

/** Whether an element's fit moves its container, so its x and y take FIT_POS_RANGES. */
export const fitMovesContainer = (id: string, fit: boolean | undefined): boolean => fit === true && (id === 'siHealth' || id === 'infectedRow');

/** clampOverride for a stored x or y, the fitted range where the fit moves the container. */
export function clampPos(key: 'x' | 'y', value: number, fitted: boolean): number {
  const [lo, hi] = fitted ? FIT_POS_RANGES[key] : RANGES[key];
  return Math.min(hi, Math.max(lo, value));
}

const CHILD_RANGES = { x: [-64, 512], y: [-64, 512], w: [1, 512], h: [1, 512], fontSize: [6, 64], z: [-50, 50] } as const;
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
  // A colour whose effect waits on a probe is dropped until the probe passes,
  // so a flag that flips back off clears it too (plan decision 10).
  if (def.colour && (!def.colourGate || probe(def.colourGate))) { const c = colour(raw.color); if (c) out.color = c; }
  if (def.addable && typeof raw.on === 'boolean') out.on = raw.on;
  const z = n('z');
  if (z !== undefined) out.z = Math.round(z);
  const keys = validKeys(def.keys, raw.keys);
  if (keys) out.keys = keys;
  return out;
}

/**
 * The keys of `raw` that `defs` declares, as the text the file takes: a
 * colour as "r g b a", a whole number clamped to its range, a bool as "1" or
 * "0", an enum as one of its options' values. A key whose probe has not passed is dropped like an undeclared one,
 * because the build writes only what the registry offers today. Undefined
 * when nothing survives, so an empty `keys` is never stored.
 */
export function validKeys(defs: readonly KeyDef[] | undefined, raw: unknown): Record<string, string> | undefined {
  if (!defs || !isObj(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const def of defs) {
    if (def.gate && !probe(def.gate)) continue;
    const v = raw[def.key];
    if (def.type === 'colour') {
      const c = colour(v);
      if (c) out[def.key] = c;
    } else if (def.type === 'int') {
      const num = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(num)) continue;
      let i = Math.round(num);
      if (def.range) i = Math.min(def.range[1], Math.max(def.range[0], i));
      out[def.key] = String(i);
    } else if (def.type === 'enum') {
      const hit = typeof v === 'string' ? def.options?.find((o) => o.value === v.toLowerCase()) : undefined;
      if (hit) out[def.key] = hit.value;
    } else {
      if (v === true || v === '1' || v === 1) out[def.key] = '1';
      else if (v === false || v === '0' || v === 0) out[def.key] = '0';
    }
  }
  return Object.keys(out).length ? out : undefined;
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
onUnregister((key) => { BASE_TEAMS.delete(key); BASE_CONTENT.delete(key); });

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
  const tree = baseTree(key, TEAM_FILE);
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
 * The x the game draws a panel's health bar at, read from the panel file's
 * own children (`nodes`, in whatever frame the caller holds them): its
 * barAnchor child's xpos (the teammate card's Items), or undefined when the
 * panel has no anchor or the file lacks that child (an imported card), and
 * the bar is drawn at its own xpos. client.dll 1023f5df..1023f6da; probe
 * X15 (/home/volence/l4d/hud/probe-2f/x15/RESULTS.md): the stock card bar,
 * xpos 37, is drawn at the item row's 39 from the start of the map.
 */
export function drawnBarX(nodes: KvNode[], panel: { barAnchor?: string } | undefined): number | undefined {
  if (!panel?.barAnchor) return undefined;
  const a = kvFind(nodes, [panel.barAnchor]);
  const x = a ? parseFloat(kvGet(a, 'xpos') ?? '') : NaN;
  return Number.isFinite(x) ? x : undefined;
}

/** Whether a child is the health bar the game re-places (drawnBarX): the block named Health. */
export const isBar = (name: string): boolean => name.toLowerCase() === 'health';

/**
 * The teammate card's content: the union of the visible steady-state
 * children (Head, Health, Name, Items, and HealthNumber and Status when
 * present), each where the game draws it: the health bar at the panel's bar
 * anchor's x (drawnBarX: a card's bar at its Items x, probe X15), so the
 * fitted card never clips the bar. State art and decoration never count.
 * Null when every one is hidden, which fitPass treats as "keep the file's
 * card" rather than write a 0 x 0 card. On stock this is x 13..135 (the bar
 * drawn 39..135), y 36..72: 122 x 36. It lives here, not in build.ts,
 * because the spacing migration below needs the preset's own fitted card
 * too. `panel` names the anchor: the teammate card's by default.
 */
export function contentBox(nodes: KvNode[], names: readonly string[] = CONTENT_CHILDREN, panel: { barAnchor?: string } = TEAM_PANEL): Box | null {
  const content = new Set(names.map((n) => n.toLowerCase()));
  const num = (v: string | undefined) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : 0; };
  const barX = drawnBarX(nodes, panel);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (typeof n.value === 'string' || !content.has(n.key.toLowerCase())) continue;
    if ((kvGet(n, 'visible') ?? '1') === '0') continue;
    const x = barX !== undefined && isBar(n.key) ? barX : num(kvGet(n, 'xpos'));
    const y = num(kvGet(n, 'ypos')), w = num(kvGet(n, 'wide')), h = num(kvGet(n, 'tall'));
    if (w <= 0 || h <= 0) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const BASE_CONTENT = new Map<BaseKey, Box | null>();
/** The base's own card, fitted with no inside edits: stock 122 x 36, Modern 113 x 26. */
export function baseContent(key: BaseKey): Box | null {
  if (!BASE_CONTENT.has(key)) {
    BASE_CONTENT.set(key, contentBox(baseTree(key, TEAM_PANEL.file)));
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
  const infected = id === 'infectedRow';
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  for (const k of Object.keys(RANGES) as RangeKey[]) {
    // The survivor team's spacing is migrated to gap in teamFields; gap means
    // nothing but on the two teams.
    if ((team && k === 'spacing') || (!team && !infected && k === 'gap')) continue;
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = k === 'x' || k === 'y' ? clampPos(k, v, fitMovesContainer(id, raw.fit === true))
      : infected && k === 'gap' ? clampRowGap(v) : clampOverride(k, v);
  }
  // The infected row is only ever a row: the game lays its cards out
  // HorizPanelSpacing apart and reads no vertical key (probe RESULTS, dll 0x10247a70).
  if (raw.dir === 'row' || (raw.dir === 'column' && !infected)) out.dir = raw.dir;
  if (team) teamFields(raw, out, key);
  // The infected row is spaced by its gap (plan Task 11, decision 5). A
  // saved design's `spacing` (the old HorizPanelSpacing, final units) is
  // kept as it is while no gap replaces it, not migrated: its bytes are
  // pinned (download.golden.test.ts), and the stock card, 256 wide at a
  // 140 pitch, overlaps, so no gap of 0 or more could give the same pitch.
  // The fit is opt-in, kept only as a real boolean.
  if (infected) {
    if (out.gap !== undefined) delete out.spacing;
    if (typeof raw.fit === 'boolean') out.fit = raw.fit;
  }
  // Your own health's fit rests on probe Q2 (B1 a): LocalPlayer must clip
  // its children and paint nothing of its own, or a smaller panel would
  // show or hide the wrong things. Kept only once that gate passes, and
  // only as a real boolean; never added.
  if (id === 'ownHealth' && typeof raw.fit === 'boolean' && probe('Q2')) out.fit = raw.fit;
  // Your infected health's fit (build.ts fitSi) rests on probe Q11, which
  // passed: HudZombieHealth clips its children
  // (/home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/br-bce.png).
  // Opt-in, so kept only as a real boolean; never added.
  if (id === 'siHealth' && typeof raw.fit === 'boolean') out.fit = raw.fit;
  const c = colour(raw.color); if (c) out.color = c;
  const b = colour(raw.bg); if (b) out.bg = b;
  // The kill notices' text size waits on gate K5 (probes.ts): row 0's font
  // was never seen in game, so a stored size is dropped while it is closed.
  if (id === 'killNotices' && !probe('K5')) delete out.fontSize;
  // The open chat's box colour waits on gate C2: the probe never got the
  // chat open (/home/volence/l4d/hud/probe-phase2-rest/RESULTS.md, C2).
  if (id === 'chat' && !probe('C2')) delete out.bg;
  if (id === 'killNotices' && isObj(raw.noticeBox) && (raw.noticeBox.kind === 'flat' || raw.noticeBox.kind === 'none')) {
    const box: NoticeBox = { kind: raw.noticeBox.kind };
    const bc = colour(raw.noticeBox.color);
    if (bc && box.kind === 'flat') box.color = bc;
    out.noticeBox = box;
  }
  const keys = validKeys(elementById(id)?.keys, raw.keys);
  if (keys) out.keys = keys;
  return out;
}

function boxStyle(v: unknown, hasImage: boolean): WeaponBoxStyle | undefined {
  if (!isObj(v) || (v.kind !== 'hidden' && v.kind !== 'flat' && v.kind !== 'rounded' && v.kind !== 'image')) return undefined;
  // An Image box with no picture stored (a share link carries none) is stock.
  if (v.kind === 'image' && !hasImage) return undefined;
  const out: WeaponBoxStyle = { kind: v.kind };
  const c = colour(v.color);
  if (c && (v.kind === 'flat' || v.kind === 'rounded')) out.color = c;
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
function weaponsOf(raw: unknown, oldStyles: unknown, advanced: boolean, images: Record<string, UploadedImage>): WeaponsOverride | undefined {
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
    const style = boxStyle(w[box], images[WEAPON_BOX_IMAGE[box]] !== undefined);
    const was = old[slot];
    if (style) out[box] = style;
    else if (isObj(was) && (was.kind === 'flat' || was.kind === 'rounded')) out[box] = { kind: was.kind, color: colour(was.color) ?? WEAPON_BOX_COLOUR[box] };
  }
  if (typeof w.weaponIcons === 'boolean') out.weaponIcons = w.weaponIcons;
  if (typeof w.itemIcons === 'boolean') out.itemIcons = w.itemIcons;
  if (isObj(w.icons)) {
    const icons: Record<string, string> = {};
    for (const [entry, id] of Object.entries(w.icons)) {
      if (!weaponImageKind(entry) || id !== weaponIconId(entry) || !images[id]) continue;
      icons[entry] = id;
    }
    if (Object.keys(icons).length) out.icons = icons;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The weapon pictures the design ships: every named icon upload, and each Image box's. */
export function weaponImagesInUse(d: HudDesign): Set<string> {
  const w = d.weapons;
  return new Set([...Object.values(w?.icons ?? {}),
    ...(['boxActive', 'boxInactive'] as const).filter((b) => w?.[b]?.kind === 'image').map((b) => WEAPON_BOX_IMAGE[b])]);
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
  if (raw.pickupFlyIn === false) d.pickupFlyIn = false;
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
  // Every splatter's None is its child's hide, one flag that Layers and
  // Delete already use, so it is never stored here (plan decision 4). The
  // teammate splatter never stored it; a scratch saved before this did, and
  // loads as the hide below, once the stored children are read, with the
  // kind back to stock so a Fade colour it kept waits for the next Fade.
  // Both paths end in the same hard hide, so the download does not change.
  const noneHides: SplatterId[] = [];
  if (isObj(raw.splatters)) {
    const out: Partial<Record<SplatterId, SplatterStyle>> = {};
    for (const def of SPLATTERS) {
      const v = raw.splatters[def.id];
      if (!isObj(v)) continue;
      let kind = oneOf(v.kind, ['stock', 'none', 'fade', 'image'] as const, 'stock');
      if (kind === 'none') {
        if (def.route === 'standIn') continue;
        noneHides.push(def.id);
        kind = 'stock';
      }
      const s: SplatterStyle = { kind };
      const c = colour(v.color); if (c) s.color = c;
      if (def.healthTint && v.keepColours === true) s.keepColours = true;
      out[def.id] = s;
    }
    if (Object.keys(out).length) d.splatters = out;
  }
  if (isObj(raw.images)) for (const [id, v] of Object.entries(raw.images)) {
    if (!ID.test(id) || !isObj(v)) continue;
    const { w, h, png } = v;
    if (typeof w !== 'number' || typeof h !== 'number' || typeof png !== 'string') continue;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) continue;
    // A weapon upload must be the texel size it was drawn at (decision 5),
    // which is also the size the build encodes and the cell rect it writes.
    const weapon = weaponImageFits(id, w, h);
    if (weapon === false || (weapon === undefined && !(isSlot(id) || splatterDef(id)))) continue;
    // A splatter image must be its texture's exact size: the preview draws the
    // stored PNG and the build encodes it at the texture size, so only that
    // size can be both.
    const splat = splatterDef(id);
    if (splat && (w !== splat.size.w || h !== splat.size.h)) continue;
    if (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE || png.length > MAX_IMAGE_B64) continue;
    if (!/^[A-Za-z0-9+/=]+$/.test(png)) continue;
    d.images[id] = { w, h, png };
  }
  const weapons = weaponsOf(raw.weapons, raw.styles, d.advanced, d.images);
  if (weapons) d.weapons = weapons;
  // A weapon picture nothing names is dropped, as the old weapon box slots'
  // were: nothing would ever ship it.
  const named = weaponImagesInUse(d);
  for (const id of Object.keys(d.images)) if (weaponImageFits(id, 1, 1) !== undefined && !named.has(id)) delete d.images[id];
  // Every registered panel's children, by the same rules; a panel the
  // registry does not have has nothing to apply to. Names match exactly, as
  // the teammate card always did, so a stored name is the block's own.
  if (isObj(raw.children)) for (const panel of PANEL_CHILDREN) {
    const stored = raw.children[panel.panelId];
    if (!isObj(stored)) continue;
    const kids: Record<string, ChildOverride> = {};
    for (const [name, v] of Object.entries(stored)) {
      const def = panel.children.find((c) => c.name === name);
      if (!def) continue;
      const o = childOverride(def, v);
      clampInset(d, panel.file, def, o);
      if (panel.panelId === 'progressBar' && def.name === 'Bar') clampProgressBar(d, panel.file, def, o);
      if (Object.keys(o).length) kids[name] = o;
    }
    if (Object.keys(kids).length) d.children[panel.panelId] = kids;
  }
  for (const id of noneHides) {
    const def = splatterDef(id)!;
    const panel = panelOfFile(def.file);
    if (!panel) continue;
    const kids = d.children[panel.panelId] ?? {};
    d.children[panel.panelId] = { ...kids, [def.block]: { ...kids[def.block], visible: false } };
  }
  return d;
}

/**
 * A bar's inset, cut so the bar keeps a unit of fill (maxInset) at the
 * design's own tall, else the base file's. An imported base that is not
 * registered yet cannot be read here; the build cuts it again anyway.
 */
function clampInset(d: HudDesign, file: string, def: ChildDef, o: ChildOverride) {
  const raw = o.keys?.inset;
  if (def.kind !== 'bar' || raw === undefined) return;
  let tall = o.h;
  if (tall === undefined) {
    try {
      const n = kvFind(baseTree(baseOf(d), file), [def.name]);
      const t = parseFloat((n && kvGet(n, 'tall')) ?? '');
      if (Number.isFinite(t)) tall = t;
    } catch { /* an imported base not registered yet */ }
  }
  if (tall !== undefined) o.keys = { ...o.keys, inset: String(Math.min(Number(raw), maxInset(tall))) };
}

/**
 * The use bar's border and gap, cut by probe Q22's rule (progress.ts
 * clampBarKeys) at the design's own tall, else the base file's: a stored
 * key is cut, one the design leaves alone stays the file's. Reads the
 * file's value for a key the design does not set, since the rule weighs
 * all three together.
 */
function clampProgressBar(d: HudDesign, file: string, def: ChildDef, o: ChildOverride) {
  const k = o.keys;
  if (!k || (k.gap === undefined && k.border_thickness === undefined && k.shadow_thickness === undefined)) return;
  let node: KvNode | undefined;
  try { node = kvFind(baseTree(baseOf(d), file), [def.name]); } catch { return; }
  const fileNum = (key: string, dflt: number) => { const v = parseFloat((node && kvGet(node, key)) ?? ''); return Number.isFinite(v) ? v : dflt; };
  const tall = o.h ?? fileNum('tall', NaN);
  if (!Number.isFinite(tall)) return;
  const cut = clampBarKeys({
    border: k.border_thickness !== undefined ? Number(k.border_thickness) : fileNum('border_thickness', 1),
    gap: k.gap !== undefined ? Number(k.gap) : fileNum('gap', 1),
    shadow: k.shadow_thickness !== undefined ? Number(k.shadow_thickness) : fileNum('shadow_thickness', 1),
  }, tall);
  o.keys = { ...k,
    ...(k.border_thickness !== undefined ? { border_thickness: String(cut.border) } : {}),
    ...(k.gap !== undefined ? { gap: String(cut.gap) } : {}) };
}

const KEY = 'hud';
/** The saved design, or `fresh()` when there is none this browser can read. */
export function loadDesign(fresh: () => HudDesign = () => structuredClone(DEFAULT_DESIGN)): HudDesign {
  try { const raw = localStorage.getItem(KEY); return raw ? validateDesign(JSON.parse(raw)) : fresh(); }
  catch { return fresh(); }
}
/**
 * False when the browser refused (storage full or blocked): the page warns,
 * since a design with its uploads can outgrow what localStorage keeps.
 */
export function saveDesign(d: HudDesign): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(d)); return true; } catch { return false; }
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
