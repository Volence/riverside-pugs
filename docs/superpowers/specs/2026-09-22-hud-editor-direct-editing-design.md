# HUD editor, Phase 1b: direct editing (undo, click-to-piece, handles, layers)

Date: 2026-09-22. Branch `worktree-hud-editor`. Follows Phase 1 (teammate cards,
`2026-09-22-hud-editor-teammate-cards-design.md`, built). Mockups approved by the owner in the
brainstorm companion (`.superpowers/brainstorm/`, screens `selection-model`, `drag-model`,
`multi-select`, `page-layout`).

## Why

The owner tried Phase 1 and found editing clumsy: selection happens in steps (element, then
card, then child), most resizing is a number box or slider, and there is no undo. They want it to
feel like a design tool. Approved direction:

- Undo and redo, with Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and toolbar buttons.
- One click picks the deepest piece under the pointer; a drag started on something not yet picked
  moves the whole section; once a piece is picked, dragging it moves just that piece.
- Several pieces picked at once (Shift+click, Shift+drag box, Ctrl+A) move and scale together.
- Handles on every side and corner of the selection; resizing by dragging, sliders and boxes stay
  for exact values.
- A Layers list, a single toolbar, a context panel that shows only what the selection can do,
  hover outlines, snap guides, right-click menu, Delete hides.

Nothing here changes what a download contains: every edit still lands in `HudDesign` through the
same validated fields Phase 1 defined. This phase is the page and a few pure helpers.

## Undo and redo

- A history of `HudDesign` values (designs are already replaced, never mutated). Past and future
  stacks, 100 entries max (oldest dropped).
- **What is one step.** A discrete edit (checkbox, select, button, Delete, context-menu action,
  preset switch, import, share-link load, reset) is one step. A continuous gesture is one step: a
  canvas drag or resize from pointer-down to pointer-up, a slider from first input to release, a
  number box from focus to blur or Enter, a colour picker from open to close. Arrow-key nudges
  coalesce into one step while the same selection is nudged within 800 ms of the last nudge.
- **Mechanism.** `history.ts` is pure: `push(h, prev)`, `begin(h, prev)` / `commit(h, current)`
  for gestures (a gesture that ends where it began records nothing), `undo(h, current)`,
  `redo(h, current)`. The page routes every design change through one `edit(next, mode)` function
  where `mode` is `step` or `gesture`. A new edit after an undo clears the future stack.
- **Keys.** Ctrl+Z undo, Ctrl+Shift+Z and Ctrl+Y redo (Cmd on macOS). While focus is in a text or
  number input the browser's own undo applies and the editor's does not.
- **Selection after undo.** Kept when it still names something that exists, otherwise dropped.
- History lives in memory only. Reloading the page starts a fresh history (the design itself is
  still saved to local storage as today).

## Selection model

A selection is one of:

```ts
type Selection =
  | { kind: 'none' }
  | { kind: 'elements'; ids: string[] }                 // one or more elements, same side
  | { kind: 'cards'; cards: number[] }                  // one or more teammate cards, sorted, no repeats
  | { kind: 'children'; names: string[]; card: number } // pieces of the teammate card; card = the card clicked in (for display)
```

The survivor Teammates nest three levels deep in every layout (Row, Column and Free): the
Teammates element, then a card, then a piece. Cards 1 to 3 are the ones the preview draws; card 4
shows only while spectating a full team, so it is a level only in Free, where Layers lists it.

The pure module `selection.ts` decides what a pointer gesture means, so the page holds no hit
logic of its own. Everything it measures comes from the generator's trees (`elementRect`,
`teamCardRects`, `childRects`), as Phase 1 requires.

- **Hover** outlines what a click would pick and shows its name in a small label; with Ctrl held
  it outlines what a Ctrl+click would pick (a card, over one of its pieces).
- **Click** (press and release within 3 screen pixels) picks the deepest thing under the pointer:
  a teammate card piece if the pointer is on one that is drawn in the current state, else the card,
  else the element. **Ctrl+click** picks one level up: a piece's card; the Teammates from a card's
  empty space, or when that card is already the selection, so repeated Ctrl+clicks walk up.
  **Shift+click** adds or removes the item at the same level as the current selection (pieces
  with pieces of the teammate card, cards with cards, elements with elements); at a different level
  it starts a new selection. While cards are picked, Shift+click (or Ctrl+Shift+click) anywhere on
  a card, a piece included, is lifted to that card, so it adds or removes the card.
