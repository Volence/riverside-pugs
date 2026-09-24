import { describe, it, expect } from 'vitest';
import {
  nudge, nudgeCards, freeInPlace, cardBoxes, placeCards, alignCards, hasOverrides, elementsTouched, resetElement, withTeamDir, placeCard, patchChild,
  placeChild, nudgeChild, resizeChild, resetChild,
  startsOf, moveChildren, placeChildren, scaleChildren, cornerFactor, anchorOf, alignChildren, setChildrenVisible, resetChildren,
  placeElement, moveElements, moveCards, alignElements, scaleElement, resizeBox, resizeElement, nudgeSelection, hideSelection, setSelectionVisible, resetSelection,
  ammoOnly, withImport, withPreset, hasLayoutEdits,
} from './edit';
import { buildHud, buildTrees } from './build';
import { weaponSlots } from './weapons';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { DEFAULT_DESIGN, newDesign } from './design';
import { DEFAULT_STATE } from '../crosshair/draw';
import type { CrosshairArt } from '../crosshair/model';
import { formatPos, parsePos } from './units';
import { teamCardRects, elementRect, cardChild, isFreeTeam } from './build';
import { elementFrame } from './selection';

describe('nudge', () => {
  it('starts from the base position the first time', () => {
    const d = nudge(DEFAULT_DESIGN, 'ownHealth', -10, 0);
    expect(d.elements.ownHealth).toEqual({ x: 718, y: 389 });
  });
  it('does nothing to an element that cannot move', () => {
    expect(nudge(DEFAULT_DESIGN, 'xhair', 5, 5)).toBe(DEFAULT_DESIGN);
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
    expect(hasOverrides(DEFAULT_DESIGN, null)).toBe(false);
    const moved = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { x: 5 } } };
    expect(elementsTouched(moved)).toBe(true);
    expect(hasOverrides({ ...DEFAULT_DESIGN, hideGameCrosshair: true }, null)).toBe(true);
  });

  // A design whose only change is picking a crosshair (the default is
  // 'none') still has to ask before a share link replaces it, or a reader
  // who only set up a bundled or addon crosshair loses it silently.
  it('counts a non-default crosshair choice as an override too', () => {
    expect(hasOverrides({ ...DEFAULT_DESIGN, crosshair: 'addon' }, null)).toBe(true);
    expect(hasOverrides({ ...DEFAULT_DESIGN, crosshair: 'bundle' }, null)).toBe(true);
    expect(hasOverrides({ ...DEFAULT_DESIGN, crosshair: 'none' }, null)).toBe(false);
  });

  // The baseline crosshair is this browser's, not always 'none': a reader
  // with a crosshair saved on the Crosshair page gets a fresh design
  // carrying it (newDesign), so that has to read as untouched too, and
  // deliberately turning it off, or changing it, has to count.
  it("measures the crosshair against this browser's own fresh baseline, not always none", () => {
    const saved: CrosshairArt = { kind: 'built', state: DEFAULT_STATE };
    expect(hasOverrides(newDesign(saved), saved)).toBe(false);
    expect(hasOverrides({ ...newDesign(saved), crosshair: 'none' }, saved)).toBe(true);
    expect(hasOverrides({ ...newDesign(saved), xhairArt: { kind: 'built', state: { ...DEFAULT_STATE, len: 9 } } }, saved)).toBe(true);
    // Unaffected: no saved crosshair still means the baseline is 'none', with no crosshair.
    expect(hasOverrides(newDesign(null), null)).toBe(false);
    expect(hasOverrides({ ...newDesign(null), xhairArt: saved }, null)).toBe(true);
  });

  it('resets an element to what a fresh design has for it', () => {
    const d = { ...DEFAULT_DESIGN, elements: { teamColumn: { gap: 40 }, chat: { x: 5 } } };
    expect(resetElement(d, 'teamColumn').elements.teamColumn).toEqual({ fit: true });
    expect(resetElement(d, 'chat').elements.chat).toBeUndefined();
  });

  it('counts a splatter as an override, and keeps splatters across a preset switch', () => {
    const d = { ...structuredClone(DEFAULT_DESIGN), splatters: { splatTop: { kind: 'fade' as const } } };
    expect(hasOverrides(d, null)).toBe(true);
    expect(withPreset(d, 'modern', true).splatters).toEqual({ splatTop: { kind: 'fade' } });
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

  it('rounds a placed card to whole units, even from the fractional pointer position a real drag gives', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    const slot = placeCard(free, 0, 347.00003062599535, 328.9999846870023).elements.teamColumn!.slots![0];
    expect(slot).toEqual({ x: 334, y: 293 });
    expect(Number.isInteger(slot.x)).toBe(true);
    expect(Number.isInteger(slot.y)).toBe(true);
  });
});

