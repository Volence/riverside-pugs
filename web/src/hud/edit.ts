/**
 * Every edit the HUD editor page applies to a design, as pure functions
 * from one HudDesign to the next. The page decides which one a gesture or a
 * control means and records it in its history; nothing here knows about
 * pointers, keys or the DOM. Every result goes through the same clamps the
 * validator uses, so a design built here is always one the generator takes.
 *
 * Positions are read back from the generator (elementRect, teamCardRects,
 * panelChild), never worked out here, so an edit starts from exactly what the
 * canvas draws.
 */
import {
  clampOverride, clampChild, clampPos, clampRowGap, fitMovesContainer, DEFAULT_DESIGN, newDesign,
  type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type Box, type WeaponsOverride, type ImportedRef,
  type UploadedImage, WEAPON_BOX_IMAGE, weaponIconId,
} from './design';
import { screenW, SCREEN_H } from './units';
import { elementById } from './elements';
import { elementRect, elementFitShift, drawnAt, pieceMovableIn, teamLayout, teamCardRects, isFreeTeam, panelChild, panelLink, buildTrees, panelBgZpos, type CardChild } from './build';
import { childDef, childPath, panelChildren, panelOfFile, linkedValue, unlinkedValue } from './children';
import { kvFind, kvGet } from './kv';
import { unionBox, CORNERS, type Handle } from './guides';
import { elementFrame, panelClamp, panelOf, type Selection } from './selection';

// The clamp box lives in selection.ts (edit.ts already imports selection.ts,
// so the reverse import would make a loop); it is offered from here too, the
// module every child edit goes through.
export { panelClamp };
import type { CrosshairArt } from '../crosshair/model';
import { splatterDef, type SplatterId, type SplatterKind, type SplatterStyle } from './splatter';

/** Keeps at least `min` units of a span on screen, whichever side it drifts to. */
/**
 * The stored number for a drawn target when the element is drawn `bias`
 * away from what it stores: the target is rounded as it always was
 * (Math.round, which is also how the X and Y boxes show a place), and the
 * stored number is the one whose drawn place shows as that, so a place
 * drawn at 300.5 (shown 301) stores 300 again when 301 comes back.
 */
const storedFor = (want: number, bias: number): number => Math.ceil(Math.round(want) - bias - 0.5) + 0;

export function clampSpan(v: number, size: number, extent: number, min: number): number {
  return Math.min(extent - min, Math.max(min - size, v));
}

/**
 * Move an element by (dx, dy), starting from its base position the first
 * time it is touched. Starts from `elementRect`, the same function the
 * canvas and the generator use, so every nudge starts from exactly where
 * the element is drawn. An element the game places itself cannot move, so
 * it is returned unchanged, `===` and all, which is what lets a caller skip
 * a re-render when nothing happened.
 *
 * Goes through `placeElement`, the same clamp and rounding a drag uses, so
 * repeated arrow presses cannot walk an element arbitrarily far off screen
 * the way a plain `x + dx` would, and a drag and the keyboard always agree
 * on where an element lands.
 */
export function nudge(design: HudDesign, id: string, dx: number, dy: number): HudDesign {
  const el = elementById(id);
  // In Free each card places itself: the element's own position would move nothing.
  if (!el || !el.move || (id === 'teamColumn' && isFreeTeam(design))) return design;
  // From where the element is drawn, not the stored x and y: a team the
  // on-screen clamp holds at the edge is drawn there whatever it stores, and
  // a press back from the edge must move it at once.
  const base = elementRect(design, id, design.aspect);
  return placeElement(design, id, base.x + dx, base.y + dy);
}

/** Whether the elements differ from a fresh design's. Not the same as having
 *  none: a fresh design already fits the teammate card. */
export function elementsTouched(d: HudDesign): boolean {
  return JSON.stringify(d.elements) !== JSON.stringify(DEFAULT_DESIGN.elements);
}

/**
 * Whether switching this design's base should ask "keep or reset" first. On
 * an imported HUD, a design with no edits has none at all (withImport starts
 * it that way); on Stock and Modern it is elementsTouched, whose default is
 * the fitted teammates.
 */
export function hasLayoutEdits(d: HudDesign): boolean {
  const children = Object.keys(d.children).length > 0;
  return d.preset === 'imported' ? Object.keys(d.elements).length > 0 || children : elementsTouched(d) || children;
}

/**
 * A design moved onto an imported HUD: Import a HUD, or picking an import in
 * the Preset select. Edits the player keeps come along; a design with none,
 * or a reset, starts with none, so the HUD shows exactly as its author made
 * it (not even the default fitted teammates). Fonts are the HUD's own. The
 * crosshair: the upload's own altcrosshair texture becomes a bundled image
 * crosshair (`art`), which downloads as the upload's own files for as long
 * as the player leaves it (build.ts's ownCrosshair); with no texture but an
 * xHair element in its layout (`hasXhair`), the HUD was made to show a
 * crosshair addon's texture, so a design on the game's crosshair becomes
 * 'addon', which says so; otherwise the player's own choice stands. The
 * HUD's own xHair element is kept whichever it is.
 */
export function withImport(d: HudDesign, ref: ImportedRef, o: { art: CrosshairArt | null; hasXhair: boolean; reset: boolean }): HudDesign {
  const keep = !o.reset && hasLayoutEdits(d);
  const out: HudDesign = {
    ...d, preset: 'imported', imported: { ...ref }, font: 'preset',
    elements: keep ? d.elements : {}, children: keep ? d.children : {},
  };
  if (o.art) { out.crosshair = 'bundle'; out.xhairArt = structuredClone(o.art); }
  else if (o.hasXhair && d.crosshair === 'none') out.crosshair = 'addon';
  return out;
}

/** A design moved to Stock or Modern: no import, and the default teammates back when it had no edits or the player reset. */
export function withPreset(d: HudDesign, preset: 'stock' | 'modern', reset: boolean): HudDesign {
  const { imported: _dropped, ...rest } = d;
  const fresh = reset || (d.preset === 'imported' && !hasLayoutEdits(d));
  return { ...rest, preset, ...(fresh ? { elements: structuredClone(DEFAULT_DESIGN.elements), children: {} } : {}) };
}

/** Whether a design holds anything beyond the untouched defaults: decides
 *  whether loading a share link needs to ask first rather than silently
 *  overwriting whatever a reader already had going. `saved` is this
 *  browser's own crosshair (the Crosshair page's storage), since a fresh
 *  design on one that has a crosshair saved already starts carrying it
 *  (newDesign), not the static default 'none': measuring against that fixed
 *  default would both ask to replace a reader's untouched design and miss
 *  it when they deliberately turned their crosshair off or changed it. */
export function hasOverrides(d: HudDesign, saved: CrosshairArt | null): boolean {
  const fresh = newDesign(saved);
  return elementsTouched(d)
    || Object.keys(d.children).length > 0
    || Object.keys(d.styles).length > 0
    || Object.keys(d.images).length > 0
    || Object.keys(d.splatters ?? {}).length > 0
    || d.hideGameCrosshair === true
    || d.weapons !== undefined
    || d.crosshair !== fresh.crosshair
    || JSON.stringify(d.xhairArt) !== JSON.stringify(fresh.xhairArt)
    || d.preset !== DEFAULT_DESIGN.preset
    || d.aspect !== DEFAULT_DESIGN.aspect
    || d.font !== DEFAULT_DESIGN.font
    || d.advanced !== DEFAULT_DESIGN.advanced;
}

/** "Reset this element": back to what a fresh design has for it, which for
 *  the teammates is a fitted card with no inside edits, not nothing. */
export function resetElement(d: HudDesign, id: string): HudDesign {
  const elements = { ...d.elements };
  const fresh = DEFAULT_DESIGN.elements[id];
  if (fresh) elements[id] = structuredClone(fresh); else delete elements[id];
  const children = { ...d.children };
  delete children[id];
  const out = { ...d, elements, children };
  // The weapon selection's own keys, boxes and pictures are part of it.
  if (id === 'weaponSelection') delete out.weapons;
  return out;
}

