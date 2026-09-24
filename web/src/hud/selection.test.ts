import { describe, it, expect } from 'vitest';
import { DEFAULT_DESIGN, type HudDesign, type Box } from './design';
import { teamCardRects, cardFrame } from './build';
import { childRects, type CardState } from './render';
import { withTeamDir, patchChild } from './edit';
import { panelBoxes } from './mock';
import {
  NONE, TEAMMATES, hitAt, targetOf, clickSelect, dragIntent, boxSelect, selectAll, climb, breadcrumb, selectionLabel,
  sanitize, selectedIds, selectionFrames, selectionBox, handlesFor, handlePoint, handleAt, pieceTargets, sectionTargets,
  pieceGuideToScreen, menuActions, drawnPieces, elementFrame, isPicked, pick, cardsOf, panelOf, type Selection, type Mods,
} from './selection';
import { unionBox } from './guides';

const D = DEFAULT_DESIGN;
const FREE = withTeamDir(DEFAULT_DESIGN, 'free');
const plain: Mods = { shift: false, ctrl: false };
const shift: Mods = { shift: true, ctrl: false };
const ctrl: Mods = { shift: false, ctrl: true };
// Card 2 of the fitted stock row is drawn at (153, 441), 121 x 36. Its
// portrait covers (153, 443) to (176, 466), its health bar (177, 457) to
// (273, 464); (273, 442) is on the card but on no other piece, only the
// splatter, the lowest-priority target there.
const HEAD2 = { x: 164, y: 454 };
const HEALTH2 = { x: 200, y: 460 };
const SPLATTER2 = { x: 273, y: 442 };
// Card 1's portrait, and a point in the stock container between cards 1 and 2 (on no card).
const HEAD1 = { x: 24, y: 454 };
const GAP12 = { x: 143, y: 450 };
const click = (d: HudDesign, sel: Selection, p: { x: number; y: number }, mods = plain, state: CardState = 'healthy') =>
  clickSelect(d, sel, hitAt(d, 'survivor', state, p.x, p.y), mods);

