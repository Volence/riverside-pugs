# HUD Editor: Custom Damage Splatter, Design

Date: 2026-09-24. Branch `worktree-hud-editor`. Status: written overnight for the owner's review;
the plan is `docs/superpowers/plans/2026-09-24-hud-editor-custom-splatter.md`.

## What the owner asked

2026-09-24, first on the owner's NEXT UP list, in their words this "should be on here": players ship
their own splatter art. Splatter means two things in the stock HUD:

1. The teammate card's splatter: the `BackgroundImage` ImagePanel in `teammatepanel.res`, the black
   `hud/healthbar_bg_N` art behind each teammate card.
2. The own-health panel's scratches: `HealthbarTextureTop` and `HealthbarTextureBottom` in
   `localplayerpanel.res`, the `detail_scratches_top_1` / `bottom_1` art around your own health bar.

A player picks, per splatter: the stock art, none, a built-in style, or their own image. The preview
draws exactly the pixels the download ships, the way the game draws them.

## What the game does (found 2026-09-24, from pak01 and client.dll)

These facts decide the whole design. The disassembly was done on the owner's
`left4dead/bin/client.dll` (PE, image base 0x10000000, so a file offset plus 0x10000000 is the
address below) with capstone.

### The teammate splatter is one texture per card slot, chosen by code

- client.dll holds a four-entry string table at 0x10519fe8: `hud/healthbar_bg_1` .. `_4`.
- The team display creates `TeamPlayer1..4` in a loop (0x1023e2f0..0x1023e351) and calls a setter on
  each new card with the loop index 0..3 (`call 0x1023ecd0` at 0x1023e343). The setter stores the
  index mod 4 and calls `SetImage(table[index])` on the card's BackgroundImage child.
- The card's own settings code (0x1023efc1..0x1023f002) does the same again after the card finds
  its `BackgroundImage` child, so the `image` key in `teammatepanel.res` never wins.
- So card N always draws `vgui/hud/healthbar_bg_N`. **The audit doc's "swapped by damage" is wrong**:
  it is by slot, never by damage. The four textures are four different black splatter shapes.
- Per update, code calls `SetVisible(a && !b)` on that child (0x1023f700..0x1023f72b), where `a` and `b`
  are two card flags, most likely "alive" and "incapacitated" (inferred, not proven). That is the
  "game code shows the splatter even at visible 0" trap already met in game.
- Nothing in client.dll sets the splatter's draw colour: the only four uses of that child's pointer
  are the creation store, the two SetImage calls and the SetVisible. So its colour is the .res
  `drawColor` (white by default) and nothing else.

### The own-health scratches are named by the .res file and tinted by code

- `detail_scratches` appears nowhere in client.dll. Their names come only from the `image` keys in
  `localplayerpanel.res` (`../vgui/hud/detail_scratches_top_1`, `_bottom_1`), so a .res edit can point
  them at other art.
- Code finds both by name (`HealthbarTextureTop` at 0x1023f18f, `HealthbarTextureBottom` at 0x1023f1ba)
  and, per update, passes the health colour into a virtual call on each (0x1023f7d9..0x1023f809).
  That matches what was already proven by eye: they draw green above 50 health, orange above 15,
  red below and when down (`render.ts`'s `healthRgb`).

### The stock files (pak01)

| Material | Size | Format | Flags | Art |
| --- | --- | --- | --- | --- |
| `vgui/hud/healthbar_bg_1..4` | 512 x 256 | DXT5, 10 mips | 0x2300 (NOMIP, NOLOD, EIGHTBITALPHA) | pure black, alpha up to 172 |
| `vgui/hud/detail_scratches_top_1` | 256 x 64 | DXT5, 9 mips | 0x2300 | pure white, alpha up to 255 |
| `vgui/hud/detail_scratches_bottom_1` | 256 x 64 | DXT5, 9 mips | 0x2300 | pure white, alpha up to 255 |

Every one of their `.vmt` files is the same UnlitGeneric: `$translucent 1`, `$alpha 1`,
`$vertexalpha 1`, `$vertexcolor 1`, `$ignorez 1`, `$no_fullbright 1`. `$vertexcolor 1` is what makes the
panel's draw colour multiply the texture: that is how code tints the white scratches, and it would
tint a coloured upload the same way.

### What an addon can and cannot do

- The first design spec's engine fact: an `addons/` VPK mounts after pak01 and **can never replace a
  file inside pak01**. The splatter textures ship in pak01. So "write a VTF at the splatter's material
  path" does nothing from a normal download; it only works from Advanced mode's gameinfo mount.
- `materials/vgui/` is on the server file-consistency generator's NEVER_FORCE list (owner's ruling
  2026-09-19), so custom HUD textures can never get a player kicked. Checked: the live list holds no
  `vgui` path.