/**
 * Merge weapon edits into a design. A field given as undefined goes back to
 * the preset's, and a design left with no weapon edits carries no `weapons`
 * at all, so its download is the untouched one again.
 */
export function patchWeapons(d: HudDesign, p: Partial<WeaponsOverride>): HudDesign {
  const weapons: Record<string, unknown> = { ...d.weapons, ...p };
  for (const k of Object.keys(weapons)) if (weapons[k] === undefined) delete weapons[k];
  const out: HudDesign = { ...d, weapons: weapons as WeaponsOverride };
  if (!Object.keys(weapons).length) delete out.weapons;
  return out;
}

/**
 * Store a weapon upload, already redrawn at its texels (weaponUploadSize),
 * and use it: an icon entry's picture goes under weaponIconId(entry) and is
 * named in weapons.icons; a box's under WEAPON_BOX_IMAGE and the box becomes
 * an Image. One design in, one out: a single undo step.
 */
export function withWeaponUpload(d: HudDesign, target: string, img: UploadedImage): HudDesign {
  if (target === 'boxActive' || target === 'boxInactive') {
    return patchWeapons({ ...d, images: { ...d.images, [WEAPON_BOX_IMAGE[target]]: img } }, { [target]: { kind: 'image' } });
  }
  const id = weaponIconId(target);
  return patchWeapons({ ...d, images: { ...d.images, [id]: img } }, { icons: { ...d.weapons?.icons, [target]: id } });
}

/** Back to the game's art: the stored picture gone, and an Image box back to stock. */
export function resetWeaponUpload(d: HudDesign, target: string): HudDesign {
  const images = { ...d.images };
  if (target === 'boxActive' || target === 'boxInactive') {
    delete images[WEAPON_BOX_IMAGE[target]];
    const p = d.weapons?.[target]?.kind === 'image' ? { [target]: undefined } : {};
    return patchWeapons({ ...d, images }, p);
  }
  delete images[weaponIconId(target)];
  const icons = { ...d.weapons?.icons };
  delete icons[target];
  return patchWeapons({ ...d, images }, { icons: Object.keys(icons).length ? icons : undefined });
}

/**
 * The "Ammo only" look: probe B's values, which the owner saw in game on
 * 2026-09-23 as "8 128 30" on one line just right of the crosshair. The
 * panel sits at c-10, c-12 (its 100 wide is both presets' own); the boxes
 * are 0 and Hidden, every picture is off and IconSize 0 drops the item
 * slots; the clip ends 48 in from the panel's right, the reserve follows on
 * the same line and the pistol clip sits at the far end. Probe B named HudAmmo for the clip; here the clip keeps
 * its own font at HudAmmo's size, 18, which is the same face.
 *
 * Two changes from probe B, from the owner's tests 1 and 3 in game. The
 * pistol row starts two 640-units under the gun's (zero) box, which put its
 * clip that much below the line; a PistolBoxTall of minus four 640-units
 * centres the row back on it. With the box that far up the pistol clip ends
 * past the panel's right edge and was cut off, so an inset of 6 brings it
 * back inside; the gun's numbers are measured from the panel, not the inset,
 * so they stay where probe B had them.
 *
 * One design in, one out, so the page records it as a single undo step. The
 * player's colours and the element's visibility stay; every other weapon
 * edit is replaced, so the result is probe B whatever came before. Probe B
 * also made the panel 60 tall, which the editor cannot write (the element
 * has no size of its own); the stock 160 only reaches further down, empty.
 */
export function ammoOnly(d: HudDesign): HudDesign {
  const keep: WeaponsOverride = {};
  if (d.weapons?.reserveColor) keep.reserveColor = d.weapons.reserveColor;
  if (d.weapons?.inactiveColor) keep.inactiveColor = d.weapons.inactiveColor;
  const weapons: WeaponsOverride = {
    ...keep,
    primaryY: 12, primaryBoxW: 0, primaryBoxH: 0, pistolBoxW: 0, pistolBoxH: -Math.round(4 * screenW(d.aspect) / 640), indent: 6,
    ammoX: 48, reserveY: 0, itemSize: 0, clipFont: 18, pistolFont: 18,
    boxActive: { kind: 'hidden' }, boxInactive: { kind: 'hidden' }, weaponIcons: false, itemIcons: false,
  };
  const x = clampOverride('x', screenW(d.aspect) / 2 - 10);
  const y = clampOverride('y', SCREEN_H / 2 - 12);
  return { ...d, weapons, elements: { ...d.elements, weaponSelection: { ...d.elements.weaponSelection, x, y } } };
}

/**
 * Where a Free card is drawn relative to its slot: the fit offset, scaled,
 * straight from teamLayout. A slot stores the card's unfitted origin, so every
 * control that thinks in drawn positions (the drag, the arrows, the X and Y
 * boxes) adds this to show a slot and takes it off to store one.
 */
export function cardOffset(design: HudDesign): { x: number; y: number } {
  return teamLayout(design, elementById('teamColumn')!).offset ?? { x: 0, y: 0 };
}

/**
 * Switch the survivor team's layout. Going into Free for the first time
 * copies where each card sits now into `slots`, read from the generated file
 * like everything the canvas draws, less the fit offset, so nothing jumps;
 * leaving Free keeps them, so coming back restores the cards where the
 * player left them.
 */
export function withTeamDir(d: HudDesign, dir: TeamDir): HudDesign {
  const cur = d.elements.teamColumn ?? {};
  const next: ElementOverride = { ...cur, dir };
  if (dir === 'free' && !cur.slots) {
    const off = cardOffset(d);
    next.slots = teamCardRects(d, d.aspect).map((r) => ({ x: Math.round(r.x - off.x), y: Math.round(r.y - off.y) }));
  }
  return { ...d, elements: { ...d.elements, teamColumn: next } };
}

/**
 * The survivor team laid out Free with every card where it is drawn now:
 * what moving one card of a Row or Column team starts from, so that card
 * can move alone and the others stay put. Slots a past Free layout left
 * behind are dropped first, so withTeamDir seeds all four from the cards'
 * drawn places rather than bringing the old ones back. A team already Free
 * is returned unchanged, `===`.
 */
export function freeInPlace(d: HudDesign): HudDesign {
  if (isFreeTeam(d)) return d;
  const { slots: _stale, ...rest } = d.elements.teamColumn ?? {};
  return withTeamDir({ ...d, elements: { ...d.elements, teamColumn: rest } }, 'free');
}

/**
 * Where each of the four cards is drawn once the team is Free: its slot plus
 * the fit offset, sized as teamCardRects sizes it. This is what the X and Y
 * boxes show and take, since teamCardRects' centre-anchor rounding can put a
 * card half a unit off its slot and a typed number must read back as typed.
 * A Row or Column team is measured as freeInPlace would lay it out.
 */
export function cardBoxes(design: HudDesign): Box[] {
  const d = freeInPlace(design);
  const off = cardOffset(d);
  const rects = teamCardRects(d, d.aspect);
  return (d.elements.teamColumn?.slots ?? []).map((s, i) => ({ x: s.x + off.x, y: s.y + off.y, w: rects[i].w, h: rects[i].h }));
}

/**
 * Draw one Free card's top-left at (x, y): its slot becomes that less the fit
 * offset, rounded to whole units (a drag's pointer position is a fractional
 * screen pixel divided back into HUD units, and a slot is stored, unlike a
 * gesture's live delta, so it has to land on a whole one, the same as any
 * other stored position), then clamped through the same table as an
 * element's position.
 */
