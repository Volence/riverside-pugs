import { describe, it, expect } from 'vitest';
import {
  nudge, nudgeCard, hasOverrides, elementsTouched, resetElement, withTeamDir, placeCard, patchChild,
  placeChild, nudgeChild, resizeChild, resetChild,
  startsOf, moveChildren, placeChildren, scaleChildren, cornerFactor, anchorOf, alignChildren, setChildrenVisible, resetChildren,
  placeElement, moveElements, moveCard, alignElements, scaleElement, resizeBox, resizeElement, nudgeSelection, hideSelection, setSelectionVisible, resetSelection,
} from './edit';
import { DEFAULT_DESIGN } from './design';
import { teamCardRects, elementRect, cardChild } from './build';

describe('nudge', () => {
  it('starts from the base position the first time', () => {
    const d = nudge(DEFAULT_DESIGN, 'ownHealth', -10, 0);
    expect(d.elements.ownHealth).toEqual({ x: 718, y: 389 });
  });
  it('does nothing to an element that cannot move', () => {
    expect(nudge(DEFAULT_DESIGN, 'targetId', 5, 5)).toBe(DEFAULT_DESIGN);
  });

  // Dragging clamps to an 8-unit floor via clampSpan; a plain x + dx nudge
  // would not, so repeated arrow presses could walk an element arbitrarily
  // far off screen. This pins that nudge shares the same floor, the same
  // way repeated arrow-key presses would call it.
  it('keeps at least 8 units of the element on screen, however far it is pushed, matching the drag clamp', () => {
    let d = DEFAULT_DESIGN;
    for (let i = 0; i < 200; i++) d = nudge(d, 'ownHealth', -10, -10);
    // ownHealth is 125x91 HUD units at 16:9 (853 wide): clampSpan's 8-unit
    // floor caps x at 8 - 125 and y at 8 - 91.
    expect(d.elements.ownHealth).toEqual({ x: 8 - 125, y: 8 - 91 });
  });

  it('also clamps on the far side', () => {
    let d = DEFAULT_DESIGN;
    for (let i = 0; i < 200; i++) d = nudge(d, 'ownHealth', 10, 10);
    expect(d.elements.ownHealth).toEqual({ x: 853 - 8, y: 480 - 8 });
  });

  it('nudges a team from where it is drawn, so a press back from the edge moves it at once', () => {
    let d = DEFAULT_DESIGN;
    for (let i = 0; i < 5; i++) d = nudge(d, 'teamColumn', -1, 0);
    expect(elementRect(d, 'teamColumn', d.aspect).x).toBe(0);
    d = nudge(d, 'teamColumn', 1, 0);
    expect(elementRect(d, 'teamColumn', d.aspect).x).toBe(1);
  });

  // Chat is 320 wide: clampSpan's 8-unit floor alone would allow x = 8 - 320
  // = -312, but nudge now goes through placeElement, whose validator floor of
  // -200 is tighter. Keys and a drag must agree on where that lands.
  it('nudges Chat far left to the same clamped value a drag would give', () => {
    let d = DEFAULT_DESIGN;
    for (let i = 0; i < 200; i++) d = nudge(d, 'chat', -10, 0);
    expect(d.elements.chat).toMatchObject(placeElement(DEFAULT_DESIGN, 'chat', -10000, 275).elements.chat!);
    expect(d.elements.chat).toMatchObject({ x: -200 });
  });
});

describe('what counts as an edit', () => {
  // A fresh design already fits the teammate card, so "has elements" is not
  // "has edits": a share link must not ask to replace an untouched design.
  it('treats a fresh design as untouched and a moved element as an edit', () => {
    expect(elementsTouched(DEFAULT_DESIGN)).toBe(false);
    expect(hasOverrides(DEFAULT_DESIGN)).toBe(false);
    const moved = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { x: 5 } } };
    expect(elementsTouched(moved)).toBe(true);
    expect(hasOverrides({ ...DEFAULT_DESIGN, hideGameCrosshair: true })).toBe(true);
  });

  it('resets an element to what a fresh design has for it', () => {
    const d = { ...DEFAULT_DESIGN, elements: { teamColumn: { gap: 40 }, chat: { x: 5 } } };
    expect(resetElement(d, 'teamColumn').elements.teamColumn).toEqual({ fit: true });
    expect(resetElement(d, 'chat').elements.chat).toBeUndefined();
  });
});

