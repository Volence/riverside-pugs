/**
 * What a HUD build needs besides the design: decoded style, splatter, weapon
 * and voice images, the crosshair's texture pixels and the Roboto Condensed
 * files. Shared by the
 * HUD editor's download and the community page's, so one design is the
 * same bytes from either.
 */
import { weaponImageFits, weaponImagesInUse, VOICE_ICONS, VOICE_ICON_TEXELS, type HudDesign } from './design';
import type { BuildAssets } from './build';
import { importedFiles, baseOf } from './base';
import { SLOTS } from './slots';
import { splatterDef, type SplatterId } from './splatter';
import { TEX } from '../crosshair/draw';
import { artPixels, importedCrosshair } from '../crosshair/texture';
import regularUrl from './base/fonts/RobotoCondensed-Regular.ttf?url';
import boldUrl from './base/fonts/RobotoCondensed-Bold.ttf?url';

/** `fetch` only rejects on a network error, not on a 404 or 500: an unchecked
 *  response would let an error page's HTML sail through as if it were the
 *  font's own bytes, ending up written into the shipped VPK as
 *  resource/robotocondensed-regular.ttf with nothing catching it until the
 *  game refuses to load a corrupt font. Named after the file so a failure
 *  here tells a bug report exactly what to look at, the same as every other
 *  fetch in this codebase (see web/src/api.ts). */
async function fontBytes(u: string, filename: string): Promise<Uint8Array> {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`${filename}: failed to load (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The texture size an uploaded image is redrawn at: a style slot's, else a
 * splatter's, else a weapon picture's, else null (not an upload the build
 * takes). A gun picture's width is its own shape's, so it comes from the
 * stored record, and only when that is a size validateDesign keeps
 * (weaponImageFits): the size the build writes into its cell rect.
 */
export function assetSize(id: string, stored?: { w: number; h: number }): { w: number; h: number } | null {
  const fixed = SLOTS.find((s) => s.id === id)?.size ?? splatterDef(id)?.size
    ?? (id in VOICE_ICONS ? { w: VOICE_ICON_TEXELS, h: VOICE_ICON_TEXELS } : undefined);
  if (fixed) return fixed;
  return stored && weaponImageFits(id, stored.w, stored.h) ? { w: stored.w, h: stored.h } : null;
}

/**
 * Rebuild `BuildAssets` from a design: the crosshair's texture pixels,
 * decoded pixels for every uploaded style or splatter image, plus the Roboto Condensed
 * files when the design needs them.
 *
 * A design's `images[id].w/h` are untrusted metadata: nothing has ever
 * cross-checked them against the PNG they came with, and a share link or an
 * imported .json file could claim anything. So every image is redrawn at its
 * SLOT's (or splatter's) real size, never the stored one; that size is what
 * the generator actually encodes, and it is the only thing here that comes
 * from the registry rather than from the design itself.
 */
export async function assetsFor(design: HudDesign): Promise<BuildAssets> {
  const assets: BuildAssets = {};
  // A bundled crosshair's texture, drawn from the design's own crosshair as
  // the preview draws it (a built one exactly as the Crosshair page
  // exports it). Without it the generator refuses the build. An imported
  // HUD's own crosshair that the player left as the import made it ships as
  // the upload's own files instead (build.ts's ownCrosshair).
  if (design.crosshair === 'bundle' && design.xhairArt) {
    const layer = importedFiles(baseOf(design));
    const own = layer ? importedCrosshair(layer) : null;
    if (own && JSON.stringify(own) === JSON.stringify(design.xhairArt)) assets.ownCrosshair = true;
    else {
      const px = await artPixels(design.xhairArt);
      if (px && px.length === TEX * TEX * 4) assets.crosshair = px;
    }
  }
  const entries = Object.entries(design.images);
  if (entries.length) {
    const images: Record<string, Uint8ClampedArray> = {};
    const weaponsInUse = weaponImagesInUse(design);
    for (const [id, stored] of entries) {
      const size = assetSize(id, stored);
      if (!size) continue;
      // A weapon picture ships only while something names it (weaponsPass).
      if (weaponImageFits(id, 1, 1) !== undefined && !weaponsInUse.has(id)) continue;
      // A splatter keeps its picture through a switch to another kind, but
      // only an Image ships it (splatterPass), so only that one is decoded.
      if (splatterDef(id) && design.splatters?.[id as SplatterId]?.kind !== 'image') continue;
      const { w, h } = size;
      const label = SLOTS.find((s) => s.id === id)?.label ?? splatterDef(id)?.label ?? (id in VOICE_ICONS ? 'A voice icon' : 'A weapon picture');
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`${label}: the stored image will not decode`));
        img.src = `data:image/png;base64,${stored.png}`;
      });
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      images[id] = ctx.getImageData(0, 0, w, h).data;
    }
    assets.images = images;
  }
  if (design.font === 'roboto' || design.preset === 'modern') {
    assets.fonts = {
      regular: await fontBytes(regularUrl, 'RobotoCondensed-Regular.ttf'),
      bold: await fontBytes(boldUrl, 'RobotoCondensed-Bold.ttf'),
    };
  }
  return assets;
}
