# HUD editor: "Your items" element (design)

Date: 2026-09-25. Owner request: "can we have something that adds the default [item icons] that we can
move around and hide the normal ones?" Approved in chat: approach 1 (stretch the own panel only when the
element is on), place anywhere on screen, turning it on hides the stock item slots.

Evidence: `/home/volence/l4d/hud/probe-own-items/RESULTS.md` (2026-09-24, the Items label is filled in
your own panel) and `/home/volence/l4d/hud/probe-your-items/RESULTS.md` (2026-09-25, runs p1-p3 below).

## 1. What the player gets

- A new element **Your items** in Layers, survivor side. Off by default: a new or reset design, and every
  saved design, ships exactly what it ships today.
- Turning it on (one edit, one Undo step) shows the element and switches the stock item slots off:
  `weapons.itemSize = 0` and `weapons.itemIcons = false`. Probe p3 proved both are needed: IconSize 0 alone
  hides the slots at rest, but the pickup fly-in still draws a pile of slot art near the weapons for about
  a second after a pickup; clearing the item textures as well hides that pile. The weapon icons stay.
  Turning it off again only hides the element; the item slot settings are left as they are (the Weapons
  panel's own controls bring them back), since the player may have set them on purpose.
- Where it starts: its right end at the weapon selection's drawn right edge, its top just below the
  pistol row (from `weaponSlots` on the design as it is), so it first appears about where the stock slots
  were, as a row. Section 2's clamps apply to that spot like any other.
- The row shows YOUR medkit, pills and throwable (molotov or pipe bomb), packed with no gaps, in that order
  (the game's code, one Label filled with ToolBox glyphs). In game it is empty while you are incapacitated
  or dead, and the item in your hand is not marked.
- Controls: move (drag, arrows, X and Y), font (the game's three item icon fonts: `L4D_Icons` 16,
  `L4D_Icons_medium` 18, `L4D_Icons_large` 24; default medium, the teammate cards' font), colour
  (`fgcolor_override`; unset = the game's white), and alignment **Right** (default) or **Center**.
  Alignment is the end that stays put as items come and go.
- No background box, no per-item placement (one Label, the game fills its text).

### Why no Left alignment
The Label must start at your health bar's x (section 3). Left alignment would then put the glyphs right at
the bar's x. The only offset a Label has, `textinsetx`, is raw screen pixels, not HUD units (probe p1: 40
put the glyphs 40 px in at 1080p, not 90; p2: 400 put them 400 px in), so it would land differently at
every resolution. Right and Center are both resolution independent.

## 2. The health-bar limit

client.dll puts your health bar at the Items child's x (the revive snap, which also runs at spawn;
probe-own-items v2). So the written Label's x is always the bar's x, and the glyphs can only sit at or to
the right of it. The editor enforces it:

- The row's box (its size is a full loadout at the chosen font) can never start left of the bar's drawn x
  (`drawnBarX` of Your health, after every move, scale and fit). A drag, an arrow or a typed X that would go
  further stops at it. Center: the Label spans bar x to `2 * centre - bar x`, so the centre must also be
  at least half a row right of the bar; Right: the Label spans bar x to the row's right end.
- The Label must also end inside the screen: the right end (Right) or `2 * centre - bar x` (Center) at most
  the screen width. A position that would need more is clamped (Center falls back to the widest centre
  that fits).
- Moving or scaling Your health later moves the limit. A stored row left of the new limit is drawn and
  written at the limit, not rewritten in the design (the same "drawn where the clamp holds it" rule as the
  team column at the screen edge).
- The element's note says it in one line: "The game puts your health bar at this row's left edge, so the
  icons can only sit level with or right of your health bar."

## 3. What the download writes

**Element off:** nothing changes. The golden download tests must stay byte-identical.

**Element on**, as one new build pass after `scalePass` and before `reviveAnchorPass` (which then finds an
Items child and adds nothing):

1. `scripts/hudlayout.res` `CHudLocalPlayerDisplay`: `xpos 0`, `ypos 0`, `wide f0`, `tall f0`.
2. `resource/ui/hud/localplayerdisplay.res` `LocalPlayer`: `xpos 0`, `ypos 0`, `wide f0`, `tall f0`, and a
   fully transparent `image` (the editor's existing clear texture; the stock panel image would otherwise
   stretch over the whole screen). Modern's LocalPlayer has no image and gets the clear one too.
3. Every child of `resource/ui/hud/localplayerpanel.res` is rewritten to the same screen position it had:
   its position inside LocalPlayer plus LocalPlayer's offset plus the element's final screen position,
   written with the same anchor the element had (a right-anchored element's children as `r` positions, a
   left-anchored one's as plain numbers, a bottom one's `ypos` as `r`), so another resolution of the same
   aspect still lines up. Sizes are untouched. Probes p1 (Stock, r125/r91) and p2 (Modern, 8/r46) proved
   the card stays put through healthy, temp health, crouch, incap and revive.
4. The Items Label is added (or, on an import that has none, added the same way):
   `ControlName Label`, `fieldName Items`, `xpos` = the bar's written x, `ypos` = the row's y,
   `wide` per section 2, `tall` = the font's height, `visible 1`, `enabled 1`, `labelText ""`,
   `textAlignment east` or `center`, `font`, `fgcolor_override` when set, a `zpos` above the card's pieces.
5. If Your health itself is hidden (element visible false), the container stays shown and every other own
   piece is written `visible 0`, so the items can be shown without the health card.

Imported HUDs: when the import's own panel already has an Items child, the element is disabled in Layers
with a note ("This HUD already places your items itself") and the author's Label is kept untouched.
Otherwise the pass works on the import's files like on Stock and Modern. Anything the pass cannot resolve
(no LocalPlayer block, a Health child without a numeric xpos) disables the element with a note rather than
writing a guess.

## 4. Preview

- The row draws the game's item glyphs for a full loadout (medkit, pills, pipe bomb) in the chosen font,
  colour and alignment, inside its box, with the same renderer the teammate cards' Items use (additive
  ToolBox glyphs).
- Preview states Down and Dead draw the row empty (the game empties it); Crouched changes nothing.
- The own health card draws exactly where it does today (the preview never needs the full-screen frame).
- Hit tests and Layers pick the row like any element.

## 5. Proof

Unit tests:
- Off: download golden tests unchanged, for Stock, Modern and an import.
- On, Stock and Modern, every aspect: every own-panel piece's drawn screen box from the built files equals
  its box with the element off (the build's own tree readers, as the fit tests do).
- The written Items x equals the bar's written x; `wide` and alignment per section 2; the screen-width and
  bar-x clamps; moving Your health after placing the row.
- Turning on sets `itemSize 0` and `itemIcons false` in the same edit; Undo restores both; turning off
  leaves them.
- Import with its own Items: element disabled, file untouched.
- Your health hidden + Your items on: other pieces `visible 0`, Items shown.

In game (harness, before shipping): a download from the editor on Stock (row near the crosshair is not
reachable on Stock, so under the weapons) and on Modern (row just right of the crosshair), shots healthy,
pickup, pills used, crouched, incapped, revived, compared with the editor's preview pixel positions. Then
the owner's own test.

## Out of scope
Per-item placement, a background box, marking the item in hand, Left alignment, the infected side.
