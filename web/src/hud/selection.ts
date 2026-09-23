/**
 * What a pointer gesture on the canvas means, and what a selection covers,
 * as pure functions of the design, so the page holds no hit logic of its
 * own. Everything measured here comes from the generator's trees
 * (elementRect, teamCardRects, childRects, cardChild), as Phase 1 requires:
 * a hit, a frame, a handle or a snap target is wherever the file puts it.
 *
 * A selection is one of four levels: nothing, one or more elements of the
 * current side, one Free teammate card, or pieces of the teammate card.
 * Pieces live in the one teammate card file, so picking a piece in any card
 * picks it in all of them; `card` only says which card it was picked in, for
 * the breadcrumb and the handles.
 */
import { baseTeam, type Box, type HudDesign } from './design';
import { elementById } from './elements';
import { cardChild, elementRect, isFreeTeam, teamCardRects, type CardFrame } from './build';
import { childRects, hiddenInState, type CardState } from './render';
import { childAt, hitTest, inside, TEAM_CARDS, visibleElements, type Side } from './mock';
import { TEAM_PANEL, teamChild } from './children';
import { screenW, SCREEN_H } from './units';
import { ALL_HANDLES, CORNERS, unionBox, type Guide, type Handle } from './guides';

export type Selection =
  | { kind: 'none' }
  | { kind: 'elements'; ids: string[] }
  | { kind: 'card'; card: number }
  | { kind: 'children'; names: string[]; card: number };

export const NONE: Selection = { kind: 'none' };
export const TEAMMATES: Selection = { kind: 'elements', ids: ['teamColumn'] };

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

/**
 * The thing a click picks: the deepest level under the pointer (a drawn
 * piece, else a Free card, else the element), or with Ctrl one level up.
 * It is also what a hover outlines.
 */
export function targetOf(design: HudDesign, hit: Hit, ctrl = false): Selection {
  if (!hit.element) return NONE;
  const levels: Selection[] = [];
  if (hit.child) levels.push({ kind: 'children', names: [hit.child], card: hit.card ?? 0 });
  if (hit.element === 'teamColumn' && isFreeTeam(design) && hit.card !== null) levels.push({ kind: 'card', card: hit.card });
  levels.push({ kind: 'elements', ids: [hit.element] });
  return ctrl && levels.length > 1 ? levels[1] : levels[0];
}

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * Combine a newly picked target with the selection, as the canvas and the
 * Layers list both do. Without Shift the target replaces it. With Shift, an
 * element toggles among elements and a piece among pieces; at another level
 * (or a card, which is picked alone) the target starts a new selection, and
 * Shift on nothing keeps what there is.
 */
export function pick(sel: Selection, target: Selection, shift: boolean): Selection {
  if (!shift) return target;
  if (target.kind === 'none') return sel;
  if (sel.kind === 'elements' && target.kind === 'elements') {
    const ids = toggle(sel.ids, target.ids[0]);
    return ids.length ? { kind: 'elements', ids } : NONE;
  }
  if (sel.kind === 'children' && target.kind === 'children') {
    const names = toggle(sel.names, target.names[0]);
    return names.length ? { kind: 'children', names, card: sel.card } : NONE;
  }
  return target;
}

export function clickSelect(design: HudDesign, sel: Selection, hit: Hit, mods: Mods): Selection {
  return pick(sel, targetOf(design, hit, mods.ctrl), mods.shift);
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
    case 'card': return isFreeTeam(design) && hit.card === sel.card;
    case 'children': return hit.child !== null && sel.names.includes(hit.child);
    default: return false;
  }
}

export type Intent = { kind: 'resize'; handle: Handle } | { kind: 'box' } | { kind: 'move'; sel: Selection } | { kind: 'none' };

/**
 * What a drag means once the pointer has moved past a click. A press on one
 * of the selection's handles (`handle`, found by handleAt) resizes, with or
 * without Shift, since Shift there keeps the ratio. Otherwise Shift draws a
 * box. A drag on part of the selection moves the selection; anywhere else it
 * moves the outermost section under the pointer (the element, or in Free the
 * card) and selects it, so no key is needed to move a section.
 */
export function dragIntent(design: HudDesign, sel: Selection, hit: Hit, mods: Mods, handle: Handle | null = null): Intent {
  if (handle) return { kind: 'resize', handle };
  if (mods.shift) return { kind: 'box' };
  if (isPicked(design, sel, hit)) return { kind: 'move', sel };
  if (!hit.element) return { kind: 'none' };
  if (hit.element === 'teamColumn' && isFreeTeam(design)) {
    return hit.card === null ? { kind: 'none' } : { kind: 'move', sel: { kind: 'card', card: hit.card } };
  }
  return { kind: 'move', sel: { kind: 'elements', ids: [hit.element] } };
}

