/**
 * "Your items": your own medkit, pills and throwable as one row placed
 * anywhere at or right of your health bar
 * (docs/superpowers/specs/2026-09-25-hud-editor-your-items-design.md).
 *
 * The geometry, pure: where the preview draws the row and what Items Label
 * the download writes for it, from the four numbers that decide both (the
 * health bar's drawn x, the screen width, the font's tall, the alignment).
 * build.ts reads those numbers off a design (yourItemsInput); nothing here
 * reads a design, so every rule is tested on plain numbers.
 *
 * Why the bar: client.dll puts your health bar at the own panel's Items
 * child's x, at spawn and after every revive (probe-own-items v2: an Items
 * at x 20 pulled the bar to x 20, /home/volence/l4d/hud/probe-own-items/RESULTS.md).
 * So the Label starts at the bar's x and the glyphs can only sit at or right
 * of it. Right and Centre are resolution independent; Left would need
 * textinsetx, which is raw screen pixels (probe-your-items p1: 40 put the
 * glyphs 40 px in at 1080p, not 90; p2: 400 put them 400 px in,
 * /home/volence/l4d/hud/probe-your-items/RESULTS.md).
 */
import type { Box } from './design';
import { ICON_ADVANCE, ICON_SPACE, ICON_CELL_EM, ICON_EM_PER_TALL } from './iconMetrics';
import { SCREEN_H } from './units';

export const YOUR_ITEMS = 'yourItems';

/** The game's three item icon fonts (the ToolBox face at three talls in both presets' clientscheme.res). */
export type ItemFont = 'L4D_Icons' | 'L4D_Icons_medium' | 'L4D_Icons_large';
export const ITEM_FONTS: readonly ItemFont[] = ['L4D_Icons', 'L4D_Icons_medium', 'L4D_Icons_large'];
/** The stock teammate card's Items font. */
export const DEFAULT_ITEM_FONT: ItemFont = 'L4D_Icons_medium';
/** Each font's tall in the stock and Modern schemes: the fallback when a scheme lacks the font. */
export const ITEM_FONT_TALL: Readonly<Record<ItemFont, number>> = { L4D_Icons: 16, L4D_Icons_medium: 18, L4D_Icons_large: 24 };
export const ITEM_FONT_LABELS: Readonly<Record<ItemFont, string>> = {
  L4D_Icons: 'Small (16)', L4D_Icons_medium: 'Medium (18)', L4D_Icons_large: 'Large (24)',
};

/** Which end of the row stays put as items come and go: the Label's textAlignment east or center. */
export type ItemAlign = 'right' | 'center';

/**
 * The row the preview shows: a full loadout, in the order the game writes it.
 * client.dll builds the Items label's text as the medkit ('!'), the pills
 * ('"'), then one throwable (the pipe bomb '$', or the molotov '#' when that
 * is what is carried), with a space between each; a survivor carries one
 * throwable, so the row shows the pipe bomb.
 */
export const ITEM_ROW: readonly string[] = ['icon/item/medkit', 'icon/item/pills', 'icon/item/pipebomb'];

/** How wide the row is with the glyph PNGs s units (or canvas pixels) tall: each glyph's advance, and a space between two. */
export function glyphRowWidth(s: number): number {
  return ITEM_ROW.reduce((w, name, i) => w + (ICON_ADVANCE[name] ?? 1) * s + (i ? ICON_SPACE * s : 0), 0);
}

/**
 * The glyph PNG's height, units, for an item font `tall` units tall: the
 * face's unhinted em for that tall (ICON_EM_PER_TALL, never smaller than
 * the em the game picks from VDMX at any common resolution) times the PNG
 * cell's share of the em (ICON_CELL_EM). About 0.834 of the tall: the game
 * does not fit the glyph cell to the tall, iconMetrics.ts has the probe p4
 * measurements.
 */
export function itemGlyphCell(tall: number): number {
  return tall * ICON_EM_PER_TALL * ICON_CELL_EM;
}

/** How wide the row is, units, in an item font `tall` units tall (glyphRowWidth at itemGlyphCell). */
export function itemRowWidth(tall: number): number {
  return glyphRowWidth(itemGlyphCell(tall));
}

/**
 * Units the Label reaches above and below the glyph cell: medium's 18 becomes
 * a 24-tall Label, the one probe p3 drew (a Label as tall as its font risks
 * clipping the glyph's last pixel row).
 */
export const LABEL_PAD = 3;
/**
 * Units the Label stays in from the screen's right edge: probe-own-items v3
 * saw an east-aligned medkit glyph cut where its Label ended exactly at the
 * edge (runs/v3 5-pipe-thrown).
 */
