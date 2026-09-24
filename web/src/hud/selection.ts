/**
 * What a pointer gesture on the canvas means, and what a selection covers,
 * as pure functions of the design, so the page holds no hit logic of its
 * own. Everything measured here comes from the generator's trees
 * (elementRect, teamCardRects, childRects, cardChild), as Phase 1 requires:
 * a hit, a frame, a handle or a snap target is wherever the file puts it.
 *
 * A selection is one of four levels: nothing, one or more elements of the
 * current side, one or more teammate cards, or pieces of the teammate card.
 * The levels nest as Teammates, then a card, then a piece, in every layout:
 * a card can be picked and moved on its own in Row and Column too, and
 * moving one switches the Teammates to Free (edit.ts's freeInPlace), the
 * only layout that stores a position per card. Pieces live in the one
 * teammate card file, so picking a piece in any card picks it in all of
 * them; `card` only says which card it was picked in, for the breadcrumb
 * and the handles.
 */
import { baseTeam, type Box, type HudDesign } from './design';
import { baseOf } from './base';
import { elementById } from './elements';
import { cardChild, cardFrame, elementRect, isFreeTeam, teamCardRects, type CardFrame } from './build';
import { childRects, hiddenInState, type CardState, type ChildRect } from './render';
import { childAt, hitTest, inside, TEAM_CARDS, visibleElements, type Side } from './mock';
import { TEAM_PANEL, teamChild } from './children';
import { screenW, SCREEN_H } from './units';
import { ALL_HANDLES, CORNERS, unionBox, type Guide, type Handle } from './guides';

export type Selection =
  | { kind: 'none' }
  | { kind: 'elements'; ids: string[] }
  | { kind: 'cards'; cards: number[] }
  | { kind: 'children'; names: string[]; card: number };

export const NONE: Selection = { kind: 'none' };
export const TEAMMATES: Selection = { kind: 'elements', ids: ['teamColumn'] };

/** A card selection, sorted and without repeats, so two that pick the same cards are equal. */
export function cardsOf(cards: number[]): Selection {
  return { kind: 'cards', cards: [...new Set(cards)].sort((a, b) => a - b) };
}

/**
 * How many cards can be picked: the three the preview draws, and in Free
 * the fourth as well, which shows only while spectating a full team and is
 * reachable only from Layers, where Free lists it.
 */
export function pickableCards(design: HudDesign): number {
  return isFreeTeam(design) ? 4 : TEAM_CARDS;
}

export interface Mods { shift: boolean; ctrl: boolean }
/** Everything under a point, one field per level: the element, the teammate card (in any layout), the piece. */
export interface Hit { element: string | null; card: number | null; child: string | null }

const touches = (a: Box, b: Box) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
const plain = ({ x, y, w, h }: Box): Box => ({ x, y, w, h });
const drawnCards = (design: HudDesign): Box[] => teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).map(plain);

export function hitAt(design: HudDesign, side: Side, state: CardState, ux: number, uy: number): Hit {
  const element = hitTest(design, side, ux, uy);
  if (element !== 'teamColumn') return { element, card: null, child: null };
  const piece = childAt(design, state, ux, uy);
  const card = piece ? piece.card : drawnCards(design).findIndex((c) => inside(c, ux, uy));
  return { element, card: card >= 0 ? card : null, child: piece ? piece.name : null };
}

const sameCards = (sel: Selection, card: number) => sel.kind === 'cards' && sel.cards.length === 1 && sel.cards[0] === card;

/**
 * The thing a click picks: the deepest level under the pointer (a drawn
 * piece, else a card, else the element), or with Ctrl one level up: a
 * piece's card, or the Teammates from a card's empty space. When the card
 * Ctrl would pick is already the selection, it climbs on to the Teammates,
 * so repeated Ctrl+clicks walk up. It is also what a hover outlines, which
 * is why it takes the selection.
 */
export function targetOf(design: HudDesign, hit: Hit, ctrl = false, sel: Selection = NONE): Selection {
  if (!hit.element) return NONE;
  const levels: Selection[] = [];
  if (hit.child) levels.push({ kind: 'children', names: [hit.child], card: hit.card ?? 0 });
  if (hit.element === 'teamColumn' && hit.card !== null) levels.push(cardsOf([hit.card]));
  levels.push({ kind: 'elements', ids: [hit.element] });
  if (!ctrl || levels.length === 1) return levels[0];
  return hit.card !== null && levels[1].kind === 'cards' && sameCards(sel, hit.card) ? levels[2] : levels[1];
}

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * Combine a newly picked target with the selection, as the canvas and the
 * Layers list both do. Without Shift the target replaces it. With Shift, an
 * element toggles among elements, a card among cards and a piece among
 * pieces; at another level the target starts a new selection, and Shift on
 * nothing keeps what there is.
 */
