/*
 * Turning a picked image file into a stored upload: the page's style slots,
 * splatters and weapon pictures all come through here. Its own module so the
 * side panel can use it without importing the page.
 */

/** A decoded upload: its pixels, a PNG copy for the design, and the size it was drawn at. */
export interface Decoded { rgba: Uint8ClampedArray; png: string; w: number; h: number }

/**
 * The sizes a big picture passes through on its way down to w x h: each side
 * halves while it is over twice its target, so no single draw shrinks by more
 * than half and the browser's filter keeps the detail a one-step shrink of a
 * photo would alias away. The final draw to w x h is not listed.
 */
export function halvingSteps(sw: number, sh: number, w: number, h: number): { w: number; h: number }[] {
  const steps: { w: number; h: number }[] = [];
  while (sw > w * 2 || sh > h * 2) {
    if (sw > w * 2) sw = Math.ceil(sw / 2);
    if (sh > h * 2) sh = Math.ceil(sh / 2);
    steps.push({ w: sw, h: sh });
  }
  return steps;
}

/**
 * Decode any image the browser can read, fit it to the slot (a fixed size,
 * or one worked out from the picture's own), and keep a PNG copy for the
 * saved design. A big picture comes down in halving steps
 * (halvingSteps), each drawn at the high smoothing quality.
 */
export async function decodeUpload(file: Blob, w: number, h: number): Promise<Decoded>;
export async function decodeUpload(file: Blob, size: (srcW: number, srcH: number) => { w: number; h: number }): Promise<Decoded>;
export async function decodeUpload(file: Blob, a: number | ((srcW: number, srcH: number) => { w: number; h: number }), b?: number): Promise<Decoded> {
  if (file.size > 4_000_000) throw new Error('That image is over 4 MB.');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('That file is not an image the browser can read.'); });
  // A weapon icon's size follows the picture's own shape (weaponUploadSize).
  const { w, h } = typeof a === 'function' ? a(bmp.width, bmp.height) : { w: a, h: b! };
  let src: CanvasImageSource = bmp;
  for (const step of halvingSteps(bmp.width, bmp.height, w, h)) {
    const s = document.createElement('canvas'); s.width = step.w; s.height = step.h;
    const sctx = s.getContext('2d')!;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, 0, 0, step.w, step.h);
    src = s;
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  bmp.close();
  const png = c.toDataURL('image/png').split(',')[1];
  if (png.length > 1_400_000) throw new Error('That image is too detailed to store. Try a smaller one.');
  return { rgba: ctx.getImageData(0, 0, w, h).data, png, w, h };
}