describe('patchChild', () => {
  it('merges into one child of the teammate card and leaves the rest alone', () => {
    const a = patchChild(DEFAULT_DESIGN, 'Head', { w: 30, h: 30 });
    const b = patchChild(a, 'Head', { x: 5 });
    expect(b.children.teamColumn).toEqual({ Head: { w: 30, h: 30, x: 5 } });
    expect(resetElement(b, 'teamColumn').children.teamColumn).toBeUndefined();
    expect(hasOverrides(b, null)).toBe(true);
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
    // The down picture starts where the fit rule drew it: (13, 9) in the unfitted frame.
    expect(nudgeChild(DEFAULT_DESIGN, 'Incapacitated', 0, 1).children.teamColumn!.Incapacitated).toEqual({ x: 13, y: 10 });
  });

  it('resizes square art keeping it square, and anything else freely, inside the card', () => {
    const head = { x: 13, y: 38, w: 23, h: 23, visible: true };
    const health = { x: 37, y: 52, w: 96, h: 7, visible: true };
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'se', 5, 2).children.teamColumn!.Head).toEqual({ w: 28, h: 28 });
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'se', 500, 0).children.teamColumn!.Head).toEqual({ w: 112, h: 112 });
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'se', -48, 0).children.teamColumn!.Health).toEqual({ w: 48, h: 7 });
  });

  it('shrinks a square piece dragged straight in on one axis, not just along the diagonal', () => {
    // A signed Math.max of the two deltas would see max(0, -5) = 0 and never shrink; the larger
    // magnitude, here the vertical one, must win even though it is the negative of the two.
    const head = { x: 13, y: 38, w: 23, h: 23, visible: true };
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'se', 0, -5).children.teamColumn!.Head).toEqual({ w: 18, h: 18 });
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

// A card left of the screen's centre is written with a left anchor and
// lands where its slot says; card 3 of the stock row sits near the centre,
// whose token resolves against half the 853-unit screen, so in Free it is
// drawn half a unit right of the whole number its slot holds (293.5 for
// 293). That half unit is the file's own, and the Layout select's switch to
// Free has always had it, so card 3 is compared to within it here.
const within = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(0.5);

describe('where a Free card in the middle third can land', () => {
  // Why card 3 cannot be seeded to land exactly: on the 853-wide 16:9
  // screen a centre token is a whole number from 426.5, so every card in the
  // middle third lands on a half unit whatever its slot holds. The cards in
  // the left third (1 and 2 of the stock row) are exact, unrounded.
  it('lands on a half unit through the centre token, and exactly through a left one', () => {
    expect(parsePos(formatPos(293, 121, 853), 853)).toBe(293.5);
    expect(parsePos(formatPos(292.5, 121, 853), 853)).toBe(292.5);
    expect(parsePos(formatPos(153, 121, 853), 853)).toBe(153);
    const before = teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect);
    const free = freeInPlace(DEFAULT_DESIGN);
    const after = teamCardRects(free, free.aspect);
    expect(after[0].x).toBe(before[0].x);
    expect(after[1].x).toBe(before[1].x);
    expect(after[2].x - before[2].x).toBe(0.5);
  });
});