describe('click', () => {
  it('picks the piece under the pointer in one click', () => {
    expect(click(D, NONE, HEAD2)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
  });

  it('picks what the preview state draws there', () => {
    expect(click(D, NONE, HEAD2, plain, 'down')).toEqual({ kind: 'children', names: ['Incapacitated'], card: 1 });
  });

  it('picks the splatter, the lowest-priority piece, where no other piece is', () => {
    expect(click(D, NONE, SPLATTER2)).toEqual({ kind: 'children', names: ['BackgroundImage'], card: 1 });
    // A real piece drawn on top of it still wins.
    expect(click(D, NONE, HEAD2)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
  });

  it('picks the card itself only where nothing at all is drawn there, not even the splatter', () => {
    const noSplatter = patchChild(D, 'BackgroundImage', { visible: false });
    expect(click(noSplatter, NONE, SPLATTER2)).toEqual({ kind: 'cards', cards: [1] });
  });

  it('picks the element where no card is, and nothing on empty screen', () => {
    expect(click(D, NONE, GAP12)).toEqual(TEAMMATES);
    expect(click(D, NONE, { x: 780, y: 430 })).toEqual({ kind: 'elements', ids: ['ownHealth'] });
    expect(click(D, TEAMMATES, { x: 426, y: 100 })).toEqual(NONE);
  });

  it('reports the card under the pointer in Row as in Free', () => {
    expect(hitAt(D, 'survivor', 'healthy', SPLATTER2.x, SPLATTER2.y)).toEqual({ element: 'teamColumn', card: 1, child: 'BackgroundImage' });
    expect(hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y)).toEqual({ element: 'teamColumn', card: 1, child: 'Head' });
    expect(hitAt(D, 'survivor', 'healthy', GAP12.x, GAP12.y)).toEqual({ element: 'teamColumn', card: null, child: null });
  });

  it('picks a Free card the same way as Row: a piece if one is there, else the splatter', () => {
    expect(click(FREE, NONE, SPLATTER2)).toEqual({ kind: 'children', names: ['BackgroundImage'], card: 1 });
    expect(click(FREE, NONE, HEAD2)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
  });

  it("climbs one level with Ctrl: the piece's card, and from that card the Teammates", () => {
    const card2: Selection = { kind: 'cards', cards: [1] };
    expect(click(D, NONE, HEAD2, ctrl)).toEqual(card2);
    expect(click(D, card2, HEAD2, ctrl)).toEqual(TEAMMATES);
    // The splatter climbs like any other piece: first its card, then the Teammates.
    expect(click(D, NONE, SPLATTER2, ctrl)).toEqual(card2);
    expect(click(D, card2, SPLATTER2, ctrl)).toEqual(TEAMMATES);
    expect(click(FREE, NONE, HEAD2, ctrl)).toEqual(card2);
    expect(click(FREE, card2, HEAD2, ctrl)).toEqual(TEAMMATES);
    expect(click(FREE, NONE, SPLATTER2, ctrl)).toEqual(card2);
    // Another card picked is not this card: Ctrl still picks this one.
    expect(click(D, { kind: 'cards', cards: [0] }, HEAD2, ctrl)).toEqual(card2);
  });

  it('adds and removes cards with Shift while cards are picked, lifting a piece to its card', () => {
    const card2: Selection = { kind: 'cards', cards: [1] };
    const both = click(D, card2, HEAD1, shift);
    expect(both).toEqual({ kind: 'cards', cards: [0, 1] });
    // Shift on any part of a picked card, splatter included, lifts the target to that card.
    expect(click(D, both, SPLATTER2, shift)).toEqual({ kind: 'cards', cards: [0] });
    expect(click(D, { kind: 'cards', cards: [0] }, HEAD1, shift)).toEqual(NONE);
    // Off the cards Shift starts again at the level the click picks.
    expect(click(D, both, { x: 780, y: 430 }, shift)).toEqual({ kind: 'elements', ids: ['ownHealth'] });
    // At another level Shift on a card's piece starts a new selection at the piece.
    expect(click(D, TEAMMATES, HEAD2, shift)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
    // The Layers list picks cards the same way, kept sorted.
    expect(pick({ kind: 'cards', cards: [2] }, cardsOf([0]), true)).toEqual({ kind: 'cards', cards: [0, 2] });
    expect(cardsOf([2, 0, 2])).toEqual({ kind: 'cards', cards: [0, 2] });
  });

  it('adds and removes with Shift at the same level, and starts again at another', () => {
    const one = click(D, NONE, HEAD2);
    const two = click(D, one, HEALTH2, shift);
    expect(two).toEqual({ kind: 'children', names: ['Head', 'Health'], card: 1 });
    expect(click(D, two, HEAD2, shift)).toEqual({ kind: 'children', names: ['Health'], card: 1 });
    const el = click(D, two, { x: 780, y: 430 }, shift);
    expect(el).toEqual({ kind: 'elements', ids: ['ownHealth'] });
    const els = click(D, el, { x: 100, y: 300 }, shift);
    expect(els).toEqual({ kind: 'elements', ids: ['ownHealth', 'chat'] });
    expect(click(D, els, { x: 426, y: 100 }, shift)).toBe(els);                  // Shift on nothing keeps the selection
    expect(click(D, el, { x: 780, y: 430 }, shift)).toEqual(NONE);               // the last one taken away
  });
});

describe('drag', () => {
  it('moves a selected element from anywhere inside its frame, even where a smaller element sits on top', () => {
    // The owner's report, 2026-09-24: Your health at scale 2 covers the weapons, the kill
    // notices and the chat, and the smallest element under a point wins the hit, so a drag
    // inside the selected panel moved (and selected) whatever smaller thing sat there.
    const big: HudDesign = { ...structuredClone(D), elements: { ...D.elements, ownHealth: { x: 339, y: 136, scale: 2 } } };
    const own: Selection = { kind: 'elements', ids: ['ownHealth'] };
    const f = elementFrame(big, 'ownHealth');
    // The use / revive bar sits inside the scaled panel here and is the smaller of the two.
    const b = elementFrame(big, 'progressBar');
    const p = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    expect(p.x > f.x && p.x < f.x + f.w && p.y > f.y && p.y < f.y + f.h).toBe(true);
    const hit = hitAt(big, 'survivor', 'healthy', p.x, p.y);
    expect(hit.element).toBe('progressBar');
    expect(dragIntent(big, own, hit, plain, null, p)).toEqual({ kind: 'move', sel: own });
    // With nothing selected, and outside the selected frame, the element under the point still wins.
    expect(dragIntent(big, NONE, hit, plain, null, p)).toEqual({ kind: 'move', sel: { kind: 'elements', ids: ['progressBar'] } });
    expect(dragIntent(big, own, hitAt(big, 'survivor', 'healthy', 426, 20), plain, null, { x: 426, y: 20 }).kind).not.toBe('move');
  });

  it('moves only the card under the pointer when the drag starts on one not picked, in any layout', () => {
    const card2: Selection = { kind: 'cards', cards: [1] };
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(D, NONE, hit, plain)).toEqual({ kind: 'move', sel: card2 });
    expect(dragIntent(D, { kind: 'children', names: ['Health'], card: 0 }, hit, plain)).toEqual({ kind: 'move', sel: card2 });
    expect(dragIntent(D, { kind: 'cards', cards: [0] }, hit, plain)).toEqual({ kind: 'move', sel: card2 });
    const free = hitAt(FREE, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(FREE, NONE, free, plain)).toEqual({ kind: 'move', sel: card2 });
    // The Free Teammates cannot move as one, so a drag on a card moves that card.
    expect(dragIntent(FREE, TEAMMATES, free, plain)).toEqual({ kind: 'move', sel: card2 });
    // Off the cards, the stock container still moves the whole team.
    expect(dragIntent(D, NONE, hitAt(D, 'survivor', 'healthy', GAP12.x, GAP12.y), plain)).toEqual({ kind: 'move', sel: TEAMMATES });
  });

  it('moves the whole Row team when the Teammates are picked, and every picked card from any of them', () => {
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(isPicked(D, TEAMMATES, hit)).toBe(true);
    expect(dragIntent(D, TEAMMATES, hit, plain)).toEqual({ kind: 'move', sel: TEAMMATES });
    const cards: Selection = { kind: 'cards', cards: [0, 1] };
    expect(isPicked(D, cards, hit)).toBe(true);
    expect(dragIntent(D, cards, hit, plain)).toEqual({ kind: 'move', sel: cards });
    expect(isPicked(D, cards, hitAt(D, 'survivor', 'healthy', 300, 450))).toBe(false);
  });

  it('moves the selection when the drag starts on part of it, in any card', () => {
    const sel: Selection = { kind: 'children', names: ['Head', 'Health'], card: 0 };
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(D, sel, hit, plain)).toEqual({ kind: 'move', sel });
  });

  it('moves the splatter once it is picked, and its own handles resize it', () => {
    const splatter: Selection = { kind: 'children', names: ['BackgroundImage'], card: 1 };
    const hit = hitAt(D, 'survivor', 'healthy', SPLATTER2.x, SPLATTER2.y);
    expect(isPicked(D, splatter, hit)).toBe(true);
    expect(dragIntent(D, splatter, hit, plain)).toEqual({ kind: 'move', sel: splatter });
    // A wh piece takes all eight handles, the splatter included.
    expect(handlesFor(D, splatter)).toHaveLength(8);
    expect(dragIntent(D, splatter, hit, plain, 'se')).toEqual({ kind: 'resize', handle: 'se' });
    // Not yet picked, the same spot still moves the card under it instead.
    expect(dragIntent(D, NONE, hit, plain)).toEqual({ kind: 'move', sel: { kind: 'cards', cards: [1] } });
  });

  it('draws a box with Shift, and does nothing from empty screen', () => {
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(D, NONE, hit, shift)).toEqual({ kind: 'box' });
    expect(dragIntent(D, NONE, hitAt(D, 'survivor', 'healthy', 426, 100), plain)).toEqual({ kind: 'none' });
  });

  it('resizes from a handle, with or without Shift', () => {
    const sel: Selection = { kind: 'elements', ids: ['chat'] };
    const hit = hitAt(D, 'survivor', 'healthy', 100, 300);
    expect(dragIntent(D, sel, hit, shift, 'se')).toEqual({ kind: 'resize', handle: 'se' });
    expect(dragIntent(D, sel, hit, plain, 'n')).toEqual({ kind: 'resize', handle: 'n' });
    expect(dragIntent(D, sel, hit, shift, null)).toEqual({ kind: 'box' });
  });
});

