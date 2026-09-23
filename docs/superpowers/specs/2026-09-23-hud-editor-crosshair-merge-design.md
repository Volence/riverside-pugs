# HUD editor: the crosshair inside the HUD editor

Date: 2026-09-23. Branch `worktree-hud-editor`. Owner's decisions in conversation:

- Players should be able to bring a crosshair they already like (not only one made on the site).
- The crosshair builder should live in the HUD editor, so a HUD and its crosshair are one addon.
- The standalone Crosshair page stays, and warns that a custom HUD later means bringing the crosshair
  into the HUD editor (with a button that carries it over).

Background: L4D1 crosshair addons ship a whole `scripts/hudlayout.res` because the image is drawn by the
`xHair` ImagePanel inside it, so a crosshair addon and a HUD addon fight over that file and the first in
`addonlist.txt` wins; the in-game Add-ons menu cannot reorder. Bundling the crosshair texture into the HUD
download (already built as `crosshair: 'bundle'`) removes the fight.

## The crosshair in the design

- `HudDesign` gains `xhairArt?: CrosshairArt`, the crosshair this HUD carries:

  ```ts
  type CrosshairArt =
    | { kind: 'built'; state: CrosshairState }            // the builder's parameters (shape 'image' excluded)
    | { kind: 'image'; png: string; w: number; h: number } // an uploaded image or a crosshair .vpk's texture, as a PNG data URL
  ```

  `validateDesign` checks it (state keys and ranges as the builder uses; PNG data URL size capped like
  uploaded style images, reuse that cap; dimensions 1..512).
- The `crosshair` choice becomes, in the UI, **Custom** (bundle `xhairArt`) or **Game default** (no
  `xHair` element). The stored values stay `'bundle' | 'none'`, plus the legacy `'addon'`, which the UI shows
  only when a loaded design already has it ("Separate crosshair addon (legacy)"), so old designs keep
  building the same file.
- Where the art comes from, in order: the design's own `xhairArt`; else, for a brand new design, the
  crosshair saved by the standalone page in local storage key `xhair` (read once and copied into the design,
  so the design is self-contained from then on and share links carry it). The existing `usableCrosshair`
  logic moves to "is there art in the design".
- `buildHud` for `'bundle'` generates the texture from `xhairArt`: `built` draws through the crosshair
  module's `crosshairPixels`; `image` decodes the PNG to pixels (scaled into the TEX square, centred, aspect
  kept) and encodes with the same VTF writer. Byte-for-byte parity with the standalone page for a `built`
  state stays pinned by a test.

## Editing it in the HUD editor

- The crosshair is a normal element (`xhair` already in the registry): clicking it on the canvas or in
  Layers selects it, and the context panel shows the full builder controls, reused from the Crosshair page
  (factor its controls into a shared component used by both pages; do not duplicate), plus a zoomed
  preview, plus **Upload a crosshair**: accepts a `.vpk` (any crosshair addon) or an image file.
  - `.vpk`: read the VPK directory (v1 and v2 headers, the files this project already writes plus common
    real addons), take `materials/vgui/hud/altcrosshair.vtf`, decode the VTF (formats real crosshair
    addons use: at least BGRA8888, RGBA8888, BGR888, DXT1, DXT5; mip 0 only), convert to a PNG data URL,
    store as `{ kind: 'image' }`. A VPK without that texture reports "No crosshair found in this file".
  - An image file: stored as `{ kind: 'image' }` (as the Crosshair page's image shape does today, but saved).
- The canvas draws the crosshair at the `xHair` rect from `xhairArt` (built: `drawCrosshair`; image: the
  decoded image), exactly as the file will make the game draw it.
- Editing is undoable like everything else (builder sliders are gestures).

## The standalone Crosshair page

- Stays at `/crosshair`, unchanged in function.
- Gains a notice near its download: "Planning a custom HUD too? A crosshair addon and a HUD addon fight
  over the same file, so bring your crosshair into the HUD editor instead: it goes into the HUD's download."
  and a button **Open in the HUD editor** that saves the current crosshair (including an uploaded image) so
  the HUD editor picks it up, and navigates to `/hud` with the crosshair selected.
- The Crosshair page's uploaded image is now saved in its own storage too (so the button can carry it).

## Out of scope

HUD upload (importing a whole HUD as a preset) is the next piece, specced separately.

## Testing

- design: `xhairArt` validation (built ranges, image cap), migration of old designs (no art: take the
  standalone page's saved crosshair for a brand new design only; a loaded design with `'bundle'` and no art
  but a saved page crosshair adopts it once).
- build: bundle from `built` equals the standalone page's VPK texture bytes for the same state; bundle from
  `image` produces a TEX x TEX VTF with the image centred; `'none'` has no xHair; legacy `'addon'` unchanged.
- VPK/VTF reading: a VPK written by this project's own writer round-trips; hand-made fixtures for each VTF
  format decode to the expected pixels; a VPK without the texture gives the message.
- page: selecting the crosshair shows the builder; a slider change redraws the canvas and is one undo step;
  uploading a crosshair VPK fixture sets the art and the download contains the texture; the Crosshair page
  button carries a built and an image crosshair into `/hud` with the crosshair selected.
- Browser check by the controller; the owner checks in game.