describe('nudgeCards', () => {
  it('moves a Free card from its slot and keeps 8 units of it on screen, like a drag', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    // The slot is the unfitted origin, 13 left of the drawn card.
    expect(nudgeCards(free, [0], 5, 0).elements.teamColumn!.slots![0]).toEqual({ x: 5, y: 405 });
    let d = free;
    for (let i = 0; i < 200; i++) d = nudgeCards(d, [0], -10, 0);
    expect(teamCardRects(d, d.aspect)[0].x).toBe(8 - 121);
  });

  it('switches a Row team to Free first, so the nudge moves one card', () => {
    const d = nudgeCards(DEFAULT_DESIGN, [2], 1, 0);
    expect(isFreeTeam(d)).toBe(true);
    const before = teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect), after = teamCardRects(d, d.aspect);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    within(after[2].x, before[2].x + 1);
    expect(after[2].y).toBe(before[2].y);
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

  it('never moves a piece with nothing to start from (an addable child not yet in the file)', () => {
    // HealthNumber is off by default on stock: cardChild is null, so startsOf leaves it out.
    const d = moveChildren(DEFAULT_DESIGN, ['HealthNumber'], startsOf(DEFAULT_DESIGN, ['HealthNumber']), 5, 5);
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
    expect(placeElement(DEFAULT_DESIGN, 'xhair', 5, 5)).toBe(DEFAULT_DESIGN);
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
    const starts = { 0: teamCardRects(free, free.aspect)[0] };
    expect(teamCardRects(moveCards(free, [0], starts, 100, -200), free.aspect)[0]).toMatchObject({ x: 113, y: 241 });
    expect(teamCardRects(moveCards(free, [0], starts, -5000, 0), free.aspect)[0].x).toBe(8 - 121);
  });

  it('rounds a moved Free card to whole units too, since it stores through placeCard', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    const starts = { 0: teamCardRects(free, free.aspect)[0] };
    const slot = moveCards(free, [0], starts, 34.00003062599535, -112.0000153129977).elements.teamColumn!.slots![0];
    expect(Number.isInteger(slot.x)).toBe(true);
    expect(Number.isInteger(slot.y)).toBe(true);
  });

  // The default design lays its cards out in a Row, which stores one
  // position for the team: moving one card must first make it Free.
  it('moves one card of a Row team, switching it to Free with the other cards where they were drawn', () => {
    const D = DEFAULT_DESIGN;
    const before = teamCardRects(D, D.aspect);
    const d = moveCards(D, [2], { 2: before[2] }, 50, -100);
    expect(isFreeTeam(d)).toBe(true);
    const after = teamCardRects(d, d.aspect);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    within(after[2].x, before[2].x + 50);
    expect(after[2].y).toBe(before[2].y - 100);
  });

  it('seeds Free from where the cards are drawn, not from slots a past Free layout left behind', () => {
    const stale = withTeamDir(placeCard(withTeamDir(DEFAULT_DESIGN, 'free'), 0, 50, 60), 'row');
    expect(stale.elements.teamColumn!.slots).toBeDefined();
    const before = teamCardRects(stale, stale.aspect);
    const free = freeInPlace(stale);
    expect(teamCardRects(free, free.aspect).slice(0, 2)).toEqual(before.slice(0, 2));
    expect(freeInPlace(free)).toBe(free);
  });

  it('moves several cards together, keeping their spacing even against the screen edge', () => {
    const D = DEFAULT_DESIGN;
    const r = teamCardRects(D, D.aspect);
    const d = moveCards(D, [0, 1], { 0: r[0], 1: r[1] }, 20, -30);
    const a = teamCardRects(d, d.aspect);
    expect(a[0]).toMatchObject({ x: 33, y: 411 });
    expect(a[1]).toMatchObject({ x: 173, y: 411 });
    within(a[2].x, r[2].x);
    expect(a[2].y).toBe(r[2].y);
    const edge = teamCardRects(moveCards(D, [0, 1], { 0: r[0], 1: r[1] }, -5000, 0), D.aspect);
    expect(edge[0].x).toBe(8 - 121);
    expect(edge[1].x - edge[0].x).toBe(140);
  });

  it('places and aligns several cards by the box around them', () => {
    const D = DEFAULT_DESIGN;
    const placed = placeCards(D, [0, 2], 100, 200);
    expect(isFreeTeam(placed)).toBe(true);
    expect(cardBoxes(placed)[0]).toMatchObject({ x: 100, y: 200 });
    expect(cardBoxes(placed)[2]).toMatchObject({ x: 380, y: 200 });
    expect(cardBoxes(placed)[1]).toEqual(cardBoxes(D)[1]);
    const r = teamCardRects(D, D.aspect);
    const staggered = moveCards(D, [1], { 1: r[1] }, 0, -50);
    const top = alignCards(staggered, [0, 1], 'top');
    expect(cardBoxes(top)[0].y).toBe(391);
    expect(cardBoxes(top)[1].y).toBe(391);
    expect(cardBoxes(alignCards(staggered, [0, 1], 'left'))[1].x).toBe(13);
  });

  it('aligns several elements against their box', () => {
    const left = alignElements(DEFAULT_DESIGN, ['chat', 'progressBar'], 'left');
    expect(left.elements.chat).toEqual({ x: 10, y: 275 });
    expect(left.elements.progressBar).toEqual({ x: 10, y: 250 });
    const top = alignElements(DEFAULT_DESIGN, ['chat', 'progressBar'], 'top');
    expect(top.elements.chat).toEqual({ x: 10, y: 250 });
  });

  // The Teammates' handles sit on their drawn cards, not on the container
  // (which starts left of card 1 and hangs off the bottom), so the factor
  // and the corner that stays put are both the cards'.
  // Moved off the left edge first, where the on-screen clamp would stop the
  // container going the 3 units left the cards' corner needs.
  it('scales the Teammates from a corner of their drawn cards, the opposite corner staying put', () => {
    const D = placeElement(DEFAULT_DESIGN, 'teamColumn', 100, 405);
    const frame = elementFrame(D, 'teamColumn');
    const next = scaleElement(D, 'teamColumn', { rect: frame, scale: 1 }, 'ne', frame.w * 0.2, 0);
    expect(next.elements.teamColumn?.scale).toBe(1.2);
    const after = elementFrame(next, 'teamColumn');
    expect(Math.abs(after.x - frame.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y + after.h - (frame.y + frame.h))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.w - frame.w * 1.2)).toBeLessThanOrEqual(1);
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

  it('keeps the opposite edge put when the range clamp, not just the 20-unit minimum, catches the dragged edge', () => {
    // Dragging the left handle far enough left pushes x past the validator's -200 floor while the
    // width itself (620) is nowhere near its own cap: x and w must still agree that the right edge,
    // start.x + start.w = 330, never moves.
    const chat = { x: 10, y: 275, w: 320, h: 120 };
    expect(resizeElement(DEFAULT_DESIGN, 'chat', chat, 'w', -300, 0).elements.chat).toEqual({ x: -200, w: 530, h: 120 });
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
    expect(nudgeSelection(free, { kind: 'cards', cards: [0] }, 5, 0).elements.teamColumn!.slots![0]).toEqual({ x: 5, y: 405 });
    const two = nudgeSelection(DEFAULT_DESIGN, { kind: 'cards', cards: [0, 1] }, 0, -1);
    expect(two.elements.teamColumn!.slots!.slice(0, 2)).toEqual([{ x: 0, y: 404 }, { x: 140, y: 404 }]);
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
    expect(hideSelection(free, { kind: 'cards', cards: [1] })).toBe(free);
    expect(resetSelection(free, { kind: 'cards', cards: [1] })).toBe(free);
    expect(setSelectionVisible(els, { kind: 'elements', ids: ['chat'] }, true).elements.chat).toEqual({ visible: true });
  });

  it('resets elements and pieces', () => {
    const moved = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { x: 5 } } };
    expect(resetSelection(moved, { kind: 'elements', ids: ['chat'] }).elements.chat).toBeUndefined();
    const edited = patchChild(DEFAULT_DESIGN, 'Head', { x: 5 });
    expect(resetSelection(edited, { kind: 'children', names: ['Head'], card: 0 }).children.teamColumn).toBeUndefined();
  });
});

