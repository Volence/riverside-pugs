# HUD editor: importing a whole HUD

Date: 2026-09-23. Branch `worktree-hud-editor`. The owner approved this approach in conversation: import
an existing HUD and use it as a third preset. The goal is accuracy: the editor shows and edits the
player's HUD as the game would show it, and the download is that HUD plus the player's edits.

## What the player does

The toolbar's Preset select gains **Import a HUD...**. It accepts one of:

- a `.vpk` addon;
- a `.zip` of a HUD folder, whether an addon folder or a gameinfo-mounted folder like `riversidehud/`.

The editor then does three things:

- It reads the upload and finds the HUD root. For a `.vpk` that is the root. For a `.zip` it is the
  folder that holds `scripts/hudlayout.res`, even when that folder is nested a level or two deep.
- It stores the HUD in this browser.
- It switches the design to the imported preset, named after the upload (for example "Imported: edgehud").

Edits then work as they do on Stock and Modern.

Errors are one line each, and none of them changes the design:

- no `scripts/hudlayout.res`: "This file has no scripts/hudlayout.res, so it is not a HUD";
- over the size cap (50 MB unpacked): "This HUD is over 50 MB";
- an unreadable archive: "Could not read this file as a VPK or zip".

## The imported layer

An imported HUD is a layer over stock, the way Modern is: `baseFile` returns the imported copy of a
path when the upload has one and the stock copy otherwise. That is how the game resolves an addon's
files.

- **What the editor reads and edits:** the text files it already knows, meaning `scripts/hudlayout.res`,
  `scripts/hudanimations.txt`, `resource/clientscheme.res`, `resource/chatscheme.res`,
  `resource/ui/**.res`, `scripts/mod_textures.txt` and `scripts/hud_textures.txt`. These are parsed with
  kv.ts, which keeps key order, duplicate keys, conditionals and everything the editor does not
  understand.
- **What passes through untouched:** every other file in the upload, such as textures, fonts, sounds,
  and panels the editor does not model. These go into the download byte for byte. Two exceptions:
  - A file the editor generates at the same path (a font copy, a generated texture, the crosshair) is
    replaced by the generated one, and the download note lists it.
  - A zip's `gameinfo.txt` or other files outside the HUD root are dropped, and the note says so.
- **When the upload lacks an expected piece:** where a panel or child the editor models is missing or
  renamed, its controls hide. The existing `baseHasChild` style check extends to elements, and the
  preview draws what the files give. Stock fills in only where the game itself would fall back to the
  stock file, which means a whole file, never a single key.
- **Downloads:** an imported design downloads as a normal addon `.vpk` with the imported layer's files
  plus the edited and generated ones. The Advanced download (gameinfo mount) works the same way as for
  the other presets.
- **Caches:** every cache keyed by preset (`BASE_TEAMS`, build caches) keys on the imported HUD's
  identity too, so two imports never share cached trees.

## Storage and identity

- **Where files live:** the imported files go into IndexedDB (a small `hudStore` module with get, put,
  list and delete). The page loads the design's import into memory before the first draw. baseFile
  stays synchronous and reads from an in-memory registry that the page fills.
- **What the design records:** `HudDesign.preset: 'imported'` plus
  `HudDesign.imported: { id: string; name: string }`. The `id` is the SHA-256 of the canonical file
  list (sorted paths and their bytes), so the same HUD imported twice is one entry, and a design never
  opens against different files.
- **validateDesign:** a design whose `id` is missing in this browser keeps its data and shows a banner:
  "This design was made on the imported HUD 'name'. Import it again to edit or download it." Controls
  are read-only and Download is disabled until the HUD is imported. A re-import with the same `id`
  restores it.
- **Share links** carry the design but not the files, and open with the same banner.
- **Managing imports:** the Preset select lists this browser's imports and has a "Remove an imported
  HUD" option.
- **Community HUDs:** the owner plans a "community HUDs" page later, where players share a HUD or two.
  This design keeps that open: an import's identity is a content hash and its files are one canonical
  set, so a server-side store can later hold the same records and a share link can reference one. None
  of that is built here.

## Preview accuracy

- **Fonts:** the HUD's own fonts load into the preview. These are the `.ttf`/`.otf`/`.vfont` files named
  by its clientscheme `CustomFontFiles`, including a `.vfont`, which is decoded the same way
  export-hud-art.py decodes it.
  - Each face registers through FontFace under its internal family name, which is the name the scheme
    refers to.
  - Each face is sized by the same VDMX-first rule fonts.ts uses. This needs a small runtime TrueType
    reader in TypeScript that reads `head`, `hhea`, `OS/2`, `VDMX` and `name` and returns what
    fontCell needs. A test checks it against export-hud-art.py's baked numbers for Trade Gothic.
  - A face the upload does not carry falls back as today.
- **Textures:** an ImagePanel that names a material the upload carries is drawn from
  that material. The editor reads the `.vmt`, resolves `$baseTexture` to the `.vtf`, and decodes it
  with `decodeVTF`, including DXT, and mip 0 is enough. It is drawn as the game draws that panel
  (scaleImage, drawColor, additive where the `.vmt` says `$additive 1`).
- **Icon files:** the upload's `hud_textures.txt` and `mod_textures.txt` cells resolve against its own
  textures, so a HUD that repoints weapon or item icons shows its own art.
- **Crosshair:** when the upload has `materials/vgui/hud/altcrosshair.vtf`, it becomes the design's
  `xhairArt` (`{ kind: 'image' }`) with crosshair 'bundle', as uploading it on the crosshair control
  does. The HUD's own `xHair` element is kept as the upload has it.

## Testing

- **Import:**
  - a VPK written by this project's writer;
  - a zip with the HUD nested in a folder;
  - a zip with `gameinfo.txt` and extra files;
  - each error message;
  - the same HUD twice gives the same `id`.
- **Round trip:** importing then downloading with no edits gives the upload's HUD files back byte for
  byte. An upload's own `addoninfo.txt` is kept as it is; an upload without one gets the one the editor
  writes today.
  - Moving an element, editing a teammate child and styling the weapons land in the imported files.
  - Files the editor does not know pass through unchanged.
- **Degrading:** a hand-made HUD missing a teammate child and one panel shows no controls for them and
  does not throw.
- **Preview:** a fixture with a custom TTF draws labels in that face at the VDMX size. A fixture with a
  custom texture draws it for an ImagePanel. The runtime TTF reader agrees with the baked Trade Gothic
  metrics.
- **Storage:** hudStore round trip (a fake IndexedDB in tests); a design whose import is missing shows
  the banner and disables Download; a re-import restores it.
- **Crosshair:** an upload with `altcrosshair.vtf` sets `xhairArt`.
- **Owner check:** import the owner's pre-test `my_hud.vpk`
  (`/home/volence/l4d/hud/test-hud-2026-09-23/my_hud.vpk.orig`) and one community HUD, compare the
  preview to game screenshots, then make an edit, install it and check in game (campaign Expert, map 2:
  `sv_cheats 1; z_difficulty impossible; map l4d_hospital02_subway`).

## Out of scope

- Community HUD sharing (later; see "Managing imports").
- Scheme borders drawn from the upload's own textures: the preview draws no scheme borders for any preset
  yet (decided in the plan).
- Special handling for HUDs made for L4D2. Such an upload imports like any other, and whatever the
  L4D1 game ignores is simply ignored; there is no warning.
- Phase 2 (own health insides, infected panels).
