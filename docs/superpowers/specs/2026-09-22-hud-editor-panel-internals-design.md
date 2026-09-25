# HUD editor v2: edit the insides of a panel, preview with the real art

Status: design agreed in conversation 2026-09-22, spec written the same day. Nothing built.

Scope: web app only, all of it client side, built on the v1 HUD editor
(`2026-09-21-hud-editor-design.md`, branch `worktree-hud-editor`). No server code, no
database, no plugin, no game server change. Nothing is deployed until the owner says so.

Related: `web/src/hud/` (the v1 generator, registry, preview and page), `/home/volence/l4d/hud`
(the owner's Modern HUD, whose `teammatepanel.res` already carries the health-number label
this version adds to stock), the Phase 0 results section of the v1 spec (which observed
results this design rests on).

## Why

v1 lets a player move, scale, hide and restyle whole panels. Players ask for the next level
down: show health numbers on teammates, shrink or hide the health bar, hide portraits or
names, change a label's size and colour. Every one of those is a change inside a panel's
`resource/ui` file, and Phase 0 question 1 (observed 2026-09-22) proved the game honours an
addon's copy of those files.

The v1 preview is thirteen hand-drawn stand-ins. They are honest about where a panel sits but
say nothing true about its insides, so they cannot show these edits. This version replaces
the stand-ins for the four panels that have insides with a renderer that draws what the
generator actually wrote, using the game's own art.

## Decisions taken by the owner, 2026-09-22

1. **Real art in the preview: in.** About twenty textures are exported once from the owner's
   `pak01` and shipped as site assets. The owner knows this is Valve's art on a public page
   and made the same call earlier for the overhead maps. It is shown in the preview only;
   no build ever ships a Valve texture, modified or not.
2. **Panels with editable insides: survivor and infected.** Own health, the teammate card,
   the own special-infected health card, the infected teammate card. Weapon slot insides
   are out: game code places most of them.
3. **Picking a child: both ways.** Click inside a selected panel to select the child under
   the pointer and drag it, and a list of the panel's children in the side panel, which is
   the only way to reach a hidden or tiny one.
4. **Adding a child that stock lacks: fixed toggles.** The teammate card gets a "Health
   number" checkbox that injects a known label block. No general "add element" menu.
5. **Architecture: the preview draws what the generator produced**, for the four panels.
   The seven elements without meaningful insides (chat, kill feed, use bar, crosshair
   marker, ability ring, ghost panel, tank meter) keep their v1 stand-ins.
6. Sections 2 to 5 of the design were delegated to Claude to settle; the owner reviews the
   player-facing behaviour, not the internals.

## Engine facts this design rests on

Observed 2026-09-22 unless noted:

- An addon copy of `resource/ui/hud/localplayerpanel.res` is honoured (Phase 0 Q1). The
  same mechanism carries `teammatepanel.res`, `zombieteamdisplayplayer.res` and the six
  special-infected health files, all of which v1 already rewrites for scale.
- `%HealthNumber%` is the only dialog variable HUD panels receive (v1 spec), and a `Label`
  bound to it inside `teammatepanel.res` shows each teammate's health: the owner's Modern
  HUD does exactly this and sample b showed it in game.
- Raw colours work as `fgcolor_override "r g b a"` (v1 spec). Named scheme colours do not.
- The game reads VTF 7.2. The Phase 0 tool wrote 7.5 and every texture failed; the editor's
  own encoder writes 7.2 and its textures drew. Nothing in this version writes a texture
  any other way, and the art export reads pak01's textures (7.4, DXT) with the Python tools
  only to produce PNGs for the browser.
- Children are positioned in plain units inside their parent (no `r`/`c` anchors in the
  stock files), and the parent clips them.
- Which portrait a `Head` shows, and whether `Incapacitated`, `Dead` and `Voice` show at
  all, is decided by game code at runtime. The `.res` only says where they would go.

## Architecture

New or changed units, all under `web/src/hud/` and the one route file:

| Unit | Job | Depends on |
|---|---|---|
| `hud/children.ts` | The child registry: for each of the four panels, its file, its editable children, which are labels, which are addable, and the template block for each addable one. Data only. | `elements` |
| `hud/design.ts` | `ChildOverride`, the `children` map on `HudDesign`, validation and clamping through the one `RANGES` table. | as v1 |
| `hud/build.ts` | `childPass` between `layoutPass` and `scalePass`; `buildTrees(design)` exposing the generator's parsed files to the preview, memoised per design object. | as v1, `children` |
| `hud/art/` | Exported PNGs plus `index.json` mapping lower-case material names to files. Produced by `scripts/export-hud-art.py`, committed. | nothing |
| `hud/render.ts` | Draws one panel by walking its generated tree: images from `art/`, labels in the panel's font, bars from the bar art. Replaces four of the thirteen painters. Also `childRects(design, panelId)` for hit testing, from the same tree. | `build`, `children`, `art` |
| `hud/mock.ts` | Keeps the seven stand-in painters; delegates the four panels to `render.ts`; `hitTest` gains a child level. | `render` |
| `routes/Hud.tsx` | Two-level selection, child dragging, the children list and toggles, child controls. | all of the above |

`crosshair/`, `vpk/`, `kv.ts`, `units.ts`, `elements.ts`, `slots.ts`, `textures.ts` are
unchanged.

### The data model

`HudDesign` stays at `v: 1` and gains one sparse map next to `elements`:

```ts
children: Record<string, Record<string, ChildOverride>>;   // panelId -> childName -> override

interface ChildOverride {
  visible?: boolean;
  x?: number; y?: number;      // units inside the panel, at parent scale 1
  w?: number; h?: number;
  fontSize?: number;           // labels only: tall of a HudEd_ copy of the label's font
  color?: string;              // labels only: raw "r g b a", written as fgcolor_override
  on?: boolean;                // addable children only: present in the file or not
}
```

- `panelId` is one of `ownHealth`, `teamColumn` (its card file), `siHealth` (its six files,
  see below), `infectedRow` (its card file). `childName` is the block name in the real file
  (`Health`, `Head`, `Name`, `HealthNumber`, ...), pinned to the file by test exactly as v1
  pins element keys.
- Positions are stored unscaled. The parent's existing `scale` multiplies them afterwards,
  so scaling a panel keeps edited insides in proportion, and a child's X and Y boxes show
  the unscaled number.
- `siHealth` spans six files (one per special infected), and they are the same four children
  (`BackgroundImage`, `Health`, `HealthNumber`, `DuckingIcon`) at six different placements
  and sizes: the Boomer's bar is 64 wide at x 322, the Tank's 278 wide at x 112. An absolute
  position or size would be right for one infected and wrong for five. So `siHealth` child
  `x` and `y` are stored as **absolute positions on the Hunter's card**, which is the card the
  preview draws and the X and Y boxes show, exactly like every other panel. `childPass`
  writes them to `hunterhealth.res` as they are and to the other five files as the same
  **delta** from each file's own base (`stored - hunterBase + thisFileBase`), so a number
  nudged 10 units right moves 10 units right on every infected. `w` and `h` are not offered
  on `siHealth` (six different bar widths make an absolute size wrong for five of them);
  `validateDesign` drops them for that panel by an explicit per-panel rule, not through
  `RANGES`. `visible`, `color` and `fontSize` apply as they are, so "hide the ducking icon"
  hides it for every infected. The page says "Shown as the Hunter; applies to all infected".
- Toggles are children: `HealthNumber` on `teamColumn` is a registry entry flagged
  `addable`, its template taken from the Modern card. `on: true` injects it and it then
  accepts every other override like any child. Absent means "as the base file has it": on
  Modern, where the block already exists, the same entry reads as present and can be hidden
  or moved.