describe('the weapon selection', () => {
  const MODTEX = 'scripts/mod_textures.txt';
  const fonts = { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } };
  const fileText = (files: { path: string; data: Uint8Array }[], path: string) =>
    new TextDecoder('latin1').decode(files.find((f) => f.path === path)!.data);
  const pcValue = (block: KvNode, key: string) => (block.value as KvNode[])
    .find((n) => n.key.toLowerCase() === key.toLowerCase() && (!n.cond || n.cond === '[$WIN32]'))?.value;

  // Probe B (2026-09-23), confirmed by the owner in game: "8 128 30" on one
  // line beside the crosshair, no boxes, no pictures, no item slots.
  for (const preset of ['stock', 'modern'] as const) {
    it(`Ammo only writes probe B's keys and repoints (${preset})`, () => {
      const files = buildHud(ammoOnly({ ...structuredClone(DEFAULT_DESIGN), preset }), fonts);
      const ws = kvFind(parseKv(fileText(files, 'scripts/hudlayout.res'))[0].value as KvNode[], ['HudWeaponSelection'])!;
      const want: Record<string, string> = {
        xpos: 'c-10', ypos: 'c-12', wide: '100', PrimaryWeaponsYPos: '12',
        // Two changes from probe B, both from the owner's tests 1 and 3: a PistolBoxTall of -5
        // lifts the pistol row onto the clip's line, and an inset of 6 keeps its clip inside the panel.
        PrimaryWeaponBoxWide: '0', PrimaryWeaponBoxTall: '0', PistolBoxWide: '0', PistolBoxTall: '-5',
        RightSideIndent: '6', PrimaryWeaponAmmoX: '48', ReserveAmmoYPos: '0', IconSize: '0', PrimaryWeaponTall: '20',
        // Probe B named HudAmmo for the clip; the editor sizes the clip's own font to HudAmmo's 18, the same face.
        PrimaryAmmoFont: 'HudEd_HudAmmoLarge_t18', PistolAmmoFont: 'HudAmmo',
      };
      for (const [k, v] of Object.entries(want)) expect(pcValue(ws, k), k).toBe(v);
      const cells = kvFind(parseKv(fileText(files, MODTEX))[0].value as KvNode[], ['TextureData'])!.value as KvNode[];
      for (const n of ['rounded_background_glow', 'rounded_background_noborder', 'icon_equip_pumpshotgun', 'icon_equip_uzi',
        'icon_equip_dualpistols', 'icon_equip_pistol', 'icon_equip_molotov', 'icon_equip_pills', 'icon_equip_medkit']) {
        expect(kvGet(kvFind(cells, [n])!, 'file'), n).toBe('vgui/hud/hudeditor/clear');
      }
    });
  }

  it('puts the column beside the crosshair on every aspect', () => {
    for (const aspect of ['16:9', '16:10', '4:3'] as const) {
      const ws = kvFind(buildTrees(ammoOnly({ ...structuredClone(DEFAULT_DESIGN), aspect }))('scripts/hudlayout.res'), ['HudWeaponSelection'])!;
      expect([kvGet(ws, 'xpos'), kvGet(ws, 'ypos')], aspect).toEqual(['c-10', 'c-12']);
    }
  });

  it('lays the numbers out where the game drew them: clip, reserve and pistol clip on one line right of the crosshair', () => {
    const d = ammoOnly(structuredClone(DEFAULT_DESIGN));
    const r = elementRect(d, 'weaponSelection', d.aspect);
    const [primary, pistol] = weaponSlots(d, d.aspect, r.w);
    const cx = 853 / 2, cy = 240;
    const [clip, reserve] = primary.texts;
    expect(r.x + clip.x - cx).toBeCloseTo(35.67, 1);        // right edge
    expect(r.x + reserve.x - cx).toBeCloseTo(40.33, 1);     // left edge
    expect(r.x + pistol.texts[0].x - cx).toBeCloseTo(85, 1);
    expect(r.y + clip.y + 9 - cy).toBeCloseTo(0, 6);        // centred on the crosshair
    expect(weaponSlots(d, d.aspect, r.w)).toHaveLength(2);
  });

  it('puts the pistol clip on the same line as the clip, inside the panel, on every aspect', () => {
    for (const aspect of ['16:9', '16:10', '4:3'] as const) {
      const d = ammoOnly({ ...structuredClone(DEFAULT_DESIGN), aspect });
      const r = elementRect(d, 'weaponSelection', aspect);
      const [primary, pistol] = weaponSlots(d, aspect, r.w);
      // Keys are whole numbers, so the row lands within half a unit of the clip's.
      expect(Math.abs(pistol.texts[0].y - primary.texts[0].y), aspect).toBeLessThanOrEqual(0.5);
      // The text's right edge, with room for the game's active-slot nudge.
      expect(pistol.texts[0].x, aspect).toBeLessThanOrEqual(r.w - 4);
    }
  });

  it("keeps the player's colours and visibility, and replaces everything else in one design", () => {
    const d0 = { ...structuredClone(DEFAULT_DESIGN), elements: { weaponSelection: { visible: false } },
      weapons: { reserveColor: '1 2 3 255', inactiveColor: '4 5 6 255', pistolBoxW: 90, iconTall: 40 } };
    const d = ammoOnly(d0);
    expect(d.elements.weaponSelection.visible).toBe(false);
    expect(d.weapons).toMatchObject({ reserveColor: '1 2 3 255', inactiveColor: '4 5 6 255', pistolBoxW: 0 });
    expect(d.weapons?.iconTall).toBeUndefined();
    expect(d0.weapons.pistolBoxW).toBe(90);
  });

  it('resets the weapon edits with the element, and counts them as overrides', () => {
    const d = ammoOnly(structuredClone(DEFAULT_DESIGN));
    expect(hasOverrides({ ...structuredClone(DEFAULT_DESIGN), weapons: { itemIcons: false } }, null)).toBe(true);
    const back = resetElement(d, 'weaponSelection');
    expect(back.weapons).toBeUndefined();
    expect(back.elements.weaponSelection).toBeUndefined();
    expect(resetElement(d, 'chat').weapons).toEqual(d.weapons);
  });
});