describe('box and Ctrl+A', () => {
  it('picks the drawn pieces a box started inside a card touches', () => {
    expect(boxSelect(D, 'survivor', 'healthy', { x: 200, y: 456 }, { x: 240, y: 470 }))
      .toEqual({ kind: 'children', names: ['Health', 'Name'], card: 1 });
  });

  it('picks the elements a box started outside the cards touches, or nothing', () => {
    expect(boxSelect(D, 'survivor', 'healthy', { x: 5, y: 300 }, { x: 40, y: 420 }))
      .toEqual({ kind: 'elements', ids: ['teamColumn', 'chat'] });
    expect(boxSelect(D, 'survivor', 'healthy', { x: 400, y: 20 }, { x: 420, y: 40 })).toEqual(NONE);
  });

  it('selects every drawn piece of the card, or every visible element of the side', () => {
    const piece: Selection = { kind: 'children', names: ['Head'], card: 1 };
    expect(selectAll(D, 'survivor', 'healthy', piece)).toEqual({ kind: 'children', names: ['Head', 'Health', 'Name', 'Items', 'Status'], card: 1 });
    expect(selectAll(D, 'survivor', 'down', piece)).toEqual({ kind: 'children', names: ['Health', 'Name', 'Items', 'Status', 'Incapacitated'], card: 1 });
    expect(selectAll({ ...D, crosshair: 'addon' }, 'survivor', 'healthy', NONE)).toEqual({ kind: 'elements',
      ids: ['ownHealth', 'teamColumn', 'weaponSelection', 'chat', 'progressBar', 'killNotices', 'xhair'] });
    // With crosshair 'none' there is no xHair element to select.
    expect(selectAll(D, 'survivor', 'healthy', NONE)).toEqual({ kind: 'elements',
      ids: ['ownHealth', 'teamColumn', 'weaponSelection', 'chat', 'progressBar', 'killNotices'] });
  });

  it('never counts a hidden piece or decoration as drawn', () => {
    expect(drawnPieces(D, 'healthy')).toEqual(['Head', 'Health', 'Name', 'Items', 'Status']);
    expect(drawnPieces(patchChild(D, 'Name', { visible: false }), 'healthy')).toEqual(['Head', 'Health', 'Items', 'Status']);
  });
});