export function pick(sel: Selection, target: Selection, shift: boolean): Selection {
  if (!shift) return target;
  if (target.kind === 'none') return sel;
  if (sel.kind === 'elements' && target.kind === 'elements') {
    const ids = toggle(sel.ids, target.ids[0]);
    return ids.length ? { kind: 'elements', ids } : NONE;
  }
  if (sel.kind === 'cards' && target.kind === 'cards') {
    const cards = target.cards.reduce((list, c) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]), sel.cards);
    return cards.length ? cardsOf(cards) : NONE;
  }
  if (sel.kind === 'children' && target.kind === 'children') {
    const names = toggle(sel.names, target.names[0]);
    return names.length ? { kind: 'children', names, card: sel.card } : NONE;
  }
  return target;
}

/**
 * A click. While cards are picked, Shift on any part of a card (a piece or
 * its empty space) lifts the target to that card, so it joins or leaves
 * the cards rather than starting a selection of pieces.
 */
export function clickSelect(design: HudDesign, sel: Selection, hit: Hit, mods: Mods): Selection {
  const onCard = hit.element === 'teamColumn' && hit.card !== null;
  const target = mods.shift && sel.kind === 'cards' && onCard ? cardsOf([hit.card!]) : targetOf(design, hit, mods.ctrl, sel);
  return pick(sel, target, mods.shift);
}

/**
 * Whether a press lands on something already selected, so a drag from it
 * moves the selection. A picked piece counts in every card. The Free
 * Teammates never count: their container is the screen and cannot move, so
 * a drag on one of their cards moves that card instead.
 */
export function isPicked(design: HudDesign, sel: Selection, hit: Hit): boolean {
  switch (sel.kind) {
    case 'elements':
      return hit.element !== null && sel.ids.includes(hit.element) && !(hit.element === 'teamColumn' && isFreeTeam(design));
    case 'cards': return hit.element === 'teamColumn' && hit.card !== null && sel.cards.includes(hit.card);
    case 'children': return hit.child !== null && sel.names.includes(hit.child);
    default: return false;
  }
}

/**
 * Whether a press lands inside a selected element's frame. The smallest
 * element under a point wins a hit, so a big selected element (Your health at
 * scale 2 covers the use bar, the crosshair and more) would otherwise lose
 * every drag that starts where a smaller element sits; a drag anywhere inside
 * what is selected moves it, as in any editor. A plain click still picks what
 * is under the pointer. The Free Teammates never count (their frame is the
 * screen, and their cards move one by one).
 */
function insideSelected(design: HudDesign, sel: Selection, at: { x: number; y: number } | null): boolean {
  if (!at || sel.kind !== 'elements') return false;
  return sel.ids.some((id) => !(id === 'teamColumn' && isFreeTeam(design)) && inside(elementFrame(design, id), at.x, at.y));
}

export type Intent = { kind: 'resize'; handle: Handle } | { kind: 'box' } | { kind: 'move'; sel: Selection } | { kind: 'none' };

/**
 * What a drag means once the pointer has moved past a click. A press on one
 * of the selection's handles (`handle`, found by handleAt) resizes, with or
 * without Shift, since Shift there keeps the ratio. Otherwise Shift draws a
 * box. A drag on part of the selection moves the selection (the Row or
 * Column Teammates picked move as one). Anywhere else it moves the card
 * under the pointer, in any layout, or where there is no card the element,
 * and selects it, so no key is needed to move a card or a section.
 */
export function dragIntent(
  design: HudDesign, sel: Selection, hit: Hit, mods: Mods, handle: Handle | null = null, at: { x: number; y: number } | null = null,
): Intent {
  if (handle) return { kind: 'resize', handle };
  if (mods.shift) return { kind: 'box' };
  if (isPicked(design, sel, hit) || insideSelected(design, sel, at)) return { kind: 'move', sel };
  if (!hit.element) return { kind: 'none' };
  if (hit.element === 'teamColumn' && hit.card !== null) return { kind: 'move', sel: cardsOf([hit.card]) };
  if (hit.element === 'teamColumn' && isFreeTeam(design)) return { kind: 'none' };
  return { kind: 'move', sel: { kind: 'elements', ids: [hit.element] } };
}

