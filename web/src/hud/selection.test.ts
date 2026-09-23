import { describe, it, expect } from 'vitest';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { teamCardRects, cardFrame } from './build';
import { childRects, type CardState } from './render';
import { withTeamDir, patchChild } from './edit';
import {
  NONE, TEAMMATES, hitAt, targetOf, clickSelect, dragIntent, boxSelect, selectAll, climb, breadcrumb, selectionLabel,
  sanitize, selectedIds, selectionFrames, selectionBox, handlesFor, handlePoint, handleAt, pieceTargets, sectionTargets,
  pieceGuideToScreen, menuActions, drawnPieces, elementFrame, type Selection, type Mods,
} from './selection';
import { unionBox } from './guides';

const D = DEFAULT_DESIGN;
const FREE = withTeamDir(DEFAULT_DESIGN, 'free');
const plain: Mods = { shift: false, ctrl: false };
const shift: Mods = { shift: true, ctrl: false };
const ctrl: Mods = { shift: false, ctrl: true };
// Card 2 of the fitted stock row is drawn at (153, 441), 121 x 36. Its
// portrait covers (153, 443) to (176, 466), its health bar (177, 457) to
// (273, 464); (273, 442) is on the card but on no piece (only the splatter).
const HEAD2 = { x: 164, y: 454 };
const HEALTH2 = { x: 200, y: 460 };
const EMPTY2 = { x: 273, y: 442 };
const click = (d: HudDesign, sel: Selection, p: { x: number; y: number }, mods = plain, state: CardState = 'healthy') =>
  clickSelect(d, sel, hitAt(d, 'survivor', state, p.x, p.y), mods);

