import { describe, it, expect } from 'vitest';
import {
  nudge, nudgeCards, freeInPlace, cardBoxes, placeCards, alignCards, hasOverrides, elementsTouched, resetElement, withTeamDir, placeCard, patchChild,
  placeChild, nudgeChild, resizeChild, resetChild,
  startsOf, moveChildren, placeChildren, scaleChildren, cornerFactor, anchorOf, alignChildren, setChildrenVisible, resetChildren,
  placeElement, moveElements, moveCards, alignElements, scaleElement, resizeBox, resizeElement, nudgeSelection, hideSelection, setSelectionVisible, resetSelection,
  ammoOnly, withImport, withPreset, hasLayoutEdits,
  splatterKind, patchSplatter, withSplatterImage, resetSplatter, panelClamp, raiseChild, resetChildKey, setFit,
} from './edit';
import { buildHud, buildTrees } from './build';
import { weaponSlots } from './weapons';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { DEFAULT_DESIGN, newDesign, baseTeam, validateDesign, type HudDesign } from './design';
import { DEFAULT_STATE } from '../crosshair/draw';
import type { CrosshairArt } from '../crosshair/model';
import { formatPos, parsePos } from './units';
import { teamCardRects, elementRect, cardChild, isFreeTeam, panelChild, elementFitShift } from './build';
import { childDef } from './children';
import { elementFrame } from './selection';

/**
 * DEFAULT_DESIGN as it was before your own health fitted by default (slice
 * 2.F G2), the way a design saved then still loads: the tests below pin
 * numbers of the unfitted 125 x 91 own panel.
 */
const UNFIT: HudDesign = { ...DEFAULT_DESIGN, elements: { teamColumn: { fit: true } } };