## The design

### Three splatters, one registry

A new leaf module `web/src/hud/splatter.ts` lists the three, the way `slots.ts` lists style slots:

| id | Label | File, block | Texture | Route | Tinted by health |
| --- | --- | --- | --- | --- | --- |
| `splatTeam` | Teammate card splatter | `teammatepanel.res`, `BackgroundImage` | 512 x 256 | stand-in child | no |
| `splatTop` | Your health: top scratches | `localplayerpanel.res`, `HealthbarTextureTop` | 256 x 64 | repoint the image key | yes |
| `splatBottom` | Your health: bottom scratches | `localplayerpanel.res`, `HealthbarTextureBottom` | 256 x 64 | repoint the image key | yes |

Texture sizes are the stock ones, both powers of two. Each custom texture ships as
`materials/vgui/hud/hudeditor/<id lower case>.vtf` plus a `.vmt`, new names an addon can add.

### Kinds

Each splatter has a kind:

- **Stock** (shown as **As imported** on an imported HUD): nothing written, the preset's own art.
- **None**: the splatter is gone. For the teammate splatter this is the existing hide of the
  `BackgroundImage` child (size 0 and drawColor alpha 0, proven in game 2026-09-23), so there is one
  hidden flag, the one Layers and Delete already use. For the scratches it is the same hard hide on
  their block (size 0 is what holds, since code resets their colour every update).
- **Fade**: a built-in style, generated in code: one colour (with its alpha) at full strength on the
  left, fading linearly to clear on the right, constant top to bottom. A clean bar-style backdrop, a
  few lines of pixel code, no upload. Its colour lives in the design, so it survives a share link.
- **Image**: the player's own picture, stretched to the texture size (the game stretches the texture
  over the panel anyway: all three blocks are `scaleImage 1`). The PNG's alpha is kept.

### Teammate splatter: a stand-in child

Because code names the texture and an addon cannot replace it, a custom teammate splatter cannot go
through `BackgroundImage` at all. Instead a new pass writes a stand-in ImagePanel, `HudEdSplatter`,
into the card file right after `BackgroundImage`, copying its final rect and zpos (after the player's
moves, the fit rule and the hide pass) and pointing at `hud/hudeditor/splatteam`. The stock
`BackgroundImage` keeps its rect, so the player still selects, drags and resizes the splatter on the
canvas as today, but its drawColor alpha is written as 0, so the game draws nothing there. The
player's own opacity for the splatter (its drawColor) moves onto the stand-in.

This is the `HudEdCardBg` pattern the card background already uses: an injected child the game
draws, not registered as an editable piece, so canvas clicks and Layers never see it; the registered
`BackgroundImage` is the handle.

Consequences, stated in the UI and checked in game:

- **One art for all four cards.** `teammatepanel.res` is one file for every card, so per-card art is
  impossible from an addon. (Per-card art would mean overwriting `healthbar_bg_1..4` from Advanced
  mode; left out, see the decisions.)
- **It shows in every state.** Code toggles the stock child's visibility; the stand-in is not code's,
  so it also shows while the teammate is down or dead, under the down and dead art. The preview's
  Down and Dead states draw it too.
