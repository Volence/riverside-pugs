/**
 * The weapon selection, drawn the way the game draws it.
 *
 * Unlike the four card panels, the weapon slots have no .res tree of
 * children: game code paints them inside the HudWeaponSelection panel. So
 * this reads that panel's keys from the generated hudlayout.res and repeats
 * what the code does with them, found by disassembling the paint function of
 * TerrorWeaponSelection.cpp in the owner's client.dll (the one Panel::Paint
 * calls, 0x10245af0), and checked against the owner's in-game screenshot of
 * the stock HUD.
 *
 * What the code reads, and what it does not. On the PC, L4D1 lays the slots
 * out with the keys hudlayout.res files under "360 mode": PrimaryWeaponsYPos,
 * PrimaryWeaponBoxWide/Tall, PrimaryWeaponTall, PrimaryWeaponAmmoX,
 * ReserveAmmoYPos, PistolBoxWide/Tall, RightSideIndent, IconSize,
 * PrimaryAmmoFont, PistolAmmoFont, ReserveAmmoColor and InactiveItemColor,
 * plus the panel's own wide. LargeBoxWide/Tall, SmallBoxWide/Tall, BoxGap,
 * BoxDirection, the Ammo1/Ammo2, Icon and SelectionNumber positions, TextYPos
 * and MaxSlots are registered but never read by that paint, so they move
 * nothing and nothing here reads them.
 *
 * The layout, top down, every slot right-aligned RightSideIndent in from the
 * panel's right edge:
 *   - the primary weapon, a PrimaryWeaponBoxWide x PrimaryWeaponBoxTall box
 *     at PrimaryWeaponsYPos;
 *   - the pistol, a PistolBoxWide x PistolBoxTall box;
 *   - three items (the throwable, the medkit, the pills), IconSize squares.
 * The active slot is drawn 1.2 times its size, grown to the left and down.
 * Each slot starts two "640-units" (ScreenWidth / 640 pixels, see unit640)
 * below the last. The boxes are the scalable panel art mod_textures.txt
 * names rounded_background_glow (the active slot) and
 * rounded_background_noborder (the rest), drawn nine-sliced with 16-texel
 * corners, grown by a pad on every side, at alpha 180. The icons are cells of
 * vgui/hud/iconsheet (icon_equip_*); an item slot the player lacks keeps its
 * box and draws its icon tinted by InactiveItemColor.
 *
 * The player's edits (HudDesign.weapons) reach the picture the way they
 * reach the game: the keys through the generated hudlayout.res and the
 * scheme's HudEd_ font copies, the boxes and pictures through the generated
 * scripts/mod_textures.txt. An entry pointed at the clear texture draws
 * nothing, one pointed at a generated box texture draws that box's style (a
 * flat or rounded fill in its colour, as the texture is), and anything else
 * draws the art the entry names. IconSize 0 draws no item slots at all, box
 * or picture (probe B).
 *
 * Preview only, like the rest of the art: nothing here is in a download.
 */
import type { HudDesign } from './design';
import type { Aspect } from './units';
import { screenW } from './units';
import { buildTrees, pcGet, CLEAR_TEXTURE, WEAPON_BOX_ENTRY, weaponBoxTexture } from './build';
import { WEAPON_BOX_COLOUR } from './design';
import { kvFind, type KvNode } from './kv';
import { artImage, colourOf, fontFace, hatch, isMissing, PREVIEW_FONT, rgbaOf, tinted } from './render';
import { EQUIP_ICON_SIZE } from './art/index';

interface Rect { x: number; y: number; w: number; h: number }

export interface WeaponText {
  text: string;
  /** The scheme font the game draws it in. */
  font: string;
  /** A literal "r g b a" or a scheme colour name; null is the game's own white. */
  colour: string | null;
  /** The edge x names: the game measures the text and places its right or left edge there. */
  align: 'left' | 'right';
  x: number;
  /** The top of the text's cell, one font tall. */
  y: number;
}

export interface WeaponSlot {
  kind: 'primary' | 'pistol' | 'item';
  active: boolean;
  /** The rect the game hands its box drawing, in HUD units inside the panel. */
  box: Rect;
  /** The nine-sliced art: the box grown by its pad on every side. */
  frame: Rect;
  /** How big each corner of the art is drawn, in HUD units. */
  corner: number;
  /** The box art as mod_textures.txt names it, lower case; null when the box draws nothing or is a generated fill. */
  art: string | null;
  /** A generated flat or rounded box: its "r g b a" colour, drawn over the frame instead of art. */
  fill?: { color: string; rounded: boolean };
  /**
   * tint: the colour the icon is multiplied by, or null to draw it as it is.
   * hidden: its mod_textures.txt entry points at the clear texture.
   */
  icon: Rect & { name: string; tint: string | null; hidden?: boolean };
  texts: WeaponText[];
}

