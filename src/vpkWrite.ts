/**
 * The VPK writer: a v1 archive with every file inline in the one _dir file.
 *
 * Shared by the web (the crosshair maker, the HUD editor's download and a
 * community HUD's import) and the server, which re-encodes an uploaded
 * import to prove it is byte for byte what this writer makes. No imports, so
 * both sides can load it.
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

export interface VpkFile {
  /** Forward-slash path inside the archive, e.g. materials/vgui/hud/x.vtf */
  path: string;
  data: Uint8Array;
}

/**
 * Why `path` cannot be stored in a VPK, or null when it can.
 *
 * The directory tree is a run of NUL-terminated strings, extension, then
 * folder, then name, and an empty string ends the current list. So an empty
 * extension, folder or name (".DS_Store", "foo.", "/abs.txt", "a//b.txt")
 * would write a bare NUL that ends the tree early and hides every file after
 * it. A single space is the format's placeholder for "no folder" and "no
 * extension", so a real folder or extension named " " would read back as
 * something else. "." and ".." folders, backslashes (a separator on Windows)
 * and control characters are refused too: no game file is named that way,
 * and a tool that extracts the archive could write outside its folder.
 */
export function vpkPathProblem(path: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(path)) return 'a control character';
  if (path.includes('\\')) return 'a backslash';
  const segments = path.split('/');
  const base = segments.pop()!;
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return `an empty, "." or ".." folder`;
    if (seg.trim() === '') return 'a folder named with spaces only';
  }
  const dot = base.lastIndexOf('.');
  const name = dot < 0 ? base : base.slice(0, dot);
  const ext = dot < 0 ? null : base.slice(dot + 1);
  if (name.trim() === '') return 'no file name before the extension';
  if (ext !== null && ext.trim() === '') return 'an empty extension';
  return null;
}

/**
 * VPK v1, all data inline in the _dir file. Throws on a path the format
 * cannot hold (see vpkPathProblem): writing it anyway gives an archive the
 * game reads as missing files, which nobody would trace back to one name.
 */
export function encodeVPK(files: VpkFile[]): Uint8Array<ArrayBuffer> {
  // ext -> dir -> name -> data
  const tree: Record<string, Record<string, Record<string, Uint8Array>>> = {};
  for (const f of files) {
    const problem = vpkPathProblem(f.path);
    if (problem) throw new Error(`A VPK cannot hold ${JSON.stringify(f.path)}: it has ${problem}`);
    const slash = f.path.lastIndexOf('/');
    const dir = slash < 0 ? ' ' : f.path.slice(0, slash);
    const base = f.path.slice(slash + 1);
    // A file with no extension is stored under a blank one, which the format
    // writes as a single space (readVPK reads it back the same way). An
    // imported HUD can carry one, a LICENSE say, and it passes through.
    const dot = base.lastIndexOf('.');
    const name = dot < 0 ? base : base.slice(0, dot);
    const ext = dot < 0 ? ' ' : base.slice(dot + 1);
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