describe('the teammate layout helpers', () => {
  // A slot is the card's unfitted origin: the fitted stock card is drawn
  // (13, 36) in from it, so the card drawn at (13, 441) has its slot at (0, 405).
  it('fills the four Free positions from where the cards sit, only the first time', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(free.elements.teamColumn).toEqual({ fit: true, dir: 'free',
      slots: [{ x: 0, y: 405 }, { x: 140, y: 405 }, { x: 280, y: 405 }, { x: 420, y: 405 }] });
    expect(teamCardRects(free, free.aspect)[0]).toMatchObject({ x: 13, y: 441 });
    const moved = placeCard(free, 0, 50, 60);
    expect(withTeamDir(withTeamDir(moved, 'row'), 'free').elements.teamColumn!.slots![0]).toEqual({ x: 37, y: 24 });
  });

  it('places a card by where it is drawn, so the card lands under the pointer fitted or not', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(teamCardRects(placeCard(free, 1, 200, 100), free.aspect)[1]).toMatchObject({ x: 200, y: 100 });
    const unfitted = { ...free, elements: { teamColumn: { ...free.elements.teamColumn!, fit: false } } };
    expect(teamCardRects(placeCard(unfitted, 1, 200, 100), free.aspect)[1]).toMatchObject({ x: 200, y: 100 });
  });

  it('clamps a placed card like an element position', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(placeCard(free, 2, 5000, -900).elements.teamColumn!.slots![2]).toEqual({ x: 1000, y: -200 });
    expect(placeCard(DEFAULT_DESIGN, 0, 5, 5)).toBe(DEFAULT_DESIGN);           // not Free: nothing to place
  });
});

describe('patchChild', () => {
  it('merges into one child of the teammate card and leaves the rest alone', () => {
    const a = patchChild(DEFAULT_DESIGN, 'Head', { w: 30, h: 30 });
    const b = patchChild(a, 'Head', { x: 5 });
    expect(b.children.teamColumn).toEqual({ Head: { w: 30, h: 30, x: 5 } });
    expect(resetElement(b, 'teamColumn').children.teamColumn).toBeUndefined();
    expect(hasOverrides(b)).toBe(true);
  });
});