export function placeCard(design: HudDesign, card: number, x: number, y: number): HudDesign {
  const o = design.elements.teamColumn;
  if (!o?.slots || !o.slots[card]) return design;
  const off = cardOffset(design);
  const at = { x: clampOverride('x', Math.round(x - off.x)), y: clampOverride('y', Math.round(y - off.y)) };
  const slots = o.slots.map((s, i) => (i === card ? at : s));
  return { ...design, elements: { ...design.elements, teamColumn: { ...o, slots } } };
}

/**
 * Nudge cards by (dx, dy) from where they are placed (cardBoxes, what the X
 * and Y boxes show, so three presses read as three more there), through the
 * same clamp a drag uses (moveCards), so repeated arrow presses cannot walk
 * them off screen. A Row or Column team goes Free first, as a drag does.
 */
export function nudgeCards(design: HudDesign, cards: number[], dx: number, dy: number): HudDesign {
  return moveCards(design, cards, cardStarts(design, cards), dx, dy);
}

/** Where a gesture on these cards starts them: their cardBoxes, keyed by card. */
export function cardStarts(design: HudDesign, cards: number[]): Record<number, Box> {
  const boxes = cardBoxes(design);
  return Object.fromEntries(cards.filter((c) => boxes[c]).map((c) => [c, boxes[c]]));
}

/**
 * Where a panel's piece is now, in its file's unfitted frame, as a gesture
 * starts from it: panelChild without the typed keys and zpos, which no
 * gesture moves.
 *
 * `file`, on this and every piece helper below, is the file the piece is
 * seen in: one of the panel's linked files (your infected health shown as
 * the Smoker or the Boomer, render.ts panelFile). Positions and sizes are
 * read and taken in that file's own frame and stored back in the panel
 * file's (plan decision 3): what the player sees on the Boomer is what the
 * Boomer file gets. The panel's own file, or none, changes nothing.
 */
function childAt(design: HudDesign, panel: string, name: string, file?: string): CardChild | null {
  const c = panelChild(design, panel, name, file);
  if (!c) return null;
  const { keys: _keys, z: _z, ...plain } = c;
  return plain;
}

/**
 * Merge into one panel child's override. Every child helper below takes the
 * panel last, defaulting to the teammate card, so the Phase 1 calls read as
 * they always did.
 */
export function patchChild(design: HudDesign, name: string, p1: Partial<ChildOverride>, panel = 'teamColumn', file?: string): HudDesign {
  // A place or size seen where it cannot be mapped back (build.ts pieceMovableIn) is dropped, and nothing else left is no edit.
  let p0 = p1;
  if (file && !pieceMovableIn(design, panel, name, file)) {
    const { x: _x, y: _y, w: _w, h: _h, ...rest } = p1;
    if (!Object.keys(rest).length) return design;
    p0 = rest;
  }
  const p = file ? storedFrame(design, name, p0, panel, file) : p0;
  const mate = LINKED_X[panel]?.[name.toLowerCase()];
  if (p.x === undefined || !mate) return mergeChild(design, name, p, panel);
  const was = panelChild(design, panel, name), other = panelChild(design, panel, mate);
  if (!was || !other) return mergeChild(design, name, p, panel);
  // x is the drawn x, which panelChild reports (a card bar's is its Items x):
  // the move is a delta, applied to each block's own x, so the pair keeps
  // the file's offset and the bar lands at the x asked for.
  const dx = p.x - was.x;
  const next = mergeChild(design, name, { ...p, x: clampChild('x', Math.round((was.ownX ?? was.x) + dx)) }, panel);
  if (dx === 0) return next;
  return mergeChild(next, mate, { x: clampChild('x', Math.round((other.ownX ?? other.x) + dx)) }, panel);
}

/** A patch seen in a linked file, back in the panel file's frame (unlinkedValue), rounded and clamped as stored numbers are. */
function storedFrame(design: HudDesign, name: string, p: Partial<ChildOverride>, panel: string, file: string): Partial<ChildOverride> {
  const link = panelLink(design, panel, name, file);
  if (!link) return p;
  const out: Partial<ChildOverride> = { ...p };
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    if (p[k] !== undefined) out[k] = clampChild(k, Math.round(unlinkedValue(link.rule, k, p[k]!, link.from, link.to) as number));
  }
  return out;
}

function mergeChild(design: HudDesign, name: string, p: Partial<ChildOverride>, panel: string): HudDesign {
  const kids = design.children[panel] ?? {};
  return { ...design, children: { ...design.children, [panel]: { ...kids, [name]: { ...(kids[name] ?? {}), ...p } } } };
}

/**
 * Pieces whose x moves together (the card revive trap). client.dll's player
 * panel update (1023f5df..1023f6da, the class shared by your own panel and
 * the cards) moves Health to the down picture's x while it shows and, when
 * it hides, to the x of the panel's Items child. On a card Items is the item
 * row, and probe X15 (/home/volence/l4d/hud/probe-2f/x15/RESULTS.md) showed
 * the card bar at the row's x from the first frame of the map, not only
 * after a revive: a bar dragged alone never moved in game. Any x edit to
 * one moves the other by the same delta, keeping the offset the file has
 * (stock: bar 37, items 39; the game draws the stock bar at 39). Your own
 * panel's Items is the hidden anchor build.ts's reviveAnchorPass places at
 * the bar, so it needs no link.
 */
const LINKED_X: Record<string, Record<string, string>> = { teamColumn: { health: 'Items', items: 'Health' } };

/**
 * For a panel whose pieces are written to linked files (your infected
 * health: the Hunter's file, the Smoker's and the Boomer's, which the Tank
 * reads through the Hunter's), whether a box for a piece seen in `file`
 * keeps it inside the panel's container (panelClamp) in every one of them,
 * or null for any other panel. The box is taken back to the stored frame as
 * storedFrame does and out to each file as build.ts's childPass writes it,
 * so the check is on the numbers the files will carry. A piece that starts
 * past an edge in some file (the stock Hunter frame runs to 450 of 400) may
 * stay as far past it, never further: a nudge does not yank it in, and
 * nothing is pushed out of view in any class.
 */
function linkedHolds(design: HudDesign, panel: string, name: string, file: string | undefined, start: Box): ((b: Box) => boolean) | null {
  const reg = panelChildren(panel);
  if (!reg?.linked) return null;
  const C = panelClamp(design, panel);
  const seen = file ? panelLink(design, panel, name, file) : null;
  const links = reg.linked.map((l) => panelLink(design, panel, name, l.file)).filter((l): l is NonNullable<typeof l> => !!l);
  const map = (b: Box, f: (k: 'x' | 'y' | 'w' | 'h', v: number) => number): Box => ({ x: f('x', b.x), y: f('y', b.y), w: f('w', b.w), h: f('h', b.h) });
  const everywhere = (b: Box): Box[] => {
    const s = seen ? map(b, (k, v) => clampChild(k, Math.round(unlinkedValue(seen.rule, k, v, seen.from, seen.to) as number))) : b;
    return [s, ...links.map((l) => map(s, (k, v) => linkedValue(l.rule, k, v, l.from, l.to) as number))];
  };
  const past = (b: Box) => everywhere(b).flatMap((r) => [-r.x, -r.y, r.x + r.w - C.w, r.y + r.h - C.h].map((v) => Math.max(0, v)));
  const allowed = past(start);
  return (b) => past(b).every((v, i) => v <= allowed[i]);
}

/** The largest t in 0..1 (to about 1/65536) at which ok holds, given that it holds at 0: how far a gesture may go before a linked check stops it. */
function furthest(ok: (t: number) => boolean): number {
  if (ok(1)) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 16; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return lo;
}

/** A piece's box moved toward (x, y) as far as `holds` allows, each axis on its own, rounded: a drag along an edge still slides. */
function slideHeld(r: Box, x: number, y: number, holds: (b: Box) => boolean): { x: number; y: number } {
  const at = (t: number, from: number, to: number) => Math.round(from + t * (to - from));
  const nx = at(furthest((t) => holds({ ...r, x: at(t, r.x, x) })), r.x, x);
  const ny = at(furthest((t) => holds({ ...r, x: nx, y: at(t, r.y, y) })), r.y, y);
  return { x: nx, y: ny };
}