/**
 * The fixed loadout the preview shows, as the teammate cards show fixed
 * people: a pump shotgun with 5 in the clip and 105 in reserve, the active
 * weapon; dual pistols with 20; a molotov, no medkit (its slot dimmed) and
 * pills, as in the owner's screenshot.
 */
export const WEAPON_SAMPLE = { clip: '5', reserve: '105', pistolClip: '20' };
const SAMPLE_ITEMS: { icon: string; has: boolean }[] = [
  { icon: 'icon/equip/molotov', has: true },
  { icon: 'icon/equip/medkit', has: false },
  { icon: 'icon/equip/pills', has: true },
];

/** The box art, both slot kinds: a scalable panel drawn at this alpha (180 of 255) in white. */
export const BOX_ALPHA = 180 / 255;
/** The art's corners, in texels of its 128-texel texture, kept square when the box stretches. */
const SRC_CORNER = 16;
/** The active slot's size, against the others. */
const GROW = 1.2;

/**
 * The paint's other unit. Box pads, corners and the gaps between slots are
 * ScreenWidth / 640 pixels, not the proportional ScreenHeight / 480 every
 * .res value is in, so in HUD units one of them is the screen's width in
 * HUD units over 640: 1.33 at 16:9, 1 at 4:3.
 */
const unit640 = (aspect: Aspect) => screenW(aspect) / 640;

/**
 * The defaults client.dll registers for each key, used when a file leaves
 * one out. Neither preset gives PistolAmmoFont, so the pistol's clip and
 * the primary's reserve are always in HudAmmo.
 */
const DEFAULTS: Record<string, string> = {
  PrimaryWeaponsYPos: '0', PrimaryWeaponBoxWide: '0', PrimaryWeaponBoxTall: '0', PrimaryWeaponTall: '0',
  PrimaryWeaponAmmoX: '0', ReserveAmmoYPos: '0', PistolBoxWide: '0', PistolBoxTall: '0',
  RightSideIndent: '10', IconSize: '32',
  PrimaryAmmoFont: 'FrameTitle', PistolAmmoFont: 'HudAmmo',
  ReserveAmmoColor: '128 128 128 255', InactiveItemColor: '100 100 100 255',
};

/** A HudWeaponSelection key as the generated file has it, or the dll's default when the file leaves it out. */
export function weaponKey(design: HudDesign, key: string): string { return keys(design)(key); }

function keys(design: HudDesign): (key: string) => string {
  const panel: KvNode | undefined = kvFind(buildTrees(design)('scripts/hudlayout.res'), ['HudWeaponSelection']);
  return (key) => (panel && pcGet(panel, key)) ?? DEFAULTS[key];
}

/**
 * What each mod_textures.txt entry the paint uses points at, in the
 * generated file: lower case, as the art index names materials.
 */
function textureFiles(design: HudDesign): (entry: string) => string {
  const cells = kvFind(buildTrees(design)('scripts/mod_textures.txt'), ['TextureData']);
  return (entry) => {
    const e = cells && kvFind(cells.value as KvNode[], [entry]);
    return ((e && typeof e.value !== 'string' && e.value.find((n) => n.key.toLowerCase() === 'file')?.value) as string ?? '').toLowerCase();
  };
}

/** An icon cell's width over its height, from the index; square when the art is not indexed. */
function cellAspect(name: string): number {
  const size = EQUIP_ICON_SIZE[name];
  return size ? size[0] / size[1] : 1;
}

/**
 * Every slot the preview draws for the sample loadout, in HUD units inside
 * the panel (its top-left is 0, 0), panelWide being the panel's own wide.
 */
