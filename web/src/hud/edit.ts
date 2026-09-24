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
  clampOverride, clampChild, DEFAULT_DESIGN, newDesign,
  type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type Box, type WeaponsOverride, type ImportedRef,
} from './design';
import { screenW, SCREEN_H } from './units';
import { elementById } from './elements';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, panelChild, buildTrees, panelBgZpos, type CardChild } from './build';
import { childDef, panelChildren, panelOfFile } from './children';
import { kvGet } from './kv';
import { unionBox, CORNERS, type Handle } from './guides';
import { elementFrame, panelClamp, panelOf, type Selection } from './selection';

// The clamp box lives in selection.ts (edit.ts already imports selection.ts,
// so the reverse import would make a loop); it is offered from here too, the
// module every child edit goes through.
export { panelClamp };
import type { CrosshairArt } from '../crosshair/model';
import { splatterDef, type SplatterId, type SplatterKind, type SplatterStyle } from './splatter';

/** Keeps at least `min` units of a span on screen, whichever side it drifts to. */
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
 */
function childAt(design: HudDesign, panel: string, name: string): CardChild | null {
  const c = panelChild(design, panel, name);
  if (!c) return null;
  const { keys: _keys, z: _z, ...plain } = c;
  return plain;
}

/**
 * Merge into one panel child's override. Every child helper below takes the
 * panel last, defaulting to the teammate card, so the Phase 1 calls read as
 * they always did.
 */
export function patchChild(design: HudDesign, name: string, p: Partial<ChildOverride>, panel = 'teamColumn'): HudDesign {
  const next = mergeChild(design, name, p, panel);
  const mate = LINKED_X[panel]?.[name.toLowerCase()];
  if (p.x === undefined || !mate) return next;
  const was = panelChild(design, panel, name), other = panelChild(design, panel, mate);
  if (!was || !other || p.x === was.x) return next;
  return mergeChild(next, mate, { x: clampChild('x', Math.round(other.x + p.x - was.x)) }, panel);
}

function mergeChild(design: HudDesign, name: string, p: Partial<ChildOverride>, panel: string): HudDesign {
  const kids = design.children[panel] ?? {};
  return { ...design, children: { ...design.children, [panel]: { ...kids, [name]: { ...(kids[name] ?? {}), ...p } } } };
}

/**
 * Pieces whose x moves together (the card revive trap). client.dll's player
 * panel update (1023f5df..1023f6da, the class shared by your own panel and
 * the cards) moves Health to the down picture's x while it shows and, on the
 * revive, to the x of the panel's Items child. On a card Items is the item
 * row, so a bar or row dragged sideways on its own would make the bar jump
 * after a revive. Any x edit to one moves the other by the same delta,
 * keeping the offset the file has (stock: bar 37, items 39, the 2 units the
 * stock card already jumps). Your own panel's Items is the hidden anchor
 * build.ts's reviveAnchorPass places at the bar, so it needs no link.
 */
const LINKED_X: Record<string, Record<string, string>> = { teamColumn: { health: 'Items', items: 'Health' } };

/**
 * Place a panel child at (x, y): unscaled units in the panel file's own
 * unfitted frame, rounded, clamped inside the panel's clamp box (panelClamp:
 * for the teammate card the unfitted card, 150 x 150 on stock). The clamp is
 * the unfitted card, not the fitted one, or a child could never move past
 * the card it currently makes and nothing could grow.
 */
export function placeChild(design: HudDesign, name: string, x: number, y: number, panel = 'teamColumn'): HudDesign {
  const r = childAt(design, panel, name);
  if (!r || !childDef(panel, name)?.move) return design;
  const p = panelClamp(design, panel);
  const cx = Math.round(Math.min(Math.max(0, p.w - r.w), Math.max(0, x)));
  const cy = Math.round(Math.min(Math.max(0, p.h - r.h), Math.max(0, y)));
  return patchChild(design, name, { x: clampChild('x', cx), y: clampChild('y', cy) }, panel);
}

