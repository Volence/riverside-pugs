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
import { WEAPON_BOX_COLOUR, WEAPON_BOX_IMAGE, WEAPON_ICONS, weaponIconId, weaponImageKind } from './design';
import { kvFind, kvGet, type KvNode } from './kv';
import { artImage, colourOf, fillFontText, fontFace, hatch, isMissing, rgbaOf, scratchCanvas, setFont, storedImage, tinted } from './render';
import { baseOf } from './base';
import { importedMaterial } from './importArt';
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
  /** An Image box: the id of its upload in the design's images, nine-sliced over the frame instead of art. */
  image?: string;
  /**
   * tint: the colour the icon is multiplied by, or null to draw it as it is.
   * hidden: its mod_textures.txt entry points at the clear texture.
   */
  icon: Rect & { name: string; tint: string | null; hidden?: boolean; upload?: string };
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

/**
 * The box art, both slot kinds: a scalable panel drawn at this alpha (180 of
 * 255) in white. Generated flat and rounded boxes draw at it too, active and
 * inactive: slice 2.F launch P (/home/volence/l4d/hud/probe-2f/RESULTS.md,
 * shots p/shots/p/p-a.png and p-g.png) drew a 255 0 0 255 active and a
 * 0 0 255 255 inactive box as the game blending in linear light at 180/255:
 * red 222 over a backdrop red of 83, blue 219 over a backdrop blue of 29, the
 * zero channels about half the backdrop. Probe S4's "about 0.55, no
 * multiplier" assumed a gamma-space blend; the same linear model fits its
 * pixels (166 red, 36 green for a 128-alpha box). The canvas blends in gamma
 * space, so no single alpha matches the game over every backdrop; 180/255 is
 * the game's own number, kept.
 */
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

/**
 * A mod_textures.txt (then hud_textures.txt) cell the paint asks for by
 * name: the material it cuts from and its rect in texels. The weapon
 * selection looks names up in the game's icon dictionary, which both files
 * fill; mod_textures.txt is the one probe B showed the paint reads, so it
 * wins. A glyph cell (font and character, no file) has no rect and is left
 * to the preview's own art.
 */
export function iconCell(design: HudDesign, entry: string): { file: string; x: number; y: number; w: number; h: number } | undefined {
  for (const path of ['scripts/mod_textures.txt', 'scripts/hud_textures.txt']) {
    const cells = kvFind(buildTrees(design)(path), ['TextureData']);
    const e = cells && typeof cells.value !== 'string' ? kvFind(cells.value, [entry]) : undefined;
    const file = e && kvGet(e, 'file');
    if (!e || !file) continue;
    const n = (k: string) => parseFloat(kvGet(e, k) ?? '0') || 0;
    return { file: file.toLowerCase(), x: n('x'), y: n('y'), w: n('width'), h: n('height') };
  }
  return undefined;
}

/** An icon cell's width over its height, from the index; square when the art is not indexed. */
function cellAspect(name: string): number {
  const size = EQUIP_ICON_SIZE[name];
  return size ? size[0] / size[1] : 1;
}

/**
 * Which slot the survivor holds, for the preview: the gun, the pistol, or an
 * item (the first, the molotov). The held slot is the active one, grown, and
 * only a held gun gets its numbers nudged left, so switching moves them; the
 * owner saw exactly that in game on 2026-09-23, and the page lets the player
 * flip between the three to see it before downloading.
 */
export type WeaponHeld = 'primary' | 'pistol' | 'item';

/**
 * Every slot the preview draws for the sample loadout, in HUD units inside
 * the panel (its top-left is 0, 0), panelWide being the panel's own wide,
 * with `held` the active slot.
 */
