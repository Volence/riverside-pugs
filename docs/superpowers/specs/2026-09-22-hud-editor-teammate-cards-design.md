# HUD editor, Phase 1: teammate cards done right

Date: 2026-09-22. Branch `worktree-hud-editor`. Builds on the v2 spec
(`2026-09-22-hud-editor-panel-internals-design.md`, whose Plan 1 "honest preview" is built) and
the capability audit (`2026-09-22-hud-editor-capability-audit.md`, including its "In-game probe
results" section, which is the ground truth for every engine claim below).

## Why

The owner tried the honest preview and asked for control the editor does not give:

1. Real spacing. In Column mode the stock cards fill the whole side of the screen.
2. Each teammate card placed on its own.
3. Control inside a card: icons the same size or gone, icons above a shorter bar, portrait and
   name sizes, teammate health numbers placed where they want.
4. A panel background that covers the card, not a huge box.
5. Down and dead pictures that are not stretched.

The owner's direction is "super modular to what L4D can handle". This phase does all of it for
the survivor teammate card, plus four cheap correctness fixes the probe exposed. It replaces the
v2 spec's Plan 2 for the teammate card only; Plan 2's design for the other three panels (own
health, infected card, SI health) moves to Phase 2 unchanged except where this spec's shared
machinery (fit, aspect lock, card background, state preview) supersedes it.

## Engine facts this design rests on (all from the probe unless marked)

- Each `TeamPlayerN` block in `teamdisplayhud.res` is placed by its own `xpos`/`ypos`; the game
  honours scattered positions (T5).
- A card can be shrunk to its content with every child shifted, and nothing is lost (T6).
- The card block's own `image` key is never painted (T6). Stock `s_panel_background` is
  therefore invisible, and today's `panelBg` style slot, which repoints that key, does nothing
  in game.
- Incap and dead art shown in a non-square box is stretched: both are square textures drawn with
  `scaleImage 1` (T6, owner's screenshots).
- A `%HealthNumber%` label on the teammate card shows each teammate's health and updates;
  incapacitated it shows the incap health in red. Game code recolours it by health and ignores
  `fgcolor_override` (T7).
- The stock damage splatter (`BackgroundImage`, `hud/healthbar_bg_N`) is drawn faintly at full
  health, not hidden (T6).
- Health bar fills are code-drawn; the `healthbar_*` textures do not change them (T8).
- The Tank reads `hunterhealth.res`; `tankhealth.res` is never loaded (T1).
- `never_draw 1` on `HudCrosshair` hides the engine crosshair (T2).
- There is no kill feed in L4D1; kill and incap messages print into the chat history.
- One `teammatepanel.res` is loaded for every card, so inside edits apply to every teammate, and
  game code decides which teammate lands in which slot (audit C.1).

## Scope

In: teammate card layout (Row, Column, Free), fit to content, gap spacing, inside editing of the
teammate card with aspect-locked square art, a card background that is actually drawn, a
Healthy / Down / Dead preview for the teammate card, and the cleanups (kill feed, `tankhealth.res`,
Advanced bar slots, the preview's splatter, a "hide the game's crosshair" option).

Out (later phases): inside editing of own health, infected card and SI health; weapons, chat,
target ID, ghost panel and the rest; themes; per-teammate different contents (impossible).

## The design data

`HudDesign` stays `v: 1`. `ElementOverride` gains, for the `teamColumn` element only:

```ts
dir?: 'row' | 'column' | 'free';      // 'free' is new
gap?: number;                          // units between cards at scale 1, Row and Column
fit?: boolean;                         // shrink the card to its content
slots?: { x: number; y: number }[];    // Free: four card positions, screen units, like an element's x/y
```

and `HudDesign` gains the v2 spec's sparse `children` map and `ChildOverride` exactly as that
spec defines them (`visible`, `x`, `y`, `w`, `h`, `fontSize`, `color`, `on`), accepted in this
phase for `panelId` `teamColumn` only; `validateDesign` drops other panel ids until Phase 2.

`HudDesign` also gains `hideGameCrosshair?: boolean`.

Rules:

- `spacing` stays readable for old designs and is migrated on load: `gap = spacing - cardExtent`
  along the direction, where `cardExtent` is the unfitted card size (150 on stock), clamped at 0.
  `validateDesign` writes `gap` and drops `spacing`, so a saved design loads looking the same.
- `fit` absent means off, so every saved design and share link renders exactly as before.
  `DEFAULT_DESIGN` sets `teamColumn: { fit: true }`, so new designs and "Reset" start fitted.
- `gap` is clamped to 0..200. `slots` positions go through the same clamp and anchor handling as
  element `x`/`y`; a `slots` array is always four entries (the fourth card shows only when the
  player spectates a full team, audit, **inferred**).
- Switching into Free fills `slots` from where each card currently sits, so nothing jumps.
  Switching out of Free keeps `slots` stored, so switching back restores them.
- `ChildOverride` numbers are unscaled, as in the v2 spec; the element's `scale` multiplies them.

## Fit to content

Pass order becomes `layoutPass`, `childPass`, `fitPass`, `teamPass`, `scalePass`, `stylePass`,
`fontPass` (and `buildTrees` the same minus `fontPass`). `fitPass` sees moved and added children,
`teamPass` places the fitted card, and `scalePass` multiplies everything afterwards, as values are
stored unscaled. `fitPass` touches `teammatepanel.res` and the four `TeamPlayerN` sizes; when
`fit` is off it only computes the card size the card background needs.

1. **Content box.** The union of the rects of the card's steady-state children that are visible:
   `Head`, `Health`, `Name`, `Items`, and `HealthNumber` and `Status` when present and visible.
   State children (`Incapacitated`, `Dead`, `Voice`) and decoration (`BackgroundImage`, the
   card background child below) never count. On stock this is x 13..134, y 36..72: 121 x 36.
2. **Shift.** Subtract the box's top-left from every child's `xpos`/`ypos`, state children
   included, so the content sits at the card's top-left.
3. **Card size.** Every `TeamPlayerN` gets `wide`/`tall` = the box size.
4. **Keep the content where it was.** `teamPass` adds the box's top-left to each card's
   position, so fitting alone moves nothing on screen; only empty space goes.
5. **State art** (the aspect rule, below): `Incapacitated` and `Dead` become squares of side
   `tall` (the card height) at the `Head`'s x and y 0, unless the player has sized or moved them
   (then their override wins, still square). `Voice` becomes a square of side `min(tall, 16)` at
   the card's right edge. `BackgroundImage` (the splatter) keeps its 2:1 shape, width = card
   width, clipped by the card.

Fit is recomputed on every build from the tree, so moving a child or turning on the health number
re-fits the card; the player never edits the card size directly.

## The aspect rule

Square game art stays square. A child is aspect-locked when its texture is square: `Head`,
`Incapacitated`, `Dead`, `Voice`. For a locked child the side panel shows one Size box instead of
W and H, dragging a resize handle keeps the ratio, `validateDesign` stores `w` and `h` equal
(the smaller wins if a hand-edited design disagrees), and `fitPass` sizes state art square. A
registry test asserts every locked child's base block has `wide == tall` in both presets or is
covered by the fit rule.

## Layout: Row, Column, Free

`teamLayout` and `teamPass` change from pitch to gap:

- **Row / Column.** Card `n` sits at `(n - 1) * (cardSize + gap * scale)` along the direction,
  where `cardSize` is the fitted size when `fit` is on, else the file's. The container is sized
  to four cards and three gaps, as today. The old "spacing" number disappears from the UI; the
  Gap slider (0 to 200) replaces it. When `gap` is absent it is derived from the base file, the
  base pitch minus the card extent (fitted or not), so a new design looks like its preset: stock
  Row fitted gives 140 - 121 = 19.
- **Free.** The team container in `hudlayout.res` becomes the full screen (`xpos 0`, `ypos 0`,
  `wide f0`, `tall f0`, the probe's setting) and each `TeamPlayerN` gets its slot's position,
  written with the same anchor tokens (`r`, `c`) elements use, so a card placed at the right edge
  stays at the right edge on another aspect ratio. The element's own X/Y/drag is disabled in Free
  (the side panel says "Drag each card"); each card is dragged on the canvas and has X and Y
  boxes under a "Card 1..4" list. Scale still applies to all cards.
- **Hit testing.** In Free each card is its own hit target labelled "Teammate card 1..3"; card 4
  is reachable only from the list.

## Inside editing (the teammate card)

This is the v2 spec's Plan 2 design ("The child registry", "The child pass", "The page") applied
to `teamColumn` only, with these changes:

- **Registry** for `teamColumn` (`teammatepanel.res`): `Head` (image, locked), `Health` (bar),
  `Name` (label), `HealthNumber` (label, addable on stock from the v2 template, present on
  Modern), `Items` (label, the item icon row; its size is its font's `tall`, so it offers Size,
  not W and H), `Status` (label, the status text), `BackgroundImage` (image, the splatter,
  Visible only), and `Incapacitated`, `Dead` (image, locked), `Voice` (other, locked).
- **Colour.** `HealthNumber` offers no colour control (the game ignores it); its row says "The
  game colours this by health". `Name` and `Status` offer colour.
- **Items preview.** The icon glyphs live in a Valve font, so the preview draws neutral stand-in
  icons (a medkit and a pills outline) at the font's size, and the side panel says the real icons
  are the game's.
- **Moving a child** re-fits the card (fit is on by default), so dragging the icons above a
  shorter bar reshapes the card to match. The drag clamp is the unfitted parent (150 x 150 on
  stock), not the fitted card, or nothing could grow.

## The card background

`panelBg` is re-pointed from the card block's `image` (never painted) to a child the card draws:
when `panelBg` is not stock, `fitPass` injects an `ImagePanel` named `HudEdCardBg` first in
`teammatepanel.res` (unscaled, so `scalePass` scales it with the card; `stylePass` then points its
`image` at the slot texture) (`zpos -2`, `xpos 0`, `ypos 0`, `wide`/`tall` = the card size after fit,
`scaleImage 1`, `image hud/hudeditor/panelbg`). A flat style may instead use `fillcolor` with the
raw colour (the Modern `ModBg` pattern) so no texture ships; rounded and uploaded styles use the
generated texture as today. It is visible in every state. The preview draws it through the
renderer's existing `hud/hudeditor/` branch, so what the preview shows is what the file says.
Stock `s_panel_background` stays exported but is documented as never painted.

## Healthy / Down / Dead preview

A three-way toggle next to the Survivor/Infected switch, shown when the survivor side is active:

- **Healthy** (default): as today.
- **Down**: the teammate cards draw `Incapacitated` (the character's `_incap` art, already
  exported), the bar at the incap sample (red, 299 as the number), and skip `Head`.
- **Dead**: the cards draw `Dead` (`s_panel_dead`), the name dimmed, no bar, no number.

The renderer's state-children rule becomes state-dependent: `Incapacitated` is drawn only in
Down, `Dead` only in Dead, and each state hides what the game hides in it (a best reading of the
probe screenshots; the owner corrects it after seeing it). Every state is still drawn from the
generated tree, so fitted and aspect-locked art shows exactly as the file will make the game
draw it. Own health, infected and SI panels keep the healthy state in this phase.

## Cleanups

- **Kill feed:** remove the `killFeed` element; `validateDesign` drops its overrides. The chat
  already shows kill messages.
- **`tankhealth.res`:** remove it from the SI health file list; the page's note becomes "Shown as
  the Hunter; the Tank uses the same file". Any build that wrote it wrote a file the game ignores.
- **Advanced bar slots:** remove `barGreen`, `barOrange`, `barRed`, `barWhite` from `slots.ts`
  and the renderer's bar-slot branch; `validateDesign` drops their styles. The bar keeps its
  stock art in the preview.
- **Splatter in the preview:** draw the stock teammate `BackgroundImage` at a reduced opacity
  (0.35) instead of hiding it (reverting `bba2ee6`'s hide), matching the faint look in game.
- **Hide the game's crosshair:** a checkbox near the crosshair option writes `never_draw "1"` on
  `HudCrosshair`. The copy says it hides the game's own crosshair so an image crosshair can
  replace it.

## Errors

As the v2 spec: a registry child missing from its file, a colour or size on the wrong kind, or an
unparsable base file fails the build with the file and child named; a missing texture draws a
hatched placeholder. New: a fit box that comes out empty (every steady-state child hidden) keeps
the unfitted card size and says so on the status line rather than writing a 0 x 0 card.

## Testing

- `design`: migration of `spacing` to `gap` for both presets and directions; `fit` absent stays
  off; `DEFAULT_DESIGN` fitted; `slots` clamping; aspect-locked `w == h`; dropped fields for
  removed elements and slots; unknown child panels dropped.
- `build`, fit: stock fitted card is 121 x 36 and every child shifted by (13, 36); fitting alone
  leaves every card's content at the same screen position; moving `Items` above the bar or
  turning on `HealthNumber` re-fits; state art square at the card height; empty box falls back.
- `build`, layout: Row and Column pitch = card + gap; Free writes the full-screen container and
  four anchored slot positions; switching modes round-trips `slots`.
- `build`, card background: `HudEdCardBg` injected first with the fitted size; flat uses
  `fillcolor`; the card block's `image` is never written.
- `build`, cleanups: no `tankhealth.res`, no bar slot textures, `never_draw` written only when
  checked.
- Registry: every `teamColumn` child exists in both presets (addable ones' `after` sibling
  exists); locked children are square or fit-covered.
- `render`: Down and Dead draw the state art square and fitted; Healthy draws the splatter at
  reduced opacity; `HudEdCardBg` draws at the card size; the preview-equals-file parity test
  extends to `children`, `fit` and every layout mode.
- `Hud` page: Row/Column/Free switch; Gap slider; Fit checkbox; dragging a card in Free; the
  children list and child controls for the teammate card; the state toggle; the crosshair
  checkbox.
- In game, by the owner: a fitted Column with gap 4, a Free layout, icons above a half bar with
  the health number on, and the Down and Dead states on bots, compared with the preview.