/**
 * Place a panel child at (x, y): unscaled units in the panel file's own
 * unfitted frame, rounded, clamped inside the panel's clamp box (panelClamp:
 * for the teammate card the unfitted card, 150 x 150 on stock). The clamp is
 * the unfitted card, not the fitted one, or a child could never move past
 * the card it currently makes and nothing could grow.
 */
export function placeChild(design: HudDesign, name: string, x: number, y: number, panel = 'teamColumn', file?: string): HudDesign {
  const r = childAt(design, panel, name, file);
  if (!r || !childDef(panel, name)?.move) return design;
  const holds = linkedHolds(design, panel, name, file, r);
  if (holds) {
    const at = slideHeld(r, x, y, holds);
    return patchChild(design, name, { x: clampChild('x', at.x), y: clampChild('y', at.y) }, panel, file);
  }
  const p = panelClamp(design, panel);
  const cx = Math.round(Math.min(Math.max(0, p.w - r.w), Math.max(0, x)));
  const cy = Math.round(Math.min(Math.max(0, p.h - r.h), Math.max(0, y)));
  return patchChild(design, name, { x: clampChild('x', cx), y: clampChild('y', cy) }, panel, file);
}

/** Nudge a child from where it is now, through the same clamp as a drag. */
export function nudgeChild(design: HudDesign, name: string, dx: number, dy: number, panel = 'teamColumn', file?: string): HudDesign {
  const r = childAt(design, panel, name, file);
  return r ? placeChild(design, name, r.x + dx, r.y + dy, panel, file) : design;
}

/**
 * A box resized by one handle from `start` by (dx, dy): the dragged edges
 * move, the opposite edges stay put, no side below `min`. With `keepRatio`
 * a side handle carries the other dimension along in proportion (Shift on a
 * side handle). Corners are never ratio-locked here: square art and scaled
 * elements lock their own ratio.
 */
export function resizeBox(start: Box, handle: Handle, dx: number, dy: number, keepRatio: boolean, min: number): Box {
  let w = start.w, h = start.h;
  if (handle.includes('e')) w = start.w + dx;
  if (handle.includes('w')) w = start.w - dx;
  if (handle.includes('s')) h = start.h + dy;
  if (handle.includes('n')) h = start.h - dy;
  w = Math.max(min, Math.round(w));
  h = Math.max(min, Math.round(h));
  if (keepRatio && (handle === 'e' || handle === 'w')) h = Math.max(min, Math.round((start.h * w) / (start.w || 1)));
  if (keepRatio && (handle === 'n' || handle === 's')) w = Math.max(min, Math.round((start.w * h) / (start.h || 1)));
  return {
    x: handle.includes('w') ? start.x + start.w - w : start.x,
    y: handle.includes('n') ? start.y + start.h - h : start.y,
    w, h,
  };
}

/**
 * Resize one panel piece by a handle from where the gesture started it,
 * unscaled units, inside the panel's clamp box (the unfitted card). Width-and-height pieces take
 * any of the eight handles, and a left or top handle moves the origin so the
 * opposite edge stays put. Square art takes the corners only and grows by
 * the larger of the two deltas, keeping its ratio. The item icons have no
 * box of their own: a corner scales their icon size in proportion.
 */
export function resizeChild(
  design: HudDesign, name: string, start: CardChild, handle: Handle, dx: number, dy: number, keepRatio = false, panel = 'teamColumn', file?: string,
): HudDesign {
  const def = childDef(panel, name);
  if (!def) return design;
  const p = panelClamp(design, panel);
  if (def.box === 'none') {
    if (!def.font || start.fontTall === undefined || !CORNERS.includes(handle)) return design;
    return patchChild(design, name, { fontSize: clampChild('fontSize', Math.round(start.fontTall * cornerFactor(start, handle, dx, dy))) }, panel, file);
  }
  if (def.box === 'square') {
    if (!CORNERS.includes(handle)) return design;
    // The delta with the larger absolute value wins, as cornerFactor picks its
    // axis: a straight-in drag on one axis alone (the other delta 0) must
    // still shrink the piece, which Math.max of the two signed deltas would
    // miss whenever the moving one is negative.
    const sx = handle.includes('w') ? -dx : dx;
    const sy = handle.includes('n') ? -dy : dy;
    const grow = Math.abs(sx) >= Math.abs(sy) ? sx : sy;
    const held = linkedHolds(design, panel, name, file, start);
    if (held) {
      // Linked files: grown as far as it stays inside the container in every one (linkedHolds).
      const at = (t: number): Box => {
        const side = clampChild('w', Math.max(1, Math.round(start.w + t * grow)));
        return { x: handle.includes('w') ? start.x + start.w - side : start.x, y: handle.includes('n') ? start.y + start.h - side : start.y, w: side, h: side };
      };
      const b = at(furthest((t) => held(at(t))));
      const patch: Partial<ChildOverride> = { w: b.w, h: b.h };
      if (handle.includes('w')) patch.x = clampChild('x', b.x);
      if (handle.includes('n')) patch.y = clampChild('y', b.y);
      return patchChild(design, name, patch, panel, file);
    }
    const room = Math.min(handle.includes('w') ? start.x + start.w : p.w - start.x, handle.includes('n') ? start.y + start.h : p.h - start.y);
    const side = clampChild('w', Math.round(Math.min(Math.max(1, room), Math.max(1, start.w + grow))));
    const patch: Partial<ChildOverride> = { w: side, h: side };
    if (handle.includes('w')) patch.x = clampChild('x', start.x + start.w - side);
    if (handle.includes('n')) patch.y = clampChild('y', start.y + start.h - side);
    return patchChild(design, name, patch, panel, file);
  }
  const held = linkedHolds(design, panel, name, file, start);
  if (held) {
    // Linked files: the drag goes as far as the piece stays inside the container in every one (linkedHolds).
    const at = (t: number) => resizeBox(start, handle, t * dx, t * dy, keepRatio, 1);
    const b = at(furthest((t) => held(at(t))));
    const patch: Partial<ChildOverride> = { w: clampChild('w', b.w), h: clampChild('h', b.h) };
    if (handle.includes('w')) patch.x = clampChild('x', b.x);
    if (handle.includes('n')) patch.y = clampChild('y', b.y);
    return patchChild(design, name, patch, panel, file);
  }
  const b = resizeBox(start, handle, dx, dy, keepRatio, 1);
  // Inside the unfitted card: an edge dragged past the card stops at it.
  const left = Math.max(0, b.x), top = Math.max(0, b.y);
  const right = Math.min(p.w, b.x + b.w), bottom = Math.min(p.h, b.y + b.h);
  const patch: Partial<ChildOverride> = { w: clampChild('w', Math.max(1, right - left)), h: clampChild('h', Math.max(1, bottom - top)) };
  if (handle.includes('w')) patch.x = clampChild('x', left);
  if (handle.includes('n')) patch.y = clampChild('y', top);
  return patchChild(design, name, patch, panel, file);
}

/**
 * "Reset this child": drop the child's edits. Resetting an added child (the
 * stock health number) keeps it added: only its own Remove control takes it
 * away. The last edit gone, the card's map goes too, so a reset design is
 * the same value as one never touched.
 */
