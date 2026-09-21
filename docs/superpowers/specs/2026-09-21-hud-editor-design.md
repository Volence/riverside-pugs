# HUD editor: design a Left 4 Dead HUD on the site, download it as a VPK

Status: design approved in conversation 2026-09-21, spec written the same day. Nothing built.

Scope: web app only, all of it client side. No server code, no database, no plugin, no game
server change. Work happens on the `worktree-hud-editor` worktree and nothing is deployed
until the owner says so.

Related: `web/src/crosshair/` (the crosshair maker, whose VTF and VPK writers this reuses),
`/home/volence/l4d/hud` (the owner's Modern HUD addon: `src/` is the restyled tree, `stock/`
the pristine originals, `tools/gen_textures.py` the texture generator this ports),
`2026-09-19-file-consistency-phase2-design.md` (the owner's ruling that custom HUDs and
crosshairs are allowed customisation and never part of the forced file list).

## Why

The crosshair maker proved that a browser page can hand a player a working addon VPK.
Players ask for the same thing for the whole HUD: move panels, resize them, hide them,
change fonts, colours and panel art, then download one file. Today that means hand-editing
`.res` files in 640x480 units and restarting the game to see each change.

## Decisions taken by the owner, 2026-09-21

1. **Install model:** a drop-in `addons/` VPK is the default. An "Advanced mode" button
   unlocks the features an addon cannot do and switches the download to a zip that is
   mounted through `gameinfo.txt`.
2. **Editor:** a visual canvas. Click an element, drag it, resize or scale it, edit its
   properties in a side panel. Start from a preset.
3. **Storage:** the browser only (localStorage), plus a share link. No accounts, no
   gallery.
4. **Crosshair:** separate and composable. The HUD VPK never ships a crosshair image; the
   crosshair maker stays as it is; players install either VPK or both.
5. **Art:** generated styles plus upload-your-own PNG for image slots. Weapon and item icon
   packs are out of the first version.

## Engine facts this design rests on

Verified earlier on the owner's client, recorded in the Modern HUD notes:

- L4D1 reads VPK **version 1** only.
- The game mounts every VPK before every loose folder, and `addons/` after `pak01`. An addon
  can therefore add new files and override files that ship loose on disk, but can never
  replace a file that ships inside `pak01`.
- HUD `.res` files and `scripts/` files ship loose. Textures ship in `pak01`.
- An addon copy of `scripts/hudlayout.res` is honoured (the crosshair addon depends on it).
- HUD coordinates are proportional units, 480 tall. Width depends on aspect ratio: 640 at
  4:3, 768 at 16:10, 853 at 16:9. `xpos "r160"` is measured from the right edge and
  `xpos "c-13"` from the centre, and the same prefixes work for `ypos`.
- VGUI does not scale a panel's children when the panel is resized. Children are positioned
  absolutely inside it, and text size comes from a named font in `clientscheme.res`.
- The only dialog variable HUD panels receive is `%HealthNumber%`. The infected team row
  (`CHudZombieTeamDisplay`) is horizontal only.
- The survivor health bar fill textures and the incap and dead portraits are named by game
  code, not by any `.res` file, so only a VPK mounted ahead of `pak01` can change them.
- The crosshair image is a separate texture, `vgui/hud/altcrosshair`, drawn by an `xHair`
  ImagePanel in `hudlayout.res`. Any layout that contains that element works with any
  crosshair addon, which is why the Modern HUD and crosshair addons already coexist.
- `fgcolor_override "White"` silently draws nothing in some panels; raw `"255 255 255 255"`
  works. The generator always writes raw colours.
- Three `hudanimations.txt` events (ResetChatPosition, DeathPanelOpen, ZombieIntroPanelOpen)
  hard-code the chat position and snap a moved chat box back.

Not yet verified, settled by the in-game test in "Phase 0" below:

- An addon copy of a `resource/ui/hud/*.res` file is honoured.
- An addon copy of `resource/clientscheme.res` is honoured and a `.ttf` inside an addon VPK
  loads through `CustomFontFiles`.
- A `.res` image pointed at a new texture name inside the addon draws.
- What the `xHair` element draws when no crosshair addon is installed.
- Whether an addon copy of `scripts/mod_textures.txt` is honoured.

## Architecture

Everything lives in `web/src/hud/` and one route file. Each unit below has one job and can
be tested without the others.

| Unit | Job | Depends on |
|---|---|---|
| `web/src/vpk/` | VTF, VPK and CRC32 encoders, moved out of `crosshair/vpk.ts` unchanged. Adds a store-only zip writer. | nothing |
| `hud/kv.ts` | Parse Valve KeyValues text into an ordered tree and write it back. | nothing |
| `hud/units.ts` | Anchor and scale maths: screen position to `xpos`/`ypos` strings and back, per aspect ratio. | nothing |
| `hud/base/` | The stock and Modern HUD files as raw text assets, plus bundled fonts. | nothing |
| `hud/design.ts` | The `HudDesign` type, defaults, validation, localStorage and share-link encoding. | nothing |
| `hud/elements.ts` | The element registry. | `units`, `design` |
| `hud/textures.ts` | Generated textures (flat and rounded panels, bar fills, tinted portraits) and PNG upload to RGBA. | nothing |
| `hud/build.ts` | `HudDesign` in, list of `{path, data}` files out. | `kv`, `units`, `base`, `elements`, `textures` |
| `hud/mock/` | Canvas drawing of each element for the preview. | `elements`, `units` |
| `routes/Hud.tsx` | The page: canvas, selection, drag, side panel, download. | all of the above |

`crosshair/vpk.ts` keeps `buildVPK` and imports the encoders from `web/src/vpk/`, so the
crosshair page and its tests keep working with no behaviour change.

### Generating files by patching real ones

The generator never writes a HUD file from a template. It loads the base file for the
chosen preset, parses it, changes the values the design overrides, and writes it back.
An element the editor knows nothing about ships exactly as the base HUD has it, so a gap in
the editor can never produce a broken panel.

`kv.ts` requirements:

- Preserve key order and duplicate keys. Both occur in stock files.
- Accept quoted and unquoted tokens, `//` comments, conditional tags such as `[$X360]`, and
  CRLF or LF line endings.
- Output need not be byte-identical to the input, but `parse(write(parse(x)))` must equal
  `parse(x)` for every stock and Modern HUD file. That is the round-trip test.
- A file that fails to parse fails the build with the file name. It never ships half a file.

### The design object

```ts
interface HudDesign {
  v: 1;
  name: string;                       // addon title and download file name
  preset: 'stock' | 'modern';
  advanced: boolean;
  aspect: '16:9' | '16:10' | '4:3';   // preview only, never written to a file
  font: 'preset' | 'roboto';          // one bundled family in this version: Roboto Condensed
  elements: Record<string, ElementOverride>;   // sparse: only what the user changed
  styles: Record<string, StyleOverride>;       // panel background, bar fills, portraits
  images: Record<string, UploadedImage>;       // keyed by slot id
}

interface ElementOverride {
  visible?: boolean;
  x?: number; y?: number;             // HUD units from the top-left at the design aspect
  w?: number; h?: number;             // free-resize elements only
  scale?: number;                     // composite elements only, 0.5 to 2
  dir?: 'row' | 'column';             // survivor team display only
  spacing?: number;                   // team displays: units between teammate panels
  color?: string; bg?: string;        // 'r g b a'
  fontSize?: number;
}

interface UploadedImage { w: number; h: number; png: string }   // base64
```

Positions are stored as plain units from the top-left, together with the aspect ratio they
were placed at. The anchor is derived at build time, not stored, so an old design benefits
from any later fix to the anchor rule.