- `validateDesign` treats `children` exactly as `elements`: unknown panel or child names
  dropped, numbers clamped through `RANGES` (child `x`, `y` in -64..512, `w`, `h` in 1..512,
  `fontSize` in the existing 6..64), colours through the existing four-byte check. Share
  links carry it. The one `clampOverride` helper gains the child keys so the page's number
  boxes and the file can never disagree.
- The three reserved fields on `ElementOverride` stay reserved. Child styling lives on
  `ChildOverride`, where it has a consumer.

### The child registry

```ts
interface ChildDef {
  name: string;                 // block name in the file
  label: string;                // "Health bar"
  kind: 'image' | 'label' | 'bar' | 'other';
  addable?: { template: KvNode; after: string };   // inject after this sibling when turned on
}
interface PanelChildren { panelId: string; files: string[]; children: ChildDef[] }
export const PANELS: PanelChildren[];
```

First version, per panel (names are the real block names):

- **ownHealth** (`localplayerpanel.res`): `Head` (portrait, image), `Health` (bar),
  `HealthNumber` (label, font `HUDHealth`, which the scheme defines as an unquoted key, so
  the registry test must look it up through `kvFind`, not a quoted grep), `HealthIcon`
  (label, the cross glyph), `DuckingIcon` (image). `Incapacitated` is listed as `other`: it
  can be hidden or moved but is not drawn, since the preview shows the healthy state. The
  two scratch textures (`HealthbarTextureTop`, `HealthbarTextureBottom`) are not listed:
  nobody asked to move decoration, and they ship untouched.
- **teamColumn** (`teammatepanel.res`): `BackgroundImage` (image), `Head` (image),
  `Health` (bar), `Name` (label), `HealthNumber` (label, addable on stock; present on
  Modern). `Incapacitated`, `Dead`, `Voice` as `other`. `Status` and `Items` are not
  listed: the preview would draw them empty, so moving them would be blind.
- **siHealth** (`boomerhealth`, `hunterhealth`, `smokerhealth`, `tankhealth`,
  `zombiehealthleft_large`, `zombiehealthleft_small`): `BackgroundImage` (image, the
  `pz_healthbar_50/250/3000` frames), `Health` (bar), `HealthNumber` (label, font
  `MenuTitle`), `DuckingIcon` (image). All six files carry exactly these four, verified
  2026-09-22, and the registry test pins that they keep doing so.
- **infectedRow** (`zombieteamdisplayplayer.res`): `BackgroundImage` (image), `PlayerImage`
  (image), `HealthPanel` (bar), `NameLabel` (label), `SpawnTimeLabel` (label, drawn with the
  sample text `12`), and `AbilityProgress`, `Dead`, `Voice`, `SkullIconPlacement` as `other`
  (hide or move; not drawn).

The `HealthNumber` template is the Modern card's block, re-positioned to sit right of the
stock card's `Name` (which is at `xpos 13`, `ypos 60`, `wide 120`) and with its colour written
raw, because a named scheme colour silently draws nothing in some panels (v1 engine facts).
This is the exact block, inserted after `Name`:

```
"HealthNumber"
{
    "ControlName"        "Label"
    "fieldName"          "HealthNumber"
    "xpos"               "103"
    "ypos"               "60"
    "wide"               "30"
    "tall"               "12"
    "visible"            "1"
    "enabled"            "1"
    "labelText"          "%HealthNumber%"
    "textAlignment"      "east"
    "font"               "PlayerDisplayName"
    "zpos"               "3"
    "fgcolor_override"   "255 255 255 255"
}
``` A registry test parses
every panel file in both presets and asserts each non-addable child exists, each addable
child's `after` sibling exists, and every label child has a `font`.

### The child pass

`childPass` runs after `layoutPass` and before `scalePass`, so `scalePass` multiplies the
edited values, matching the stored-unscaled rule.

For each panel with entries in `design.children`, for each of that panel's files (opened
through `Work`, so a file ships only if touched), for each override:

- `on: true` on an addable child whose block is absent: clone the template and insert it
  after its `after` sibling. `on: false`: remove the block if present. Then continue with
  the other fields as for any child.