export function resetChild(d: HudDesign, name: string, panel = 'teamColumn'): HudDesign {
  const def = childDef(panel, name);
  const kids = { ...(d.children[panel] ?? {}) };
  const on = kids[name]?.on;
  delete kids[name];
  if (def?.addable && on !== undefined) kids[name] = { on };
  // A linked partner (LINKED_X) goes back to the file's x too, so the pair keeps the file's offset.
  const mate = LINKED_X[panel]?.[name.toLowerCase()];
  if (mate && kids[mate]?.x !== undefined) {
    const { x: _x, ...rest } = kids[mate];
    if (Object.keys(rest).length) kids[mate] = rest; else delete kids[mate];
  }
  const children: HudDesign['children'] = { ...d.children, [panel]: kids };
  if (Object.keys(kids).length === 0) delete children[panel];
  return { ...d, children };
}

/**
 * "Use the file's value" on one typed key (review M2): the design's value
 * for that key goes, and nothing else of the piece's edits, so the file's
 * own value (or the game's, when the file has none) is back. An emptied
 * keys object, piece and panel go too, as resetChild leaves them.
 */
export function resetChildKey(d: HudDesign, name: string, key: string, panel = 'teamColumn'): HudDesign {
  const kids = d.children[panel] ?? {};
  const o = kids[name];
  if (o?.keys?.[key] === undefined) return d;
  const { [key]: _gone, ...keys } = o.keys;
  const { keys: _old, ...rest } = o;
  const next: ChildOverride = Object.keys(keys).length ? { ...rest, keys } : rest;
  const left = { ...kids };
  if (Object.keys(next).length) left[name] = next; else delete left[name];
  const children: HudDesign['children'] = { ...d.children, [panel]: left };
  if (!Object.keys(left).length) delete children[panel];
  return { ...d, children };
}

/**
 * "Use the file's value" on one of an element's own keys (the ability
 * timer's state colours): that key's edit goes, and an emptied keys object
 * and element override go too, as resetChildKey leaves a piece.
 */
export function resetElementKey(d: HudDesign, id: string, key: string): HudDesign {
  const o = d.elements[id];
  if (o?.keys?.[key] === undefined) return d;
  const { [key]: _gone, ...keys } = o.keys;
  const { keys: _old, ...rest } = o;
  const next = Object.keys(keys).length ? { ...rest, keys } : rest;
  const elements = { ...d.elements };
  if (Object.keys(next).length) elements[id] = next; else delete elements[id];
  return { ...d, elements };
}

// --- several pieces of one panel at once ---

/** Where each named piece is now, in the unfitted frame: what a gesture starts from. Pieces the file lacks are left out. */
export function startsOf(design: HudDesign, names: string[], panel = 'teamColumn', file?: string): Record<string, CardChild> {
  const out: Record<string, CardChild> = {};
  for (const n of names) {
    const c = childAt(design, panel, n, file);
    if (c) out[n] = c;
  }
  return out;
}

/**
 * Move pieces by (dx, dy) from where a gesture started them, unscaled units.
 * The delta is clamped once for the whole group, against the panel's clamp
 * box (for the teammate card the unfitted card, the Phase 1 drag clamp), so the pieces keep their spacing when the group
 * meets an edge instead of piling up against it one by one. A name missing
 * from the registry, or with nothing to start from (an addable child not
 * yet in the file), is skipped. Every registered piece moves today, so
 * `childDef(panel, n)?.move` here currently means exactly "is `n` registered",
 * the same live case build.ts's childPass guards against with its own "not
 * an editable child" check; `?.move` stays rather than a plain existence
 * check only so a future non-movable child would not need this filter
 * touched again.
 */
export function moveChildren(
  design: HudDesign, names: string[], starts: Record<string, CardChild>, dx: number, dy: number, panel = 'teamColumn', file?: string,
): HudDesign {
  const p = panelClamp(design, panel);
  const list = names.filter((n) => childDef(panel, n)?.move && starts[n]);
  if (!list.length) return design;
  const held = list.map((n) => linkedHolds(design, panel, n, file, starts[n]));
  if (held.every((h) => h)) {
    // Linked files: one delta for the group, as far as every piece holds in every file, each axis on its own.
    const all = (ddx: number, ddy: number) => list.every((n, i) => held[i]!({ ...starts[n], x: starts[n].x + ddx, y: starts[n].y + ddy }));
    const hx = Math.round(furthest((t) => all(Math.round(t * dx), 0)) * dx);
    const hy = Math.round(furthest((t) => all(hx, Math.round(t * dy))) * dy);
    // Patched, not placed: placeChild would hold each piece to where it is
    // now, mid-gesture, not to where the gesture started it.
    let d = design;
    for (const n of list) d = patchChild(d, n, { x: clampChild('x', starts[n].x + hx), y: clampChild('y', starts[n].y + hy) }, panel, file);
    return d;
  }
  const cx = Math.min(Math.min(...list.map((n) => p.w - starts[n].w - starts[n].x)), Math.max(Math.max(...list.map((n) => -starts[n].x)), dx));
  const cy = Math.min(Math.min(...list.map((n) => p.h - starts[n].h - starts[n].y)), Math.max(Math.max(...list.map((n) => -starts[n].y)), dy));
  let d = design;
  for (const n of list) d = placeChild(d, n, starts[n].x + cx, starts[n].y + cy, panel, file);
  return d;
}

/** The group X and Y boxes: put the pieces' box at (x, y), moving all of them. */
export function placeChildren(design: HudDesign, names: string[], x: number, y: number, panel = 'teamColumn', file?: string): HudDesign {
  const starts = startsOf(design, names, panel, file);
  const box = unionBox(Object.values(starts));
  return box ? moveChildren(design, names, starts, x - box.x, y - box.y, panel, file) : design;
}

/**
 * One proportional factor from a corner drag: the box's new width or height
 * over its old, whichever changed more, never below 0.05 so a drag past the
 * opposite corner cannot flip or vanish the selection.
 */
export function cornerFactor(start: Box, handle: Handle, dx: number, dy: number): number {
  const sx = handle.includes('w') ? -dx : dx;
  const sy = handle.includes('n') ? -dy : dy;
  const fx = (start.w + sx) / (start.w || 1);
  const fy = (start.h + sy) / (start.h || 1);
  return Math.max(0.05, Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy);
}

/** The point that stays put while a handle drags: the corner (or side) opposite it. */
export function anchorOf(box: Box, handle: Handle): { x: number; y: number } {
  return { x: handle.includes('w') ? box.x + box.w : box.x, y: handle.includes('n') ? box.y + box.h : box.y };
}

/**
 * Scale pieces by `f` about `anchor`, from where the gesture started them:
 * positions and sizes both, so the group grows or shrinks as one. Square art
 * stays square; a label scales its text size with its box, and the item
 * icons (no box of their own) scale their icon size. Each size is capped to
 * the panel's clamp box first and each position then clamped inside it, as
 * placeChild does, so any factor leaves a valid design.
 */
export function scaleChildren(
  design: HudDesign, names: string[], starts: Record<string, CardChild>, anchor: { x: number; y: number }, f: number, panel = 'teamColumn', file?: string,
): HudDesign {
  const p = panelClamp(design, panel);
  let d = design;
  for (const n of names) {
    const def = childDef(panel, n);
    const s = starts[n];
    if (!def || !s) continue;
    const patch: Partial<ChildOverride> = {};
    let w = s.w, h = s.h;
    if (def.box === 'square') {
      w = h = Math.min(p.w, p.h, Math.max(1, Math.round(s.w * f)));
    } else if (def.box === 'wh') {
      w = Math.min(p.w, Math.max(1, Math.round(s.w * f)));
      h = Math.min(p.h, Math.max(1, Math.round(s.h * f)));
    }
    if (def.box !== 'none') { patch.w = clampChild('w', w); patch.h = clampChild('h', h); }
    if (def.font && s.fontTall !== undefined) patch.fontSize = clampChild('fontSize', Math.round(s.fontTall * f));
    const held = def.move && def.box !== 'none' ? linkedHolds(design, panel, n, file, s) : null;
    if (held) {
      // Linked files: this piece scales as far toward f as it stays inside the container in every one (linkedHolds).
      const at = (t: number): Box => {
        const g = 1 + t * (f - 1);
        const w1 = Math.max(1, Math.round(s.w * g)), h1 = def.box === 'square' ? w1 : Math.max(1, Math.round(s.h * g));
        return { x: Math.round(anchor.x + (s.x - anchor.x) * g), y: Math.round(anchor.y + (s.y - anchor.y) * g), w: w1, h: h1 };
      };
      const b = at(furthest((t) => held(at(t))));
      d = patchChild(d, n, { ...patch, x: clampChild('x', b.x), y: clampChild('y', b.y), w: clampChild('w', b.w), h: clampChild('h', b.h) }, panel, file);
      continue;
    }
    if (def.move) {
      const x = anchor.x + (s.x - anchor.x) * f, y = anchor.y + (s.y - anchor.y) * f;
      patch.x = clampChild('x', Math.round(Math.min(Math.max(0, p.w - w), Math.max(0, x))));
      patch.y = clampChild('y', Math.round(Math.min(Math.max(0, p.h - h), Math.max(0, y))));
    }
    d = patchChild(d, n, patch, panel, file);
  }
  return d;
}

