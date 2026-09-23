/**
 * Crosshair art to texture pixels, and a player's file to crosshair art.
 * Both need the browser's canvas and image decoders, so they live apart
 * from model.ts, which design.ts loads.
 *
 * An uploaded crosshair is stored already drawn into the TEX x TEX square
 * it will ship as: the texture that comes out of the download is then the
 * stored picture, pixel for pixel, and a share link carries a few kilobytes
 * rather than the original file.
 */
import { TEX } from './draw';
import { drawArt, type CrosshairArt } from './model';
import { crosshairPixels } from './saved';
import { readVPK, decodeVTF } from '../vpk/read';

/** Where a crosshair addon keeps its texture: the image the xHair element shows. */
export const XHAIR_TEXTURE = 'materials/vgui/hud/altcrosshair.vtf';
const MAX_UPLOAD = 4_000_000;

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the crosshair.');
  return { c, ctx };
}

/** A data URL decoded to an image, or a sentence saying it would not. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("This HUD's crosshair image will not decode. Upload it again."));
    img.src = url;
  });
}

/**
 * The texture's pixels, TEX x TEX RGBA, drawn as drawArt draws everywhere
 * else. A built crosshair goes through crosshairPixels, the Crosshair
 * page's own export routine, so the same crosshair is the same bytes from
 * either download. Null when the browser gives no 2D context.
 */
export async function artPixels(art: CrosshairArt): Promise<Uint8ClampedArray | null> {
  if (art.kind === 'built') return crosshairPixels(art.state, null);
  const img = await loadImage(art.png);
  const c = document.createElement('canvas');
  c.width = TEX; c.height = TEX;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  drawArt(ctx, TEX / 2, TEX / 2, TEX, art, img);
  return ctx.getImageData(0, 0, TEX, TEX).data;
}

/** A crosshair drawn from `source` (w x h), fitted into the TEX square, aspect kept and centred, as the build would fit it. */
function fitted(source: CanvasImageSource, w: number, h: number): CrosshairArt {
  const { c, ctx } = canvas(TEX, TEX);
  drawArt(ctx, TEX / 2, TEX / 2, TEX, { kind: 'image', png: '', w, h }, source);
  return { kind: 'image', png: c.toDataURL('image/png'), w: TEX, h: TEX };
}

/** An altcrosshair texture's pixels as crosshair art. */
function vtfArt(tex: Uint8Array): CrosshairArt {
  const vtf = decodeVTF(tex);
  const { c, ctx } = canvas(vtf.w, vtf.h);
  const data = ctx.createImageData(vtf.w, vtf.h);
  data.data.set(vtf.rgba);
  ctx.putImageData(data, 0, 0);
  return fitted(c, vtf.w, vtf.h);
}

/**
 * An imported HUD's own crosshair texture (spec, "Crosshair"), as the
 * design's crosshair, exactly as uploading that texture on the crosshair
 * control would make it. Null when the HUD has none or it will not decode:
 * the import then keeps the design's own crosshair choice.
 */
export function importedCrosshair(files: ReadonlyMap<string, Uint8Array>): CrosshairArt | null {
  const tex = files.get(XHAIR_TEXTURE);
  if (!tex) return null;
  try { return vtfArt(tex); } catch { return null; }
}

const isVpk = (b: Uint8Array) => b.length >= 4 && b[0] === 0x34 && b[1] === 0x12 && b[2] === 0xAA && b[3] === 0x55;

/**
 * A crosshair from a player's file: any crosshair addon's .vpk (its
 * altcrosshair texture), or any image the browser can read. Either is
 * fitted into the TEX square, aspect kept and centred, the way the build
 * would fit it, and kept as that square's PNG.
 */
export async function uploadArt(file: File): Promise<CrosshairArt> {
  if (file.size > MAX_UPLOAD) throw new Error('That file is over 4 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isVpk(bytes) || /\.vpk$/i.test(file.name)) {
    const split = new Set<string>();
    const tex = readVPK(bytes, split).get(XHAIR_TEXTURE);
    if (!tex && split.has(XHAIR_TEXTURE)) {
      throw new Error('This addon is split across several files (..._dir.vpk plus _000.vpk); the site needs a single-file .vpk.');
    }
    if (!tex) throw new Error('No crosshair found in this file.');
    return vtfArt(tex);
  }
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error('That is not a crosshair: pick a crosshair addon (.vpk) or an image.');
  });
  return fitted(bmp, bmp.width, bmp.height);
}