- `visible`, `x`, `y`, `w`, `h`: `kvSet` the corresponding keys as plain numbers. Children
  never carry anchor letters. On `siHealth`, `x` and `y` are written to `hunterhealth.res` as
  stored and to the other five files as the delta rule above; `w`, `h` never reach the pass
  because validation drops them for that panel.
- `color` on a label: `kvSet('fgcolor_override', colour)`.
- `fontSize` on a label: reuse `scalePass`'s font mechanism rather than a second one. A
  `HudEd_<font>_t<tall>` copy of the label's scheme font with `tall` set to the size, the
  label pointed at it, the same rename-only-if-the-scheme-defines-it rule and the same
  de-duplication map, hoisted so `childPass` and `scalePass` share it. The `t` in the tag is
  load bearing: `scalePass` tags its copies `_<percent>`, and without it a size-60 label and a
  0.60-scaled parent on the same font would collide on one key with two meanings. If the
  parent is also scaled, `scalePass` then collects the `HudEd_..._t14` leaf like any other
  font and clones it again as `HudEd_HudEd_<font>_t14_150`; the plan writer should expect
  that name, and a test pins that the final `tall` is `round(14 * 1.5)`.
- A `color` or `fontSize` on a non-label child, an unknown child name, or a missing block
  (other than an addable one being turned on) fails the build with the file and child named,
  through the existing error path. Nothing is half written.

Because one file drives all three teammate cards, editing "the teammate card" edits all
three, as the game does. The same holds for the infected card and the six SI files.

Pass order, for the `buildHud` comment and a test each: `childPass` before `scalePass`
(unscaled values written first, then multiplied); `childPass` and `fontPass` order
independent (shared memoised scheme, the same argument already recorded for `scalePass`).

### The art export and the renderer

**Export.** `scripts/export-hud-art.py`, run by hand in `/home/volence/l4d/hud/.venv`, reads
the owner's `pak01_dir.vpk`, decodes each listed texture with `srctools` and writes
`web/src/hud/art/<lower-case-material-name-with-slashes-as-dashes>.png` plus
`web/src/hud/art/index.json` mapping the material name (as `.res` files write it, lower
case, no extension, `../vgui/` prefixes resolved) to the file. Output is committed. The
list is every `image` value used by a registry child in either preset, every `stockNames`
entry in `slots.ts`, the four survivor portrait panels (`vgui/s_panel_biker`, `_manager`,
`_namvet`, `_teenangst`), `vgui/s_panel_background`, the four `vgui/hud/healthbar_bg_*`,
`vgui/hud/infected_healthbar_bg_1`, and the five `vgui/healthbar_*` fills. The script
refuses to run if the total exceeds 1 MB, so a mistake in the list cannot bloat the page.
The route is already lazy, so the art joins the HUD chunk's assets and costs nothing on
other pages.

The boundary is enforced, not just stated: a test asserts that nothing under `web/src/hud/`
other than `render.ts` imports from `hud/art/`, and a build test asserts that no file
`buildHud` emits under `materials/` has a name in `art/index.json` except the advanced-mode
`stockNames` (whose bytes are the editor's own generated textures, never the exported PNGs).
Two facts for the owner, stated here so nobody discovers them later: the pug repository is
public on GitHub, so committing the PNGs publishes Valve's HUD art in the repo as well as on
the page; and the export list is the only place a new texture can enter, by hand.

**Fonts.** Preview text uses Roboto Condensed for both presets: it is the Modern preset's
real font, it is already shipped, and it is a close enough stand-in for Trade Gothic, which
is licensed and cannot ship. Label size comes from the label's scheme font `tall` (after
any `HudEd_` copy), so a font size edit shows at the right size.

**Renderer** (`render.ts`). `drawPanel(ctx, panelId, design, parentRect, k)`:

1. Reads the panel's generated tree from `buildTrees(design)`, which runs `layoutPass`,
   `childPass`, `teamPass`, `scalePass` and `stylePass` on a `Work` and returns its parsed
   files, memoised in a `WeakMap` on the design object (designs are replaced, not mutated,
   on every change, so one build per edit and none per frame). It skips `fontPass`: that pass
   only renames faces and demands the ttf bytes, and the preview draws every label in Roboto
   Condensed regardless. `buildHud` is unchanged and still runs all six.
2. Walks the root's children in file order, later over earlier, honouring a `zpos` key where
   present, skipping `visible 0` and the children whose visibility game code decides
   (`Incapacitated`, `Dead`, `Voice`, `SkullIconPlacement`, and `DuckingIcon`, which shows
   only while crouching): the healthy, standing, alive state. Those children keep their
   registry entries, so they can still be hidden or moved.
3. Draws by kind. `image` with an `image` key: the art index texture; or, when the key
   points at `hud/hudeditor/<slot>` because `stylePass` repointed it, the slot's generated
   texture, which the renderer produces itself from `design.styles` with `textures.ts`'s
   `flatTexture` or `roundedTexture` (or the stored upload) into an offscreen canvas, cached
   per slot and style, so a flat or rounded panel background shows in place of the stock
   one. Stretched to the rect when `scaleImage` is set, else drawn at texture size clipped
   to the rect. `Head` and `PlayerImage`, whose
   texture game code chooses: a fixed portrait per card (Bill, Francis, Louis, Zoey for the
   survivor cards; the SI's own head is a plain silhouette). `label`: `labelText`, with
   `%HealthNumber%` shown as `100`, empty `Name` and `NameLabel` shown as the card's sample
   name, `Status` and `Items` left empty, `HealthIcon` drawn as a plus sign in the text
   colour since its glyph lives in a Valve icon font; size from the scheme font's `tall`,
   colour from `fgcolor_override` else white, alignment from `textAlignment` where present.
   `bar`: the bar background art if the panel has one as a sibling, then `healthbar_green`
   stretched to the full rect (100 health).
4. A material the index lacks draws a hatched grey placeholder and logs once. The preview
   never fails; only the build does.

`childRects(design, panelId, parentRect, k)` returns each drawable child's pixel rect from the
same tree, for hit testing and outlines, so the preview, the hit test and the file are the
same numbers.

`mock.ts` keeps the seven stand-in painters and, for the four panels, calls `drawPanel`
inside the existing `clipToRect`. The team painters call it once per card at each card's
rect, so all three cards draw from the one card file.

### The page

- **Selection has two levels.** Clicking a panel selects it as in v1. Clicking inside a
  selected panel selects the smallest drawable child under the pointer, outlines it in the
  accent colour, and dragging moves it inside the panel: the new unscaled position is the
  pixel delta divided by `k` and by the parent's scale, snapped to the parent's edges and
  centre with the existing `snap`, and clamped so the child stays inside the parent. Escape
  steps up one level; a click on empty canvas deselects both.
- **The side panel** for a selected panel keeps its v1 controls and gains a **Children**
  list: one pill per registry child, struck through when hidden, greyed when addable and
  off. Addable children show as a checkbox ("Health number") rather than a pill until on.
  Selecting a pill selects the child. The list is the only way to reach a hidden or tiny
  child, as the element list is for elements.
- **A selected child's controls:** Visible; X and Y; W and H; for labels, Size (6 to 64) and
  Colour (the existing colour plus opacity control writing raw `r g b a`); "Reset this
  child". `other` children show Visible, X, Y and a note that the game decides when this
  one appears. Arrow keys nudge the selected child by 1, Shift by 10, through the same
  clamp as dragging.
- **The element list** below the canvas is unchanged. Copy near the download gains one
  sentence: "Edits inside a card apply to every teammate's card."
- **Preset switch** with child edits present asks the same Keep or Reset question v1 asks
  for moves, with the copy widened to "moves and inside edits". Keep then drops any child
  override whose child the new preset's file does not have (the registry records which
  presets carry each child), so the build can never be asked to edit a block that is not
  there; a missing block at build time is therefore a real bug and fails loudly.