describe('moving a teammate card child', () => {
  it('clamps a placed child inside the unfitted card, not the fitted one, or nothing could grow', () => {
    // Stock unfitted card 150 x 150; Head is 23 square.
    expect(placeChild(DEFAULT_DESIGN, 'Head', 500, -20).children.teamColumn!.Head).toEqual({ x: 127, y: 0 });
    expect(placeChild(DEFAULT_DESIGN, 'Head', 40.4, 50.6).children.teamColumn!.Head).toEqual({ x: 40, y: 51 });
  });

  it('nudges from where the child is now', () => {
    expect(nudgeChild(DEFAULT_DESIGN, 'Head', 1, 0).children.teamColumn!.Head).toEqual({ x: 14, y: 38 });
    // The down picture starts where the fit rule drew it: (13, 36) in the unfitted frame.
    expect(nudgeChild(DEFAULT_DESIGN, 'Incapacitated', 0, 1).children.teamColumn!.Incapacitated).toEqual({ x: 13, y: 37 });
  });

  it('resizes square art keeping it square, and anything else freely, inside the card', () => {
    const head = { x: 13, y: 38, w: 23, h: 23, visible: true };
    const health = { x: 37, y: 52, w: 96, h: 7, visible: true };
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'se', 5, 2).children.teamColumn!.Head).toEqual({ w: 28, h: 28 });
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'se', 500, 0).children.teamColumn!.Head).toEqual({ w: 112, h: 112 });
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'se', -48, 0).children.teamColumn!.Health).toEqual({ w: 48, h: 7 });
  });

  it('resizes from any handle, the opposite edge staying put', () => {
    const head = { x: 13, y: 38, w: 23, h: 23, visible: true };
    const health = { x: 37, y: 52, w: 96, h: 7, visible: true };
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'w', -10, 0).children.teamColumn!.Health).toEqual({ w: 106, h: 7, x: 27 });
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'n', 0, -3).children.teamColumn!.Health).toEqual({ w: 96, h: 10, y: 49 });
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'nw', -5, -2).children.teamColumn!.Head).toEqual({ w: 28, h: 28, x: 8, y: 33 });
    // A square piece has no side handles.
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'e', 5, 0)).toBe(DEFAULT_DESIGN);
  });

  it('keeps the ratio on a side handle with Shift', () => {
    const health = { x: 37, y: 52, w: 96, h: 7, visible: true };
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'e', 10, 0, true).children.teamColumn!.Health).toEqual({ w: 106, h: 8 });
  });

  it('scales the item icons by a corner, and nothing else resizes them', () => {
    const items = { x: 39, y: 36, w: 50, h: 14, visible: true, fontTall: 18 };
    expect(resizeChild(DEFAULT_DESIGN, 'Items', items, 'se', 0, 7).children.teamColumn!.Items).toEqual({ fontSize: 27 });
    expect(resizeChild(DEFAULT_DESIGN, 'Items', items, 'e', 10, 0)).toBe(DEFAULT_DESIGN);
  });
});

describe('nudgeCard', () => {
  it('moves a Free card from its slot and keeps 8 units of it on screen, like a drag', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    // The slot is the unfitted origin, 13 left of the drawn card.
    expect(nudgeCard(free, 0, 5, 0).elements.teamColumn!.slots![0]).toEqual({ x: 5, y: 405 });
    let d = free;
    for (let i = 0; i < 200; i++) d = nudgeCard(d, 0, -10, 0);
    expect(teamCardRects(d, d.aspect)[0].x).toBe(8 - 121);
  });

  it('leaves the element position alone in Free, where it moves nothing', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(nudge(free, 'teamColumn', 5, 5)).toBe(free);
  });
});

describe('resetChild', () => {
  it('drops a child edit and keeps an added child added', () => {
    const edited = patchChild(patchChild(DEFAULT_DESIGN, 'HealthNumber', { on: true, x: 90 }), 'Head', { w: 30, h: 30 });
    const once = resetChild(edited, 'HealthNumber');
    expect(once.children.teamColumn).toEqual({ HealthNumber: { on: true }, Head: { w: 30, h: 30 } });
    expect(resetChild(resetChild(once, 'Head'), 'HealthNumber').children.teamColumn).toEqual({ HealthNumber: { on: true } });
    // The last edit gone: no empty teamColumn map is left behind.
    expect(resetChild(patchChild(DEFAULT_DESIGN, 'Head', { x: 5 }), 'Head').children.teamColumn).toBeUndefined();
  });
});

