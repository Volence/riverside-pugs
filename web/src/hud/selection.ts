/**
 * What a pointer gesture on the canvas means, and what a selection covers,
 * as pure functions of the design, so the page holds no hit logic of its
 * own. Everything measured here comes from the generator's trees
 * (elementRect, teamCardRects, childRects, panelChild), as Phase 1 requires:
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
 *
 * The pieces level belongs to a panel: any panel the child registry has.
 * A selection of pieces names its panel in `panel`, left out for the
 * teammate card so every Phase 1 selection still compares equal. A single
 * panel (one file, one box on screen) has no card level: its pieces use
 * card 0 and climb straight to its element.
 *
 * The infected cards are a level too (plan Task 13), named by `panel` like
 * the pieces, but the game places every one of them itself, i x
 * HorizPanelSpacing inside the row (client.dll 0x10247a70): there is no Free,
 * so a drag or a nudge of an infected card moves the whole row.
 */
import { baseTeam, isBar, type Box, type HudDesign } from './design';
import { baseOf, baseTree } from './base';
import { elementById } from './elements';
import { blockIn, panelChild, panelFrame, elementRect, isFreeTeam, teamCardRects, type CardFrame } from './build';
import { childRects, hiddenInState, previewOf, panelFile, DOWN_MOVES_BAR, type ChildRect, type PreviewState, type SurvivorState } from './render';
import { childAt, elementTargets, hitTest, inside, panelBoxes, shownInState, TEAM_CARDS, visibleElements, type Side } from './mock';
import { tabFrames, tabSideOf } from './tabscreen';
import { childDef, childPath, panelChildren } from './children';
import { probe } from './probes';
import { kvFind, kvGet } from './kv';
import { screenW, SCREEN_H } from './units';
import { ALL_HANDLES, CORNERS, unionBox, type Guide, type Handle } from './guides';

export type Selection =
  | { kind: 'none' }
  | { kind: 'elements'; ids: string[] }
  | { kind: 'cards'; cards: number[]; panel?: string }
  | { kind: 'children'; names: string[]; card: number; panel?: string };

type State = SurvivorState | PreviewState;

/** The panel a pieces or cards selection belongs to: absent means the teammate card. */
export const panelOf = (sel: { panel?: string }): string => sel.panel ?? 'teamColumn';

/** A pieces selection, naming its panel only when it is not the teammate card. */
const piecesSel = (names: string[], card: number, panel: string): Selection =>
  ({ kind: 'children', names, card, ...(panel === 'teamColumn' ? {} : { panel }) });

/**
 * Whether a panel repeats per teammate card, so its pieces have a card level
 * above them. The Tab screen's rows repeat too, but code places every row
 * and no row moves in v1, so a row piece climbs straight to its element.
 */
const hasCards = (panel: string) => panelChildren(panel)?.repeat === 'cards' && !isTab(panel);
/** A Tab screen element, or a piece of one (HudElement.tab). */
const isTab = (id: string) => !!elementById(id)?.tab;
/** The order a box select tries the elements in: the Tab panels, the Tab board, the HUD. */
const rank = (el: { id: string; tab?: true }) => (el.tab ? (el.id === 'tabBoard' ? 1 : 0) : 2);
/** An element the game takes off while the Tab screen shows (the teammate cards, HudElement.underTab), in a state that draws it. */
const offUnderTab = (id: string, state?: State) => !!state && !!previewOf(state).tab && elementById(id)?.underTab === 'hidden';
/** Whether an element belongs to the side: its own, or both. */
const onSideOf = (id: string, side: Side) => { const s = elementById(id)?.side; return s === side || s === 'both'; };

export const NONE: Selection = { kind: 'none' };
export const TEAMMATES: Selection = { kind: 'elements', ids: ['teamColumn'] };

/** A card selection, sorted and without repeats, so two that pick the same cards are equal; it names its panel unless the teammate card. */
export function cardsOf(cards: number[], panel = 'teamColumn'): Selection {
  return { kind: 'cards', cards: [...new Set(cards)].sort((a, b) => a - b), ...(panel === 'teamColumn' ? {} : { panel }) };
}