- **"Reset this element"** on a panel clears its child overrides as well as its own; a child
  has its own "Reset this child".
- **Three cards, one file.** Clicking inside any teammate card selects the child in the card
  file; the outline is drawn on that child in all three cards, and dragging in any card moves
  it in all three, because the game has one card file. The same holds for the infected row.

### Errors

- Registry key missing from its file, a colour or size on a non-label child, or a base file
  that fails to parse: the build fails with file and child named on the status line, as v1.
- A texture missing from the art index: hatched placeholder in the preview, logged once,
  never a build failure.
- Child dragging is clamped inside the card the preview draws (for `siHealth`, the Hunter's).
  The other five infected files receive the same delta unclamped; the game clips a child to
  its parent, so the worst case is a partly hidden number on one infected, which the page's
  "shown as the Hunter" note already warns about.
- Everything else as v1: validated designs, guarded storage, damaged links reported.

### Testing

Unit tests (vitest, web project), alongside the v1 suites:

- `children`: every non-addable child exists in its file(s) in both presets; every addable
  template's `after` sibling exists; every label child has a font the scheme defines; the
  union of `siHealth` children across the six files is what the registry lists.
- `design`: `children` validated, clamped and stripped of unknown names; `clampOverride`
  covers the child keys; share link round trip carries `children`.
- `build`, `childPass`: writes only the overridden keys; `on` injects after the right
  sibling and removes cleanly; `fontSize` produces a `HudEd_` copy shared with `scalePass`;
  a scaled parent multiplies the edited child values; a colour on a non-label fails with
  the child named; pass order tests for the two rules above.
- `build`, `buildTrees`: memoised per design object; the panel files it returns parse back
  to the same bytes `buildHud` writes.
- `render`: `childRects` equals the rects read from `buildHud`'s written bytes across a
  matrix of `x`, `y`, `w`, `h`, `visible`, `on` and parent `scale`, in both presets. That is
  the preview-versus-file guarantee for insides, pinned the same way v1 pins it for
  containers.
- `art`: every material the registry and the slots need is in `index.json` and its file
  exists; total size under the cap; no module under `hud/` except `render.ts` imports from
  `art/`; `buildHud` never emits a file whose bytes came from `art/`. The tests read the
  committed index, never pak01.
- `build`, fonts: a `fontSize` on a scaled parent yields `HudEd_HudEd_<font>_t<n>_<pct>` with
  `tall` equal to `round(n * scale)`; a size-60 label and a 0.60-scaled parent on the same
  font produce two distinct entries.
- `mock`: `hitTest` prefers a child inside a selected panel and returns the panel otherwise.
- `Hud`: selecting a panel shows its children list; toggling "Health number" on the stock
  teammate card writes `on: true`; selecting a child shows its controls; a child's X box
  snaps to its cap.
- The existing `scripts/check-hud-vpk.sh` sample gains a child edit and a toggle.

In game, by the owner: a stock teammate card with the health number on and the bar hidden,
and a scaled own-health panel with a moved number, screenshotted with the HUD listed above
any crosshair addon in `addonlist.txt`.

## Delivery: two plans

This spec is one design delivered as two implementation plans, because the first is a
complete upgrade on its own and the second is blind without it:

1. **The honest preview.** The art export and index, `buildTrees`, `render.ts` with
   `childRects`, the four panels delegated from `mock.ts`, and the preview-equals-file test
   for insides. No change to `HudDesign`, no new controls: v1 users just see the real art
   laid out by the real files, in both presets.
2. **Editing the insides.** `children.ts`, `ChildOverride` and validation, `childPass`, the
   two-level selection, the children list, toggles and child controls.

## Not in this version

Weapon slot insides. Drawing the incapacitated, dead or black-and-white states. A general
"add element" menu. Shipping any Valve texture in a build. Editing the scoreboard or the
versus score panel. Per-teammate different cards (the game has one card file). L4D2.
