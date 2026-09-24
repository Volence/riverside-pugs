/**
 * Binary encoders for Source engine addons: a VTF texture, a VPK archive.
 *
 * Shared by the crosshair maker and the HUD editor's advanced-mode download.
 * Every field below is a byte offset into a format Source parses without
 * complaining when it is wrong, so a mistake here shows up as an invisible
 * crosshair or a missing HUD element in game rather than as an error
 * anywhere.
 *
 * The VPK writer lives in src/vpkWrite.ts, where the server can use it too.
 */

export { crc32, vpkPathProblem, encodeVPK, type VpkFile } from '../../../src/vpkWrite';

/**
 * VTF 7.2, BGRA8888, one mip, no thumbnail.
 *
 * `rgba` is a canvas Uint8ClampedArray: RGBA, top-left pixel first. Source
 * wants BGRA, so the red and blue channels are swapped on the way in.
 */
export function encodeVTF(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array {
  const header = new ArrayBuffer(80);
  const dv = new DataView(header);
  const u8 = new Uint8Array(header);
  u8.set([0x56, 0x54, 0x46, 0x00], 0);            // "VTF\0"
  dv.setUint32(4, 7, true);
  dv.setUint32(8, 2, true);
  dv.setUint32(12, 80, true);                      // headerSize
  dv.setUint16(16, width, true);
  dv.setUint16(18, height, true);
  const CLAMPS = 0x4, CLAMPT = 0x8, NOMIP = 0x100, NOLOD = 0x200, EIGHTBITALPHA = 0x2000;
  dv.setUint32(20, CLAMPS | CLAMPT | NOMIP | NOLOD | EIGHTBITALPHA, true);
  dv.setUint16(24, 1, true);                       // frames
  dv.setUint16(26, 0, true);                       // firstFrame
  dv.setFloat32(32, 0.5, true);
  dv.setFloat32(36, 0.5, true);
  dv.setFloat32(40, 0.5, true);                    // reflectivity
  dv.setFloat32(48, 1.0, true);                    // bumpmap scale
  dv.setUint32(52, 12, true);                      // IMAGE_FORMAT_BGRA8888
  u8[56] = 1;                                      // mipmap count
  dv.setUint32(57, 0xFFFFFFFF, true);              // low-res format: none
  u8[61] = 0;
  u8[62] = 0;                                      // low-res size
  dv.setUint16(63, 1, true);                       // depth

  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    px[i * 4] = rgba[i * 4 + 2];
    px[i * 4 + 1] = rgba[i * 4 + 1];
    px[i * 4 + 2] = rgba[i * 4];
    px[i * 4 + 3] = rgba[i * 4 + 3];
  }
  const out = new Uint8Array(80 + px.length);
  out.set(u8, 0);
  out.set(px, 80);
  return out;
}

export { encodeZip } from './zip';
