/**
 * Readers for the two Source formats a player's crosshair addon is made of:
 * the VPK archive and the VTF texture inside it. The writers in index.ts
 * make the few variants this project needs; these read what real addons
 * ship, which were packed by Valve's vpk.exe or by hand-rolled tools and
 * compressed by VTFEdit, so they accept more than the writers produce.
 *
 * Every read is bounds-checked: the bytes come from a file a player picked,
 * and a truncated or foreign file must fail with a sentence, not with a
 * RangeError or a texture of garbage.
 */

import { encodeVPK } from './vpkWrite.js';

const NOT_VPK = 'That is not a .vpk file the site can read.';
/** readVPK's refusal of two entries whose paths differ only in case. */
export const VPK_CASE_CLASH = 'That .vpk holds two files whose names differ only in case.';

/** Whether the bytes start with a VPK's signature (0x55AA1234, little-endian). */
export const isVpk = (b: Uint8Array) => b.length >= 4 && b[0] === 0x34 && b[1] === 0x12 && b[2] === 0xaa && b[3] === 0x55;
const NOT_VTF = 'That crosshair is not a texture the site can read.';

/**
 * Every file stored inside a single-file VPK, by lower-cased path. Versions
 * 1 and 2 share the directory tree; version 2 only adds four section sizes
 * to the header (and sections after the data this reader has no use for).
 *
 * A multi-part addon's _dir.vpk names a numbered side archive (_000.vpk)
 * for most files. A file wholly preloaded into the tree (length 0) is read
 * whatever archive it names, since its offset means nothing. One whose data
 * is in a side archive cannot be read from this one file: it is left out,
 * and its path goes into `split`, so the caller can say why.
 *
 * The game ignores case, so two entries whose paths differ only in case
 * name one file, and which of the two it reads is not ours to guess: such
 * an archive is refused (VPK_CASE_CLASH), split entries included.
 */
export function readVPK(bytes: Uint8Array, split?: Set<string>): Map<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (end: number) => { if (end > bytes.length) throw new Error(NOT_VPK); };
  need(12);
  if (dv.getUint32(0, true) !== 0x55AA1234) throw new Error(NOT_VPK);
  const version = dv.getUint32(4, true);
  if (version !== 1 && version !== 2) throw new Error(NOT_VPK);
  const headerSize = version === 1 ? 12 : 28;
  need(headerSize);
  const treeSize = dv.getUint32(8, true);
  const treeEnd = headerSize + treeSize;
  need(treeEnd);

  let o = headerSize;
  // Names are UTF-8, as encodeVPK writes them, so a non-ASCII name this
  // project packed reads back as the same path. An older packer on a Windows
  // code page wrote single bytes such as E9 for an e with an accent, which is
  // not valid UTF-8: such a name is read as Latin-1, one character per byte,
  // rather than turned into replacement marks that two names could share.
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const latin1 = new TextDecoder('latin1');
  const str = () => {
    const end = bytes.indexOf(0, o);
    if (end < 0 || end >= treeEnd) throw new Error(NOT_VPK);
    const raw = bytes.subarray(o, end);
    let s: string;
    try { s = utf8.decode(raw); } catch { s = latin1.decode(raw); }
    o = end + 1;
    return s;
  };

  const out = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  for (let ext = str(); ext !== ''; ext = str()) {
    for (let dir = str(); dir !== ''; dir = str()) {
      for (let name = str(); name !== ''; name = str()) {
        if (o + 18 > treeEnd) throw new Error(NOT_VPK);
        const preload = dv.getUint16(o + 4, true);
        const archive = dv.getUint16(o + 6, true);
        const offset = dv.getUint32(o + 8, true);
        const length = dv.getUint32(o + 12, true);
        o += 18;
        if (o + preload > treeEnd) throw new Error(NOT_VPK);
        const head = bytes.subarray(o, o + preload);
        o += preload;
        // A blank directory or extension is written as a single space.
        const file = (ext === ' ' ? name : `${name}.${ext}`);
        const path = (dir === ' ' ? file : `${dir}/${file}`).toLowerCase();
        if (seen.has(path)) throw new Error(VPK_CASE_CLASH);
        seen.add(path);
        if (archive !== 0x7FFF && length > 0) { split?.add(path); continue; }
        const data = new Uint8Array(preload + length);
        data.set(head, 0);
        if (length > 0) {
          const start = treeEnd + offset;
          need(start + length);
          data.set(bytes.subarray(start, start + length), preload);
        }
        out.set(path, data);
      }
    }
  }
  return out;
}