describe('levels', () => {
  // The levels are the same in every layout, so none of these needs the design.
  it('climbs one level on Escape: piece, card, Teammates, nothing', () => {
    expect(climb({ kind: 'children', names: ['Head'], card: 1 })).toEqual({ kind: 'cards', cards: [1] });
    expect(climb({ kind: 'cards', cards: [0, 1] })).toEqual(TEAMMATES);
    expect(climb(TEAMMATES)).toEqual(NONE);
  });

  it('names the path for the breadcrumb', () => {
    const labels = (s: Selection) => breadcrumb(s).map((c) => c.label);
    expect(labels({ kind: 'children', names: ['Health'], card: 1 })).toEqual(['Teammates', 'Card 2', 'Health bar']);
    expect(labels({ kind: 'children', names: ['Head', 'Health', 'Name'], card: 0 })).toEqual(['Teammates', 'Card 1', '3 pieces']);
    expect(labels({ kind: 'cards', cards: [2] })).toEqual(['Teammates', 'Card 3']);
    expect(labels({ kind: 'cards', cards: [0, 2] })).toEqual(['Teammates', '2 cards']);
    expect(breadcrumb({ kind: 'cards', cards: [0, 2] })[0].sel).toEqual(TEAMMATES);
    expect(labels({ kind: 'elements', ids: ['chat', 'ownHealth'] })).toEqual(['2 elements']);
    expect(breadcrumb({ kind: 'children', names: ['Health'], card: 1 })[1].sel).toEqual({ kind: 'cards', cards: [1] });
    expect(selectionLabel({ kind: 'elements', ids: ['chat'] })).toBe('Chat');
  });

  it('keeps a selection that still applies and drops what does not', () => {
    const els: Selection = { kind: 'elements', ids: ['chat', 'ownHealth'] };
    expect(sanitize(D, 'survivor', els)).toBe(els);
    expect(sanitize(D, 'infected', els)).toEqual({ kind: 'elements', ids: ['chat'] });
    const added = patchChild(D, 'HealthNumber', { on: true });
    const kids: Selection = { kind: 'children', names: ['Head', 'HealthNumber'], card: 0 };
    expect(sanitize(added, 'survivor', kids)).toBe(kids);
    expect(sanitize(D, 'survivor', kids)).toEqual({ kind: 'children', names: ['Head'], card: 0 });
    expect(sanitize(D, 'survivor', { kind: 'children', names: ['HealthNumber'], card: 0 })).toEqual(TEAMMATES);
    // Cards are a level in every layout; card 4 is one only in Free, where it is listed.
    const cards: Selection = { kind: 'cards', cards: [1, 2] };
    expect(sanitize(D, 'survivor', cards)).toBe(cards);
    expect(sanitize(D, 'survivor', { kind: 'cards', cards: [1, 3] })).toEqual({ kind: 'cards', cards: [1] });
    expect(sanitize(D, 'survivor', { kind: 'cards', cards: [3] })).toEqual(TEAMMATES);
    const four: Selection = { kind: 'cards', cards: [3] };
    expect(sanitize(FREE, 'survivor', four)).toBe(four);
    expect(sanitize(D, 'infected', cards)).toEqual(NONE);
    expect(selectedIds(cards)).toEqual(['teamColumn']);
    expect(selectedIds({ kind: 'children', names: ['Head'], card: 0 })).toEqual(['teamColumn']);
  });
});