/** The element a panel's cards and pieces climb to: the Teammates for the survivor card. */
const elementOf = (panel: string): Selection => (panel === 'teamColumn' ? TEAMMATES : { kind: 'elements', ids: [panel] });

/**
 * What a move of this selection moves: the infected cards cannot move one
 * by one (code places each at i x HorizPanelSpacing), so their row does.
 */
function movable(sel: Selection): Selection {
  return sel.kind === 'cards' && panelOf(sel) !== 'teamColumn' ? elementOf(panelOf(sel)) : sel;
}

/**
 * Whether a move of this selection can move anything: an element that moves
 * (HudElement.move, its moveGate open, not the Free Teammates, whose frame
 * is the screen), a card, or a piece that moves (ChildDef.move). The Tab
 * pieces and the Tab board cannot, so a drag must not start a move of them.
 */
function canMove(design: HudDesign, sel: Selection): boolean {
  switch (sel.kind) {
    case 'elements': return sel.ids.some((id) => {
      const el = elementById(id);
      return !!el?.move && (!el.moveGate || probe(el.moveGate)) && !(id === 'teamColumn' && isFreeTeam(design));
    });
    case 'cards': return true;
    case 'children': return sel.names.some((n) => { const def = childDef(panelOf(sel), n); return !!def?.move && (!def.gate || probe(def.gate)); });
    default: return false;
  }
}

/** What a drag in this selection moves: the selection, else the nearest level up that can move (a Tab piece's versus panel), else nothing. */
function movableUp(design: HudDesign, sel: Selection): Selection | null {
  for (let s = movable(sel); s.kind !== 'none'; s = movable(climb(s))) if (canMove(design, s)) return s;
  return null;
}

/**
 * How many cards can be picked: the three the preview draws, and in Free
 * the fourth as well, which shows only while spectating a full team and is
 * reachable only from Layers, where Free lists it.
 */
export function pickableCards(design: HudDesign, panel = 'teamColumn'): number {
  return panel === 'teamColumn' && isFreeTeam(design) ? 4 : TEAM_CARDS;
}

export interface Mods { shift: boolean; ctrl: boolean }
/** Everything under a point, one field per level: the element, the teammate card (in any layout), the piece. */
export interface Hit { element: string | null; card: number | null; child: string | null }

const touches = (a: Box, b: Box) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
const plain = ({ x, y, w, h }: Box): Box => ({ x, y, w, h });
const drawnCards = (design: HudDesign): Box[] => teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).map(plain);

export function hitAt(design: HudDesign, side: Side, state: State, ux: number, uy: number): Hit {
  const element = hitTest(design, side, ux, uy, state);
  if (!element || !panelChildren(element)) return { element, card: null, child: null };
  const piece = childAt(design, state, ux, uy, element, side);
  // Only a panel repeated per card has a card level; a single panel's piece is in its one box.
  if (!hasCards(element)) return { element, card: piece ? piece.card : null, child: piece ? piece.name : null };
  // The infected cards overlap while unfitted (256 wide, 140 apart), and a later card draws over an earlier one.
  const boxes = element === 'teamColumn' ? drawnCards(design) : panelBoxes(design, element);
  const under = boxes.map((c, i) => (inside(c, ux, uy) ? i : -1)).filter((i) => i >= 0);
  const card = piece ? piece.card : element === 'teamColumn' ? (under[0] ?? -1) : (under[under.length - 1] ?? -1);
  return { element, card: card >= 0 ? card : null, child: piece ? piece.name : null };
}

const sameCards = (sel: Selection, card: number, panel: string) =>
  sel.kind === 'cards' && panelOf(sel) === panel && sel.cards.length === 1 && sel.cards[0] === card;

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
  if (hit.child) levels.push(piecesSel([hit.child], hit.card ?? 0, hit.element));
  if (hasCards(hit.element) && hit.card !== null) levels.push(cardsOf([hit.card], hit.element));
  levels.push({ kind: 'elements', ids: [hit.element] });
  if (!ctrl || levels.length === 1) return levels[0];
  return hit.card !== null && levels[1].kind === 'cards' && sameCards(sel, hit.card, hit.element) ? levels[2] : levels[1];
}

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * Combine a newly picked target with the selection, as the canvas and the
 * Layers list both do. Without Shift the target replaces it. With Shift, an
 * element toggles among elements, a card among cards and a piece among
 * the pieces of the same panel; at another level or in another panel the
 * target starts a new selection, and Shift on nothing keeps what there is.
 */
