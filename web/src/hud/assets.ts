/**
 * What a HUD build needs besides the design: decoded style images, the
 * crosshair's texture pixels and the Roboto Condensed files. Shared by the
 * HUD editor's download and the community page's, so one design is the
 * same bytes from either.
 */
import type { HudDesign } from './design';
import type { BuildAssets } from './build';
import { importedFiles, baseOf } from './base';
import { SLOTS } from './slots';
import { TEX } from '../crosshair/draw';
import { artPixels, importedCrosshair } from '../crosshair/texture';
import regularUrl from './base/fonts/RobotoCondensed-Regular.ttf?url';
import boldUrl from './base/fonts/RobotoCondensed-Bold.ttf?url';

/**
 * Decode any image the browser can read, fit it to the slot, and keep a PNG
 * copy for the saved design.
 */
export async function decodeUpload(file: Blob, w: number, h: number) {
  if (file.size > 4_000_000) throw new Error('That image is over 4 MB.');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('That file is not an image the browser can read.'); });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const png = c.toDataURL('image/png').split(',')[1];
  if (png.length > 1_400_000) throw new Error('That image is too detailed to store. Try a smaller one.');
  return { rgba: ctx.getImageData(0, 0, w, h).data, png };
}

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
 * Rebuild `BuildAssets` from a design: the crosshair's texture pixels,
 * decoded pixels for every uploaded style image, plus the Roboto Condensed
 * files when the design needs them.
 *
 * A design's `images[id].w/h` are untrusted metadata: nothing has ever
 * cross-checked them against the PNG they came with, and a share link or an
 * imported .json file could claim anything. So every image is redrawn at its
 * SLOT's real size, never the stored one; that size is what the generator
 * actually encodes, and it is the only thing here that comes from the
 * registry rather than from the design itself.
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
    for (const [id, stored] of entries) {
      const slot = SLOTS.find((s) => s.id === id);
      if (!slot) continue;
      const { w, h } = slot.size;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`${slot.label}: the stored image will not decode`));
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