describe('what the canvas draws for a selection', () => {
  it('frames a piece in every drawn card, from the generated tree', () => {
    const frames = selectionFrames(D, { kind: 'children', names: ['Head'], card: 0 });
    const cards = teamCardRects(D, D.aspect).slice(0, 3);
    expect(frames).toEqual(cards.map((c) => {
      const r = childRects(D, 'teamColumn', { x: c.x, y: c.y }, 1).find((x) => x.name === 'Head')!;
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }));
  });

  it('frames the Free teammates as their three cards, not the screen', () => {
    expect(selectionFrames(FREE, TEAMMATES)).toEqual(teamCardRects(FREE, FREE.aspect).slice(0, 3));
  });

  // Stock's container hangs 25 units off the bottom of the screen at r75,
  // so the Teammates are framed by the three cards the preview draws.
  it('frames the Teammates by their drawn cards, on screen, with every corner handle on screen', () => {
    const cards = teamCardRects(D, D.aspect).slice(0, 3);
    const box = selectionBox(D, TEAMMATES)!;
    expect(box).toEqual(unionBox(cards.map(({ x, y, w, h }) => ({ x, y, w, h }))));
    expect(box.y + box.h).toBeLessThanOrEqual(480);
    for (const h of handlesFor(D, TEAMMATES)) {
      const p = handlePoint(box, h);
      expect(p.y, h).toBeLessThanOrEqual(480);
      expect(p.y, h).toBeGreaterThanOrEqual(0);
    }
    expect(elementFrame(D, 'teamColumn')).toEqual(box);
    expect(elementFrame(D, 'chat')).toEqual(selectionBox(D, { kind: 'elements', ids: ['chat'] }));
  });

  it('frames your own health by its fitted panel when fitted, else by its element', () => {
    const d = { ...structuredClone(D), elements: { ownHealth: { x: 20, y: 380 } } };
    expect(elementFrame(d, 'ownHealth')).toEqual(selectionBox(d, { kind: 'elements', ids: ['ownHealth'] }));
    const r = elementFrame(d, 'ownHealth');
    const fitted = { ...d, elements: { ownHealth: { x: 20, y: 380, fit: true } } };
    expect(elementFrame(fitted, 'ownHealth')).toEqual(panelBoxes(fitted, 'ownHealth')[0]);
    expect(elementFrame(fitted, 'ownHealth')).not.toEqual(r);
  });

  it('frames each picked card where it is drawn, in Row as in Free', () => {
    const rects = teamCardRects(D, D.aspect).map(({ x, y, w, h }) => ({ x, y, w, h }));
    expect(selectionFrames(D, { kind: 'cards', cards: [0, 2] })).toEqual([rects[0], rects[2]]);
    expect(selectionBox(D, { kind: 'cards', cards: [0, 2] })).toEqual(unionBox([rects[0], rects[2]]));
  });

  it("boxes several pieces in the card they were picked in", () => {
    expect(selectionBox(D, { kind: 'children', names: ['Head', 'Health'], card: 1 })).toEqual({ x: 153, y: 443, w: 120, h: 23 });
    expect(selectionBox(D, NONE)).toBeNull();
  });

  // buildTrees runs hidePass, so a piece the player hid is 0 x 0 in the
  // generated tree childRects reads; picking it in Layers must still show a
  // real frame, from cardChild (which cardWork never hides), not a point.
  it('frames a hidden piece by its real size, not the 0x0 buildTrees writes for it', () => {
    const hidden = patchChild(D, 'BackgroundImage', { visible: false });
    const cards = teamCardRects(hidden, hidden.aspect).slice(0, 3);
    const zeroedIn = (c: Box) => childRects(hidden, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'BackgroundImage')!;
    for (const c of cards) expect([zeroedIn(c).w, zeroedIn(c).h]).toEqual([0, 0]);   // pins the trap this fix works around

    // Non-circular: hiding a piece must not change the frame it reports,
    // only whether it draws. At a team scale other than 1 (so a fix that
    // forgot to scale cardChild's unscaled real size would show up), a
    // hidden piece's frame has to equal that very piece's own frame while
    // visible, found the ordinary way (childRects on an untouched design),
    // not by asking cardChild what the fix itself would use.
    const scaled = { ...D, elements: { ...D.elements, teamColumn: { ...D.elements.teamColumn, scale: 1.5 } } };
    const scaledHidden = patchChild(scaled, 'BackgroundImage', { visible: false });
    const visibleFrame = selectionFrames(scaled, { kind: 'children', names: ['BackgroundImage'], card: 0 });
    const hiddenFrame = selectionFrames(scaledHidden, { kind: 'children', names: ['BackgroundImage'], card: 0 });
    expect(visibleFrame[0].w).toBeGreaterThan(0);
    expect(visibleFrame[0].h).toBeGreaterThan(0);
    expect(hiddenFrame).toEqual(visibleFrame);

    const frames = selectionFrames(hidden, { kind: 'children', names: ['BackgroundImage'], card: 0 });
    expect(selectionBox(hidden, { kind: 'children', names: ['BackgroundImage'], card: 0 })).toEqual(frames[0]);
  });

  // A mixed group's union must use the hidden piece's real footprint, not
  // the point buildTrees zeroes it to: pinned against that old, buggy union.
  it("does not stretch a mixed group's union box to a hidden piece's zeroed origin", () => {
    const hidden = patchChild(D, 'BackgroundImage', { visible: false });
    const card = teamCardRects(hidden, hidden.aspect)[0];
    const zeroed = childRects(hidden, 'teamColumn', { x: card.x, y: card.y }, 1).find((r) => r.name === 'BackgroundImage')!;
    const headBox = selectionBox(hidden, { kind: 'children', names: ['Head'], card: 0 })!;
    const mixedBox = selectionBox(hidden, { kind: 'children', names: ['Head', 'BackgroundImage'], card: 0 })!;
    const oldBuggyBox = unionBox([headBox, { x: zeroed.x, y: zeroed.y, w: 0, h: 0 }])!;
    expect(mixedBox).not.toEqual(oldBuggyBox);
    const bgFrame = selectionFrames(hidden, { kind: 'children', names: ['BackgroundImage'], card: 0 })[0];
    expect(mixedBox).toEqual(unionBox([headBox, bgFrame]));
  });

  it('offers the handles the spec table lists', () => {
    const el = (id: string) => handlesFor(D, { kind: 'elements', ids: [id] });
    expect(el('ownHealth')).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(el('chat')).toEqual(['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']);
    expect(el('xhair')).toEqual([]);       // move: false, resize: 'none'
    expect(handlesFor(FREE, TEAMMATES)).toEqual([]);
    expect(handlesFor(FREE, { kind: 'cards', cards: [0] })).toEqual([]);
    expect(handlesFor(D, { kind: 'cards', cards: [0, 1] })).toEqual([]);
    const piece = (names: string[]) => handlesFor(D, { kind: 'children', names, card: 0 });
    expect(piece(['Health'])).toHaveLength(8);
    expect(piece(['Head'])).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(piece(['Items'])).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(piece(['Head', 'Health'])).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(handlesFor(D, { kind: 'elements', ids: ['chat', 'ownHealth'] })).toEqual([]);
  });

  it('places handles on the box and finds the nearest one under the pointer', () => {
    const box = { x: 0, y: 0, w: 100, h: 10 };
    expect(handlePoint(box, 'se')).toEqual({ x: 100, y: 10 });
    expect(handlePoint(box, 'n')).toEqual({ x: 50, y: 0 });
    const all = handlesFor(D, { kind: 'elements', ids: ['chat'] });
    expect(handleAt(box, all, 100, 5, 5)).toBe('e');
    expect(handleAt(box, all, 100, 1, 5)).toBe('ne');
    expect(handleAt(box, all, 50, 50, 5)).toBeNull();
  });
});