export function pick(sel: Selection, target: Selection, shift: boolean): Selection {
  if (!shift) return target;
  if (target.kind === 'none') return sel;
  if (sel.kind === 'elements' && target.kind === 'elements') {
    const ids = toggle(sel.ids, target.ids[0]);
    return ids.length ? { kind: 'elements', ids } : NONE;
  }
  if (sel.kind === 'cards' && target.kind === 'cards' && panelOf(sel) === panelOf(target)) {
    const cards = target.cards.reduce((list, c) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]), sel.cards);
    return cards.length ? cardsOf(cards, panelOf(sel)) : NONE;
  }
  if (sel.kind === 'children' && target.kind === 'children' && panelOf(sel) === panelOf(target)) {
    const names = toggle(sel.names, target.names[0]);
    return names.length ? piecesSel(names, sel.card, panelOf(sel)) : NONE;
  }
  return target;
}

/**
 * A click. While cards are picked, Shift on any part of a card (a piece or
 * its empty space) lifts the target to that card, so it joins or leaves
 * the cards rather than starting a selection of pieces.
 */
export function clickSelect(design: HudDesign, sel: Selection, hit: Hit, mods: Mods): Selection {
  const onCard = hit.element !== null && hasCards(hit.element) && hit.card !== null;
  const target = mods.shift && sel.kind === 'cards' && onCard && panelOf(sel) === hit.element
    ? cardsOf([hit.card!], hit.element!) : targetOf(design, hit, mods.ctrl, sel);
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
    case 'cards': return hit.element === panelOf(sel) && hit.card !== null && sel.cards.includes(hit.card);
    case 'children': return hit.child !== null && hit.element === panelOf(sel) && sel.names.includes(hit.child);
    default: return false;
  }
}

/**
 * Whether a press lands inside what is selected. The smallest element under a
 * point wins a hit, so a big selected element (Your health at scale 2 covers
 * the use bar, the crosshair and more) would otherwise lose every drag that
 * starts where a smaller element sits; the same goes for a selected piece
 * under another piece (Your health's number lies under its cross). A drag
 * anywhere inside what is selected moves it, as in any editor. A plain click
 * still picks what is under the pointer. The Free Teammates never count
 * (their frame is the screen, and their cards move one by one).
 */
function insideSelected(design: HudDesign, sel: Selection, at: { x: number; y: number } | null, state?: State): boolean {
  if (!at) return false;
  if (sel.kind === 'elements') {
    return sel.ids.some((id) => !(id === 'teamColumn' && isFreeTeam(design)) && !offUnderTab(id, state) && inside(elementFrame(design, id), at.x, at.y));
  }
  if (sel.kind === 'children' || sel.kind === 'cards') return selectionFrames(design, sel, state).some((f) => inside(f, at.x, at.y));
  return false;
}

/**
 * The selection without what the Tab screen takes off (the teammate cards,
 * HudElement.underTab): the page drops those when Tab held turns on, as the
 * canvas no longer draws them. Anything else comes back as it was.
 */
export function withoutUnderTab(sel: Selection): Selection {
  const off = (id: string) => elementById(id)?.underTab === 'hidden';
  if (sel.kind === 'elements') {
    const ids = sel.ids.filter((id) => !off(id));
    return ids.length === sel.ids.length ? sel : ids.length ? { kind: 'elements', ids } : NONE;
  }
  return sel.kind !== 'none' && off(panelOf(sel)) ? NONE : sel;
}

export type Intent = { kind: 'resize'; handle: Handle } | { kind: 'box' } | { kind: 'move'; sel: Selection } | { kind: 'none' };

