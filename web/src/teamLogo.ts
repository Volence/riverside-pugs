/** The server takes exactly 256 x 256 PNG logos (src/community/validate.ts),
 *  so whatever the captain picks is centre-cropped to a square and scaled
 *  here first. Returns the PNG as base64, without the data: prefix. */
export async function toLogoPng(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize images.');
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  bmp.close();
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