export function weaponSlots(design: HudDesign, aspect: Aspect, panelWide: number): WeaponSlot[] {
  const get = keys(design);
  const n = (key: string) => { const v = parseFloat(get(key)); return Number.isFinite(v) ? v : parseFloat(DEFAULTS[key]); };
  const u = unit640(aspect);
  const indent = n('RightSideIndent');
  const slots: WeaponSlot[] = [];

  /** A box of w x h whose right edge is `indent` in, grown to the left and down when active. */
  const boxAt = (y: number, w: number, h: number, active: boolean): Rect => {
    const x = panelWide - w - indent;
    return active ? { x: x - (w * GROW - w), y, w: w * GROW, h: h * GROW } : { x, y, w, h };
  };
  const file = textureFiles(design);
  const hidden = (icon: string) => file(icon.replaceAll('/', '_')) === CLEAR_TEXTURE;
  const frameOf = (b: Rect, active: boolean) => {
    const pad = (active ? 4 : 2) * u;
    const box = active ? 'boxActive' : 'boxInactive';
    const art = file(WEAPON_BOX_ENTRY[box]);
    const style = design.weapons?.[box];
    const fill = art === weaponBoxTexture(box) && style && style.kind !== 'hidden'
      ? { color: style.color ?? WEAPON_BOX_COLOUR[box], rounded: style.kind === 'rounded' } : undefined;
    return {
      frame: { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }, corner: (active ? 8 : 4) * u,
      art: art === CLEAR_TEXTURE || fill ? null : art, ...(fill ? { fill } : {}),
    };
  };

  // The primary weapon: its icon PrimaryWeaponTall high (times 1.2 when
  // active), as wide as the cell's shape, right-aligned with the box and
  // centred on the box's top edge. The clip ends PrimaryWeaponAmmoX in from
  // the right (5 more when active), the reserve starts just past it, both
  // spaced by one 640-unit, and the reserve sits ReserveAmmoYPos lower.
  // Each slot below sets `active` as a fixed const rather than inlining true/false, since
  // the sample loadout always shows the primary as the active one: boxAt and frameOf already
  // branch on it generically, so a later feature that lets the preview choose the active slot
  // can compute these instead of writing them here and reuse those branches unchanged.
  let y = n('PrimaryWeaponsYPos');
  {
    const active = true;
    const f = active ? GROW : 1;
    const box = boxAt(y, n('PrimaryWeaponBoxWide'), n('PrimaryWeaponBoxTall'), active);
    const ih = n('PrimaryWeaponTall') * f;
    const iw = cellAspect('icon/equip/pumpshotgun') * ih;
    const clipFont = get('PrimaryAmmoFont');
    const reserveFont = get('PistolAmmoFont');
    const clipTop = y + (box.h - fontFace(design, clipFont).tall) / 2;
    const ammoX = panelWide - n('PrimaryWeaponAmmoX');
    slots.push({
      kind: 'primary', active, box, ...frameOf(box, active),
      icon: { name: 'icon/equip/pumpshotgun', tint: null, ...(hidden('icon/equip/pumpshotgun') ? { hidden: true } : {}),
        x: panelWide - iw - indent, y: y - ih / 2, w: iw, h: ih },
      texts: [
        { text: WEAPON_SAMPLE.clip, font: clipFont, colour: null, align: 'right', x: ammoX - (active ? 5 : 0) - u, y: clipTop },
        { text: WEAPON_SAMPLE.reserve, font: reserveFont, colour: get('ReserveAmmoColor'), align: 'left',
          x: ammoX + u - (active ? 3 : 0), y: clipTop + n('ReserveAmmoYPos') },
      ],
    });
    y += box.h + 2 * u;
  }

  // The pistol: its icon a square as tall as the box, one 640-unit in from
  // the box's right edge; the clip ends two 640-units left of the icon.
  {
    const active = false;
    const box = boxAt(y, n('PistolBoxWide'), n('PistolBoxTall'), active);
    const iconX = panelWide - indent - box.h - u;
    const font = get('PistolAmmoFont');
    slots.push({
      kind: 'pistol', active, box, ...frameOf(box, active),
      icon: { name: 'icon/equip/dualpistols', tint: null, ...(hidden('icon/equip/dualpistols') ? { hidden: true } : {}), x: iconX, y, w: box.h, h: box.h },
      texts: [{ text: WEAPON_SAMPLE.pistolClip, font, colour: null, align: 'right', x: iconX - 2 * u, y: y + (box.h - fontFace(design, font).tall) / 2 }],
    });
    y += box.h + 2 * u;
  }

  // The items: IconSize squares, each icon filling its box. At IconSize 0
  // the game draws no item slot at all, not even the box's rim (probe B).
  if (n('IconSize') <= 0) return slots;
  for (const item of SAMPLE_ITEMS) {
    const active = false;
    const size = n('IconSize');
    const box = boxAt(y, size, size, active);
    slots.push({
      kind: 'item', active, box, ...frameOf(box, active),
      icon: { name: item.icon, tint: item.has ? null : get('InactiveItemColor'), ...(hidden(item.icon) ? { hidden: true } : {}), ...box },
      texts: [],
    });
    y += box.h + 2 * u;
  }
  return slots;
}