describe('nudge', () => {
  it('starts from the base position the first time', () => {
    const d = nudge(UNFIT, 'ownHealth', -10, 0);
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
    let d = UNFIT;
    for (let i = 0; i < 200; i++) d = nudge(d, 'ownHealth', -10, -10);
    // ownHealth is 125x91 HUD units at 16:9 (853 wide): clampSpan's 8-unit
    // floor caps x at 8 - 125 and y at 8 - 91.
    expect(d.elements.ownHealth).toEqual({ x: 8 - 125, y: 8 - 91 });
  });

  it('also clamps on the far side', () => {
    let d = UNFIT;
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
    // The bar starts where the game draws it, at the item row's 39 (probe X15); the block's own x is 37.
    const health = { x: 39, y: 52, w: 96, h: 7, visible: true };
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
    expect(teamCardRects(d, d.aspect)[0].x).toBe(8 - 122);
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
  // Stock, fitted: Head (13, 38, 23 x 23), Health (37, 52, 96 x 7, drawn at the item row's 39), in the
  // unfitted 150 x 150 card. The item row follows the bar's x: the card revive trap, below.
  const both = ['Head', 'Health'];

  it('moves every piece by the same amount', () => {
    const d = moveChildren(DEFAULT_DESIGN, both, startsOf(DEFAULT_DESIGN, both), 5, -2);
    expect(d.children.teamColumn).toEqual({ Head: { x: 18, y: 36 }, Health: { x: 42, y: 50 }, Items: { x: 44 } });
  });

  it('clamps the group as one, so the pieces keep their spacing at the card edge', () => {
    const s = startsOf(DEFAULT_DESIGN, both);
    expect(moveChildren(DEFAULT_DESIGN, both, s, -100, -100).children.teamColumn).toEqual({ Head: { x: 0, y: 0 }, Health: { x: 24, y: 14 }, Items: { x: 26 } });
    // The health bar reaches the right edge first: drawn at 39, 150 - 96 - 39 = 15 is all the room there is.
    expect(moveChildren(DEFAULT_DESIGN, both, s, 100, 0).children.teamColumn).toEqual({ Head: { x: 28, y: 38 }, Health: { x: 52, y: 52 }, Items: { x: 54 } });
  });

  it('places the group by its box', () => {
    const d = placeChildren(DEFAULT_DESIGN, both, 20, 40);
    expect(d.children.teamColumn).toEqual({ Head: { x: 20, y: 40 }, Health: { x: 44, y: 54 }, Items: { x: 46 } });
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
      // The bar scales from where it is drawn (39): 13 + 26 / 2 = 26 for the row, its own block 2 left of it.
      Health: { w: 48, h: 4, x: 24, y: 45 },
      Items: { x: 26 },
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
    // The drawn bar (the item row's x) stops at the card's left edge; its own block keeps the file's 2 units left of it.
    expect(d.children.teamColumn!.Health).toEqual({ w: 150, h: 14, x: -2, y: 66 });
    expect(d.children.teamColumn!.Items).toEqual({ x: 0 });
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
    const d = moveElements(UNFIT, ['chat', 'ownHealth'], starts, -5, 10);
    expect(d.elements.chat).toEqual({ x: 5, y: 285 });
    expect(d.elements.ownHealth).toEqual({ x: 723, y: 399 });
  });

  it('moves a Free card from where it started, keeping 8 units on screen', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    const starts = { 0: teamCardRects(free, free.aspect)[0] };
    expect(teamCardRects(moveCards(free, [0], starts, 100, -200), free.aspect)[0]).toMatchObject({ x: 113, y: 241 });
    expect(teamCardRects(moveCards(free, [0], starts, -5000, 0), free.aspect)[0].x).toBe(8 - 122);
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
    expect(edge[0].x).toBe(8 - 122);
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
    expect(scaleElement(UNFIT, 'ownHealth', start, 'nw', -62.5, -45.5).elements.ownHealth).toEqual({ scale: 1.5, x: 666, y: 344 });
    // The bottom-right corner: the element keeps its own position (and its file anchor).
    expect(scaleElement(UNFIT, 'ownHealth', start, 'se', 125, 0).elements.ownHealth).toEqual({ scale: 2 });
    expect(scaleElement(UNFIT, 'ownHealth', start, 'se', 1000, 0).elements.ownHealth).toEqual({ scale: 2 });
    expect(scaleElement(UNFIT, 'ownHealth', start, 'se', -1000, 0).elements.ownHealth).toEqual({ scale: 0.5 });
    expect(scaleElement(UNFIT, 'chat', start, 'se', 10, 10)).toBe(UNFIT);
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

  it('nudges an infected card by moving its whole row: the game places every card itself (plan Task 13)', () => {
    const moved = nudgeSelection(DEFAULT_DESIGN, { kind: 'cards', cards: [1], panel: 'infectedRow' }, 3, -2);
    expect(moved).toEqual(nudgeSelection(DEFAULT_DESIGN, { kind: 'elements', ids: ['infectedRow'] }, 3, -2));
    expect(moved.elements.infectedRow).toMatchObject({ x: 3, y: 403 });
    expect(moved.elements.teamColumn).toEqual(DEFAULT_DESIGN.elements.teamColumn);
  });

  it('hides elements and pieces, never a card, and skips an element with no Visible control', () => {
    const els = hideSelection(UNFIT, { kind: 'elements', ids: ['chat', 'ownHealth', 'xhair'] });
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

describe('splatter edits', () => {
  const base = () => structuredClone(DEFAULT_DESIGN);
  const hiddenBg = (d: HudDesign) => d.children.teamColumn?.BackgroundImage?.visible === false;

  it("makes the teammate splatter's None the child's hide, and any other kind shows it again", () => {
    const none = patchSplatter(base(), 'splatTeam', { kind: 'none' });
    expect(hiddenBg(none)).toBe(true);
    expect(none.splatters?.splatTeam).toBeUndefined();
    expect(splatterKind(none, 'splatTeam')).toBe('none');
    const fade = patchSplatter(none, 'splatTeam', { kind: 'fade' });
    expect(hiddenBg(fade)).toBe(false);
    expect(fade.children.teamColumn?.BackgroundImage).toBeUndefined();   // no empty override left behind
    expect(splatterKind(fade, 'splatTeam')).toBe('fade');
  });

  it("keeps a Fade colour through None, and makes a scratch's None its child's hide", () => {
    const d = patchSplatter(patchSplatter(base(), 'splatTop', { kind: 'fade', color: '1 2 3 4' }), 'splatTop', { kind: 'none' });
    expect(d.splatters?.splatTop).toEqual({ kind: 'fade', color: '1 2 3 4' });
    expect(d.children.ownHealth?.HealthbarTextureTop).toEqual({ visible: false });
    expect(splatterKind(d, 'splatTop')).toBe('none');
    const back = patchSplatter(d, 'splatTop', { kind: 'fade' });
    expect(back.children.ownHealth).toBeUndefined();   // no empty override left behind
    expect(splatterKind(back, 'splatTop')).toBe('fade');
  });

  it('never stores None for a scratch', () => {
    const d = patchSplatter(base(), 'splatBottom', { kind: 'none' });
    expect(d.splatters?.splatBottom).toBeUndefined();
    expect(splatterKind(d, 'splatBottom')).toBe('none');
  });

  it('reads a scratch hidden in Layers as None, and Reset shows it again', () => {
    const d = setChildrenVisible(base(), ['HealthbarTextureTop'], false, 'ownHealth');
    expect(splatterKind(d, 'splatTop')).toBe('none');
    expect(splatterKind(d, 'splatBottom')).toBe('stock');
    const reset = resetSplatter(d, 'splatTop');
    expect(splatterKind(reset, 'splatTop')).toBe('stock');
    expect(reset.children.ownHealth).toBeUndefined();
  });

  it('stores an upload at the texture size and switches the splatter to Image', () => {
    const d = withSplatterImage(base(), 'splatTop', 'AAAA');
    expect(d.images.splatTop).toEqual({ w: 256, h: 64, png: 'AAAA' });
    expect(d.splatters?.splatTop?.kind).toBe('image');
  });

  it('resets to stock: no style, no stored image, and the teammate splatter shown', () => {
    let d = withSplatterImage(base(), 'splatTeam', 'AAAA');
    d = patchChild(d, 'BackgroundImage', { visible: false, color: '255 255 255 100' });
    d = resetSplatter(d, 'splatTeam');
    expect(d.splatters).toBeUndefined();
    expect(d.images.splatTeam).toBeUndefined();
    expect(d.children.teamColumn?.BackgroundImage).toEqual({ color: '255 255 255 100' });   // only the hide goes
  });
});

describe('child edits name their panel', () => {
  it('stores an edit under the panel it was made in', () => {
    const d = patchChild(structuredClone(DEFAULT_DESIGN), 'Head', { x: 4 }, 'teamColumn');
    expect(d.children.teamColumn?.Head).toEqual({ x: 4 });
    expect(patchChild(structuredClone(DEFAULT_DESIGN), 'Head', { x: 4 })).toEqual(d);
  });
  it('clamps teammate pieces inside the unfitted card, as before', () => {
    expect(panelClamp(structuredClone(DEFAULT_DESIGN), 'teamColumn')).toEqual(baseTeam('stock').card);
  });
  it('brings pieces to the front and sends them to the back of their file', () => {
    // Stock teammatepanel.res: Voice, Name and Status at zpos 3 are the highest, BackgroundImage at -1 the lowest; Head has none (0).
    const d = structuredClone(DEFAULT_DESIGN);
    expect(raiseChild(d, ['Head'], 'front').children.teamColumn?.Head?.z).toBe(4);
    const back = raiseChild(d, ['Head', 'Name'], 'back');
    // One below BackgroundImage would be -2, the card background's zpos: the floor is that background + 1.
    expect([back.children.teamColumn?.Head?.z, back.children.teamColumn?.Name?.z]).toEqual([-1, -1]);
  });
  it('never sends a piece under the background the build injects', () => {
    // Review M1: HudEdCardBg sits at -2; going below it hid the piece.
    const d = { ...structuredClone(DEFAULT_DESIGN), styles: { panelBg: { kind: 'flat' as const } } };
    expect(raiseChild(d, ['Head'], 'back').children.teamColumn?.Head?.z).toBe(-1);
    // Modern's own panel: ModBg at -5 is the lowest, HudEdOwnBg injects at -5 too; the floor is -4.
    const own = { ...withPreset(structuredClone(DEFAULT_DESIGN), 'modern', true), styles: { ownBg: { kind: 'flat' as const } } };
    expect(buildTrees(own)('resource/ui/hud/localplayerpanel.res').some((n) => n.key === 'HudEdOwnBg')).toBe(true);
    expect(raiseChild(own, ['Head'], 'back', 'ownHealth').children.ownHealth?.Head?.z).toBe(-4);
  });
  it('leaves the injected blocks and the hidden revive anchor out of the zpos list', () => {
    // Modern ships bar 34 and down picture 0, so unfitted the build adds the hidden Items anchor (no zpos, so 0).
    const own = { ...withPreset(structuredClone(DEFAULT_DESIGN), 'modern', true), elements: {} };
    expect(buildTrees(own)('resource/ui/hud/localplayerpanel.res').some((n) => n.key === 'Items')).toBe(true);
    // With every registered piece moving, only ModBg (-5) is left: front is -4, not 1 from the anchor.
    const all = ['Head', 'Health', 'HealthIcon', 'HealthNumber', 'HealthbarTextureTop', 'HealthbarTextureBottom', 'Incapacitated', 'DuckingIcon'];
    expect(raiseChild(own, all, 'front', 'ownHealth').children.ownHealth?.Head?.z).toBe(-4);
    // The card's HudEdSplatter stand-in and HudEdCardBg do not count either.
    // The card's HudEdCardBg does not count either: with every card piece moving nothing is left to measure.
    const card = { ...structuredClone(DEFAULT_DESIGN), styles: { panelBg: { kind: 'flat' as const } } };
    const allCard = ['Head', 'Health', 'Name', 'Items', 'Status', 'BackgroundImage', 'Incapacitated', 'Dead', 'Voice'];
    expect(raiseChild(card, allCard, 'front')).toBe(card);
  });
});

describe('resetChildKey (review M2: Use the file\'s value)', () => {
  it('removes just that key, keeping the rest of the piece\'s edits', () => {
    // x 40 is the drawn x (the item row's), so the bar's own block goes to 38.
    const d = patchChild(structuredClone(DEFAULT_DESIGN), 'Health', { x: 40, keys: { inset: '1', monochrome_color: '1 2 3 255' } });
    expect(resetChildKey(d, 'Health', 'inset').children.teamColumn?.Health).toEqual({ x: 38, keys: { monochrome_color: '1 2 3 255' } });
  });
  it('drops an emptied keys object, then an emptied piece and panel', () => {
    const d = patchChild(structuredClone(DEFAULT_DESIGN), 'Health', { keys: { inset: '1' } }, 'ownHealth');
    expect(resetChildKey(d, 'Health', 'inset', 'ownHealth').children).toEqual({});
    const e = patchChild(structuredClone(DEFAULT_DESIGN), 'Health', { x: 3, keys: { inset: '1' } });
    expect(resetChildKey(e, 'Health', 'inset').children.teamColumn?.Health).toEqual({ x: 1 });
  });
  it('gives the design back unchanged when the key is not set', () => {
    const d = structuredClone(DEFAULT_DESIGN);
    expect(resetChildKey(d, 'Health', 'inset')).toBe(d);
  });
});

describe('setFit', () => {
  it('turns fit on and off and gives back the elements exactly', () => {
    const d = structuredClone(UNFIT);
    const on = setFit(d, 'ownHealth', true);
    expect(on.elements.ownHealth).toEqual({ fit: true });
    expect(setFit(on, 'ownHealth', false).elements).toEqual(d.elements);
  });
  it('keeps a moved panel where it was through the toggle', () => {
    const d = { ...structuredClone(DEFAULT_DESIGN), elements: { ownHealth: { x: 20, y: 380 } } };
    expect(setFit(d, 'ownHealth', true).elements.ownHealth).toEqual({ x: 20, y: 380, fit: true });
    expect(setFit(setFit(d, 'ownHealth', true), 'ownHealth', false).elements).toEqual(d.elements);
  });
});

describe('the card bar and the item row move sideways together (the card revive trap)', () => {
  // client.dll 1023f5df..1023f6da, the player panel class shared by your own panel and the cards: after a
  // revive the game sets a card's Health x to its Items child's x. Stock has the bar at 37 and the items at
  // 39, so a bar or item row dragged on its own would jump after a revive; the two keep the stock offset.
  const at = (d: HudDesign, n: string) => panelChild(d, 'teamColumn', n)!;
  // The file's own offset: the bar's block x (ownX) against the row's. The bar's x is the row's, where the game draws it.
  const offset = (d: HudDesign) => at(d, 'Items').x - at(d, 'Health').ownX!;
  for (const [label, base] of [['unfitted', { ...structuredClone(DEFAULT_DESIGN), elements: {} }], ['fitted', structuredClone(UNFIT)]] as const) {
    it(`${label}: dragging the bar moves the item row by the same x, and not its y`, () => {
      const d0 = base as HudDesign;
      const was = offset(d0), itemsY = at(d0, 'Items').y;
      const d = placeChild(d0, 'Health', at(d0, 'Health').x + 10, at(d0, 'Health').y + 5);
      expect(at(d, 'Health').x).toBe(at(d0, 'Health').x + 10);
      expect(offset(d)).toBe(was);
      expect(at(d, 'Items').y).toBe(itemsY);
    });
    it(`${label}: dragging the item row moves the bar, and a nudge, the X box and a group move keep the offset`, () => {
      const d0 = base as HudDesign;
      const was = offset(d0);
      expect(offset(placeChild(d0, 'Items', at(d0, 'Items').x - 6, at(d0, 'Items').y))).toBe(was);
      expect(offset(nudgeChild(d0, 'Health', 3, 0))).toBe(was);
      expect(offset(patchChild(d0, 'Items', { x: 70 }))).toBe(was);
      const both = ['Health', 'Items'];
      const moved = moveChildren(d0, both, startsOf(d0, both), 5, 0);
      expect([at(moved, 'Health').x, at(moved, 'Items').x]).toEqual([at(d0, 'Health').x + 5, at(d0, 'Items').x + 5]);
    });
  }
  it('stock keeps 37 and 39, and the bar\'s x is 39, where the game draws it (probe X15)', () => {
    const d = { ...structuredClone(DEFAULT_DESIGN), elements: {} };
    expect([at(d, 'Health').x, at(d, 'Health').ownX, at(d, 'Items').x]).toEqual([39, 37, 39]);
    // The X box takes the drawn x: 50 puts the bar at 50 in game, the block at 48 with the row at 50.
    expect(patchChild(d, 'Health', { x: 50 }).children.teamColumn).toEqual({ Health: { x: 48 }, Items: { x: 50 } });
    expect(at(patchChild(d, 'Health', { x: 50 }), 'Health').x).toBe(50);
  });
  it('turns a bar x edit with no move into its own x, never the drawn one (a W change through the left handle)', () => {
    const d = { ...structuredClone(DEFAULT_DESIGN), elements: {} };
    expect(patchChild(d, 'Health', { x: 39, w: 80 }).children.teamColumn).toEqual({ Health: { x: 37, w: 80 } });
  });
  it('falls back to the bar\'s own x on a design whose file has no item row\'s partner to move', () => {
    // The own panel is not linked: its bar x is stored as given.
    expect(patchChild(structuredClone(DEFAULT_DESIGN), 'Health', { x: 40 }, 'ownHealth').children.ownHealth).toEqual({ Health: { x: 40 } });
  });
  it('resets the partner\'s x with the piece, keeping its other edits', () => {
    const d = patchChild(patchChild({ ...structuredClone(DEFAULT_DESIGN), elements: {} }, 'Items', { fontSize: 20 }), 'Health', { x: 50 });
    expect(d.children.teamColumn).toEqual({ Health: { x: 48 }, Items: { fontSize: 20, x: 50 } });
    expect(resetChild(d, 'Health').children.teamColumn).toEqual({ Items: { fontSize: 20 } });
    expect(resetChild(patchChild(d, 'Health', { y: 3 }), 'Items').children.teamColumn).toEqual({ Health: { y: 3 } });
  });
  it('leaves your own panel alone: its Items is the build\'s hidden anchor, placed at the bar', () => {
    const d = patchChild(structuredClone(DEFAULT_DESIGN), 'Health', { x: 40 }, 'ownHealth');
    expect(d.children.ownHealth).toEqual({ Health: { x: 40 } });
  });
  it('explains the link on both pieces', () => {
    for (const n of ['Health', 'Items']) expect(childDef('teamColumn', n)!.note, n).toMatch(/revive/);
  });
});

describe('placing a fitted infected health', () => {
  it('lands where it is asked on screen, the fit offset kept out of the stored position', () => {
    const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), elements: { siHealth: { fit: true } } };
    const moved = placeElement(d, 'siHealth', 300, 200);
    const r = elementRect(moved, 'siHealth', moved.aspect);
    // A centre token on the 853.33-wide screen reads back to the half unit, as any placed element does.
    expect(Math.abs(r.x - 300)).toBeLessThanOrEqual(0.5);
    expect(r.y).toBe(200);
    // Stored where the unfitted container would sit: fit off and on show the same pieces in the same place.
    // 49, not 50: 49 draws at 299.5, which the X box shows as the 300 asked for; 50 draws at 300.5, shown 301.
    expect(moved.elements.siHealth).toMatchObject({ x: 49, y: 200 });
  });

  it('nudges from where it is drawn', () => {
    const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), elements: { siHealth: { fit: true } } };
    const before = elementRect(d, 'siHealth', d.aspect);
    const after = elementRect(nudge(d, 'siHealth', -5, 0), 'siHealth', d.aspect);
    expect(Math.abs(after.x - (before.x - 5))).toBeLessThanOrEqual(1);
    expect(after.y).toBe(before.y);
  });
});

describe('a fitted infected health at the screen edges', () => {
  for (const k of [1, 2]) {
    it(`reaches the left edge as any element does, 8 units kept on screen, at scale ${k}`, () => {
      const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), elements: { siHealth: { fit: true, scale: k, x: 50, y: 200 } } };
      const w = elementRect(d, 'siHealth', d.aspect).w;
      const moved = placeElement(d, 'siHealth', -10000, -10000);
      const r = elementRect(moved, 'siHealth', moved.aspect);
      expect([r.x, r.y]).toEqual([8 - w, 8 - r.h]);
      // Stored less the fit offset, below the unfitted -200 floor, and kept by the validator.
      expect(moved.elements.siHealth!.x).toBeLessThan(-200);
      expect(validateDesign(moved).elements.siHealth).toEqual(moved.elements.siHealth);
    });
  }
  it('still holds an unfitted element to the validator\'s -200', () => {
    expect(placeElement(DEFAULT_DESIGN, 'chat', -900, 0).elements.chat!.x).toBe(-200);
  });
});

describe('arrow presses at a centre-anchored place', () => {
  // Stored 300 in 16:9 writes c-126 (300 - 426.5, the half rounded up), which reads back at 300.5.
  for (const id of ['chat', 'siHealth', 'ownHealth', 'progressBar', 'abilityRing']) {
    it(`moves ${id} exactly one unit on the axis pressed and never the other`, () => {
      let d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), elements: { [id]: { x: 300, y: 200 } } };
      expect(elementRect(d, id, d.aspect).x % 1).toBe(0.5);
      for (const [dx, dy] of [[1, 0], [-1, 0], [-1, 0], [0, 1], [0, -1], [1, 0]]) {
        const before = elementRect(d, id, d.aspect);
        d = nudge(d, id, dx, dy);
        const after = elementRect(d, id, d.aspect);
        expect([after.x - before.x, after.y - before.y], `${dx},${dy}`).toEqual([dx, dy]);
      }
      expect(d.elements[id]).toMatchObject({ x: 300, y: 200 });
    });
  }
});