describe('click', () => {
  it('picks the piece under the pointer in one click', () => {
    expect(click(D, NONE, HEAD2)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
  });

  it('picks what the preview state draws there', () => {
    expect(click(D, NONE, HEAD2, plain, 'down')).toEqual({ kind: 'children', names: ['Incapacitated'], card: 1 });
  });

  it('picks the element where no piece is, and nothing on empty screen', () => {
    expect(click(D, NONE, EMPTY2)).toEqual(TEAMMATES);
    expect(click(D, NONE, { x: 780, y: 430 })).toEqual({ kind: 'elements', ids: ['ownHealth'] });
    expect(click(D, TEAMMATES, { x: 426, y: 100 })).toEqual(NONE);
  });

  it('picks a Free card where no piece is', () => {
    expect(click(FREE, NONE, EMPTY2)).toEqual({ kind: 'card', card: 1 });
    expect(click(FREE, NONE, HEAD2)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
  });

  it('climbs one level with Ctrl', () => {
    expect(click(D, NONE, HEAD2, ctrl)).toEqual(TEAMMATES);
    expect(click(FREE, NONE, HEAD2, ctrl)).toEqual({ kind: 'card', card: 1 });
    expect(click(FREE, NONE, EMPTY2, ctrl)).toEqual(TEAMMATES);
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
  it('moves the outermost section when the drag starts on something not selected', () => {
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(D, NONE, hit, plain)).toEqual({ kind: 'move', sel: TEAMMATES });
    const free = hitAt(FREE, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(FREE, NONE, free, plain)).toEqual({ kind: 'move', sel: { kind: 'card', card: 1 } });
    // The Free Teammates cannot move as one, so a drag on a card moves that card.
    expect(dragIntent(FREE, TEAMMATES, free, plain)).toEqual({ kind: 'move', sel: { kind: 'card', card: 1 } });
  });

  it('moves the selection when the drag starts on part of it, in any card', () => {
    const sel: Selection = { kind: 'children', names: ['Head', 'Health'], card: 0 };
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(D, sel, hit, plain)).toEqual({ kind: 'move', sel });
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
    expect(selectAll(D, 'survivor', 'healthy', NONE)).toEqual({ kind: 'elements',
      ids: ['ownHealth', 'teamColumn', 'weaponSelection', 'chat', 'targetId', 'progressBar', 'xhair'] });
  });

  it('never counts a hidden piece or decoration as drawn', () => {
    expect(drawnPieces(D, 'healthy')).toEqual(['Head', 'Health', 'Name', 'Items', 'Status']);
    expect(drawnPieces(patchChild(D, 'Name', { visible: false }), 'healthy')).toEqual(['Head', 'Health', 'Items', 'Status']);
  });
});

describe('levels', () => {
  it('climbs one level on Escape', () => {
    expect(climb(D, { kind: 'children', names: ['Head'], card: 1 })).toEqual(TEAMMATES);
    expect(climb(FREE, { kind: 'children', names: ['Head'], card: 1 })).toEqual({ kind: 'card', card: 1 });
    expect(climb(FREE, { kind: 'card', card: 1 })).toEqual(TEAMMATES);
    expect(climb(D, TEAMMATES)).toEqual(NONE);
  });

  it('names the path for the breadcrumb', () => {
    const labels = (d: HudDesign, s: Selection) => breadcrumb(d, s).map((c) => c.label);
    expect(labels(D, { kind: 'children', names: ['Health'], card: 1 })).toEqual(['Teammates', 'Health bar']);
    expect(labels(FREE, { kind: 'children', names: ['Health'], card: 1 })).toEqual(['Teammates', 'Card 2', 'Health bar']);
    expect(labels(D, { kind: 'children', names: ['Head', 'Health', 'Name'], card: 0 })).toEqual(['Teammates', '3 pieces']);
    expect(labels(FREE, { kind: 'card', card: 1 })).toEqual(['Teammates', 'Card 2']);
    expect(labels(D, { kind: 'elements', ids: ['chat', 'ownHealth'] })).toEqual(['2 elements']);
    expect(breadcrumb(FREE, { kind: 'children', names: ['Health'], card: 1 })[1].sel).toEqual({ kind: 'card', card: 1 });
    expect(selectionLabel(D, { kind: 'elements', ids: ['chat'] })).toBe('Chat');
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
    expect(sanitize(D, 'survivor', { kind: 'card', card: 1 })).toEqual(TEAMMATES);
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

  it("boxes several pieces in the card they were picked in", () => {
    expect(selectionBox(D, { kind: 'children', names: ['Head', 'Health'], card: 1 })).toEqual({ x: 153, y: 443, w: 120, h: 23 });
    expect(selectionBox(D, NONE)).toBeNull();
  });

  it('offers the handles the spec table lists', () => {
    const el = (id: string) => handlesFor(D, { kind: 'elements', ids: [id] });
    expect(el('ownHealth')).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(el('chat')).toEqual(['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']);
    expect(el('targetId')).toEqual([]);
    expect(handlesFor(FREE, TEAMMATES)).toEqual([]);
    expect(handlesFor(FREE, { kind: 'card', card: 0 })).toEqual([]);
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
    expect(got).toContainEqual({ x: 728, y: 389, w: 125, h: 91 });
    expect(got).not.toContainEqual({ x: 10, y: 275, w: 320, h: 120 });
    const cards = teamCardRects(FREE, FREE.aspect);
    const free = sectionTargets(FREE, 'survivor', { kind: 'card', card: 1 });
    expect(free).toContainEqual(cards[0]);
    expect(free).not.toContainEqual(cards[1]);
  });

  it("draws a piece's guide where the piece is drawn", () => {
    const card = teamCardRects(D, D.aspect)[1];
    expect(pieceGuideToScreen({ axis: 'x', at: 37, from: 36, to: 72 }, card, cardFrame(D)))
      .toEqual({ axis: 'x', at: 177, from: 441, to: 477 });
  });
});

describe('the right-click menu', () => {
  it('offers what applies to the selection', () => {
    expect(menuActions(D, { kind: 'elements', ids: ['chat'] })).toEqual(['hide', 'reset']);
    expect(menuActions(D, { kind: 'children', names: ['Head'], card: 0 })).toEqual(['hide', 'reset', 'selectTeam']);
    expect(menuActions(FREE, { kind: 'children', names: ['Head'], card: 0 })).toEqual(['hide', 'reset', 'selectCard', 'selectTeam']);
    expect(menuActions(FREE, { kind: 'card', card: 0 })).toEqual(['selectTeam']);
    expect(menuActions(D, NONE)).toEqual([]);
  });
});

describe('targetOf', () => {
  it('is what a hover outlines: the deepest thing, or one up with Ctrl', () => {
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(targetOf(D, hit)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
    expect(targetOf(D, hit, true)).toEqual(TEAMMATES);
  });
});