/**
 * CHudTexture::DrawSelfScalableCorners: the texture's 16-texel corners drawn
 * `corner` pixels square, its edges stretched between them, its middle
 * stretched to fill, so a box of any size keeps round corners and an even rim.
 */
function drawNineSlice(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, corner: number) {
  const tw = img.naturalWidth, th = img.naturalHeight;
  const sx = [0, SRC_CORNER, tw - SRC_CORNER], sw = [SRC_CORNER, tw - 2 * SRC_CORNER, SRC_CORNER];
  const sy = [0, SRC_CORNER, th - SRC_CORNER], sh = [SRC_CORNER, th - 2 * SRC_CORNER, SRC_CORNER];
  const dx = [x, x + corner, x + w - corner], dw = [corner, w - 2 * corner, corner];
  const dy = [y, y + corner, y + h - corner], dh = [corner, h - 2 * corner, corner];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) ctx.drawImage(img, sx[c], sy[r], sw[c], sh[r], dx[c], dy[r], dw[c], dh[r]);
}

/**
 * Draws the sample loadout for a panel whose top-left is at `origin` in
 * canvas pixels, k canvas pixels to a HUD unit, in the order the game paints
 * it: each slot's box, then its icon, then its numbers. Art that is still
 * loading is left out (onAsset asks for a redraw); art that is missing is
 * hatched where it would be.
 */
export function drawWeapons(ctx: CanvasRenderingContext2D, design: HudDesign, origin: { x: number; y: number }, k: number,
  panelWide: number, onAsset?: () => void): void {
  const px = (r: Rect): Rect => ({ x: origin.x + r.x * k, y: origin.y + r.y * k, w: r.w * k, h: r.h * k });
  for (const s of weaponSlots(design, design.aspect, panelWide)) {
    const frame = px(s.frame);
    const box = s.art ? artImage(s.art, onAsset) : undefined;
    if (s.fill) {
      // The generated texture is the colour edge to edge, its corners cut
      // round by one 16-texel corner for Rounded, nine-sliced over the frame
      // like the art, so the fill is the frame with round corners s.corner big.
      ctx.save();
      ctx.globalAlpha *= BOX_ALPHA;
      ctx.fillStyle = colourOf(design, s.fill.color);
      if (s.fill.rounded && typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(frame.x, frame.y, frame.w, frame.h, s.corner * k);
        ctx.fill();
      } else ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
      ctx.restore();
    } else if (box) {
      ctx.save();
      ctx.globalAlpha *= BOX_ALPHA;
      drawNineSlice(ctx, box, frame.x, frame.y, frame.w, frame.h, s.corner * k);
      ctx.restore();
    } else if (s.art && isMissing(s.art)) hatch(ctx, { name: s.art, kind: 'image', visible: true, ...frame });

    const icon = px(s.icon);
    const img = s.icon.hidden ? undefined : artImage(s.icon.name, onAsset);
    if (img) {
      let src: CanvasImageSource = img;
      ctx.save();
      if (s.icon.tint) {
        const [r, g, b, a] = rgbaOf(design, s.icon.tint);
        if (r < 255 || g < 255 || b < 255) src = tinted(img, s.icon.name, r, g, b);
        ctx.globalAlpha *= a / 255;
      }
      ctx.drawImage(src, icon.x, icon.y, icon.w, icon.h);
      ctx.restore();
    } else if (!s.icon.hidden && isMissing(s.icon.name)) hatch(ctx, { name: s.icon.name, kind: 'image', visible: true, ...icon });

    for (const t of s.texts) {
      const face = fontFace(design, t.font);
      ctx.save();
      ctx.font = `${face.bold ? 'bold ' : ''}${face.tall * k}px ${PREVIEW_FONT}`;
      ctx.fillStyle = colourOf(design, t.colour ?? undefined);
      ctx.textAlign = t.align;
      ctx.textBaseline = 'middle';
      ctx.fillText(t.text, origin.x + t.x * k, origin.y + (t.y + face.tall / 2) * k);
      ctx.restore();
    }
  }
}