describe('moving several pieces', () => {
  // Stock, fitted: Head (13, 38, 23 x 23), Health (37, 52, 96 x 7), in the unfitted 150 x 150 card.
  const both = ['Head', 'Health'];

  it('moves every piece by the same amount', () => {
    const d = moveChildren(DEFAULT_DESIGN, both, startsOf(DEFAULT_DESIGN, both), 5, -2);
    expect(d.children.teamColumn).toEqual({ Head: { x: 18, y: 36 }, Health: { x: 42, y: 50 } });
  });

  it('clamps the group as one, so the pieces keep their spacing at the card edge', () => {
    const s = startsOf(DEFAULT_DESIGN, both);
    expect(moveChildren(DEFAULT_DESIGN, both, s, -100, -100).children.teamColumn).toEqual({ Head: { x: 0, y: 0 }, Health: { x: 24, y: 14 } });
    // The health bar reaches the right edge first: 150 - 96 - 37 = 17 is all the room there is.
    expect(moveChildren(DEFAULT_DESIGN, both, s, 100, 0).children.teamColumn).toEqual({ Head: { x: 30, y: 38 }, Health: { x: 54, y: 52 } });
  });

  it('places the group by its box', () => {
    const d = placeChildren(DEFAULT_DESIGN, both, 20, 40);
    expect(d.children.teamColumn).toEqual({ Head: { x: 20, y: 40 }, Health: { x: 44, y: 54 } });
  });

  it('never moves a piece that cannot move', () => {
    const d = moveChildren(DEFAULT_DESIGN, ['BackgroundImage'], startsOf(DEFAULT_DESIGN, ['BackgroundImage']), 5, 5);
    expect(d).toBe(DEFAULT_DESIGN);
  });
});

describe('scaling several pieces', () => {
  const names = ['Head', 'Health', 'Name'];

  it('scales positions and sizes about the anchor, square stays square, fonts scale', () => {
    const d = scaleChildren(DEFAULT_DESIGN, names, startsOf(DEFAULT_DESIGN, names), { x: 13, y: 38 }, 0.5);
    expect(d.children.teamColumn).toEqual({
      Head: { w: 12, h: 12, x: 13, y: 38 },
      Health: { w: 48, h: 4, x: 25, y: 45 },
      Name: { w: 60, h: 6, fontSize: 6, x: 13, y: 49 },
    });
  });

  it('scales the item icons by their size', () => {
    const d = scaleChildren(DEFAULT_DESIGN, ['Items'], startsOf(DEFAULT_DESIGN, ['Items']), { x: 39, y: 36 }, 1.5);
    expect(d.children.teamColumn!.Items).toEqual({ fontSize: 27, x: 39, y: 36 });
  });

  it('keeps every piece inside the unfitted card however far it scales', () => {
    const d = scaleChildren(DEFAULT_DESIGN, ['Head', 'Health'], startsOf(DEFAULT_DESIGN, ['Head', 'Health']), { x: 13, y: 38 }, 2);
    for (const n of ['Head', 'Health']) {
      const c = cardChild(d, n)!;
      expect(c.x, n).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w, n).toBeLessThanOrEqual(150);
      expect(c.y + c.h, n).toBeLessThanOrEqual(150);
    }
    expect(d.children.teamColumn!.Head).toMatchObject({ w: 46, h: 46 });
    expect(d.children.teamColumn!.Health).toEqual({ w: 150, h: 14, x: 0, y: 66 });
  });

  it('turns a corner drag into one factor, the larger change winning', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(cornerFactor(box, 'se', 50, 0)).toBe(1.5);
    expect(cornerFactor(box, 'nw', -50, 0)).toBe(1.5);
    expect(cornerFactor(box, 'se', 10, 20)).toBe(1.4);
    expect(cornerFactor(box, 'se', -1000, 0)).toBe(0.05);
    expect(anchorOf(box, 'se')).toEqual({ x: 0, y: 0 });
    expect(anchorOf(box, 'nw')).toEqual({ x: 100, y: 50 });
  });
});

describe('aligning several pieces', () => {
  // Head spans x 13..36, y 38..61; Status x 64..134, y 38..50. Their box: x 13..134, y 38..61.
  const two = ['Head', 'Status'];
  const at = (how: Parameters<typeof alignChildren>[2]) => alignChildren(DEFAULT_DESIGN, two, how).children.teamColumn;

  it('aligns six ways against the group box', () => {
    expect(at('left')).toEqual({ Head: { x: 13, y: 38 }, Status: { x: 13, y: 38 } });
    expect(at('right')).toEqual({ Head: { x: 111, y: 38 }, Status: { x: 64, y: 38 } });
    expect(at('centre')).toEqual({ Head: { x: 62, y: 38 }, Status: { x: 39, y: 38 } });
    expect(at('top')).toEqual({ Head: { x: 13, y: 38 }, Status: { x: 64, y: 38 } });
    expect(at('middle')).toEqual({ Head: { x: 13, y: 38 }, Status: { x: 64, y: 44 } });
    expect(at('bottom')).toEqual({ Head: { x: 13, y: 38 }, Status: { x: 64, y: 49 } });
  });
});