describe('a fitted infected health at any scale (one fit shift in build and edit)', () => {
  const SCALES = [1, 1.25, 1.33, 0.75, 1.5, 2];
  // Stored at 50, 200: on screen at every scale (stock's r387 is off the right edge at 2).
  const at = (k: number, aspect: HudDesign['aspect']): HudDesign => (
    { ...structuredClone(DEFAULT_DESIGN), aspect, elements: { siHealth: { fit: true, scale: k, x: 50, y: 200 } } }
  );
  const rect = (d: HudDesign) => elementRect(d, 'siHealth', d.aspect);
  for (const aspect of ['16:9', '4:3'] as const) for (const k of SCALES) {
    it(`moves exactly one unit per arrow press and never the other axis at scale ${k}, ${aspect}`, () => {
      let d = at(k, aspect);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 0], [1, 0], [-1, 0]]) {
        const before = rect(d);
        d = nudge(d, 'siHealth', dx, dy);
        const after = rect(d);
        expect([after.x - before.x, after.y - before.y], `${dx},${dy}`).toEqual([dx, dy]);
      }
    });
    it(`keeps its place when the X or Y box's own value is typed back at scale ${k}, ${aspect}`, () => {
      const d = at(k, aspect);
      const r = rect(d);
      expect(rect(placeElement(d, 'siHealth', Math.round(r.x), r.y))).toMatchObject({ x: r.x, y: r.y });
      expect(rect(placeElement(d, 'siHealth', r.x, Math.round(r.y)))).toMatchObject({ x: r.x, y: r.y });
    });
    it(`leaves the fit box's corner where it was when Fit is toggled at scale ${k}, ${aspect}`, () => {
      const on = at(k, aspect);
      const off = setFit(on, 'siHealth', false);
      const shift = elementFitShift(on, 'siHealth');
      // 853 wide, a centre token reads back at the half unit (the game's own
      // arithmetic), and the fitted container is centred here; 640 is exact.
      const slack = aspect === '16:9' ? 0.5 : 0;
      expect(Math.abs(rect(on).x - (rect(off).x + shift.x))).toBeLessThanOrEqual(slack);
      expect(rect(on).y).toBe(rect(off).y + shift.y);
    });
  }
});