describe('moving a design onto an imported HUD and off it', () => {
  const ref = { id: 'e'.repeat(64), name: 'edgehud' };
  const art: CrosshairArt = { kind: 'image', png: 'data:image/png;base64,UE5H', w: 128, h: 128 };
  const none = { art: null, hasXhair: false, reset: false };

  it('starts a design with no layout edits with none, so the HUD shows as its author made it', () => {
    const d = withImport(structuredClone(DEFAULT_DESIGN), ref, none);
    expect(d).toMatchObject({ preset: 'imported', imported: ref, font: 'preset', elements: {}, children: {} });
    expect(hasLayoutEdits(d)).toBe(false);
  });

  it('keeps the edits a player keeps, and drops them on reset', () => {
    const edited = { ...structuredClone(DEFAULT_DESIGN), elements: { chat: { x: 8, y: 8 } } };
    expect(hasLayoutEdits(edited)).toBe(true);
    expect(withImport(edited, ref, none).elements).toEqual({ chat: { x: 8, y: 8 } });
    expect(withImport(edited, ref, { ...none, reset: true }).elements).toEqual({});
  });

  it("takes the upload's crosshair texture as a bundled image crosshair", () => {
    const d = withImport(structuredClone(DEFAULT_DESIGN), ref, { ...none, art });
    expect(d.crosshair).toBe('bundle');
    expect(d.xhairArt).toEqual(art);
  });

  it("keeps the HUD's own xHair element, as an addon crosshair, when it has no texture and none was chosen", () => {
    expect(withImport(structuredClone(DEFAULT_DESIGN), ref, { ...none, hasXhair: true }).crosshair).toBe('addon');
    const bundled = { ...structuredClone(DEFAULT_DESIGN), crosshair: 'bundle' as const, xhairArt: art };
    expect(withImport(bundled, ref, { ...none, hasXhair: true }).crosshair).toBe('bundle');
  });

  it('moves back to Stock without the import, with the default teammates when it had no edits', () => {
    const on = withImport(structuredClone(DEFAULT_DESIGN), ref, none);
    const back = withPreset(on, 'stock', false);
    expect(back.preset).toBe('stock');
    expect('imported' in back).toBe(false);
    expect(back.elements).toEqual(DEFAULT_DESIGN.elements);
    const edited = withPreset({ ...on, elements: { chat: { x: 8 } } }, 'modern', false);
    expect(edited.elements).toEqual({ chat: { x: 8 } });
    expect(withPreset({ ...on, elements: { chat: { x: 8 } } }, 'modern', true).elements).toEqual(DEFAULT_DESIGN.elements);
  });
});