/**
 * Why `bytes` is not exactly what encodeVPK writes for `files` (readVPK's
 * result for those bytes), or null when it is. Byte equality rules out
 * everything a reader could disagree about: data after the files or between
 * them that no entry reads, two entries over the same bytes, preload bytes,
 * wrong CRCs, names in upper case, a v2 header, or a tree in another order.
 */
export function canonicalVpkProblem(bytes: Uint8Array, files: ReadonlyMap<string, Uint8Array>): string | null {
  const bad = 'That .vpk is not laid out as the editor writes it.';
  let canonical: Uint8Array;
  try { canonical = encodeVPK([...files].map(([path, data]) => ({ path, data }))); } catch { return bad; }
  if (canonical.length !== bytes.length) return bad;
  for (let i = 0; i < bytes.length; i++) if (canonical[i] !== bytes[i]) return bad;
  return null;
}

// VTF image formats this reader decodes, by their number in the header.
const RGBA8888 = 0, ABGR8888 = 1, RGB888 = 2, BGR888 = 3, ARGB8888 = 11, BGRA8888 = 12;
const DXT1 = 13, DXT3 = 14, DXT5 = 15, BGRX8888 = 16, DXT1_ONEBITALPHA = 20;

/** Byte order of each uncompressed format: where r, g, b and a sit in one pixel (-1: none, opaque). */
const LAYOUT: Record<number, { bpp: number; r: number; g: number; b: number; a: number }> = {
  [RGBA8888]: { bpp: 4, r: 0, g: 1, b: 2, a: 3 },
  [ABGR8888]: { bpp: 4, r: 3, g: 2, b: 1, a: 0 },
  [RGB888]: { bpp: 3, r: 0, g: 1, b: 2, a: -1 },
  [BGR888]: { bpp: 3, r: 2, g: 1, b: 0, a: -1 },
  [ARGB8888]: { bpp: 4, r: 1, g: 2, b: 3, a: 0 },
  [BGRA8888]: { bpp: 4, r: 2, g: 1, b: 0, a: 3 },
  [BGRX8888]: { bpp: 4, r: 2, g: 1, b: 0, a: -1 },
};
const BLOCK_BYTES: Record<number, number> = { [DXT1]: 8, [DXT1_ONEBITALPHA]: 8, [DXT3]: 16, [DXT5]: 16 };

/** Bytes one mip level of `format` takes at w x h. */
function mipBytes(format: number, w: number, h: number): number {
  const block = BLOCK_BYTES[format];
  if (block) return Math.ceil(w / 4) * Math.ceil(h / 4) * block;
  return w * h * LAYOUT[format].bpp;
}

/**
 * The texture's largest mip, first frame, as canvas RGBA (top-left pixel
 * first). The header is 7.0 to 7.5: from 7.3 on, the image is found
 * through the resource list (tag 0x30); before that it follows the header
 * and the low-res thumbnail. Either way the mips run smallest first, each
 * holding every frame, so mip 0 is the last one and its first frame starts
 * after every smaller mip. A cube map is no crosshair and is refused.
 */
export function decodeVTF(bytes: Uint8Array): { w: number; h: number; rgba: Uint8ClampedArray } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 64 || bytes[0] !== 0x56 || bytes[1] !== 0x54 || bytes[2] !== 0x46 || bytes[3] !== 0) throw new Error(NOT_VTF);
  const minor = dv.getUint32(8, true);
  const headerSize = dv.getUint32(12, true);
  const w = dv.getUint16(16, true), h = dv.getUint16(18, true);
  const flags = dv.getUint32(20, true);
  const frames = Math.max(1, dv.getUint16(24, true));
  const format = dv.getInt32(52, true);
  const mips = Math.max(1, bytes[56]);
  const lowFormat = dv.getInt32(57, true);
  const lowW = bytes[61], lowH = bytes[62];
  const depth = minor >= 2 ? Math.max(1, dv.getUint16(63, true)) : 1;
  const ENVMAP = 0x4000;
  if (dv.getUint32(4, true) !== 7 || w < 1 || h < 1 || (flags & ENVMAP)) throw new Error(NOT_VTF);
  if (!(format in LAYOUT) && !(format in BLOCK_BYTES)) {
    throw new Error("That crosshair's texture uses a format the site cannot read. Re-save it as BGRA8888 or DXT5 in VTFEdit.");
  }

  let start: number;
  if (minor >= 3) {
    if (bytes.length < 80) throw new Error(NOT_VTF);
    const count = dv.getUint32(68, true);
    let found = -1;
    for (let i = 0; i < count && 80 + i * 8 + 8 <= bytes.length; i++) {
      const at = 80 + i * 8;
      if (bytes[at] === 0x30 && bytes[at + 1] === 0 && bytes[at + 2] === 0) found = dv.getUint32(at + 4, true);
    }
    if (found < 0) throw new Error(NOT_VTF);
    start = found;
  } else {
    // The thumbnail is DXT1 in every file Valve's tools write, but its own
    // format is in the header; a format this reader does not know is sized as DXT1.
    const known = lowFormat in LAYOUT || lowFormat in BLOCK_BYTES;
    const low = lowFormat === -1 || lowW === 0 || lowH === 0 ? 0 : mipBytes(known ? lowFormat : DXT1, lowW, lowH);
    start = headerSize + low;
  }
  for (let m = mips - 1; m >= 1; m--) start += mipBytes(format, Math.max(1, w >> m), Math.max(1, h >> m)) * frames * depth;
  const size = mipBytes(format, w, h);
  if (start + size > bytes.length) throw new Error(NOT_VTF);
  const src = bytes.subarray(start, start + size);

  const rgba = new Uint8ClampedArray(w * h * 4);
  const layout = LAYOUT[format];
  if (layout) {
    for (let i = 0; i < w * h; i++) {
      const p = i * layout.bpp;
      rgba[i * 4] = src[p + layout.r];
      rgba[i * 4 + 1] = src[p + layout.g];
      rgba[i * 4 + 2] = src[p + layout.b];
      rgba[i * 4 + 3] = layout.a < 0 ? 255 : src[p + layout.a];
    }
  } else {
    decodeBlocks(format, src, w, h, rgba);
  }
  return { w, h, rgba };
}