`design.ts` validates every loaded design (localStorage, link or file) field by field:
unknown keys dropped, numbers clamped to their ranges, unknown element ids ignored, image
dimensions capped at 512x512 and the decoded size at 1 MB per image. A shared link is
untrusted input.

### The element registry

One table drives the canvas, the side panel and the generator. Each entry:

```ts
interface HudElement {
  id: string;                  // 'teamColumn'
  label: string;               // 'Teammates'
  side: 'survivor' | 'infected' | 'both';
  file: string;                // 'scripts/hudlayout.res'
  key: string[];               // path to the panel inside that file
  resize: 'free' | 'scale' | 'none';
  children?: { file: string }; // the resource/ui file whose contents scale with it
  props: ('visible' | 'color' | 'bg' | 'fontSize' | 'image')[];
  draw: MockDraw;
}
```

First version, mocked and editable: own health panel, team column, weapon selection, chat,
kill feed, target ID, progress bar, crosshair marker (position preview only, the image comes
from the player's saved crosshair), infected team row, own special infected health card,
ability ring, ghost panel, tank panel with frustration meter. Every other `hudlayout.res`
element ships at its preset value. Two of the listed elements, the kill feed and target ID,
are full-screen containers whose content is placed by game code, so in this version they can
be hidden and restyled but not moved. The survivor team display can be a row or a column
(the positions of `TeamPlayer1` to `4` in `teamdisplayhud.res`); the infected row is a row only
and exposes its spacing (`HorizPanelSpacing`). Adding one later is one registry entry and one mock.

### Anchors

At build time each element's anchor comes from where its centre sits at the design aspect:
left third plain, middle third `c`, right third `r`; the same rule vertically. A layout made
at 16:9 then holds at 16:10 and 4:3. The preview's aspect switch re-projects every element
through the same function the generator uses, so the preview cannot disagree with the file.

### Resizing

- `free`: `wide` and `tall` written directly. Chat, kill feed, progress bar.
- `scale`: the generator multiplies `xpos`, `ypos`, `wide`, `tall` of every child in the
  element's `resource/ui` file by the factor, and for each font the children use it writes a
  scaled copy into `clientscheme.res` (`HudEd_<font>_<percent>`, `tall` multiplied, rounded)
  and points the child at it. Health panel, teammate panels, infected cards.
- `none`: move and hide only. Ability ring, crosshair marker.

### Styles and textures

`textures.ts` ports `gen_textures.py` to canvas: flat and rounded scalable panels in any
colour and opacity, infected health bar frames, and in Advanced mode the survivor bar fills
and flat-tinted incap and dead panels (no portrait art: the stock art is Valve's and lives in
`pak01`, which the browser cannot read). Each generated or uploaded image is encoded with the
existing `encodeVTF` and paired with an `UnlitGeneric` VMT.

In normal mode every texture gets a new name under `materials/vgui/hud/hudeditor/` and the
`.res` `image` keys are pointed at it. In Advanced mode the code-named textures are also
written under their stock names, which only takes effect because that VPK mounts ahead of
`pak01`.

Uploads are decoded with an `<img>` onto a canvas, scaled to the slot's size (capped at
512x512), and stored in the design as PNG base64.

## Output

**Normal mode:** `<name>.vpk`, VPK v1, for `left4dead/addons/`. Contains `scripts/hudlayout.res`
(always with the `xHair` element, subject to the Phase 0 result), each touched
`resource/ui` file, `resource/clientscheme.res`, `resource/chatscheme.res` when the font
changes, `scripts/hudanimations.txt` with the three chat events rewritten when chat moved,
the chosen `.ttf` files, the textures, and `addoninfo.txt`. Never contains
`materials/vgui/hud/altcrosshair.*`.

**Advanced mode:** `<name>.zip`, store-only, containing `riversidehud/pak01_dir.vpk` and
`README.txt`. The README gives the one-line `gameinfo.txt` edit (`Game riversidehud` as the
first line of `SearchPaths`), says a game restart is needed, and says Steam's "verify files"
undoes the edit. Same build as normal mode plus the stock-named textures.