/**
 * The teammate-card pieces the preview draws in `state`, in registry order:
 * the file has them, they are visible, the state shows them, and they are
 * not decoration. Used for a box-select, Ctrl+A and a moving piece's snap
 * targets, none of which the splatter joins; a plain click is different
 * (mock.ts's childAt), and does pick the splatter where no other piece is.
 */
export function drawnPieces(design: HudDesign, state: CardState): string[] {
  return TEAM_PANEL.children.filter((def) => {
    const info = cardChild(design, def.name);
    return def.role !== 'decor' && !!info && info.visible && !hiddenInState('teamColumn', def.name, state);
  }).map((def) => def.name);
}

/** The drawn pieces of one card with their rects, in registry order. */
function piecesIn(design: HudDesign, state: CardState, card: Box): (Box & { name: string })[] {
  const rects = childRects(design, 'teamColumn', { x: card.x, y: card.y }, 1);
  return drawnPieces(design, state).flatMap((name) => {
    const r = rects.find((x) => x.name === name);
    return r ? [{ name, ...plain(r) }] : [];
  });
}

/** An element's targets on screen: the Free teammates are their three cards, anything else its own rect. */
function sectionRects(design: HudDesign, id: string): Box[] {
  return id === 'teamColumn' && isFreeTeam(design) ? drawnCards(design) : [plain(elementRect(design, id, design.aspect))];
}

/**
 * A Shift+drag box from `a` to `b`. Started inside a drawn teammate card it
 * picks every drawn piece of that card it touches; otherwise every visible
 * element of the side it touches. It replaces the selection.
 */
export function boxSelect(design: HudDesign, side: Side, state: CardState, a: { x: number; y: number }, b: { x: number; y: number }): Selection {
  const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  if (side === 'survivor' && elementRect(design, 'teamColumn', design.aspect).visible) {
    const cards = drawnCards(design);
    const card = cards.findIndex((c) => inside(c, a.x, a.y));
    if (card >= 0) {
      const names = piecesIn(design, state, cards[card]).filter((r) => touches(r, box)).map((r) => r.name);
      return names.length ? { kind: 'children', names, card } : NONE;
    }
  }
  const ids = visibleElements(side, design)
    .filter((el) => elementRect(design, el.id, design.aspect).visible && sectionRects(design, el.id).some((r) => touches(r, box)))
    .map((el) => el.id);
  return ids.length ? { kind: 'elements', ids } : NONE;
}

/** Ctrl+A: with pieces picked, every drawn piece of that card; otherwise every visible element of the side. */
export function selectAll(design: HudDesign, side: Side, state: CardState, sel: Selection): Selection {
  if (sel.kind === 'children') {
    const names = drawnPieces(design, state);
    return names.length ? { kind: 'children', names, card: sel.card } : sel;
  }
  const ids = visibleElements(side, design).filter((el) => elementRect(design, el.id, design.aspect).visible).map((el) => el.id);
  return ids.length ? { kind: 'elements', ids } : NONE;
}

/** Escape: pieces climb to the card they were picked in, cards to the Teammates, anything else to nothing. */
export function climb(sel: Selection): Selection {
  if (sel.kind === 'children') return cardsOf([sel.card]);
  if (sel.kind === 'cards') return TEAMMATES;
  return NONE;
}

export interface Crumb { label: string; sel: Selection }

/** The path shown at the canvas corner: each segment selects its level. */
export function breadcrumb(sel: Selection): Crumb[] {
  const team: Crumb = { label: elementById('teamColumn')!.label, sel: TEAMMATES };
  switch (sel.kind) {
    case 'none': return [];
    case 'elements':
      return [{ label: sel.ids.length === 1 ? elementById(sel.ids[0])!.label : `${sel.ids.length} elements`, sel }];
    case 'cards': return [team, { label: sel.cards.length === 1 ? `Card ${sel.cards[0] + 1}` : `${sel.cards.length} cards`, sel }];
    case 'children': {
      const leaf: Crumb = { label: sel.names.length === 1 ? teamChild(sel.names[0])!.label : `${sel.names.length} pieces`, sel };
      return [team, { label: `Card ${sel.card + 1}`, sel: cardsOf([sel.card]) }, leaf];
    }
  }
}

/** What a selection is called: the breadcrumb's last label, as the hover label shows it. */
export function selectionLabel(sel: Selection): string {
  const crumbs = breadcrumb(sel);
  return crumbs.length ? crumbs[crumbs.length - 1].label : '';
}

