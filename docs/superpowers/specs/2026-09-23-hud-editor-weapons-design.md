# HUD editor: editing the weapon selection

Date: 2026-09-23. Branch `worktree-hud-editor`. The owner asked for weapon editing after seeing a community
HUD that shows only the ammo numbers ("8 107 12") beside the crosshair. Ground truth: the weapon preview work
(c0f666e, `web/src/hud/weapons.ts` and its header comment, from client.dll) and the owner's in-game weapons
probe of 2026-09-23 (`/home/volence/l4d/hud/probe-weapons-2026-09-23/`):

| Lever | In game |
|---|---|
| `PrimaryWeaponsYPos`, `PrimaryWeaponBoxWide/Tall`, `PrimaryWeaponTall`, `PrimaryWeaponAmmoX`, `ReserveAmmoYPos`, `PistolBoxWide/Tall`, `RightSideIndent`, `IconSize`, `PrimaryAmmoFont`, `PistolAmmoFont` | read by the paint (dll) |
| `ReserveAmmoColor`, `InactiveItemColor` | work (probe A) |
| `MaxSlots` and the LargeBox/SmallBox/BoxGap/BoxDirection/Ammo1-2/Icon/SelectionNumber/TextYPos keys | ignored (probe A, dll) |
| `scripts/mod_textures.txt` repointing `rounded_background_glow` / `rounded_background_noborder` to a texture the addon ships | works in a normal addon (probe B): transparent boxes |
| repointing `icon_equip_*` entries to a transparent texture | works (probe B): icons hidden |
| `IconSize 0` | hides the three item slots, box and icon (probe B) |
| clip numbers' colour | fixed white in code; no key |

Probe B produced exactly the owner's reference look: "8 128 30" on one line by the crosshair, no boxes, no icons,
no item slots.

## What the player can edit (Weapons element selected)

- **Position** of the whole column: as today (drag, X/Y), plus the inset from the right (`RightSideIndent`)
  and the start height inside the panel (`PrimaryWeaponsYPos`).
- **Sizes:** primary box W/H (`PrimaryWeaponBoxWide/Tall`), pistol box W/H (`PistolBoxWide/Tall`), weapon icon
  height (`PrimaryWeaponTall`), item slot size (`IconSize`, 0 = hidden). In this phase the element keeps its
  existing handles (the panel's size); the box sizes are sliders and number boxes in the context panel, with a
  live preview.
- **Ammo numbers:** clip/reserve horizontal offset (`PrimaryWeaponAmmoX`), reserve vertical offset
  (`ReserveAmmoYPos`), clip and pistol font sizes (`PrimaryAmmoFont`, `PistolAmmoFont`: a size maps to a
  `HudEd_` copy of the base font at that tall, the same mechanism as child font sizes), reserve colour
  (`ReserveAmmoColor`), empty slot colour (`InactiveItemColor`).
- **Boxes:** style per active/inactive: Stock, Hidden (transparent), Flat colour + opacity, Rounded colour +
  opacity. Written by adding `scripts/mod_textures.txt` (base copy from the game, both presets; the Modern preset
  ships its own if its VPK has one) with `rounded_background_glow` and `rounded_background_noborder` repointed
  to generated textures under `vgui/hud/hudeditor/` (reuse textures.ts flat/rounded generators; a transparent
  1x1 or small texture for Hidden). This replaces the Advanced-only `weaponBoxActive/Inactive` slots, which
  needed a gameinfo mount; migrate their stored styles to the new setting.
- **Icons:** weapon icons on/off (primary + pistol), item icons on/off. Off repoints the relevant
  `icon_equip_*` entries in mod_textures.txt to the transparent texture. List every `icon_equip_*` weapon
  entry the paint can draw (from mod_textures.txt: all primaries, single and dual pistol, throwables, medkit,
  pills) so any held weapon is hidden, not just the sample loadout's.
- **Preset button "Ammo only":** sets boxes Hidden, all icons off, IconSize 0, and moves/sizes the column
  beside the crosshair with clip, reserve and pistol clip on one line (reuse probe B's numbers from
  `/home/volence/l4d/hud/probe-weapons-2026-09-23/build.mts`, which the owner confirmed in game), in one undo
  step.
- The context panel says plainly what cannot change: clip numbers are always white; the slot order and the gap
  between slots are fixed by the game; the pistol always sits just under the main gun.

## Preview

The existing faithful preview (weapons.ts) already reads these keys from the generated hudlayout.res, so edits
show automatically. It must also read the generated mod_textures.txt: Hidden boxes draw nothing, Flat/Rounded
boxes draw the generated style (as drawSlotStyle does), hidden icons draw nothing, IconSize 0 draws no item
slots, and the fonts at their chosen sizes.

## Data

`HudDesign.weapons?: WeaponsOverride` with optional fields for each key above (numbers in the ranges the
generator can write: sizes 0..200, offsets -200..200, font sizes 6..64, colours raw "r g b a"), `boxActive` and
`boxInactive` styles (reuse `StyleOverride` shape with a new 'hidden' kind or a dedicated union), `weaponIcons:
boolean`, `itemIcons: boolean`. Absent means stock (downloads for untouched designs unchanged; mod_textures.txt
ships only when a box style or icon setting is non-stock). validateDesign clamps; share links carry it.

## Testing

design validation and migration of the old Advanced weapon box slots; build writes each key into
hudlayout.res HudWeaponSelection (both presets, PC entries), mod_textures.txt repoints for each box style and
icon setting, generated textures present, untouched designs unchanged; the Ammo only preset produces probe B's
key values and repoints; preview draws hidden/flat/rounded boxes, hidden icons, no item slots, font sizes;
page: selecting Weapons shows the controls; the preset is one undo step. Then an owner in-game check with the
Ammo only preset (campaign on Expert: `sv_cheats 1; z_difficulty impossible; map l4d_hospital01_apartment`).