- **Drag** started on something that is part of the selection moves the selection: picked pieces,
  every picked card together (keeping their spacing), or the Row or Column Teammates as one. A
  drag started on something not selected moves only the card under the pointer, in any layout,
  and selects it; off the cards it moves the element there. No key is needed to move a card or a
  section.
- **Moving a card of a Row or Column team** (a drag, the arrows, or its X and Y boxes) first
  switches the Teammates to Free, seeding all four card positions from where the cards are drawn,
  so the cards not moving stay put. The switch and the move are one undo step, and the status line
  says "Teammates switched to Free layout" until an undo, redo or cancelled drag puts the team back
  in Row or Column. (Free positions use the element anchor tokens; on the 853-wide 16:9 screen a
  card in the middle third can only land on a half unit, so card 3 of the stock row moves half a
  unit on the switch, as it always has from the Layout select.)
- **Shift+drag** on the canvas draws a box. If the box starts inside a teammate card it picks every
  drawn piece of that card it touches; otherwise every element of the current side it touches.
- **Ctrl+A**: with pieces picked, every drawn piece of the teammate card; otherwise every visible
  element of the current side.
- **Escape** climbs one level (pieces, then their card, then the Teammates, then none; an element,
  then none). The **breadcrumb** at the canvas corner shows the path (`Teammates › Card 2 › Health
  bar`, `Teammates › Card 3`, `Teammates › 2 cards`, or `Teammates › Card 1 › 3 pieces`); clicking a
  segment selects that level.
- Pieces are edited in the one teammate card file, so picking a piece in any card outlines it in
  every card (Phase 1 behaviour, kept).

## Handles and resizing

Handles sit on the selection's bounding box. What they do depends on what is selected:

| Selection | Handles | Dragging a handle |
|---|---|---|
| Element with `resize: 'free'` | 8 (sides and corners) | Width and height, as the current corner drag |
| Element with `resize: 'scale'` | 4 corners | Scale, proportional, from the opposite corner; clamped to the existing 0.5..2 |
| Element with `resize: 'none'` | none | |
| Cards | none (cards share one size) | |
| One piece, box `wh` | 8 | Width and height |
| One piece, box `square` | 4 corners | Size, ratio locked |
| One piece, box `none` with a font (Items) | 4 corners | Icon size, proportional |
| Several pieces | 4 corners | Scales every piece's position and size about the opposite corner; square pieces stay square; font pieces scale their size |
| Several elements | none | |

Shift while dragging a side handle keeps the ratio for `wh` items. Resizing from a left or top
handle moves the origin as well, so the opposite edge stays put. Every result goes through the
existing clamps (`clampChild`, the element ranges, the unfitted-card clamp), so the design stays
valid whatever the pointer does.

## Snap guides

While moving or resizing, edges and centres snap to targets within 4 HUD units, and a pink line is
drawn for each snap:

- moving elements: the screen edges and centre lines, and the edges and centres of the other
  visible elements of the current side;
- moving pieces: the teammate card's edges and centre lines (the unfitted parent, as the Phase 1
  drag clamp) and the other drawn pieces' edges and centres.

Holding Alt disables snapping. `guides.ts` is pure: given the moving box, the target boxes and the
threshold, it returns the snapped delta and the guide lines. The existing `snap()` to thirds is
replaced by it.

## Layers panel

Left of the canvas, for the current side: every element as a row, in registry order, with an eye
toggle (visible) and the label; hidden rows are struck through. `Teammates` expands to its pieces
from the child registry, drawn state children marked as "shown when down/dead", and the addable
Health number as a `＋ Health number` row that adds it. `Teammates` also lists Card 1..3 in every
layout, and Card 4 in Free.
Click selects, Shift+click adds, following the same rules as the canvas. The pill rows under the
canvas and the children list in the side panel are removed.

## Toolbar and context panel

- **Toolbar** above the canvas: Undo, Redo; Survivor / Infected; Healthy / Down / Dead (survivor
  only); Preset, Aspect, Backdrop and Font menus; Download on the right. These are the existing
  controls, moved.