export type Align = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/** Where `r` goes to line up with `box` one way; the other axis stays. */
export function alignedAt(r: Box, box: Box, how: Align): { x: number; y: number } {
  switch (how) {
    case 'left': return { x: box.x, y: r.y };
    case 'centre': return { x: box.x + box.w / 2 - r.w / 2, y: r.y };
    case 'right': return { x: box.x + box.w - r.w, y: r.y };
    case 'top': return { x: r.x, y: box.y };
    case 'middle': return { x: r.x, y: box.y + box.h / 2 - r.h / 2 };
    case 'bottom': return { x: r.x, y: box.y + box.h - r.h };
  }
}

/** Align pieces against the box around them, through placeChild's clamp, in the file they are seen in. */
export function alignChildren(design: HudDesign, names: string[], how: Align, panel = 'teamColumn', file?: string): HudDesign {
  const starts = startsOf(design, names, panel, file);
  const box = unionBox(Object.values(starts));
  if (!box) return design;
  let d = design;
  for (const [n, s] of Object.entries(starts)) {
    if (!childDef(panel, n)?.move) continue;
    const at = alignedAt(s, box, how);
    d = placeChild(d, n, at.x, at.y, panel, file);
  }
  return d;
}

export function setChildrenVisible(design: HudDesign, names: string[], visible: boolean, panel = 'teamColumn'): HudDesign {
  return names.reduce((d, n) => patchChild(d, n, { visible }, panel), design);
}

export function resetChildren(design: HudDesign, names: string[], panel = 'teamColumn'): HudDesign {
  return names.reduce((d, n) => resetChild(d, n, panel), design);
}

/**
 * "Bring to front" and "Send to back" (plan decision 5): the pieces go one
 * above the highest zpos in the panel's file, or one below the lowest, not
 * one step, since several pieces often share a zpos and a single step would
 * be ambiguous. The file is read as buildTrees has it, but the blocks the
 * build injects do not count: the backgrounds (HudEdCardBg at -2,
 * HudEdOwnBg at -5), the splatter stand-in (HudEdSplatter, which copies
 * BackgroundImage's zpos anyway) and the hidden Items revive anchor in a
 * panel where Items is no piece of its own. The pieces being moved do not
 * count either, and a block with no zpos counts as 0, which is what the
 * game gives it. Send to back never goes below the panel's injected
 * background + 1, with or without a background in this design, so a
 * background never covers a piece (panelBgZpos). Every piece gets the same
 * zpos, through the validator's -50..50 clamp.
 */
export function raiseChild(design: HudDesign, names: string[], to: 'front' | 'back', panel = 'teamColumn'): HudDesign {
  const reg = panelChildren(panel);
  if (!reg) return design;
  // Nested pieces ('Block/Child', children.ts childPath) are ordered among their own block's children.
  const parent = childPath(names[0] ?? '').slice(0, -1);
  const prefix = parent.length ? `${parent.join('/')}/` : '';
  const moving = new Set(names.map((n) => n.toLowerCase()));
  const injected = (key: string) => key.toLowerCase().startsWith('huded') || (key.toLowerCase() === 'items' && !childDef(panel, key));
  const holder = parent.length ? kvFind(buildTrees(design)(reg.file), parent) : undefined;
  const level = holder ? (typeof holder.value === 'string' ? [] : holder.value) : buildTrees(design)(reg.file);
  const zs = level
    .filter((n) => typeof n.value !== 'string' && !moving.has(`${prefix}${n.key}`.toLowerCase()) && !injected(n.key))
    .map((n) => { const z = parseFloat(kvGet(n, 'zpos') ?? ''); return Number.isFinite(z) ? z : 0; });
  if (!zs.length) return design;
  const bg = panelBgZpos(panel);
  const back = Math.min(...zs) - 1;
  const z = clampChild('z', to === 'front' ? Math.max(...zs) + 1 : bg === undefined ? back : Math.max(back, bg + 1));
  return names.filter((n) => childDef(panel, n)).reduce((d, n) => patchChild(d, n, { z }, panel), design);
}

// --- elements, cards and whole selections ---

/**
 * Put an element's top-left at (x, y), rounded, keeping 8 units of it on
 * screen as a drag always has (clampSpan) and inside the validator's range.
 * An element the game places, or the Free Teammates (each card places
 * itself), is returned unchanged, `===`.
 */
export function placeElement(design: HudDesign, id: string, x: number, y: number): HudDesign {
  const el = elementById(id);
  if (!el || !el.move || (id === 'teamColumn' && isFreeTeam(design))) return design;
  const r = elementRect(design, id, design.aspect);
  const o = design.elements[id];
  const want = { x: clampSpan(x, r.w, screenW(design.aspect), 8), y: clampSpan(y, r.h, SCREEN_H, 8) };
  // The stored number is not the drawn one: a fitted container is drawn its
  // fit offset away (build.ts elementFitShift), and a centre token reads
  // back at a half unit. So take the offset between the two at a first
  // guess (drawnAt, the build's own arithmetic) and store through it
  // (storedFor): a press of 1 from a place drawn at 300.5 then stores
  // exactly 1 more, and the other axis, handed back where it is drawn,
  // stores what it stored.
  const shift = elementFitShift(design, id);
  const guess = { x: Math.round(want.x - shift.x), y: Math.round(want.y - shift.y) };
  const at = drawnAt(design, id, guess.x, guess.y);
  // want is already held on screen; the stored range is the fitted one
  // where the fit moves the container, so that clamp never pulls a fitted
  // panel back from the left or top edge (design.ts FIT_POS_RANGES).
  const fitted = fitMovesContainer(id, o?.fit);
  const px = clampPos('x', storedFor(want.x, at.x - guess.x), fitted);
  const py = clampPos('y', storedFor(want.y, at.y - guess.y), fitted);
  // Only the height moves on an element the game places across (the peril notice).
  if (el.moveAxis === 'y') {
    const { x: _x, ...rest } = o ?? {};
    return { ...design, elements: { ...design.elements, [id]: { ...rest, y: py } } };
  }
  return { ...design, elements: { ...design.elements, [id]: { ...o, x: px, y: py } } };
}

/** Move elements by (dx, dy) from where a gesture started them. */
export function moveElements(design: HudDesign, ids: string[], starts: Record<string, Box>, dx: number, dy: number): HudDesign {
  return ids.reduce((d, id) => (starts[id] ? placeElement(d, id, starts[id].x + dx, starts[id].y + dy) : d), design);
}

/**
 * Move cards by (dx, dy) from where a gesture started them (`starts`, each
 * card's cardBoxes place, from cardStarts). A Row or Column team goes Free
 * first (freeInPlace), so the cards not moving stay where they were drawn;
 * inside a gesture the switch and the move are one undo step. The delta is
 * clamped once for the whole group so every card keeps 8 units on screen,
 * as a single card's drag always has, and the cards keep their spacing when
 * the group meets an edge instead of piling up against it. Each then goes
 * through placeCard's clamp.
 */
