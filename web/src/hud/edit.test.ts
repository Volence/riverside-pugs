import { describe, it, expect } from 'vitest';
import {
  nudge, nudgeCard, hasOverrides, elementsTouched, resetElement, withTeamDir, placeCard, patchChild,
  placeChild, nudgeChild, resizeChild, resetChild,
  startsOf, moveChildren, placeChildren, scaleChildren, cornerFactor, anchorOf, alignChildren, setChildrenVisible, resetChildren,
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
    expect(resizeChild(DEFAULT_DESIGN, 'Head', { x: 13, y: 38, w: 23, h: 23 }, 5, 2).children.teamColumn!.Head).toEqual({ w: 28, h: 28 });
    expect(resizeChild(DEFAULT_DESIGN, 'Head', { x: 13, y: 38, w: 23, h: 23 }, 500, 0).children.teamColumn!.Head).toEqual({ w: 112, h: 112 });
    expect(resizeChild(DEFAULT_DESIGN, 'Health', { x: 37, y: 52, w: 96, h: 7 }, -48, 0).children.teamColumn!.Health).toEqual({ w: 48, h: 7 });
    expect(resizeChild(DEFAULT_DESIGN, 'Items', { x: 39, y: 36, w: 50, h: 14 }, 5, 5)).toBe(DEFAULT_DESIGN);
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