- **Context panel** on the right shows only what the selection can do:
  - nothing: a short hint, then Styles and Save and share (as today);
  - one element: its existing controls (the Phase 1 `ElementControls`, including Teammates layout);
  - one card: Card X and Y (in Row or Column a typed value switches the team to Free, one step);
  - several cards: group X and Y (moving all, from their box) and Align against their box;
  - one piece: the Phase 1 `ChildControls`;
  - several pieces: group X and Y (moving all), Align (left, centre, right, top, middle, bottom,
    against the group's box), Visible for all, Reset all;
  - several elements: Align against their box, Visible for all.
  Styles and Save stay reachable below in every case.
- **Right-click** on the canvas opens a small menu for the thing under the pointer: Hide, Reset,
  and Select whole card / Select Teammates where they apply. **Delete** or **Backspace** hides the
  selection (visible false for elements and pieces; a card cannot be hidden alone, so a card's menu
  offers only Select Teammates and Delete on cards does nothing).
- **Arrow keys** nudge the selection by 1 unit, Shift by 10, through the same clamps.

## Known issue folded in

The Phase 1 final review left one Important open: a scaled Row stays at its bottom anchor and runs
off the screen, and a moved team switched to Column can too. With handles scaling the team by drag
this becomes easy to hit, so this phase adds the clamp: a team container's along-screen position
is clamped with `min(start, extent - size)` (and `max(0, ...)`) after scaling and layout, in both
axes, so the whole team always stays on screen. Applied where `teamLayout` writes `at`, so the file,
`elementRect` and `teamCardRects` agree.

## Code structure

`web/src/routes/Hud.tsx` is 1,357 lines; this phase splits it by responsibility rather than
growing it:

- `web/src/hud/history.ts`: the undo stacks (pure).
- `web/src/hud/selection.ts`: `Selection`, hit resolution for hover, click, drag and box, the
  breadcrumb path (pure, over `buildTrees` geometry).
- `web/src/hud/guides.ts`: snapping and guide lines (pure).
- `web/src/hud/edit.ts`: the pure design edits the page applies: the Phase 1 helpers moved out of
  `Hud.tsx` (`nudge`, `placeCard`, `patchChild`, `placeChild`, `nudgeChild`,
  `resizeChild`, `withTeamDir`, `resetElement`, ...) plus the new group edits (`moveChildren`,
  `scaleChildren`, `alignChildren`, `alignElements`, `scaleElement`, `hideSelection`) and the card
  edits (`freeInPlace`, `cardBoxes`, `moveCards`, `nudgeCards`, `placeCards`, `alignCards`).
- `web/src/routes/hud/Toolbar.tsx`, `LayersPanel.tsx`, `ContextPanel.tsx`, `ContextMenu.tsx`:
  presentational components.
- `web/src/routes/Hud.tsx`: state (design, history, selection, hover, drag), wiring and layout.
- `web/src/hud/mock.ts` gains drawing of hover outlines, handles, multi-selection frames, the box
  and guides, driven by a widened `HudView`.

## Errors and edge cases

- A gesture that produces an invalid value is clamped, never rejected; the design is always valid.
- Pointer capture is taken on pointer-down so a drag that leaves the canvas still ends cleanly; a
  lost capture or Escape during a drag cancels it and restores the design from the gesture start
  (recording nothing).
- Switching side, preset or state drops a selection that no longer applies (Phase 1 rule).
- Touch: pointer events cover it; Shift and Ctrl gestures have Layers-list equivalents.

## Testing

- `history`: steps, gestures, no-op gestures, cap at 100, redo cleared by a new edit, nudge
  coalescing window.
- `selection`: click picks the piece / card / element in each state and layout; Ctrl+click climbs;
  Shift+click adds and removes at the same level and restarts at another; drag on unselected
  moves the section; drag on selected moves the selection; box selection in and out of a card;
  Ctrl+A; breadcrumb paths; hidden-in-state pieces never picked.
- `guides`: snaps to edges and centres within 4 units, not beyond; Alt off; guide lines returned.
- `edit`: group move, group scale about a corner (square stays square, fonts scale, clamps hold),
  align six ways, element scale by handle clamped 0.5..2, hide selection, the Row/Column
  on-screen clamp.
- Page: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and the buttons; one drag is one undo step; a slider drag
  is one step; typing in a number box does not trigger the editor's undo; click picks a piece in
  one click; drag on an unpicked card in Row moves only that card and goes Free, one undo step;
  Shift+click multi-select (pieces or cards) then drag moves both; a handle drag resizes; the Layers list selects and hides; right-click menu; Delete hides.
- Preview equals file: every existing parity test still passes; hover, handles and guides are
  drawn from the same rects.
- Browser pass by the controller on the running page, then the owner.