/** A 565 colour word as 8-bit r, g, b, each channel's top bits repeated into its low bits. */
function rgb565(c: number): [number, number, number] {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * DXT1, DXT3 and DXT5, 4 x 4 pixels per block, rows of blocks top down,
 * cropped at the texture's edge. Every block ends in the same colour half:
 * two 565 endpoints and 2 bits per pixel. In DXT1 an endpoint order of
 * c0 <= c1 means three colours plus transparent black; DXT3 and DXT5 always
 * use four. DXT3's alpha is 4 bits per pixel; DXT5's is two endpoints and 3
 * bits per pixel, six or eight steps by the same kind of order rule.
 */
function decodeBlocks(format: number, src: Uint8Array, w: number, h: number, out: Uint8ClampedArray) {
  const blockBytes = BLOCK_BYTES[format];
  const dxt1 = blockBytes === 8;
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
  const alpha = new Uint8Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * blockBytes;
      alpha.fill(255);
      if (format === DXT3) {
        for (let i = 0; i < 16; i++) { const n = (src[o + (i >> 1)] >> ((i & 1) * 4)) & 15; alpha[i] = n * 17; }
      } else if (format === DXT5) {
        const a0 = src[o], a1 = src[o + 1];
        const steps = [a0, a1];
        if (a0 > a1) for (let i = 1; i <= 6; i++) steps.push(Math.round(((7 - i) * a0 + i * a1) / 7));
        else { for (let i = 1; i <= 4; i++) steps.push(Math.round(((5 - i) * a0 + i * a1) / 5)); steps.push(0, 255); }
        // 48 bits of indices, read as two 24-bit halves so no shift passes 31.
        for (let half = 0; half < 2; half++) {
          const bits = src[o + 2 + half * 3] | (src[o + 3 + half * 3] << 8) | (src[o + 4 + half * 3] << 16);
          for (let i = 0; i < 8; i++) alpha[half * 8 + i] = steps[(bits >> (i * 3)) & 7];
        }
      }
      const c = o + blockBytes - 8;
      const w0 = src[c] | (src[c + 1] << 8), w1 = src[c + 2] | (src[c + 3] << 8);
      const e0 = rgb565(w0), e1 = rgb565(w1);
      const four = !dxt1 || w0 > w1;
      const colours: [number, number, number, number][] = [[...e0, 255], [...e1, 255]];
      if (four) {
        colours.push([0, 1, 2].map((k) => Math.floor((2 * e0[k] + e1[k]) / 3)).concat(255) as [number, number, number, number]);
        colours.push([0, 1, 2].map((k) => Math.floor((e0[k] + 2 * e1[k]) / 3)).concat(255) as [number, number, number, number]);
      } else {
        colours.push([0, 1, 2].map((k) => Math.floor((e0[k] + e1[k]) / 2)).concat(255) as [number, number, number, number]);
        colours.push([0, 0, 0, 0]);
      }
      for (let py = 0; py < 4; py++) {
        const row = src[c + 4 + py];
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= w || y >= h) continue;
          const col = colours[(row >> (px * 2)) & 3];
          const at = (y * w + x) * 4;
          out[at] = col[0]; out[at + 1] = col[1]; out[at + 2] = col[2];
          out[at + 3] = dxt1 ? col[3] : alpha[py * 4 + px];
        }
      }
    }
  }
}