describe('snap targets', () => {
  it('snaps a piece to the unfitted card and the other drawn pieces', () => {
    expect(pieceTargets(D, 'healthy', ['Head'])).toEqual([
      { x: 0, y: 0, w: 150, h: 150 },
      { x: 37, y: 52, w: 96, h: 7 }, { x: 13, y: 60, w: 120, h: 12 },
      { x: 39, y: 36, w: 50, h: 14 }, { x: 64, y: 38, w: 70, h: 12 },
    ]);
  });

  it('snaps a section to the screen and the other visible elements of the side', () => {
    const got = sectionTargets(D, 'survivor', { kind: 'elements', ids: ['chat'] });
    expect(got[0]).toEqual({ x: 0, y: 0, w: 853, h: 480 });
    expect(got).toContainEqual({ x: 728, y: 421, w: 130, h: 53 });   // your own health, fitted by default (slice 2.F G2)
    expect(got).not.toContainEqual({ x: 10, y: 275, w: 320, h: 120 });
    const cards = teamCardRects(FREE, FREE.aspect);
    const free = sectionTargets(FREE, 'survivor', { kind: 'cards', cards: [1, 2] });
    expect(free).toContainEqual(cards[0]);
    expect(free).not.toContainEqual(cards[1]);
    expect(free).not.toContainEqual(cards[2]);
  });

  it("draws a piece's guide where the piece is drawn", () => {
    const card = teamCardRects(D, D.aspect)[1];
    expect(pieceGuideToScreen({ axis: 'x', at: 37, from: 36, to: 72 }, card, cardFrame(D)))
      .toEqual({ axis: 'x', at: 177, from: 441, to: 477 });
  });
});