- **No faint fudge.** The preview draws the stock splatter at `SPLATTER_ALPHA` (0.35) because that is
  what the owner saw in game. That factor is scoped to images named `healthbar_bg_N`, and the stand-in
  is not code-managed, so a custom splatter draws at the strength its pixels and drawColor say. The
  in-game check confirms this.

### Scratches: repoint the image key

The scratches' names live in the .res file, so the build points each block's `image` at
`hud/hudeditor/splattop` or `splatbottom` and ships the texture. Code keeps tinting them by health:

- **Colour by health** (default on, the stock behaviour): the `.vmt` keeps `$vertexcolor 1`, and the
  preview multiplies the art by the health colour exactly as it already does for the stock scratches
  (`drawTexture`'s tint). A coloured upload comes out multiplied, so the row says to use light or
  white art for this.
- **Keep my colours** (off by default): the `.vmt` is written without `$vertexcolor 1` (keeping
  `$vertexalpha 1`), so the engine should ignore the draw colour's RGB and show the art as uploaded.
  The preview then skips the RGB tint. **Unproven in game**; the in-game check decides it, and if it
  fails the option is removed rather than shipped.
- The row draws a small **tint strip** under the control: the chosen art three times, multiplied by
  the green, orange and red the game uses, so the player sees what hurt and critical look like
  without a new preview state.
- Opacity for the scratches is baked into the pixels (Fade's colour alpha, the PNG's alpha), never a
  drawColor, because code overwrites their draw colour every update.
- Where the preset hides the scratches (Modern ships both at `visible 0` with no rect) or an imported
  HUD lacks the block, the row is disabled and says why. Own-health insides editing is Phase 2.

### Textures and materials

- Encoded with the existing `encodeVTF` (VTF 7.2, BGRA8888, one mip, CLAMPS, CLAMPT, NOMIP, NOLOD,
  EIGHTBITALPHA): the same writer as the crosshair and the weapon boxes, both proven in game. Not
  DXT5: lossless keeps preview equal to file, and the stock textures are NOMIP too, so no mip chain is
  lost. 512 x 256 x 4 is 512 KiB, fine in a VPK.
- `.vmt` from the existing `vmtFor`, which gains an option to leave out `$vertexcolor 1`. Its default
  output is unchanged, so every existing download stays byte-identical (the golden test).

### Preview equals file

- The canvas already draws from `buildTrees`, so the stand-in, the hidden stock child and the
  repointed scratch blocks are drawn from the same tree the download has.
- `render.ts` learns to draw `vgui/hud/hudeditor/splat*` materials: Fade from the same
  `fadeTexture` pixels the build encodes (put into a scratch canvas), Image from the stored PNG, which
  is already at the texture size and is the source `assetsFor` redraws into the VTF. Both go through
  the existing `drawTexture`, so drawColor, the health tint and stretching behave as for stock art.
- An image kind whose picture is missing (a share link, which never carries images) is treated as
  Stock by both the build and the preview, as style slots already are.

### Storage, share link, undo

- Uploads are stored like the other style images: a PNG (base64) in `design.images`, keyed by the
  splatter id, at the texture size, inside the design JSON in localStorage. Not IndexedDB: that store
  exists for 50 MB imported HUDs, while a splatter is at most a few hundred KB, and keeping it in the
  design means undo/redo, Export and the "Reset" paths work with no new plumbing. The caps are the
  existing `MAX_IMAGE_B64`. The three splatters plus a card background upload fit well inside
  localStorage, but `saveDesign` swallows a quota error today; it now reports one, and the page says
  the design is too big to keep.
- **Share link:** images are stripped from links today and the status line says so. A splatter's kind
  and Fade colour travel; an Image splatter opens as Stock on the other browser until the image is
  uploaded there (or the design is sent with Export).
- **Undo/redo:** every change, an upload included, is one `edit()` step through the existing history.
- **Reset to stock** per splatter: drops its style and its stored image (undo brings both back), and
  for the teammate splatter also un-hides the child.

### Imported HUDs (the third preset)

- Stock is labelled **As imported**: the HUD's own `BackgroundImage` / scratch blocks, and whatever
  textures it ships, are left alone.
- A custom kind on an imported HUD works the same way: the stand-in or the repointed key is written
  into the imported HUD's own file, and our texture ships beside its files. An upload file at the same
  path would be reported as replaced by the existing download note (none will normally exist, the
  names are the editor's own).
- If the imported card file has no `BackgroundImage` block, or the local panel no scratch block, that
  row is disabled with the reason.
- Pre-existing, noted and not changed here: the preview draws an imported HUD's own texture even for a
  name that exists in pak01 (for example its own `healthbar_bg_1.vtf`), which a normal addon cannot
  override in game.

### UI

- A **Splatter** panel under Styles with three rows. Each row: the kind select (Stock or As imported,
  None, Fade, Image), a colour and opacity for Fade, **Choose image** for Image (with the texture's
  shape as a hint: "Stretched to 2:1" or "Stretched to 4:1"), **Colour by health** for the scratches,
  the tint strip for the scratches, **Reset to stock**, and an error line.
- The context panel for the selected teammate splatter shows the same row, and its note changes from
  "The splatter art is black, so it fades but does not change colour" to one that points at the row.
- Everything is disabled while the design is locked (the missing-import banner), like Styles.

## Decided overnight, for owner review

The owner was asleep; these calls were made so the build could go ahead. Each can be reversed.

1. **Addon route, not a texture at the stock path.** An addon cannot replace pak01's
   `healthbar_bg_N`, and code overrides the .res image key, so the teammate splatter is a stand-in
   child with a new texture name, in normal and Advanced mode alike. One route, one in-game check.
2. **One teammate splatter for all four cards.** The card file is shared, so per-card art is
   impossible from an addon. Per-card art through Advanced mode's pak01 names is not offered now.
3. **A custom teammate splatter also shows while down or dead** (the stand-in is not code-managed).
   Accepted rather than worked around.
4. **Scratches stay tinted by health by default**, with an unproven "Keep my colours" option that
   drops `$vertexcolor` from the material. The in-game check keeps or removes it.
5. **Built-in styles:** Stock, None and one generated Fade (colour at the left fading to clear at the
   right). No generated splatter shapes: they would be guesses at taste.
6. **Uncompressed BGRA8888, stock sizes (512 x 256, 256 x 64), no mips**, via the existing encoder.
7. **Uploads are stretched to the texture**, not letterboxed, because the panel stretches the texture
   anyway; the row shows the aspect to aim for.
8. **Stored in the design (localStorage), not IndexedDB**, with a new visible warning when the design
   no longer fits.
9. **Share links carry kinds and Fade colours, not images**, as for every other upload today.
10. **The teammate row's None is the existing child hide**, so there is one hidden flag.
11. **Infected card background** (`infected_healthbar_bg_1`, named by the .res, drawColor 64 64 64) is
    left for Phase 2 with the other infected panels.
12. **The audit doc is corrected** in passing: the teammate splatter is chosen by slot, not damage.

## Verified only in game

The final plan task checks, with the unattended harness (`/home/volence/l4d/hud/ingame-harness/`,
scenario `survivor-hurt`), a download built by the page with a coloured Image splatter for the
teammates, a coloured Image top scratch with Colour by health on and a Fade bottom scratch with Keep
my colours on:

1. The stand-in draws, at the card's rect, at full strength (no faint factor), and the stock black
   splatter is gone.
2. The top scratch is the upload multiplied by the health colour matching the scenario's health.
3. The bottom scratch shows its own colour (Keep my colours works), or the option is removed.
4. Nothing shows the magenta missing-texture checker.

## Out of scope

Per-card art, the infected card's background, generated splatter shapes, own-health insides editing
(Phase 2), and the preview/pak01 shadowing issue for imported HUDs noted above.
