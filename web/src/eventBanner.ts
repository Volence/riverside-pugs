/** The server takes exactly 1600 x 400 PNG or WebP banners
 *  (src/community/validate.ts checkBanner), so whatever the admin picks
 *  (PNG, JPEG or WebP) is centre-cropped to 4:1 and scaled here first, then
 *  written as WebP, or as PNG on a browser that cannot write WebP (its
 *  toDataURL then hands back a PNG). Returns base64 without the data: prefix. */
export async function toBannerImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const w = Math.min(bmp.width, bmp.height * 4);
  const h = w / 4;
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize images.');
  ctx.drawImage(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h, 0, 0, 1600, 400);
  bmp.close();
  const url = canvas.toDataURL('image/webp', 0.9);
  return url.replace(/^data:image\/(webp|png);base64,/, '');
}