export function moveCards(design: HudDesign, cards: number[], starts: Record<number, Box>, dx: number, dy: number): HudDesign {
  const list = cards.filter((c) => starts[c]);
  if (!list.length) return design;
  const d = freeInPlace(design);
  const W = screenW(d.aspect);
  const range = (dv: number, at: (b: Box) => number, size: (b: Box) => number, extent: number) => Math.min(
    Math.min(...list.map((c) => extent - 8 - at(starts[c]))),
    Math.max(Math.max(...list.map((c) => 8 - size(starts[c]) - at(starts[c]))), dv),
  );
  const cx = range(dx, (b) => b.x, (b) => b.w, W);
  const cy = range(dy, (b) => b.y, (b) => b.h, SCREEN_H);
  return list.reduce((acc, c) => placeCard(acc, c, starts[c].x + cx, starts[c].y + cy), d);
}

/** The group X and Y boxes: put the cards' box at (x, y), moving all of them, a Row or Column team going Free first. */
export function placeCards(design: HudDesign, cards: number[], x: number, y: number): HudDesign {
  const starts = cardStarts(design, cards);
  const box = unionBox(Object.values(starts));
  return box ? moveCards(design, cards, starts, x - box.x, y - box.y) : design;
}

/** Align cards against the box around them, through placeCard's clamp, a Row or Column team going Free first. */
export function alignCards(design: HudDesign, cards: number[], how: Align): HudDesign {
  const starts = cardStarts(design, cards);
  const box = unionBox(Object.values(starts));
  if (!box) return design;
  return Object.entries(starts).reduce((d, [c, r]) => {
    const at = alignedAt(r, box, how);
    return placeCard(d, Number(c), at.x, at.y);
  }, freeInPlace(design));
}

/** Align elements against the box around them. Ones that cannot move stay, and still count toward the box. */
export function alignElements(design: HudDesign, ids: string[], how: Align): HudDesign {
  const rects = Object.fromEntries(ids.map((id) => {
    const { x, y, w, h } = elementRect(design, id, design.aspect);
    return [id, { x, y, w, h }];
  }));
  const box = unionBox(Object.values(rects));
  if (!box) return design;
  return ids.reduce((d, id) => {
    const at = alignedAt(rects[id], box, how);
    return placeElement(d, id, at.x, at.y);
  }, design);
}

/**
 * Scale an element by a corner handle: one proportional factor from the
 * drag, applied to the scale the gesture started at, rounded to 0.01 and
 * clamped to the validator's 0.5..2. `start.rect` is the element's frame
 * (selection.ts's elementFrame, where its handles sit), and the frame's
 * opposite corner stays put: a left or top corner moves the element by the
 * size it gained, read back from the generator at the new scale. A right or
 * bottom corner leaves an element's position alone, so one still on its file
 * anchor keeps it; only the Teammates, whose frame slides as it scales,
 * move from one.
 */
export function scaleElement(
  design: HudDesign, id: string, start: { rect: Box; scale: number }, handle: Handle, dx: number, dy: number,
): HudDesign {
  const el = elementById(id);
  if (!el || el.resize !== 'scale') return design;
  const o = design.elements[id] ?? {};
  const scale = clampOverride('scale', Math.round(start.scale * cornerFactor(start.rect, handle, dx, dy) * 100) / 100);
  const next: HudDesign = { ...design, elements: { ...design.elements, [id]: { ...o, scale } } };
  // Where the opposite corner of the frame went at the new scale, measured
  // back from the generator: an element's own corner moves only by what it
  // grew, but the Teammates' cards scale about their container's origin, so
  // their frame slides even from a right or bottom corner.
  const f = elementFrame(next, id);
  const a = anchorOf(start.rect, handle);
  const sx = a.x - (handle.includes('w') ? f.x + f.w : f.x);
  const sy = a.y - (handle.includes('n') ? f.y + f.h : f.y);
  // A right or bottom corner grows the panel toward that edge, so it is
  // brought back inside on that axis; a left or top corner keeps its
  // opposite corner, as it always has.
  const axes = { x: !handle.includes('w'), y: !handle.includes('n') };
  if (Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5) return keepElementOnScreen(design, next, id, axes);
  const r = elementRect(next, id, next.aspect);
  return keepElementOnScreen(design, placeElement(next, id, r.x + sx, r.y + sy), id, axes);
}

/**
 * The Scale slider: set an element's scale (the validator's 0.5..2), then
 * bring it back on screen if the new size ran it further off an edge
 * (keepElementOnScreen). An element that does not scale is returned `===`.
 */
export function setScale(design: HudDesign, id: string, scale: number): HudDesign {
  const el = elementById(id);
  if (!el || el.resize !== 'scale') return design;
  const next: HudDesign = { ...design, elements: { ...design.elements, [id]: { ...(design.elements[id] ?? {}), scale: clampOverride('scale', scale) } } };
  return keepElementOnScreen(design, next, id, { x: true, y: true });
}

/**
 * Plan decision 8 (2026-09-24-hud-editor-phase2-rest.md, task L4): scaling
 * keeps a panel on screen by moving it, not by limiting the scale. `after`
 * is `before` with a new scale; when its frame (elementFrame, where the
 * handles sit) runs further past an edge than it did in `before`, it is
 * placed wholly inside through placeElement, on the axes given. A panel the
 * new scale did not push further out does not move, so one on its file
 * anchor keeps it: the stock right-anchored frames already overhang the
 * right edge by a few units (your own health 5, your infected health 13),
 * and that alone never moves them. The game draws a panel past the edge cut
 * off, which is what the owner saw (probe-phase2-rest RESULTS.md, "scaled
 * panel runs off screen").
 */
export function keepElementOnScreen(before: HudDesign, after: HudDesign, id: string, axes: { x: boolean; y: boolean }): HudDesign {
  const W = screenW(after.aspect);
  const fb = elementFrame(before, id), fa = elementFrame(after, id);
  // How far to move along one axis: 0 unless the frame's overhang on a side grew.
  const shift = (b0: number, bs: number, a0: number, as: number, extent: number): number => {
    const grew = (Math.max(0, a0 + as - extent) > Math.max(0, b0 + bs - extent) + 0.5) || (Math.max(0, -a0) > Math.max(0, -b0) + 0.5);
    if (!grew) return 0;
    if (a0 < 0 || as >= extent) return Math.ceil(-a0);                 // too big for the screen: its left or top edge on the screen's
    return a0 + as > extent ? -Math.ceil(a0 + as - extent) : 0;
  };
  const dx = axes.x ? shift(fb.x, fb.w, fa.x, fa.w, W) : 0;
  const dy = axes.y ? shift(fb.y, fb.h, fa.y, fa.h, SCREEN_H) : 0;
  if (!dx && !dy) return after;
  const r = elementRect(after, id, after.aspect);
  return placeElement(after, id, r.x + dx, r.y + dy);
}

/**
 * Resize a free-size element (the chat box) by any handle from where the
 * gesture started it, 20 units at least as the Phase 1 corner drag had it,
 * through the validator's ranges. A left or top handle moves the origin.
 *
 * A left or top handle's opposite edge must stay put even when the range
 * (not the 20-unit minimum resizeBox already clamped) is what catches the
 * dragged one: the stationary edge is read off the unclamped box first, the
 * moving edge is clamped to its own range, and the size is then the gap
 * between them, the same order resizeChild uses for the unfitted card.
 */