/**
 * What a drag means once the pointer has moved past a click. A press on one
 * of the selection's handles (`handle`, found by handleAt) resizes, with or
 * without Shift, since Shift there keeps the ratio. Otherwise Shift draws a
 * box. A drag on part of the selection moves the selection (the Row or
 * Column Teammates picked move as one), or when the selection cannot move
 * (a Tab piece, the Tab board) the nearest level up that can (the versus
 * panel). Anywhere else it moves the card under the pointer, in any layout,
 * or where there is no card the element, and selects it, so no key is
 * needed to move a card or a section. Nothing that cannot move starts a
 * move, so a drag never opens a gesture that changes nothing.
 */
export function dragIntent(
  design: HudDesign, sel: Selection, hit: Hit, mods: Mods, handle: Handle | null = null, at: { x: number; y: number } | null = null,
  state?: State,
): Intent {
  if (handle) return { kind: 'resize', handle };
  if (mods.shift) return { kind: 'box' };
  if (isPicked(design, sel, hit) || insideSelected(design, sel, at, state)) {
    const up = movableUp(design, sel);
    if (up) return { kind: 'move', sel: up };
  }
  if (!hit.element) return { kind: 'none' };
  if (hit.element === 'teamColumn' && hit.card !== null) return { kind: 'move', sel: cardsOf([hit.card]) };
  // What is under the pointer, when it can move: never a move that moves nothing (the Tab board, the crosshair).
  const under: Selection = { kind: 'elements', ids: [hit.element] };
  return canMove(design, under) ? { kind: 'move', sel: under } : { kind: 'none' };
}

/**
 * A panel's pieces the preview draws in `state` (the teammate card's by
 * default), in registry order:
 * the file has them, they are visible, the state shows them, and they are
 * not decoration. Used for a box-select, Ctrl+A and a moving piece's snap
 * targets, none of which the splatter joins; a plain click is different
 * (mock.ts's childAt), and does pick the splatter where no other piece is.
 */
export function drawnPieces(design: HudDesign, state: State, panel = 'teamColumn'): string[] {
  return (panelChildren(panel)?.children ?? []).filter((def) => {
    if (def.gate && !probe(def.gate)) return false;
    const info = panelChild(design, panel, def.name);
    return def.role !== 'decor' && !!info && info.visible && !hiddenInState(panel, def.name, state);
  }).map((def) => def.name);
}

/** The drawn pieces of one of a panel's boxes with their rects, in registry order. */
function piecesIn(design: HudDesign, state: State, card: Box, panel: string, index: number): (Box & { name: string })[] {
  if (isTab(panel)) {
    return drawnPieces(design, state, panel).flatMap((name) => tabFrames(design, tabSideOf(panel), panel, [name])
      .filter((f) => f.card === index).map((f) => ({ name, ...f.box })));
  }
  const rects = childRects(design, panel, { x: card.x, y: card.y }, 1, state);
  return drawnPieces(design, state, panel).flatMap((name) => {
    const r = rects.find((x) => x.name === name);
    return r ? [{ name, ...plain(r) }] : [];
  });
}

/** An element's targets on screen: the Free teammates are their three cards, anything else its own rect. */
function sectionRects(design: HudDesign, id: string): Box[] {
  return elementTargets(design, id, plain(elementRect(design, id, design.aspect))).map(plain);
}

/**
 * A Shift+drag box from `a` to `b`. Started inside a drawn box of a
 * registered panel of the side (a teammate card, a single panel's frame) it
 * picks every drawn piece of that box it touches; otherwise every visible
 * element of the side it touches. It replaces the selection.
 */
export function boxSelect(design: HudDesign, side: Side, state: State, a: { x: number; y: number }, b: { x: number; y: number }): Selection {
  const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  // What the canvas draws: the Tab screen over the HUD while it shows, and no element the game takes off under it.
  const tab = !!previewOf(state).tab;
  const els = visibleElements(side, design).filter((el) => shownInState(el, state) && !(tab && el.underTab === 'hidden'))
    // The Tab screen first, its board (the whole screen) after the panels drawn on it.
    .sort((p, q) => rank(p) - rank(q));
  for (const el of els) {
    if (!panelChildren(el.id) || !elementRect(design, el.id, design.aspect).visible) continue;
    const boxes = panelBoxes(design, el.id);
    const card = boxes.findIndex((c) => inside(c, a.x, a.y));
    if (card >= 0) {
      const names = piecesIn(design, state, boxes[card], el.id, card).filter((r) => touches(r, box)).map((r) => r.name);
      return names.length ? piecesSel(names, card, el.id) : NONE;
    }
  }
  const ids = els
    .filter((el) => elementRect(design, el.id, design.aspect).visible && sectionRects(design, el.id).some((r) => touches(r, box)))
    .map((el) => el.id);
  return ids.length ? { kind: 'elements', ids } : NONE;
}

