/**
 * A store-only zip writer.
 *
 * The advanced HUD download is a folder (riversidehud/pak01_dir.vpk) plus a
 * README, and a browser cannot hand someone a folder. Nothing here compresses:
 * the payload is a VPK of already-dense textures and fonts, and "stored" keeps
 * this to one header layout with no deflate implementation to get wrong.
 */
import { crc32, type VpkFile } from './index';

const enc = new TextEncoder();
/** 1980-01-01 00:00, the zip epoch. A fixed date keeps the output reproducible. */
const DOS_TIME = 0, DOS_DATE = 0x21;

export function encodeZip(files: VpkFile[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);                      // version needed
    l.setUint16(6, 0x0800, true);                  // names are UTF-8
    l.setUint16(8, 0, true);                       // method: store
    l.setUint16(10, DOS_TIME, true);
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, f.data.length, true);
    l.setUint32(22, f.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, DOS_TIME, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);                 // local header offset
    central.set(name, 46);

    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
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