export function resizeElement(
  design: HudDesign, id: string, start: Box, handle: Handle, dx: number, dy: number, keepRatio = false,
): HudDesign {
  const el = elementById(id);
  if (!el || el.resize !== 'free') return design;
  const b = resizeBox(start, handle, dx, dy, keepRatio, 20);
  const next: ElementOverride = { ...(design.elements[id] ?? {}) };
  if (handle.includes('w')) {
    const right = b.x + b.w;
    next.x = clampOverride('x', b.x);
    next.w = clampOverride('w', right - next.x);
  } else {
    next.w = clampOverride('w', b.w);
  }
  if (handle.includes('n')) {
    const bottom = b.y + b.h;
    next.y = clampOverride('y', b.y);
    next.h = clampOverride('h', bottom - next.y);
  } else {
    next.h = clampOverride('h', b.h);
  }
  return { ...design, elements: { ...design.elements, [id]: next } };
}

/**
 * Arrow keys: move whatever is selected by (dx, dy), through each level's
 * own clamp. `file` is the file pieces are seen in (render.ts panelFile:
 * your infected health shown as the Boomer), so a nudge clamps in the frame
 * the player sees, as a drag there does.
 */
export function nudgeSelection(design: HudDesign, sel: Selection, dx: number, dy: number, file?: string): HudDesign {
  switch (sel.kind) {
    case 'elements': return sel.ids.reduce((d, id) => nudge(d, id, dx, dy), design);
    // The infected cards have no place of their own (code puts card i at i x HorizPanelSpacing): their row moves.
    case 'cards': return panelOf(sel) === 'teamColumn' ? nudgeCards(design, sel.cards, dx, dy) : nudge(design, panelOf(sel), dx, dy);
    case 'children': return moveChildren(design, sel.names, startsOf(design, sel.names, panelOf(sel), file), dx, dy, panelOf(sel), file);
    default: return design;
  }
}

/**
 * Show or hide a selection: elements with a Visible control and pieces. A
 * card cannot be hidden alone (the game draws every teammate's card), so a
 * card selection is returned unchanged.
 */
export function setSelectionVisible(design: HudDesign, sel: Selection, visible: boolean): HudDesign {
  if (sel.kind === 'children') return setChildrenVisible(design, sel.names, visible, panelOf(sel));
  if (sel.kind !== 'elements') return design;
  return sel.ids.reduce((d, id) => {
    if (!elementById(id)?.props.includes('visible')) return d;
    return { ...d, elements: { ...d.elements, [id]: { ...(d.elements[id] ?? {}), visible } } };
  }, design);
}

/** Delete and Backspace, and the menu's Hide. */
export function hideSelection(design: HudDesign, sel: Selection): HudDesign {
  return setSelectionVisible(design, sel, false);
}

/** The menu's Reset: elements back to a fresh design's, pieces back to the file's. */
export function resetSelection(design: HudDesign, sel: Selection): HudDesign {
  if (sel.kind === 'children') return resetChildren(design, sel.names, panelOf(sel));
  if (sel.kind === 'elements') return sel.ids.reduce((d, id) => resetElement(d, id), design);
  return design;
}

// --- the damage splatters (splatter.ts) ---

/**
 * A panel child shown again: its `visible` override goes, and the override
 * itself (and the panel's map) when nothing else is left in it, so a design
 * that only ever hid and showed a child is back to no edits.
 */
function showChild(d: HudDesign, name: string, panel: string): HudDesign {
  const kids = d.children[panel];
  const own = kids?.[name];
  if (!kids || !own || !('visible' in own)) return d;
  const { visible: _gone, ...rest } = own;
  const nextKids = { ...kids };
  if (Object.keys(rest).length) nextKids[name] = rest; else delete nextKids[name];
  const children = { ...d.children };
  if (Object.keys(nextKids).length) children[panel] = nextKids; else delete children[panel];
  return { ...d, children };
}

/** The panel and child a splatter's None hides: the teammate BackgroundImage, or a scratch. */
function splatChild(id: SplatterId): { panel: string; name: string } | null {
  const def = splatterDef(id)!;
  const panel = panelOfFile(def.file);
  return panel ? { panel: panel.panelId, name: def.block } : null;
}

/**
 * What a splatter shows, as the panel offers it. None is not a stored kind
 * but the splatter child's hide (the one flag the Layers panel and this
 * panel share, plan decision 4), so it reads that first.
 */
export function splatterKind(d: HudDesign, id: SplatterId): SplatterKind {
  const c = splatChild(id);
  if (c && d.children[c.panel]?.[c.name]?.visible === false) return 'none';
  return d.splatters?.[id]?.kind ?? 'stock';
}

/**
 * Change a splatter. Choosing None hides its child and leaves the stored
 * style alone, so a Fade colour survives a trip through None; any other
 * change shows the child again. Every other field merges into what is
 * stored, so a Fade colour outlives a switch of kind.
 */
export function patchSplatter(d: HudDesign, id: SplatterId, p: Partial<SplatterStyle>): HudDesign {
  const c = splatChild(id);
  if (c && p.kind === 'none') return patchChild(d, c.name, { visible: false }, c.panel);
  const base = c ? showChild(d, c.name, c.panel) : d;
  const style: SplatterStyle = { ...(base.splatters?.[id] ?? { kind: 'stock' }), ...p };
  return { ...base, splatters: { ...base.splatters, [id]: style } };
}

/** Store an upload (PNG base64, already drawn at the texture's size) and switch the splatter to it. */
export function withSplatterImage(d: HudDesign, id: SplatterId, png: string): HudDesign {
  const { w, h } = splatterDef(id)!.size;
  return patchSplatter({ ...d, images: { ...d.images, [id]: { w, h, png } } }, id, { kind: 'image' });
}

/** Back to the stock art: no style, no stored picture, and the splatter's child shown. */
export function resetSplatter(d: HudDesign, id: SplatterId): HudDesign {
  const splatters = { ...d.splatters };
  delete splatters[id];
  const images = { ...d.images };
  delete images[id];
  const next: HudDesign = { ...d, images, splatters };
  if (!Object.keys(splatters).length) delete next.splatters;
  const c = splatChild(id);
  return c ? showChild(next, c.name, c.panel) : next;
}

/**
 * The infected row's Gap slider: the gap as the row is laid out (rowLayout:
 * the stock card, 256 wide at a 140 pitch, is -116 unfitted), from a pitch
 * of one unit for the card shown (never below the validator's floor) to
 * 200. Shown as it is, so the first touch does not jump the spacing, and a
 * return to the stock value gives the stock pitch back.
 */
export function rowGapSlider(design: HudDesign): { value: number; min: number; max: number } {
  const el = elementById('infectedRow')!;
  const t = teamLayout(design, el);
  const k = el.resize === 'scale' ? design.elements[el.id]?.scale ?? 1 : 1;
  const w = t.card ? Math.round(t.card.w / k) : 0;
  const value = Math.round(t.gap ?? 0);
  return { value, min: Math.min(value, clampRowGap(1 - w)), max: 200 };
}

/** Set the infected row's gap from the slider, dropping a saved spacing it replaces. */
export function setRowGap(design: HudDesign, gap: number): HudDesign {
  const { spacing: _old, ...rest } = design.elements.infectedRow ?? {};
  return { ...design, elements: { ...design.elements, infectedRow: { ...rest, gap: clampRowGap(gap) } } };
}

/**
 * Fit a single panel (your own health) to what it shows, or stop: sets or
 * removes `elements[id].fit`, and the element entry itself when nothing
 * else is left in it, so on then off gives back the elements exactly. The
 * stored x/y stay as they are: fit re-places the panel inside an unchanged
 * container. The teammate card keeps its own path.
 */
export function setFit(design: HudDesign, id: string, on: boolean): HudDesign {
  const { fit: _old, ...rest } = design.elements[id] ?? {};
  const elements = { ...design.elements };
  if (on) elements[id] = { ...rest, fit: true };
  else if (Object.keys(rest).length) elements[id] = rest;
  else delete elements[id];
  return { ...design, elements };
}