describe('the right-click menu', () => {
  it('offers what applies to the selection', () => {
    expect(menuActions({ kind: 'elements', ids: ['chat'] })).toEqual(['hide', 'reset']);
    expect(menuActions({ kind: 'children', names: ['Head'], card: 0 })).toEqual(['hide', 'reset', 'front', 'back', 'selectCard', 'selectTeam']);
    expect(menuActions({ kind: 'cards', cards: [0] })).toEqual(['selectTeam']);
    expect(menuActions({ kind: 'cards', cards: [0, 1] })).toEqual(['selectTeam']);
    expect(menuActions(NONE)).toEqual([]);
  });
});

describe('targetOf', () => {
  it('is what a hover outlines: the deepest thing, or one up with Ctrl', () => {
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(targetOf(D, hit)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
    expect(targetOf(D, hit, true)).toEqual({ kind: 'cards', cards: [1] });
    // With that card already picked, a Ctrl+click (and so the Ctrl hover) goes to the Teammates.
    expect(targetOf(D, hit, true, { kind: 'cards', cards: [1] })).toEqual(TEAMMATES);
  });
});

describe('the children level names its panel', () => {
  it('leaves the panel out for the teammate card, so old selections still compare equal', () => {
    const [c] = panelBoxes(D, 'teamColumn');
    const hit = hitAt(D, 'survivor', 'healthy', c.x + 1, c.y + 1);
    const t = targetOf(D, hit);
    expect(t.kind).toBe('children');
    if (t.kind === 'children') expect('panel' in t).toBe(false);
    expect(panelOf({})).toBe('teamColumn');
  });
  it('never mixes pieces of two panels in a Shift pick', () => {
    const a: Selection = { kind: 'children', names: ['Head'], card: 0 };
    const b: Selection = { kind: 'children', names: ['Health'], card: 0, panel: 'ownHealth' };
    expect(pick(a, b, true)).toEqual(b);
  });
  it('climbs from a single panel\'s pieces straight to its element', () => {
    expect(climb({ kind: 'children', names: ['Health'], card: 0, panel: 'ownHealth' })).toEqual({ kind: 'elements', ids: ['ownHealth'] });
    expect(selectedIds({ kind: 'children', names: ['Health'], card: 0, panel: 'ownHealth' })).toEqual(['ownHealth']);
  });
});