/** Ctrl+A: with pieces picked, every drawn piece of that panel; otherwise every visible element of the side. */
export function selectAll(design: HudDesign, side: Side, state: State, sel: Selection): Selection {
  if (sel.kind === 'children') {
    const names = drawnPieces(design, state, panelOf(sel));
    return names.length ? piecesSel(names, sel.card, panelOf(sel)) : sel;
  }
  // What the canvas draws: an element the page's state does not show (an occasional panel with the toggle off) is left out.
  const tab = !!previewOf(state).tab;
  const ids = visibleElements(side, design)
    .filter((el) => elementRect(design, el.id, design.aspect).visible && shownInState(el, state) && !(tab && el.underTab === 'hidden')).map((el) => el.id);
  return ids.length ? { kind: 'elements', ids } : NONE;
}

/** Escape: pieces climb to the card they were picked in (a single panel's to its element), cards to the Teammates, anything else to nothing. */
export function climb(sel: Selection): Selection {
  if (sel.kind === 'children') return hasCards(panelOf(sel)) ? cardsOf([sel.card], panelOf(sel)) : { kind: 'elements', ids: [panelOf(sel)] };
  if (sel.kind === 'cards') return elementOf(panelOf(sel));
  return NONE;
}

export interface Crumb { label: string; sel: Selection }

/** The path shown at the canvas corner: each segment selects its level. */
export function breadcrumb(sel: Selection): Crumb[] {
  const team = (panel: string): Crumb => ({ label: elementById(panel)!.label, sel: elementOf(panel) });
  switch (sel.kind) {
    case 'none': return [];
    case 'elements':
      return [{ label: sel.ids.length === 1 ? elementById(sel.ids[0])!.label : `${sel.ids.length} elements`, sel }];
    case 'cards': return [team(panelOf(sel)), { label: sel.cards.length === 1 ? `Card ${sel.cards[0] + 1}` : `${sel.cards.length} cards`, sel }];
    case 'children': {
      const panel = panelOf(sel);
      const leaf: Crumb = { label: sel.names.length === 1 ? childDef(panel, sel.names[0])!.label : `${sel.names.length} pieces`, sel };
      if (!hasCards(panel)) return [{ label: elementById(panel)!.label, sel: { kind: 'elements', ids: [panel] } }, leaf];
      return [team(panel), { label: `Card ${sel.card + 1}`, sel: cardsOf([sel.card], panel) }, leaf];
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
 * went, the panel's element (the Teammates, as Phase 1 stepped back to them). Returns `sel` itself
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
      // Card 4 is a level only in Free, where Layers lists it; the infected row never has one.
      const panel = panelOf(sel);
      if (!onSideOf(panel, side) || !onSide(panel)) return NONE;
      const cards = sel.cards.filter((c) => c < pickableCards(design, panel));
      return cards.length === sel.cards.length ? sel : cards.length ? cardsOf(cards, panel) : elementOf(panel);
    }
    case 'children': {
      const panel = panelOf(sel);
      if (!onSideOf(panel, side)) return NONE;
      const names = sel.names.filter((n) => panelChild(design, panel, n) !== null);
      return names.length === sel.names.length ? sel : names.length ? { ...sel, names } : { kind: 'elements', ids: [panel] };
    }
  }
}

/** Identifies a selection for nudge coalescing: the same key is the same selection. */
export function selectionKey(sel: Selection): string {
  return JSON.stringify(sel);
}