/**
 * The selection after the design or the side changed (an undo, an import,
 * a preset, the health number removed): kept when it still names something
 * that exists, trimmed when part of it went, and when every picked piece
 * went, the Teammates, as Phase 1 stepped back to them. Returns `sel` itself
 * when nothing changed, so the page's state update is a no-op.
 */
export function sanitize(design: HudDesign, side: Side, sel: Selection): Selection {
  const onSide = (id: string) => visibleElements(side, design).some((e) => e.id === id);
  switch (sel.kind) {
    case 'none': return sel;
    case 'elements': {
      const ids = sel.ids.filter(onSide);
      return ids.length === sel.ids.length ? sel : ids.length ? { kind: 'elements', ids } : NONE;
    }
    case 'cards': {
      // Card 4 is a level only in Free, where Layers lists it.
      if (side !== 'survivor') return NONE;
      const cards = sel.cards.filter((c) => c < pickableCards(design));
      return cards.length === sel.cards.length ? sel : cards.length ? cardsOf(cards) : TEAMMATES;
    }
    case 'children': {
      if (side !== 'survivor') return NONE;
      const names = sel.names.filter((n) => cardChild(design, n) !== null);
      return names.length === sel.names.length ? sel : names.length ? { ...sel, names } : TEAMMATES;
    }
  }
}

/** Identifies a selection for nudge coalescing: the same key is the same selection. */
export function selectionKey(sel: Selection): string {
  return JSON.stringify(sel);
}

/** The element ids a selection touches: cards or pieces belong to the Teammates. */
export function selectedIds(sel: Selection): string[] {
  if (sel.kind === 'elements') return sel.ids;
  return sel.kind === 'none' ? [] : ['teamColumn'];
}

/**
 * The box one element is drawn in, what its outline and corner handles sit
 * on. Outside Free the Teammates are framed by their drawn cards, not their
 * container: stock's container starts left of card 1 and is 100 tall at
 * r75, so it hangs 25 units off the bottom of the screen with its handles.
 * In Free this is the screen, which has no handles. Anything else is its
 * own rect.
 */
export function elementFrame(design: HudDesign, id: string): Box {
  if (id === 'teamColumn' && !isFreeTeam(design)) return unionBox(drawnCards(design))!;
  return plain(elementRect(design, id, design.aspect));
}

/**
 * A selected piece's frame, from a childRects entry: as drawn, or, for a
 * piece the player hid, from cardChild instead. hidePass (build.ts) zeroes a
 * hidden piece's wide and tall in the generated tree so the game can't force
 * it visible, but that would collapse its frame to a point at its (still
 * correct) origin. cardChild reads cardWork, which never runs hidePass, so
 * its w and h are the piece's real, undoctored size; only that size needs
 * scaling by the team's own scale, to match childRects' already-scaled
 * numbers (cardChild's frame is unscaled, the file's own stored one).
 */
function pieceFrame(design: HudDesign, r: ChildRect): Box {
  if (r.visible) return plain(r);
  const c = cardChild(design, r.name);
  if (!c) return plain(r);
  const k = cardFrame(design).k;
  // scalePass (build.ts's scaleToken) rounds every positional value it
  // writes, wide and tall included; matching that rounding here, not just
  // the factor, is what keeps a hidden piece's frame equal to the very same
  // piece's own frame while visible, at a scale that is not a whole number.
  return { x: r.x, y: r.y, w: Math.round(c.w * k), h: Math.round(c.h * k) };
}

/** One outline per selected thing as drawn: an element's frame, the Free Teammates' cards, each picked card, a piece in every card. */
export function selectionFrames(design: HudDesign, sel: Selection): Box[] {
  switch (sel.kind) {
    case 'none': return [];
    case 'elements': return sel.ids.flatMap((id) => (id === 'teamColumn' && isFreeTeam(design) ? drawnCards(design) : [elementFrame(design, id)]));
    case 'cards': {
      const rects = teamCardRects(design, design.aspect);
      return sel.cards.map((c) => plain(rects[c]));
    }
    case 'children':
      return drawnCards(design).flatMap((c) => childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1)
        .filter((r) => sel.names.includes(r.name)).map((r) => pieceFrame(design, r)));
  }
}

/** The box the handles sit on: for pieces, around them in the card they were picked in. */
export function selectionBox(design: HudDesign, sel: Selection): Box | null {
  if (sel.kind === 'children') {
    const c = teamCardRects(design, design.aspect)[sel.card];
    return unionBox(childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1).filter((r) => sel.names.includes(r.name)).map((r) => pieceFrame(design, r)));
  }
  return unionBox(selectionFrames(design, sel));
}