The page states next to both downloads that custom HUDs are allowed on the Riverside
servers and that a rebuilt HUD needs a game restart to show.

## Sharing

- Every change is saved to localStorage under `hud`, guarded with try/catch as the crosshair
  page does.
- "Copy share link" writes the design, minus `images`, as deflate-compressed base64url JSON
  in the URL fragment (`/hud#d=...`). The fragment never reaches the server. Opening such a
  link loads the design into the editor after validation and asks before replacing a saved
  design.
- A design with uploaded images shares as an exported `.json` file, loaded back through a
  file picker. The share-link button says so instead of silently dropping the images.

## The page

Route `/hud`, nav entry "HUD" beside "Crosshair". The route is lazy-loaded (dynamic import)
because it carries about 170 KB of base files and about 1 MB of fonts; fonts are fetched
only when a non-stock font is chosen. Layout follows the crosshair page: a 16:9 canvas over a
selectable backdrop (saferoom, dark, bright, own screenshot), a Survivor / Infected toggle,
an aspect switch, a preset picker, the side panel for the selected element, the Advanced
mode button, name field and download. Keyboard: arrow keys nudge the selection by one unit,
Shift for ten; Escape deselects. Elements snap to the screen edges and centre lines.

## Errors

- A base file that fails to parse, or a registry key missing from its file, fails the build
  with the file and key named on the page. No partial download.
- An upload that is not a decodable image, or is over the size cap, is refused with the
  reason; the previous image stays.
- A share link that fails validation loads nothing and says the link is damaged.
- localStorage that throws is ignored; the editor works without persistence.

## Testing

Unit tests (vitest, alongside the existing `vpk.test.ts`):

- `kv`: round-trip of every stock and Modern HUD file; duplicate keys; conditionals;
  comments; CRLF.
- `units`: each anchor at each aspect; position to string and back is lossless; an element
  placed at 16:9 lands at the same distance from its anchored edge at 4:3.
- `build`: an empty design on `stock` writes `hudlayout.res` equal to stock plus `xHair`; a
  move changes only that element's `xpos`/`ypos`; a scale multiplies children and adds the
  font entries; normal mode never emits a stock texture name; Advanced mode does; no build
  ever emits `altcrosshair`.
- `design`: clamping, unknown keys, oversize images, share-link encode and decode.
- `zip`: output opens with a standard unzip and CRCs match.
- One script check, outside vitest: a built VPK lists and extracts with the Python `vpk`
  reader in `/home/volence/l4d/hud/.venv`.

In game, by the owner: Phase 0 below, then a screenshot pass of a built HUD at the end.

## Phase 0: the in-game test, before the editor is built

A throwaway addon VPK, built with the existing tools, that the owner drops into `addons/`
with the `Game modernhud` line commented out, then screenshots as a survivor. It makes five
visible changes, one per open question:

1. `resource/ui/hud/localplayerpanel.res` with the health number moved somewhere obvious.
2. `resource/clientscheme.res` with a bundled `.ttf` on the health number.
3. The teammate panel background pointed at a new, loudly coloured texture.
4. The `xHair` element present with no crosshair addon installed (the owner's two
   crosshair VPKs moved out of `addons/` for this one screenshot).
5. `scripts/mod_textures.txt` with the weapon slot boxes pointed at new flat textures.

Outcomes: 1 to 3 failing would move panel internals, fonts or custom art behind Advanced
mode and nothing else changes. 4 drawing a missing-texture square adds an "I use a custom
crosshair addon" checkbox that controls whether `xHair` is written. 5 passing moves flat
weapon boxes into normal mode; failing keeps them Advanced only.

## Not in this version

Accounts, server-side saved designs, a gallery; weapon and item icon packs; a vertical
infected row (the engine cannot); new data readouts (the engine provides none); editing the
Tab scoreboard and versus score panel beyond what the preset gives; L4D2.