/** The element ids a selection touches: cards belong to the Teammates, pieces to their panel. */
export function selectedIds(sel: Selection): string[] {
  if (sel.kind === 'elements') return sel.ids;
  if (sel.kind === 'children') return [panelOf(sel)];
  return sel.kind === 'none' ? [] : [panelOf(sel)];
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
  // A Tab element: the versus panel's rect, the rows' boxes, the board's backdrop and title (its block is the whole screen).
  if (isTab(id)) {
    const box = unionBox(elementTargets(design, id));
    if (box) return plain(box);
  }
  // A fitted single panel (your own health) is framed by the panel it draws.
  if (id !== 'teamColumn' && design.elements[id]?.fit) {
    const [box] = panelBoxes(design, id);
    if (box) return plain(box);
  }
  return plain(elementRect(design, id, design.aspect));
}

/**
 * A selected piece's frame, from a childRects entry: as drawn, or, for a
 * piece the player hid, from panelChild instead. hidePass (build.ts) zeroes a
 * hidden piece's wide and tall in the generated tree so the game can't force
 * it visible, but that would collapse its frame to a point at its (still
 * correct) origin. panelChild reads panelWork, which never runs hidePass,
 * so its w and h are the piece's real, undoctored size; only that size
 * needs scaling by the element's own scale, to match childRects'
 * already-scaled numbers (panelChild's frame is unscaled, the file's own
 * stored one).
 */
function pieceFrame(design: HudDesign, r: ChildRect, panel: string, state?: State): Box {
  if (r.visible) return plain(r);
  const c = panelChild(design, panel, r.name, panelFile(panel, state));
  if (!c) return plain(r);
  const k = panelFrame(design, panel).k;
  // scalePass (build.ts's scaleToken) rounds every positional value it
  // writes, wide and tall included; matching that rounding here, not just
  // the factor, is what keeps a hidden piece's frame equal to the very same
  // piece's own frame while visible, at a scale that is not a whole number.
  return { x: r.x, y: r.y, w: Math.round(c.w * k), h: Math.round(c.h * k) };
}

/**
 * One outline per selected thing as drawn: an element's frame, the Free
 * Teammates' cards, each picked card, a piece in every box of its panel. A
 * piece is framed where the preview draws it in `state` (childRects: the
 * health bar sits at the down picture's x while down).
 */
export function selectionFrames(design: HudDesign, sel: Selection, state?: State): Box[] {
  // What the Tab screen takes off (the teammate cards) has no frame while it shows.
  if (sel.kind !== 'none' && sel.kind !== 'elements' && offUnderTab(panelOf(sel), state)) return [];
  switch (sel.kind) {
    case 'none': return [];
    case 'elements': return sel.ids.filter((id) => !offUnderTab(id, state))
      .flatMap((id) => (id === 'teamColumn' && isFreeTeam(design) ? drawnCards(design) : [elementFrame(design, id)]));
    case 'cards': {
      const rects = panelOf(sel) === 'teamColumn' ? teamCardRects(design, design.aspect) : panelBoxes(design, panelOf(sel));
      return sel.cards.filter((c) => rects[c]).map((c) => plain(rects[c]));
    }
    case 'children': {
      const panel = panelOf(sel);
      if (isTab(panel)) return tabFrames(design, tabSideOf(panel), panel, sel.names).map((f) => f.box);
      return panelBoxes(design, panel).flatMap((c) => childRects(design, panel, { x: c.x, y: c.y }, 1, state)
        .filter((r) => sel.names.includes(r.name)).map((r) => pieceFrame(design, r, panel, state)));
    }
  }
}