/**
 * The handles the spec's table gives a selection. Elements: eight for a
 * free-size element, four corners for a scaled one, none otherwise, and
 * none for the Free Teammates (their box is the screen). Cards: none (the
 * cards share one size). One piece: eight for width and height, four
 * corners for square art or the item icons. Several pieces: four corners.
 * Several elements: none.
 */
export function handlesFor(design: HudDesign, sel: Selection): Handle[] {
  if (sel.kind === 'elements') {
    if (sel.ids.length !== 1) return [];
    const id = sel.ids[0];
    const el = elementById(id);
    if (!el || (id === 'teamColumn' && isFreeTeam(design))) return [];
    return el.resize === 'free' ? ALL_HANDLES : el.resize === 'scale' ? CORNERS : [];
  }
  if (sel.kind === 'children') {
    if (sel.names.length > 1) return CORNERS;
    const def = teamChild(sel.names[0]);
    if (!def) return [];
    if (def.box === 'wh') return ALL_HANDLES;
    return def.box === 'square' || def.font ? CORNERS : [];
  }
  return [];
}

export function handlePoint(box: Box, h: Handle): { x: number; y: number } {
  const x = h.includes('w') ? box.x : h.includes('e') ? box.x + box.w : box.x + box.w / 2;
  const y = h.includes('n') ? box.y : h.includes('s') ? box.y + box.h : box.y + box.h / 2;
  return { x, y };
}

/** The nearest handle within `slack` HUD units of the point, so a thin box's side handle is reachable between its corners. */
export function handleAt(box: Box, handles: Handle[], ux: number, uy: number, slack: number): Handle | null {
  let best: { h: Handle; d: number } | null = null;
  for (const h of handles) {
    const p = handlePoint(box, h);
    const d = Math.max(Math.abs(ux - p.x), Math.abs(uy - p.y));
    if (d <= slack && (!best || d < best.d)) best = { h, d };
  }
  return best ? best.h : null;
}

/**
 * What moving pieces snap to, in the card file's unfitted frame (the frame
 * a ChildOverride is stored in): the unfitted card, which is what the
 * Phase 1 drag clamps to, and the other drawn pieces.
 */
export function pieceTargets(design: HudDesign, state: CardState, moving: string[]): Box[] {
  const p = baseTeam(baseOf(design)).card;
  const out: Box[] = [{ x: 0, y: 0, w: p.w, h: p.h }];
  for (const name of drawnPieces(design, state)) {
    if (moving.includes(name)) continue;
    const c = cardChild(design, name);
    if (c) out.push({ x: c.x, y: c.y, w: c.w, h: c.h });
  }
  return out;
}

/** What moving elements or cards snap to, in screen units: the screen, and every other visible thing of the side. */
export function sectionTargets(design: HudDesign, side: Side, sel: Selection): Box[] {
  const out: Box[] = [{ x: 0, y: 0, w: screenW(design.aspect), h: SCREEN_H }];
  for (const el of visibleElements(side, design)) {
    if (sel.kind === 'elements' && sel.ids.includes(el.id)) continue;
    if (!elementRect(design, el.id, design.aspect).visible) continue;
    const rects = sectionRects(design, el.id);
    out.push(...(el.id === 'teamColumn' && sel.kind === 'cards' ? rects.filter((_, i) => !sel.cards.includes(i)) : rects));
  }
  return out;
}

/** A piece's guide, found in the unfitted frame, drawn where the piece is drawn in `card`. */
export function pieceGuideToScreen(g: Guide, card: Box, f: CardFrame): Guide {
  const X = (v: number) => card.x + (v - f.shift.x) * f.k;
  const Y = (v: number) => card.y + (v - f.shift.y) * f.k;
  return g.axis === 'x' ? { axis: 'x', at: X(g.at), from: Y(g.from), to: Y(g.to) } : { axis: 'y', at: Y(g.at), from: X(g.from), to: X(g.to) };
}

export type MenuAction = 'hide' | 'reset' | 'selectCard' | 'selectTeam';

/** The right-click menu for a selection. A card cannot be hidden alone, and has no reset of its own. */
export function menuActions(sel: Selection): MenuAction[] {
  switch (sel.kind) {
    case 'elements': return ['hide', 'reset'];
    case 'cards': return ['selectTeam'];
    case 'children': return ['hide', 'reset', 'selectCard', 'selectTeam'];
    default: return [];
  }
}