/** Nudge a child from where it is now, through the same clamp as a drag. */
export function nudgeChild(design: HudDesign, name: string, dx: number, dy: number, panel = 'teamColumn'): HudDesign {
  const r = childAt(design, panel, name);
  return r ? placeChild(design, name, r.x + dx, r.y + dy, panel) : design;
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
  design: HudDesign, name: string, start: CardChild, handle: Handle, dx: number, dy: number, keepRatio = false, panel = 'teamColumn',
): HudDesign {
  const def = childDef(panel, name);
  if (!def) return design;
  const p = panelClamp(design, panel);
  if (def.box === 'none') {
    if (!def.font || start.fontTall === undefined || !CORNERS.includes(handle)) return design;
    return patchChild(design, name, { fontSize: clampChild('fontSize', Math.round(start.fontTall * cornerFactor(start, handle, dx, dy))) }, panel);
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
    const room = Math.min(handle.includes('w') ? start.x + start.w : p.w - start.x, handle.includes('n') ? start.y + start.h : p.h - start.y);
    const side = clampChild('w', Math.round(Math.min(Math.max(1, room), Math.max(1, start.w + grow))));
    const patch: Partial<ChildOverride> = { w: side, h: side };
    if (handle.includes('w')) patch.x = clampChild('x', start.x + start.w - side);
    if (handle.includes('n')) patch.y = clampChild('y', start.y + start.h - side);
    return patchChild(design, name, patch, panel);
  }
  const b = resizeBox(start, handle, dx, dy, keepRatio, 1);
  // Inside the unfitted card: an edge dragged past the card stops at it.
  const left = Math.max(0, b.x), top = Math.max(0, b.y);
  const right = Math.min(p.w, b.x + b.w), bottom = Math.min(p.h, b.y + b.h);
  const patch: Partial<ChildOverride> = { w: clampChild('w', Math.max(1, right - left)), h: clampChild('h', Math.max(1, bottom - top)) };
  if (handle.includes('w')) patch.x = clampChild('x', left);
  if (handle.includes('n')) patch.y = clampChild('y', top);
  return patchChild(design, name, patch, panel);
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

// --- several pieces of one panel at once ---

/** Where each named piece is now, in the unfitted frame: what a gesture starts from. Pieces the file lacks are left out. */
export function startsOf(design: HudDesign, names: string[], panel = 'teamColumn'): Record<string, CardChild> {
  const out: Record<string, CardChild> = {};
  for (const n of names) {
    const c = childAt(design, panel, n);
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
  design: HudDesign, names: string[], starts: Record<string, CardChild>, dx: number, dy: number, panel = 'teamColumn',
): HudDesign {
  const p = panelClamp(design, panel);
  const list = names.filter((n) => childDef(panel, n)?.move && starts[n]);
  if (!list.length) return design;
  const cx = Math.min(Math.min(...list.map((n) => p.w - starts[n].w - starts[n].x)), Math.max(Math.max(...list.map((n) => -starts[n].x)), dx));
  const cy = Math.min(Math.min(...list.map((n) => p.h - starts[n].h - starts[n].y)), Math.max(Math.max(...list.map((n) => -starts[n].y)), dy));
  let d = design;
  for (const n of list) d = placeChild(d, n, starts[n].x + cx, starts[n].y + cy, panel);
  return d;
}

/** The group X and Y boxes: put the pieces' box at (x, y), moving all of them. */
export function placeChildren(design: HudDesign, names: string[], x: number, y: number, panel = 'teamColumn'): HudDesign {
  const starts = startsOf(design, names, panel);
  const box = unionBox(Object.values(starts));
  return box ? moveChildren(design, names, starts, x - box.x, y - box.y, panel) : design;
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
  design: HudDesign, names: string[], starts: Record<string, CardChild>, anchor: { x: number; y: number }, f: number, panel = 'teamColumn',
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
    if (def.move) {
      const x = anchor.x + (s.x - anchor.x) * f, y = anchor.y + (s.y - anchor.y) * f;
      patch.x = clampChild('x', Math.round(Math.min(Math.max(0, p.w - w), Math.max(0, x))));
      patch.y = clampChild('y', Math.round(Math.min(Math.max(0, p.h - h), Math.max(0, y))));
    }
    d = patchChild(d, n, patch, panel);
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

/** Align pieces against the box around them, through placeChild's clamp. */
export function alignChildren(design: HudDesign, names: string[], how: Align, panel = 'teamColumn'): HudDesign {
  const starts = startsOf(design, names, panel);
  const box = unionBox(Object.values(starts));
  if (!box) return design;
  let d = design;
  for (const [n, s] of Object.entries(starts)) {
    if (!childDef(panel, n)?.move) continue;
    const at = alignedAt(s, box, how);
    d = placeChild(d, n, at.x, at.y, panel);
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
  const moving = new Set(names.map((n) => n.toLowerCase()));
  const injected = (key: string) => key.toLowerCase().startsWith('huded') || (key.toLowerCase() === 'items' && !childDef(panel, key));
  const zs = buildTrees(design)(reg.file)
    .filter((n) => typeof n.value !== 'string' && !moving.has(n.key.toLowerCase()) && !injected(n.key))
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
  const px = clampOverride('x', Math.round(clampSpan(x, r.w, screenW(design.aspect), 8)));
  const py = clampOverride('y', Math.round(clampSpan(y, r.h, SCREEN_H, 8)));
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
  if (Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5) return next;
  const r = elementRect(next, id, next.aspect);
  return placeElement(next, id, r.x + sx, r.y + sy);
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

/** Arrow keys: move whatever is selected by (dx, dy), through each level's own clamp. */
export function nudgeSelection(design: HudDesign, sel: Selection, dx: number, dy: number): HudDesign {
  switch (sel.kind) {
    case 'elements': return sel.ids.reduce((d, id) => nudge(d, id, dx, dy), design);
    case 'cards': return nudgeCards(design, sel.cards, dx, dy);
    case 'children': return moveChildren(design, sel.names, startsOf(design, sel.names, panelOf(sel)), dx, dy, panelOf(sel));
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
