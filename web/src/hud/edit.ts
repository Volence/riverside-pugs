/**
 * Every edit the HUD editor page applies to a design, as pure functions
 * from one HudDesign to the next. The page decides which one a gesture or a
 * control means and records it in its history; nothing here knows about
 * pointers, keys or the DOM. Every result goes through the same clamps the
 * validator uses, so a design built here is always one the generator takes.
 *
 * Positions are read back from the generator (elementRect, teamCardRects,
 * cardChild), never worked out here, so an edit starts from exactly what the
 * canvas draws.
 */
import {
  clampOverride, clampChild, baseTeam, DEFAULT_DESIGN,
  type HudDesign, type ElementOverride, type TeamDir, type ChildOverride,
} from './design';
import { screenW, SCREEN_H } from './units';
import { elementById } from './elements';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, cardChild } from './build';
import { teamChild } from './children';

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
 * Runs the result through the same `clampSpan` a drag uses, at the same
 * 8-unit floor, so repeated arrow presses cannot walk an element arbitrarily
 * far off screen the way a plain `x + dx` would; a drag and the keyboard
 * agree on how far off screen is too far because they share this call.
 * `design.aspect` (not a hardcoded 16:9) gives the screen width, since a
 * design can be 16:10 or 4:3.
 */
export function nudge(design: HudDesign, id: string, dx: number, dy: number): HudDesign {
  const el = elementById(id);
  // In Free each card places itself: the element's own position would move nothing.
  if (!el || !el.move || (id === 'teamColumn' && isFreeTeam(design))) return design;
  // From where the element is drawn, not the stored x and y: a team the
  // on-screen clamp holds at the edge is drawn there whatever it stores, and
  // a press back from the edge must move it at once.
  const o = design.elements[id];
  const base = elementRect(design, id, design.aspect);
  const extentW = screenW(design.aspect);
  const x = clampSpan(base.x + dx, base.w, extentW, 8);
  const y = clampSpan(base.y + dy, base.h, SCREEN_H, 8);
  return { ...design, elements: { ...design.elements, [id]: { ...o, x, y } } };
}

/** Whether the elements differ from a fresh design's. Not the same as having
 *  none: a fresh design already fits the teammate card. */
export function elementsTouched(d: HudDesign): boolean {
  return JSON.stringify(d.elements) !== JSON.stringify(DEFAULT_DESIGN.elements);
}

/** Whether a design holds anything beyond the untouched defaults: decides
 *  whether loading a share link needs to ask first rather than silently
 *  overwriting whatever a reader already had going. */
export function hasOverrides(d: HudDesign): boolean {
  return elementsTouched(d)
    || Object.keys(d.children).length > 0
    || Object.keys(d.styles).length > 0
    || Object.keys(d.images).length > 0
    || d.hideGameCrosshair === true
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
  return { ...d, elements, children };
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
 * Draw one Free card's top-left at (x, y): its slot becomes that less the fit
 * offset, clamped through the same table as an element's position.
 */
export function placeCard(design: HudDesign, card: number, x: number, y: number): HudDesign {
  const o = design.elements.teamColumn;
  if (!o?.slots || !o.slots[card]) return design;
  const off = cardOffset(design);
  const at = { x: clampOverride('x', x - off.x), y: clampOverride('y', y - off.y) };
  const slots = o.slots.map((s, i) => (i === card ? at : s));
  return { ...design, elements: { ...design.elements, teamColumn: { ...o, slots } } };
}

/**
 * Nudge a Free card by (dx, dy) from where it is drawn, through the same
 * clampSpan and 8-unit floor a drag uses, so repeated arrow presses cannot
 * walk it off screen. Its place and size come from the generated file.
 */
export function nudgeCard(design: HudDesign, card: number, dx: number, dy: number): HudDesign {
  if (!design.elements.teamColumn?.slots?.[card]) return design;
  const r = teamCardRects(design, design.aspect)[card];
  const extentW = screenW(design.aspect);
  return placeCard(design, card, clampSpan(r.x + dx, r.w, extentW, 8), clampSpan(r.y + dy, r.h, SCREEN_H, 8));
}

/** Merge into one teammate-card child's override. */
export function patchChild(design: HudDesign, name: string, p: Partial<ChildOverride>): HudDesign {
  const kids = design.children.teamColumn ?? {};
  return { ...design, children: { ...design.children, teamColumn: { ...kids, [name]: { ...(kids[name] ?? {}), ...p } } } };
}

/**
 * Place a teammate-card child at (x, y): unscaled units in the card file's
 * own unfitted frame, rounded, clamped inside the unfitted card (150 x 150
 * on stock). The clamp is the unfitted card, not the fitted one, or a child
 * could never move past the card it currently makes and nothing could grow.
 */
export function placeChild(design: HudDesign, name: string, x: number, y: number): HudDesign {
  const r = cardChild(design, name);
  if (!r || !teamChild(name)?.move) return design;
  const p = baseTeam(design.preset).card;
  const cx = Math.round(Math.min(Math.max(0, p.w - r.w), Math.max(0, x)));
  const cy = Math.round(Math.min(Math.max(0, p.h - r.h), Math.max(0, y)));
  return patchChild(design, name, { x: clampChild('x', cx), y: clampChild('y', cy) });
}

/** Nudge a child from where it is now, through the same clamp as a drag. */
export function nudgeChild(design: HudDesign, name: string, dx: number, dy: number): HudDesign {
  const r = cardChild(design, name);
  return r ? placeChild(design, name, r.x + dx, r.y + dy) : design;
}

/**
 * Resize a child from `start` by (dw, dh), unscaled, inside the unfitted
 * card. Square art keeps its ratio: the side grows by the larger of the two
 * deltas. A child with no size of its own (the item icons) is unchanged.
 */
export function resizeChild(
  design: HudDesign, name: string, start: { x: number; y: number; w: number; h: number }, dw: number, dh: number,
): HudDesign {
  const def = teamChild(name);
  if (!def || def.box === 'none') return design;
  const p = baseTeam(design.preset).card;
  const fit = (v: number, room: number, key: 'w' | 'h') => clampChild(key, Math.round(Math.min(Math.max(1, room), Math.max(1, v))));
  if (def.box === 'square') {
    const side = fit(start.w + Math.max(dw, dh), Math.min(p.w - start.x, p.h - start.y), 'w');
    return patchChild(design, name, { w: side, h: side });
  }
  return patchChild(design, name, { w: fit(start.w + dw, p.w - start.x, 'w'), h: fit(start.h + dh, p.h - start.y, 'h') });
}

/**
 * "Reset this child": drop the child's edits. Resetting an added child (the
 * stock health number) keeps it added: only its own Remove control takes it
 * away. The last edit gone, the card's map goes too, so a reset design is
 * the same value as one never touched.
 */
export function resetChild(d: HudDesign, name: string): HudDesign {
  const def = teamChild(name);
  const kids = { ...(d.children.teamColumn ?? {}) };
  const on = kids[name]?.on;
  delete kids[name];
  if (def?.addable && on !== undefined) kids[name] = { on };
  const children: HudDesign['children'] = { ...d.children, teamColumn: kids };
  if (Object.keys(kids).length === 0) delete children.teamColumn;
  return { ...d, children };
}