export const EDGE_MARGIN = 2;

export interface RowInput {
  /** Your health bar's drawn x on screen, units. */
  barX: number;
  screenW: number;
  /** The font's tall, units. */
  tall: number;
  align: ItemAlign;
}
export interface RowLayout {
  /** The glyph row as the preview draws it, a full loadout wide. */
  row: Box;
  /** The Items Label the download writes, in screen units. */
  label: Box;
}
/** A limit drawn while the row is placed: everything on `side` of `x` is out of reach. */
export interface LimitLine { x: number; side: 'left' | 'right'; label: string }
export const BAR_EDGE_LABEL = "Your health bar's edge";
export const CENTRE_EDGE_LABEL = 'Right limit for a centred row';

/**
 * The Label's narrowest and widest wide, whole units: never narrower than the
 * row, never past EDGE_MARGIN from the screen edge. Centre's is even, so its
 * centre is a whole unit from the bar. The narrowest wins where they cross:
 * the bar's edge is the rule the game enforces, the screen edge only clips.
 */
function labelWidths(inp: RowInput): { min: number; max: number } {
  const rowW = itemRowWidth(inp.tall);
  const room = inp.screenW - EDGE_MARGIN - inp.barX;
  if (inp.align === 'center') {
    const min = 2 * Math.ceil(rowW / 2);
    return { min, max: Math.max(min, 2 * Math.floor(room / 2)) };
  }
  const min = Math.ceil(rowW);
  return { min, max: Math.max(min, Math.floor(room)) };
}

/** Where the row is drawn in a Label `w` wide: its right end at the Label's (east), or its centre at the Label's (center). */
function rowXFor(inp: RowInput, w: number): number {
  const rowW = itemRowWidth(inp.tall);
  return inp.align === 'center' ? inp.barX + w / 2 - rowW / 2 : inp.barX + w - rowW;
}

/** The drawn row's x range: from the bar's edge to the screen's (Centre: the widest centre that fits). */
export function rowXRange(inp: RowInput): { min: number; max: number } {
  const w = labelWidths(inp);
  return { min: rowXFor(inp, w.min), max: rowXFor(inp, w.max) };
}

/**
 * The row stored at `at` (its box's top-left) as the game draws it: the
 * Label from the bar's x, as wide as puts the row's steady end nearest where
 * it was asked, held by labelWidths; its y whole and on screen.
 */
export function rowLayout(inp: RowInput, at: { x: number; y: number }): RowLayout {
  const rowW = itemRowWidth(inp.tall);
  const { min, max } = labelWidths(inp);
  const want = inp.align === 'center' ? 2 * Math.round(at.x + rowW / 2 - inp.barX) : Math.round(at.x + rowW - inp.barX);
  const w = Math.min(max, Math.max(min, want));
  const y = Math.min(SCREEN_H - inp.tall, Math.max(0, Math.round(at.y)));
  return {
    row: { x: rowXFor(inp, w), y, w: rowW, h: inp.tall },
    label: { x: inp.barX, y: y - LABEL_PAD, w, h: inp.tall + 2 * LABEL_PAD },
  };
}

/**
 * The stored numbers for a row asked for at `want` (a drag, an arrow, a typed
 * X): whole units, the x held to the whole units that still draw inside the
 * drawn range (rowXRange): rowLayout rounds the Label's wide, so a stored x
 * within half a unit of a limit draws exactly at it. A press past a limit
 * stores the limit, and a stored x always reads back from where it is drawn
 * (Math.round of the drawn x), so an arrow press never jumps.
 */
export function placeRow(inp: RowInput, want: { x: number; y: number }): { x: number; y: number } {
  const r = rowXRange(inp);
  const x = Math.min(Math.floor(r.max + 0.5), Math.max(Math.ceil(r.min - 0.5), Math.round(want.x)));
  const y = Math.min(SCREEN_H - inp.tall, Math.max(0, Math.round(want.y)));
  return { x, y };
}

/**
 * What the editor shows while the row is selected (spec section 2): the bar's
 * edge always, and for Centre the right end of the widest centred row when
 * that is short of the screen edge. Right's own right limit is the screen
 * edge less EDGE_MARGIN, which needs no line.
 */
export function rowLimitLines(inp: RowInput): LimitLine[] {
  const lines: LimitLine[] = [{ x: inp.barX, side: 'left', label: BAR_EDGE_LABEL }];
  if (inp.align === 'center') {
    const right = rowXRange(inp).max + itemRowWidth(inp.tall);
    if (right < inp.screenW) lines.push({ x: right, side: 'right', label: CENTRE_EDGE_LABEL });
  }
  return lines;
}