/**
 * The teammate-card pieces the preview draws in `state`, in registry order:
 * the file has them, they are visible, the state shows them, and they are
 * not decoration (the splatter and the card background are never targets).
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
  const ids = visibleElements(side)
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
  const ids = visibleElements(side).filter((el) => elementRect(design, el.id, design.aspect).visible).map((el) => el.id);
  return ids.length ? { kind: 'elements', ids } : NONE;
}

/** Escape: pieces climb to their card (Free) or the Teammates, a card to the Teammates, anything else to nothing. */
export function climb(design: HudDesign, sel: Selection): Selection {
  if (sel.kind === 'children') return isFreeTeam(design) ? { kind: 'card', card: sel.card } : TEAMMATES;
  if (sel.kind === 'card') return TEAMMATES;
  return NONE;
}

export interface Crumb { label: string; sel: Selection }

/** The path shown at the canvas corner: each segment selects its level. */
export function breadcrumb(design: HudDesign, sel: Selection): Crumb[] {
  const team: Crumb = { label: elementById('teamColumn')!.label, sel: TEAMMATES };
  switch (sel.kind) {
    case 'none': return [];
    case 'elements':
      return [{ label: sel.ids.length === 1 ? elementById(sel.ids[0])!.label : `${sel.ids.length} elements`, sel }];
    case 'card': return [team, { label: `Card ${sel.card + 1}`, sel }];
    case 'children': {
      const leaf: Crumb = { label: sel.names.length === 1 ? teamChild(sel.names[0])!.label : `${sel.names.length} pieces`, sel };
      return isFreeTeam(design) ? [team, { label: `Card ${sel.card + 1}`, sel: { kind: 'card', card: sel.card } }, leaf] : [team, leaf];
    }
  }
}

/** What a selection is called: the breadcrumb's last label, as the hover label shows it. */
export function selectionLabel(design: HudDesign, sel: Selection): string {
  const crumbs = breadcrumb(design, sel);
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
  const onSide = (id: string) => visibleElements(side).some((e) => e.id === id);
  switch (sel.kind) {
    case 'none': return sel;
    case 'elements': {
      const ids = sel.ids.filter(onSide);
      return ids.length === sel.ids.length ? sel : ids.length ? { kind: 'elements', ids } : NONE;
    }
    case 'card':
      if (side !== 'survivor') return NONE;
      return isFreeTeam(design) ? sel : TEAMMATES;
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

/** The element ids a selection touches: a card or pieces belong to the Teammates. */
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

/** One outline per selected thing as drawn: an element's frame, the Free Teammates' cards, a card, a piece in every card. */
export function selectionFrames(design: HudDesign, sel: Selection): Box[] {
  switch (sel.kind) {
    case 'none': return [];
    case 'elements': return sel.ids.flatMap((id) => (id === 'teamColumn' && isFreeTeam(design) ? drawnCards(design) : [elementFrame(design, id)]));
    case 'card': return [plain(teamCardRects(design, design.aspect)[sel.card])];
    case 'children':
      return drawnCards(design).flatMap((c) => childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1)
        .filter((r) => sel.names.includes(r.name)).map(plain));
  }
}

/** The box the handles sit on: for pieces, around them in the card they were picked in. */
export function selectionBox(design: HudDesign, sel: Selection): Box | null {
  if (sel.kind === 'children') {
    const c = teamCardRects(design, design.aspect)[sel.card];
    return unionBox(childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1).filter((r) => sel.names.includes(r.name)).map(plain));
  }
  return unionBox(selectionFrames(design, sel));
}

/**
 * The handles the spec's table gives a selection. Elements: eight for a
 * free-size element, four corners for a scaled one, none otherwise, and
 * none for the Free Teammates (their box is the screen). A card: none (the
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
  const p = baseTeam(design.preset).card;
  const out: Box[] = [{ x: 0, y: 0, w: p.w, h: p.h }];
  for (const name of drawnPieces(design, state)) {
    if (moving.includes(name)) continue;
    const c = cardChild(design, name);
    if (c) out.push({ x: c.x, y: c.y, w: c.w, h: c.h });
  }
  return out;
}

/** What a moving element or Free card snaps to, in screen units: the screen, and every other visible thing of the side. */
export function sectionTargets(design: HudDesign, side: Side, sel: Selection): Box[] {
  const out: Box[] = [{ x: 0, y: 0, w: screenW(design.aspect), h: SCREEN_H }];
  for (const el of visibleElements(side)) {
    if (sel.kind === 'elements' && sel.ids.includes(el.id)) continue;
    if (!elementRect(design, el.id, design.aspect).visible) continue;
    const rects = sectionRects(design, el.id);
    out.push(...(el.id === 'teamColumn' && sel.kind === 'card' ? rects.filter((_, i) => i !== sel.card) : rects));
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
export function menuActions(design: HudDesign, sel: Selection): MenuAction[] {
  switch (sel.kind) {
    case 'elements': return ['hide', 'reset'];
    case 'card': return ['selectTeam'];
    case 'children': return isFreeTeam(design) ? ['hide', 'reset', 'selectCard', 'selectTeam'] : ['hide', 'reset', 'selectTeam'];
    default: return [];
  }
}
