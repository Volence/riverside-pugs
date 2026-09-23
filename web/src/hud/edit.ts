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
  type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type Box,
} from './design';
import { screenW, SCREEN_H } from './units';
import { elementById } from './elements';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, cardChild, type CardChild } from './build';
import { teamChild } from './children';
import { unionBox, CORNERS, type Handle } from './guides';
import { elementFrame, type Selection } from './selection';

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
 * Resize one teammate-card piece by a handle from where the gesture started
 * it, unscaled units, inside the unfitted card. Width-and-height pieces take
 * any of the eight handles, and a left or top handle moves the origin so the
 * opposite edge stays put. Square art takes the corners only and grows by
 * the larger of the two deltas, keeping its ratio. The item icons have no
 * box of their own: a corner scales their icon size in proportion.
 */
export function resizeChild(
  design: HudDesign, name: string, start: CardChild, handle: Handle, dx: number, dy: number, keepRatio = false,
): HudDesign {
  const def = teamChild(name);
  if (!def) return design;
  const p = baseTeam(design.preset).card;
  if (def.box === 'none') {
    if (!def.font || start.fontTall === undefined || !CORNERS.includes(handle)) return design;
    return patchChild(design, name, { fontSize: clampChild('fontSize', Math.round(start.fontTall * cornerFactor(start, handle, dx, dy))) });
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
    return patchChild(design, name, patch);
  }
  const b = resizeBox(start, handle, dx, dy, keepRatio, 1);
  // Inside the unfitted card: an edge dragged past the card stops at it.
  const left = Math.max(0, b.x), top = Math.max(0, b.y);
  const right = Math.min(p.w, b.x + b.w), bottom = Math.min(p.h, b.y + b.h);
  const patch: Partial<ChildOverride> = { w: clampChild('w', Math.max(1, right - left)), h: clampChild('h', Math.max(1, bottom - top)) };
  if (handle.includes('w')) patch.x = clampChild('x', left);
  if (handle.includes('n')) patch.y = clampChild('y', top);
  return patchChild(design, name, patch);
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

// --- several pieces of the teammate card at once ---

/** Where each named piece is now, in the unfitted frame: what a gesture starts from. Pieces the file lacks are left out. */
export function startsOf(design: HudDesign, names: string[]): Record<string, CardChild> {
  const out: Record<string, CardChild> = {};
  for (const n of names) {
    const c = cardChild(design, n);
    if (c) out[n] = c;
  }
  return out;
}

/**
 * Move pieces by (dx, dy) from where a gesture started them, unscaled units.
 * The delta is clamped once for the whole group, against the unfitted card
 * (the Phase 1 drag clamp), so the pieces keep their spacing when the group
 * meets an edge instead of piling up against it one by one. A piece that
 * cannot move, or has nothing to start from (an addable child not yet in the
 * file), is skipped; every registered piece can move today, the splatter
 * included, but the guard stays for a future decor-only one.
 */
export function moveChildren(
  design: HudDesign, names: string[], starts: Record<string, CardChild>, dx: number, dy: number,
): HudDesign {
  const p = baseTeam(design.preset).card;
  const list = names.filter((n) => teamChild(n)?.move && starts[n]);
  if (!list.length) return design;
  const cx = Math.min(Math.min(...list.map((n) => p.w - starts[n].w - starts[n].x)), Math.max(Math.max(...list.map((n) => -starts[n].x)), dx));
  const cy = Math.min(Math.min(...list.map((n) => p.h - starts[n].h - starts[n].y)), Math.max(Math.max(...list.map((n) => -starts[n].y)), dy));
  let d = design;
  for (const n of list) d = placeChild(d, n, starts[n].x + cx, starts[n].y + cy);
  return d;
}

/** The group X and Y boxes: put the pieces' box at (x, y), moving all of them. */
export function placeChildren(design: HudDesign, names: string[], x: number, y: number): HudDesign {
  const starts = startsOf(design, names);
  const box = unionBox(Object.values(starts));
  return box ? moveChildren(design, names, starts, x - box.x, y - box.y) : design;
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
 * the unfitted card first and each position then clamped inside it, as
 * placeChild does, so any factor leaves a valid design.
 */
export function scaleChildren(
  design: HudDesign, names: string[], starts: Record<string, CardChild>, anchor: { x: number; y: number }, f: number,
): HudDesign {
  const p = baseTeam(design.preset).card;
  let d = design;
  for (const n of names) {
    const def = teamChild(n);
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
    d = patchChild(d, n, patch);
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
export function alignChildren(design: HudDesign, names: string[], how: Align): HudDesign {
  const starts = startsOf(design, names);
  const box = unionBox(Object.values(starts));
  if (!box) return design;
  let d = design;
  for (const [n, s] of Object.entries(starts)) {
    if (!teamChild(n)?.move) continue;
    const at = alignedAt(s, box, how);
    d = placeChild(d, n, at.x, at.y);
  }
  return d;
}

export function setChildrenVisible(design: HudDesign, names: string[], visible: boolean): HudDesign {
  return names.reduce((d, n) => patchChild(d, n, { visible }), design);
}

export function resetChildren(design: HudDesign, names: string[]): HudDesign {
  return names.reduce((d, n) => resetChild(d, n), design);
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
    case 'children': return moveChildren(design, sel.names, startsOf(design, sel.names), dx, dy);
    default: return design;
  }
}

/**
 * Show or hide a selection: elements with a Visible control and pieces. A
 * card cannot be hidden alone (the game draws every teammate's card), so a
 * card selection is returned unchanged.
 */
export function setSelectionVisible(design: HudDesign, sel: Selection, visible: boolean): HudDesign {
  if (sel.kind === 'children') return setChildrenVisible(design, sel.names, visible);
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
  if (sel.kind === 'children') return resetChildren(design, sel.names);
  if (sel.kind === 'elements') return sel.ids.reduce((d, id) => resetElement(d, id), design);
  return design;
}