describe('visibility and reset for several pieces', () => {
  it('hides and shows them all, and resets them all', () => {
    const hidden = setChildrenVisible(DEFAULT_DESIGN, ['Head', 'Name'], false);
    expect(hidden.children.teamColumn).toEqual({ Head: { visible: false }, Name: { visible: false } });
    expect(resetChildren(hidden, ['Head', 'Name']).children.teamColumn).toBeUndefined();
  });
});

describe('element edits', () => {
  it('places an element rounded and on screen, and leaves one the game places alone', () => {
    expect(placeElement(DEFAULT_DESIGN, 'chat', 40.4, 60.6).elements.chat).toEqual({ x: 40, y: 61 });
    // clampSpan would allow 8 - 320 = -312; the validator's floor of -200 is tighter for a box this wide.
    expect(placeElement(DEFAULT_DESIGN, 'chat', -900, 0).elements.chat).toEqual({ x: -200, y: 0 });
    expect(placeElement(DEFAULT_DESIGN, 'targetId', 5, 5)).toBe(DEFAULT_DESIGN);
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(placeElement(free, 'teamColumn', 5, 5)).toBe(free);
  });

  it('moves several elements by the same amount from where they started', () => {
    const starts = { chat: { x: 10, y: 275, w: 320, h: 120 }, ownHealth: { x: 728, y: 389, w: 125, h: 91 } };
    const d = moveElements(DEFAULT_DESIGN, ['chat', 'ownHealth'], starts, -5, 10);
    expect(d.elements.chat).toEqual({ x: 5, y: 285 });
    expect(d.elements.ownHealth).toEqual({ x: 723, y: 399 });
  });

  it('moves a Free card from where it started, keeping 8 units on screen', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    const start = teamCardRects(free, free.aspect)[0];
    expect(teamCardRects(moveCard(free, 0, start, 100, -200), free.aspect)[0]).toMatchObject({ x: 113, y: 241 });
    expect(teamCardRects(moveCard(free, 0, start, -5000, 0), free.aspect)[0].x).toBe(8 - 121);
  });

  it('aligns several elements against their box', () => {
    const left = alignElements(DEFAULT_DESIGN, ['chat', 'progressBar'], 'left');
    expect(left.elements.chat).toEqual({ x: 10, y: 275 });
    expect(left.elements.progressBar).toEqual({ x: 10, y: 250 });
    const top = alignElements(DEFAULT_DESIGN, ['chat', 'progressBar'], 'top');
    expect(top.elements.chat).toEqual({ x: 10, y: 250 });
  });

  it('scales an element by a corner, proportionally, from the opposite corner, clamped 0.5 to 2', () => {
    const start = { rect: { x: 728, y: 389, w: 125, h: 91 }, scale: 1 };
    // Dragging the top-left corner out by half: the bottom-right corner stays on the screen's.
    expect(scaleElement(DEFAULT_DESIGN, 'ownHealth', start, 'nw', -62.5, -45.5).elements.ownHealth).toEqual({ scale: 1.5, x: 666, y: 344 });
    // The bottom-right corner: the element keeps its own position (and its file anchor).
    expect(scaleElement(DEFAULT_DESIGN, 'ownHealth', start, 'se', 125, 0).elements.ownHealth).toEqual({ scale: 2 });
    expect(scaleElement(DEFAULT_DESIGN, 'ownHealth', start, 'se', 1000, 0).elements.ownHealth).toEqual({ scale: 2 });
    expect(scaleElement(DEFAULT_DESIGN, 'ownHealth', start, 'se', -1000, 0).elements.ownHealth).toEqual({ scale: 0.5 });
    expect(scaleElement(DEFAULT_DESIGN, 'chat', start, 'se', 10, 10)).toBe(DEFAULT_DESIGN);
  });

  it('resizes a free-size element from any handle, 20 units at least', () => {
    const chat = { x: 10, y: 275, w: 320, h: 120 };
    expect(resizeElement(DEFAULT_DESIGN, 'chat', chat, 'w', -30, 0).elements.chat).toEqual({ x: -20, w: 350, h: 120 });
    expect(resizeElement(DEFAULT_DESIGN, 'chat', chat, 'e', -400, 0).elements.chat).toEqual({ w: 20, h: 120 });
    expect(resizeElement(DEFAULT_DESIGN, 'chat', chat, 'e', 32, 0, true).elements.chat).toEqual({ w: 352, h: 132 });
    expect(resizeElement(DEFAULT_DESIGN, 'ownHealth', chat, 'e', 10, 0)).toBe(DEFAULT_DESIGN);
  });

  it('computes a resized box with the opposite edge fixed', () => {
    const b = { x: 10, y: 10, w: 100, h: 50 };
    expect(resizeBox(b, 'nw', 10, 5, false, 1)).toEqual({ x: 20, y: 15, w: 90, h: 45 });
    expect(resizeBox(b, 'w', 200, 0, false, 20)).toEqual({ x: 90, y: 10, w: 20, h: 50 });
    expect(resizeBox(b, 's', 0, 25, true, 1)).toEqual({ x: 10, y: 10, w: 150, h: 75 });
  });
});