export function weaponSlots(design: HudDesign, aspect: Aspect, panelWide: number, held: WeaponHeld = 'primary'): WeaponSlot[] {
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
    const generated = art === weaponBoxTexture(box) && style;
    const image = generated && style.kind === 'image' && design.images[WEAPON_BOX_IMAGE[box]] ? WEAPON_BOX_IMAGE[box] : undefined;
    const fill = generated && (style.kind === 'flat' || style.kind === 'rounded')
      ? { color: style.color ?? WEAPON_BOX_COLOUR[box], rounded: style.kind === 'rounded' } : undefined;
    return {
      frame: { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }, corner: (active ? 8 : 4) * u,
      art: art === CLEAR_TEXTURE || fill || image ? null : art, ...(fill ? { fill } : {}), ...(image ? { image } : {}),
    };
  };
  // An entry the generated mod_textures.txt points at its own upload (weaponsPass), and that upload's id.
  const uploadOf = (entry: string) => {
    const id = weaponIconId(entry);
    return file(entry) === `vgui/hud/hudeditor/${entry}` && design.images[id] ? id : undefined;
  };
  /**
   * The sample's picture for a slot: its own entry, unless only another
   * entry the slot can hold has an upload, which is then shown instead, so
   * an upload for the M16 is seen without switching the sample gun.
   */
  const sampleIcon = (preferred: string, others: string[]) => {
    const entry = uploadOf(preferred) || !others.some(uploadOf) ? preferred : others.find(uploadOf)!;
    const id = uploadOf(entry);
    return { name: entry.replaceAll('_', '/'), ...(id ? { upload: id } : {}) };
  };

  // The primary weapon: its icon PrimaryWeaponTall high (times 1.2 when
  // active), as wide as the cell's shape, right-aligned with the box and
  // centred on the box's top edge. The clip ends PrimaryWeaponAmmoX in from
  // the right (5 more when active), the reserve starts just past it, both
  // spaced by one 640-unit, and the reserve sits ReserveAmmoYPos lower.
  let y = n('PrimaryWeaponsYPos');
  {
    const active = held === 'primary';
    const f = active ? GROW : 1;
    const box = boxAt(y, n('PrimaryWeaponBoxWide'), n('PrimaryWeaponBoxTall'), active);
    const gun = sampleIcon('icon_equip_pumpshotgun', WEAPON_ICONS.filter((e) => weaponImageKind(e) === 'gun'));
    const ih = n('PrimaryWeaponTall') * f;
    // An upload is drawn at its own cell's aspect, the rect weaponsPass wrote
    // (/home/volence/l4d/hud/probe-phase2-rest/r4/shots/r4/r4-a.png, r4-b.png).
    const cell = gun.upload ? iconCell(design, gun.name.replaceAll('/', '_')) : undefined;
    const iw = (cell && cell.h > 0 ? cell.w / cell.h : cellAspect(gun.name)) * ih;
    const clipFont = get('PrimaryAmmoFont');
    const reserveFont = get('PistolAmmoFont');
    const clipTop = y + (box.h - fontFace(design, clipFont).tall) / 2;
    const ammoX = panelWide - n('PrimaryWeaponAmmoX');
    slots.push({
      kind: 'primary', active, box, ...frameOf(box, active),
      icon: { ...gun, tint: null, ...(hidden(gun.name) ? { hidden: true } : {}),
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
  // the box's right edge, an upload too whatever its shape (r4/shots/r4/r4-c.png);
  // the clip ends two 640-units left of the icon.
  {
    const pistol = sampleIcon('icon_equip_dualpistols', ['icon_equip_pistol']);
    const active = held === 'pistol';
    const box = boxAt(y, n('PistolBoxWide'), n('PistolBoxTall'), active);
    const iconX = panelWide - indent - box.h - u;
    const font = get('PistolAmmoFont');
    slots.push({
      kind: 'pistol', active, box, ...frameOf(box, active),
      icon: { ...pistol, tint: null, ...(hidden(pistol.name) ? { hidden: true } : {}), x: iconX, y, w: box.h, h: box.h },
      texts: [{ text: WEAPON_SAMPLE.pistolClip, font, colour: null, align: 'right', x: iconX - 2 * u, y: y + (box.h - fontFace(design, font).tall) / 2 }],
    });
    y += box.h + 2 * u;
  }

  // The items: IconSize squares, each icon filling its box. At IconSize 0
  // the game draws no item slot at all, not even the box's rim (probe B).
  if (n('IconSize') <= 0) return slots;
  for (const [i, item] of SAMPLE_ITEMS.entries()) {
    const active = held === 'item' && i === 0;
    const size = n('IconSize');
    const box = boxAt(y, size, size, active);
    // The throwable slot shows a pipe bomb upload when the molotov has none.
    const pic = sampleIcon(item.icon.replaceAll('/', '_'), i === 0 ? ['icon_equip_pipebomb'] : []);
    slots.push({
      kind: 'item', active, box, ...frameOf(box, active),
      icon: { ...pic, tint: item.has ? null : get('InactiveItemColor'), ...(hidden(pic.name) ? { hidden: true } : {}), ...box },
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
 * A ScalableImagePanel draws the same way with its own src_corner (texels),
 * which the kill notice box passes (mock.ts).
 */
export function drawNineSlice(ctx: CanvasRenderingContext2D, img: CanvasImageSource, tw: number, th: number,
  x: number, y: number, w: number, h: number, corner: number, src = SRC_CORNER) {
  const sx = [0, src, tw - src], sw = [src, tw - 2 * src, src];
  const sy = [0, src, th - src], sh = [src, th - 2 * src, src];
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
  panelWide: number, onAsset?: () => void, held: WeaponHeld = 'primary'): void {
  const px = (r: Rect): Rect => ({ x: origin.x + r.x * k, y: origin.y + r.y * k, w: r.w * k, h: r.h * k });
  // An imported HUD's own box and icon textures come first, where its cells point at them.
  const key = design.preset === 'imported' ? baseOf(design) : null;
  for (const s of weaponSlots(design, design.aspect, panelWide, held)) {
    const frame = px(s.frame);
    const ownBox = key && s.art ? importedMaterial(key, s.art, scratchCanvas) : null;
    // The upload's .vmt may point at a texture it does not carry; the game then draws the stock one it names.
    const box = s.art && !(ownBox && 'src' in ownBox) ? artImage(ownBox && 'stock' in ownBox ? ownBox.stock : s.art, onAsset) : undefined;
    const boxUpload = s.image ? design.images[s.image] : undefined;
    const boxPic = boxUpload ? storedImage(boxUpload, onAsset) : undefined;
    if (boxUpload) {
      // The game nine-slices an uploaded box like the stock art, 16-texel
      // corners kept square (/home/volence/l4d/hud/probe-phase2-rest/r1/shots/crops/weap-d.png).
      if (boxPic) {
        ctx.save();
        ctx.globalAlpha *= BOX_ALPHA;
        drawNineSlice(ctx, boxPic.img, boxUpload.w, boxUpload.h, frame.x, frame.y, frame.w, frame.h, s.corner * k);
        ctx.restore();
      }
    } else if (s.fill) {
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
    } else if (ownBox && 'src' in ownBox) {
      ctx.save();
      ctx.globalAlpha *= BOX_ALPHA;
      drawNineSlice(ctx, ownBox.src, ownBox.w, ownBox.h, frame.x, frame.y, frame.w, frame.h, s.corner * k);
      ctx.restore();
    } else if (box) {
      ctx.save();
      ctx.globalAlpha *= BOX_ALPHA;
      drawNineSlice(ctx, box, box.naturalWidth, box.naturalHeight, frame.x, frame.y, frame.w, frame.h, s.corner * k);
      ctx.restore();
    } else if (s.art && isMissing(s.art)) hatch(ctx, { name: s.art, kind: 'image', visible: true, ...frame });

    const icon = px(s.icon);
    const upload = s.icon.upload && !s.icon.hidden ? design.images[s.icon.upload] : undefined;
    // An imported HUD that repoints an icon's cell at its own texture shows its own art, cut from that cell.
    const cellOf = key && !s.icon.hidden && !upload ? iconCell(design, s.icon.name.replaceAll('/', '_')) : undefined;
    const ownIcon = key && cellOf ? importedMaterial(key, cellOf.file, scratchCanvas) : null;
    const img = s.icon.hidden || upload || (ownIcon && 'src' in ownIcon) ? undefined : artImage(s.icon.name, onAsset);
    if (upload) {
      // Drawn in its own colours, an item the player lacks multiplied by
      // InactiveItemColor as stock icons are (r1/shots/crops/weap-a.png).
      const pic = storedImage(upload, onAsset);
      if (pic) {
        ctx.save();
        let src: CanvasImageSource = pic.img;
        if (s.icon.tint) {
          const [r, g, b, a] = rgbaOf(design, s.icon.tint);
          if (r < 255 || g < 255 || b < 255) src = tinted(pic.img, pic.key, r, g, b, upload.w, upload.h);
          ctx.globalAlpha *= a / 255;
        }
        ctx.drawImage(src, icon.x, icon.y, icon.w, icon.h);
        ctx.restore();
      }
    } else if (cellOf && ownIcon && 'src' in ownIcon) {
      ctx.save();
      let src: CanvasImageSource = ownIcon.src;
      if (s.icon.tint) {
        const [r, g, b, a] = rgbaOf(design, s.icon.tint);
        if (r < 255 || g < 255 || b < 255) src = tinted(ownIcon.src, `${key}|${cellOf.file}`, r, g, b, ownIcon.w, ownIcon.h);
        ctx.globalAlpha *= a / 255;
      }
      ctx.drawImage(src, cellOf.x, cellOf.y, cellOf.w, cellOf.h, icon.x, icon.y, icon.w, icon.h);
      ctx.restore();
    } else if (img) {
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

    // Each number's y is the top of its font's cell, where the game starts
    // drawing it, so the baseline is the face's ascent below that.
    for (const t of s.texts) {
      ctx.save();
      const cell = setFont(ctx, design, t.font, k, onAsset);
      ctx.fillStyle = colourOf(design, t.colour ?? undefined);
      ctx.textAlign = t.align;
      fillFontText(ctx, cell, t.text, origin.x + t.x * k, origin.y + t.y * k + cell.ascent, origin.y + t.y * k);
      ctx.restore();
    }
  }
}