describe('editing your infected health on the Boomer preview (plan decision 3)', () => {
  const BOOMER = 'resource/ui/hud/boomerhealth.res';
  const plain: HudDesign = { ...structuredClone(DEFAULT_DESIGN), elements: {} };
  it('stores a drag of the Boomer\'s bar in the Hunter\'s frame: moved the same', () => {
    const starts = startsOf(plain, ['Health'], 'siHealth', BOOMER);
    expect(starts.Health).toMatchObject({ x: 322, w: 64 });
    const d = moveChildren(plain, ['Health'], starts, 10, 0, 'siHealth', BOOMER);
    expect(d.children.siHealth?.Health).toMatchObject({ x: 262, y: 69 });
    expect(panelChild(d, 'siHealth', 'Health', BOOMER)).toMatchObject({ x: 332, y: 69 });
  });
  it('stores a widening of the Boomer\'s bar in proportion to the Hunter\'s', () => {
    const start = startsOf(plain, ['Health'], 'siHealth', BOOMER).Health;
    const d = resizeChild(plain, 'Health', start, 'e', 10, 0, false, 'siHealth', BOOMER);
    expect(d.children.siHealth?.Health?.w).toBe(132 + Math.round(10 * 132 / 64));
    expect(panelChild(d, 'siHealth', 'Health', BOOMER)!.w).toBe(74);
  });
  it('nudges a piece selected on the Boomer in the Boomer\'s frame, as a drag there does', () => {
    // Hunter bar at 316 puts the Boomer's at 386, its right edge on the 450 clamp box's.
    const d: HudDesign = { ...plain, children: { siHealth: { Health: { x: 316 } } } };
    const sel = { kind: 'children' as const, names: ['Health'], card: 0, panel: 'siHealth' };
    const nudged = nudgeSelection(d, sel, 5, 0, BOOMER);
    expect(nudged).toEqual(moveChildren(d, ['Health'], startsOf(d, ['Health'], 'siHealth', BOOMER), 5, 0, 'siHealth', BOOMER));
    expect(panelChild(nudged, 'siHealth', 'Health', BOOMER)!.x).toBe(386);
  });
  it('takes an X box typed on the Boomer as the Boomer\'s own x', () => {
    const d = patchChild(plain, 'Health', { x: 300 }, 'siHealth', BOOMER);
    expect(d.children.siHealth?.Health?.x).toBe(230);
    expect(panelChild(d, 'siHealth', 'Health', BOOMER)!.x).toBe(300);
  });
  it('leaves an edit on the Hunter (or with no file) as it is', () => {
    expect(patchChild(plain, 'Health', { x: 300, w: 90 }, 'siHealth', 'resource/ui/hud/hunterhealth.res').children.siHealth?.Health).toEqual({ x: 300, w: 90 });
    expect(patchChild(plain, 'Health', { x: 300, w: 90 }, 'siHealth').children.siHealth?.Health).toEqual({ x: 300, w: 90 });
  });
});

describe('placing a fitted infected row (plan Task 11)', () => {
  it('stores the unfitted container, so a drop where it is drawn moves nothing', () => {
    // The fit moves CHudZombieTeamDisplay down by the card's 10-unit offset (build.ts rowLayout).
    const d = { ...structuredClone(DEFAULT_DESIGN), elements: { infectedRow: { fit: true } } } as HudDesign;
    const r = elementRect(d, 'infectedRow', d.aspect);
    expect(r.y).toBe(415);
    const moved = placeElement(d, 'infectedRow', r.x, r.y);
    expect(elementRect(moved, 'infectedRow', moved.aspect)).toMatchObject({ x: r.x, y: r.y });
    expect(moved.elements.infectedRow).toMatchObject({ x: 0, y: 405 });
  });
});
