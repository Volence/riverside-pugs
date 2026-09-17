/**
 * Binary encoders for the crosshair addon: a VTF texture, a VPK archive.
 *
 * Ported from the standalone crosshair.html, which carried these in an inline
 * <script id="lib"> ending in a `module.exports` guard for a node test that
 * was never written. Now a real module, and tested: every field below is a
 * byte offset into a format Source parses without complaining when it is
 * wrong, so a mistake here shows up as an invisible crosshair in game rather
 * than as an error anywhere.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();

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

export interface VpkFile {
  /** Forward-slash path inside the archive, e.g. materials/vgui/hud/x.vtf */
  path: string;
  data: Uint8Array;
}

/** VPK v1, all data inline in the _dir file. */
export function encodeVPK(files: VpkFile[]): Uint8Array<ArrayBuffer> {
  // ext -> dir -> name -> data
  const tree: Record<string, Record<string, Record<string, Uint8Array>>> = {};
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const dir = slash < 0 ? ' ' : f.path.slice(0, slash);
    const base = f.path.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const name = base.slice(0, dot);
    const ext = base.slice(dot + 1);
    ((tree[ext] ??= {})[dir] ??= {})[name] = f.data;
  }

  const parts: Uint8Array[] = [];
  const datas: Uint8Array[] = [];
  let dataOffset = 0;
  const push = (b: Uint8Array) => parts.push(b);
  const str = (s: string) => push(enc.encode(s + '\0'));

  for (const ext of Object.keys(tree).sort()) {
    str(ext);
    for (const dir of Object.keys(tree[ext]).sort()) {
      str(dir);
      for (const name of Object.keys(tree[ext][dir]).sort()) {
        const data = tree[ext][dir][name];
        str(name);
        const e = new ArrayBuffer(18);
        const dv = new DataView(e);
        dv.setUint32(0, crc32(data), true);
        dv.setUint16(4, 0, true);                  // preload bytes
        dv.setUint16(6, 0x7FFF, true);             // archive index: this file
        dv.setUint32(8, dataOffset, true);
        dv.setUint32(12, data.length, true);
        dv.setUint16(16, 0xFFFF, true);            // terminator
        push(new Uint8Array(e));
        datas.push(data);
        dataOffset += data.length;
      }
      push(new Uint8Array([0]));
    }
    push(new Uint8Array([0]));
  }
  push(new Uint8Array([0]));

  const treeSize = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + treeSize + dataOffset);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x55AA1234, true);               // signature
  dv.setUint32(4, 1, true);                        // version
  dv.setUint32(8, treeSize, true);
  let o = 12;
  for (const p of parts) { out.set(p, o); o += p.length; }
  for (const d of datas) { out.set(d, o); o += d.length; }
  return out;
}

const VMT = 'UnlitGeneric\n{\n\t$basetexture "vgui/hud/altcrosshair"\n\t$translucent 1\n\t$vertexcolor 1\n\t$vertexalpha 1\n\t$ignorez 1\n\t$no_fullbright 1\n\t$nomip 1\n}\n';

function addonInfo(name: string): string {
  return '"AddonInfo"\n{\n\taddonSteamAppID\t\t500\n\taddontitle\t\t"'
    + name.replace(/"/g, '')
    + '"\n\taddonversion\t\t1.0\n\taddontagline\t\t"Custom crosshair (Crosshair Maker)"\n\taddonauthor\t\t"Crosshair Maker"\n\taddonDescription\t\t"Custom crosshair image drawn at screen center."\n}\n';
}

/** The complete addon: texture, material, HUD layout and addon manifest. */
export function buildVPK(
  name: string, width: number, height: number,
  rgba: Uint8ClampedArray, hudlayout: string,
  // Uint8Array<ArrayBuffer>, not a bare Uint8Array: TypeScript 7 made the
  // backing-buffer parameter significant, and the default ArrayBufferLike (which
  // admits SharedArrayBuffer) is not a BlobPart. Without this the one caller,
  // the crosshair downloader, cannot put the bytes in a Blob and `npm run
  // typecheck` fails. Every array here is built with `new Uint8Array(n)`, so the
  // buffer genuinely is an ArrayBuffer; only the annotation was too loose.
): Uint8Array<ArrayBuffer> {
  return encodeVPK([
    { path: 'materials/vgui/hud/altcrosshair.vtf', data: encodeVTF(width, height, rgba) },
    { path: 'materials/vgui/hud/altcrosshair.vmt', data: enc.encode(VMT) },
    { path: 'scripts/hudlayout.res', data: enc.encode(hudlayout) },
    { path: 'addoninfo.txt', data: enc.encode(addonInfo(name)) },
  ]);
}