describe('edits for any selection', () => {
  it('nudges whatever is selected', () => {
    expect(nudgeSelection(DEFAULT_DESIGN, { kind: 'elements', ids: ['chat', 'ownHealth'] }, 1, 0).elements)
      .toMatchObject({ chat: { x: 11, y: 275 }, ownHealth: { x: 729, y: 389 } });
    expect(nudgeSelection(DEFAULT_DESIGN, { kind: 'children', names: ['Head', 'Health'], card: 0 }, 0, 1).children.teamColumn)
      .toEqual({ Head: { x: 13, y: 39 }, Health: { x: 37, y: 53 } });
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(nudgeSelection(free, { kind: 'card', card: 0 }, 5, 0).elements.teamColumn!.slots![0]).toEqual({ x: 5, y: 405 });
    expect(nudgeSelection(DEFAULT_DESIGN, { kind: 'none' }, 1, 1)).toBe(DEFAULT_DESIGN);
  });

  it('hides elements and pieces, never a card, and skips an element with no Visible control', () => {
    const els = hideSelection(DEFAULT_DESIGN, { kind: 'elements', ids: ['chat', 'ownHealth', 'xhair'] });
    expect(els.elements.chat).toEqual({ visible: false });
    expect(els.elements.ownHealth).toEqual({ visible: false });
    expect(els.elements.xhair).toBeUndefined();
    const kids = hideSelection(DEFAULT_DESIGN, { kind: 'children', names: ['Head', 'Name'], card: 0 });
    expect(kids.children.teamColumn).toEqual({ Head: { visible: false }, Name: { visible: false } });
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(hideSelection(free, { kind: 'card', card: 1 })).toBe(free);
    expect(setSelectionVisible(els, { kind: 'elements', ids: ['chat'] }, true).elements.chat).toEqual({ visible: true });
  });

  it('resets elements and pieces', () => {
    const moved = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { x: 5 } } };
    expect(resetSelection(moved, { kind: 'elements', ids: ['chat'] }).elements.chat).toBeUndefined();
    const edited = patchChild(DEFAULT_DESIGN, 'Head', { x: 5 });
    expect(resetSelection(edited, { kind: 'children', names: ['Head'], card: 0 }).children.teamColumn).toBeUndefined();
  });
});
