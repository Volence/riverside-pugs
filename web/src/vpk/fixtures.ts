const enc = new TextEncoder();

/**
 * Tests only: a v1 archive written entry by entry, for what encodeVPK never
 * writes, preload bytes and files kept in side archives (_000.vpk), as the
 * _dir.vpk of a multi-part addon has them.
 */
export function handMade(entries: { path: string; archive: number; offset: number; length: number; preload: Uint8Array; data?: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const tree: number[] = [];
  const data: number[] = [];
  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const dir = slash < 0 ? ' ' : e.path.slice(0, slash);
    const base = e.path.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    // One extension and one directory per entry: valid, if not how a packer groups them.
    tree.push(...enc.encode(`${base.slice(dot + 1)}\0${dir}\0${base.slice(0, dot)}\0`));
    const entry = new Uint8Array(18);
    const dv = new DataView(entry.buffer);
    dv.setUint16(4, e.preload.length, true);
    dv.setUint16(6, e.archive, true);
    dv.setUint32(8, e.offset, true);
    dv.setUint32(12, e.length, true);
    dv.setUint16(16, 0xFFFF, true);
    tree.push(...entry, ...e.preload, 0, 0);
    if (e.data) data.push(...e.data);
  }
  tree.push(0);
  const out = new Uint8Array(12 + tree.length + data.length);
  const h = new DataView(out.buffer);
  h.setUint32(0, 0x55AA1234, true);
  h.setUint32(4, 1, true);
  h.setUint32(8, tree.length, true);
  out.set(tree, 12);
  out.set(data, 12 + tree.length);
  return out;
}
