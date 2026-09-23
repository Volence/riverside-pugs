import { crc32 } from './index';

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

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/**
 * Tests only: a zip whose entries may be deflated (method 8) or carry extra
 * flag bits (bit 0 is "encrypted"), which encodeZip never writes. Same
 * layout as encodeZip otherwise: local headers, central directory, end record.
 */
export async function zipOf(files: { path: string; data: Uint8Array; deflate?: boolean; flags?: number }[]): Promise<Uint8Array<ArrayBuffer>> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const body = f.deflate ? await deflate(f.data) : f.data;
    const method = f.deflate ? 8 : 0;
    const flags = 0x0800 | (f.flags ?? 0);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, flags, true); l.setUint16(8, method, true);
    l.setUint32(14, crc32(f.data), true); l.setUint32(18, body.length, true); l.setUint32(22, f.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, flags, true);
    c.setUint16(10, method, true); c.setUint32(16, crc32(f.data), true); c.setUint32(20, body.length, true);
    c.setUint32(24, f.data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(offset + cdSize + 22);
  let o = 0;
  for (const p of locals) { out.set(p, o); o += p.length; }
  for (const p of centrals) { out.set(p, o); o += p.length; }
  const e = new DataView(out.buffer);
  e.setUint32(o, 0x06054b50, true);
  e.setUint16(o + 8, files.length, true);
  e.setUint16(o + 10, files.length, true);
  e.setUint32(o + 12, cdSize, true);
  e.setUint32(o + 16, offset, true);
  return out;
}