/** The box the handles sit on: for pieces, around them in the card (or single panel box) they were picked in, as drawn in `state`. */
export function selectionBox(design: HudDesign, sel: Selection, state?: State): Box | null {
  if (sel.kind === 'children') {
    const panel = panelOf(sel);
    if (offUnderTab(panel, state)) return null;
    if (isTab(panel)) {
      // The row it was picked in, or where it is drawn when that row does not draw it (Your row, from Layers, is row 1).
      const all = tabFrames(design, tabSideOf(panel), panel, sel.names);
      const here = all.filter((f) => f.card === sel.card);
      return unionBox((here.length ? here : all.filter((f) => f.card === all[0]?.card)).map((f) => f.box));
    }
    // Every teammate card, the fourth included (Free lists it), not only the three drawn.
    const c = panel === 'teamColumn' ? teamCardRects(design, design.aspect)[sel.card] : panelBoxes(design, panel)[sel.card];
    if (!c) return null;
    return unionBox(childRects(design, panel, { x: c.x, y: c.y }, 1, state).filter((r) => sel.names.includes(r.name)).map((r) => pieceFrame(design, r, panel, state)));
  }
  return unionBox(selectionFrames(design, sel, state));
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
    const def = childDef(panelOf(sel), sel.names[0]);
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

/**
 * Where the canvas draws a handle square and looks for it, in HUD units:
 * the box's point, pinned so the whole square (`half` units either side of
 * its centre) stays inside the canvas, `w` by `h`. A frame that runs past an
 * edge (a Free teammate card, an imported HUD's panel, which the scale
 * clamp does not move) keeps its handles reachable, against that edge.
 */
export interface HandleBounds { w: number; h: number; half: number }
const pin = (v: number, half: number, extent: number): number => Math.min(extent - half, Math.max(half, v));
export function handlePoints(box: Box, handles: Handle[], bounds?: HandleBounds): { x: number; y: number }[] {
  return handles.map((h) => {
    const p = handlePoint(box, h);
    return bounds ? { x: pin(p.x, bounds.half, bounds.w), y: pin(p.y, bounds.half, bounds.h) } : p;
  });
}

/**
 * The nearest handle within `slack` HUD units of the point, so a thin box's
 * side handle is reachable between its corners. With `bounds`, the handles
 * are where handlePoints pins them, the squares the canvas draws.
 */
export function handleAt(box: Box, handles: Handle[], ux: number, uy: number, slack: number, bounds?: HandleBounds): Handle | null {
  let best: { h: Handle; d: number } | null = null;
  const pts = handlePoints(box, handles, bounds);
  for (const [i, h] of handles.entries()) {
    const p = pts[i];
    const d = Math.max(Math.abs(ux - p.x), Math.abs(uy - p.y));
    if (d <= slack && (!best || d < best.d)) best = { h, d };
  }
  return best ? best.h : null;
}

/**
 * The box a panel's pieces are clamped to, in the panel file's own unfitted
 * frame, from (0, 0). The teammate card's is the unfitted base card, as in
 * Phase 1. A single panel's is the union of its frame block's base size and
 * every registered child's base rect (plan decision 9), so a piece that
 * already runs past the frame (the own panel's top scratch) is not yanked
 * inside on its first nudge. edit.ts clamps with the same box.
 *
 * A panel whose pieces are written to linked files (your infected health)
 * takes its container instead, HudZombieHealth as the base file sizes it
 * (stock 400 x 100, Modern 150 x 34): the container clips (probe Q11), so a
 * piece past it is cut in game, and the stock Hunter frame that runs to 450
 * is already cut there. edit.ts holds a piece that starts past it from
 * going further out (linkedHolds), rather than pulling it in.
 */
export function panelClamp(design: HudDesign, panel: string): { w: number; h: number } {
  const key = baseOf(design);
  if (panel === 'teamColumn') return baseTeam(key).card;
  const reg = panelChildren(panel);
  if (!reg) return { w: 0, h: 0 };
  const num = (n: ReturnType<typeof kvFind>, k: string) => { const f = parseFloat((n && kvGet(n, k)) ?? ''); return Number.isFinite(f) ? f : 0; };
  if (reg.linked && reg.frame === 'hudlayout') {
    const c = kvFind(baseTree(key, 'scripts/hudlayout.res'), [elementById(panel)!.key]);
    if (c) return { w: num(c, 'wide'), h: num(c, 'tall') };
  }
  let w = 0, h = 0;
  if (reg.frame && reg.frame !== 'hudlayout') {
    const f = kvFind(baseTree(key, reg.frame.file), [reg.frame.block]);
    w = num(f, 'wide'); h = num(f, 'tall');
  }
  const tree = baseTree(key, reg.file);
  for (const def of reg.children) {
    if (def.gate && !probe(def.gate)) continue;
    const n = blockIn(reg.file, tree, childPath(def.name));
    if (!n) continue;
    w = Math.max(w, num(n, 'xpos') + num(n, 'wide'));
    h = Math.max(h, num(n, 'ypos') + num(n, 'tall'));
  }
  return { w, h };
}

/**
 * What moving pieces snap to, in the panel file's unfitted frame (the frame
 * a ChildOverride is stored in): the panel's clamp box (panelClamp; for the
 * teammate card the unfitted card, which is what the Phase 1 drag clamps
 * to), and the other drawn pieces, each where it is drawn in `state`
 * (panelChild's x, which for a card's bar is its item row's; in the Down
 * state the bar is at the down picture's x, as childRects has it).
 */
export function pieceTargets(design: HudDesign, state: State, moving: string[], panel = 'teamColumn'): Box[] {
  const p = panelClamp(design, panel);
  const out: Box[] = [{ x: 0, y: 0, w: p.w, h: p.h }];
  const pic = previewOf(state).survivor === 'down' ? panelChild(design, panel, 'Incapacitated') : null;
  const file = panelFile(panel, state);
  for (const name of drawnPieces(design, state, panel)) {
    if (moving.includes(name)) continue;
    const c = panelChild(design, panel, name, file);
    if (c) out.push({ x: pic && isBar(name) && DOWN_MOVES_BAR.has(panel) ? pic.x : c.x, y: c.y, w: c.w, h: c.h });
  }
  return out;
}

/** What moving elements or cards snap to, in screen units: the screen, and every other visible thing of the side. */
export function sectionTargets(design: HudDesign, side: Side, sel: Selection): Box[] {
  const out: Box[] = [{ x: 0, y: 0, w: screenW(design.aspect), h: SCREEN_H }];
  // The Tab screen and the HUD are never seen apart while one moves: a Tab element snaps to the Tab screen, anything else to the HUD.
  const tab = selectedIds(sel).some(isTab);
  for (const el of visibleElements(side, design)) {
    if (!!el.tab !== tab) continue;
    if (sel.kind === 'elements' && sel.ids.includes(el.id)) continue;
    if (!elementRect(design, el.id, design.aspect).visible) continue;
    const rects = sectionRects(design, el.id);
    out.push(...(sel.kind === 'cards' && el.id === panelOf(sel) ? rects.filter((_, i) => !sel.cards.includes(i)) : rects));
  }
  return out;
}

/** A piece's guide, found in the unfitted frame, drawn where the piece is drawn in `card`. */
export function pieceGuideToScreen(g: Guide, card: Box, f: CardFrame): Guide {
  const X = (v: number) => card.x + (v - f.shift.x) * f.k;
  const Y = (v: number) => card.y + (v - f.shift.y) * f.k;
  return g.axis === 'x' ? { axis: 'x', at: X(g.at), from: Y(g.from), to: Y(g.to) } : { axis: 'y', at: Y(g.at), from: X(g.from), to: X(g.to) };
}

export type MenuAction = 'hide' | 'reset' | 'front' | 'back' | 'selectCard' | 'selectTeam';

/**
 * The right-click menu for a selection. A card cannot be hidden alone, and
 * has no reset of its own. Pieces also go to the front or the back of their
 * file (edit.ts's raiseChild). A single panel has no card level, so its
 * pieces climb straight to the element ('selectTeam' selects the panel's
 * element, whatever it is).
 */
export function menuActions(sel: Selection): MenuAction[] {
  switch (sel.kind) {
    // An element whose hide waits on a probe (HudElement.hideGate, the versus panel's TS7) offers no Hide while it is closed.
    case 'elements': return sel.ids.some((id) => { const g = elementById(id)?.hideGate; return !g || probe(g); }) ? ['hide', 'reset'] : ['reset'];
    case 'cards': return ['selectTeam'];
    // A Tab piece takes no zpos in v1 (only colours, the boxes and hides), and its hide may wait on a probe.
    case 'children': return isTab(panelOf(sel))
      ? [...(sel.names.some((n) => { const g = childDef(panelOf(sel), n)?.hideGate; return !g || probe(g); }) ? ['hide' as const] : []), 'reset', 'selectTeam']
      : hasCards(panelOf(sel))
        ? ['hide', 'reset', 'front', 'back', 'selectCard', 'selectTeam']
        : ['hide', 'reset', 'front', 'back', 'selectTeam'];
    default: return [];
  }
}
