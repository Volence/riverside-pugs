/**
 * A zip reader, for Import a HUD: a player's HUD often comes as a zip of its
 * folder rather than as a .vpk. zip.ts only writes (and only stores); real
 * zips are deflated, which the browser's own DecompressionStream inflates,
 * so no inflate code lives here.
 *
 * The bytes come from a file a player picked, so every read is bounds
 * checked and anything unexpected (zip64, encryption, a method other than
 * store or deflate, a size that does not match) fails with one sentence.
 * The declared unpacked sizes are added up and checked against the cap
 * before anything is inflated, so a zip that claims to be huge costs nothing.
 */
const NOT_ZIP = 'Could not read this file as a VPK or zip';

/** The declared unpacked sizes passed the caller's cap. */
export class ZipTooBig extends Error {}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function readZip(bytes: Uint8Array, maxBytes: number): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => { throw new Error(NOT_ZIP); };
  // The end record is 22 bytes plus a comment of up to 65535; its signature is found searching back.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail();
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > eocd) fail();   // zip64: never a HUD
  const entries: { name: string; method: number; csize: number; usize: number; local: number }[] = [];
  let total = 0;
  let o = cdOffset;
  for (let n = 0; n < count; n++) {
    if (o + 46 > eocd || dv.getUint32(o, true) !== 0x02014b50) fail();
    const flags = dv.getUint16(o + 8, true);
    const method = dv.getUint16(o + 10, true);
    const csize = dv.getUint32(o + 20, true);
    const usize = dv.getUint32(o + 24, true);
    const nameLen = dv.getUint16(o + 28, true);
    const skip = nameLen + dv.getUint16(o + 30, true) + dv.getUint16(o + 32, true);
    const local = dv.getUint32(o + 42, true);
    if (o + 46 + skip > eocd) fail();
    // Bit 11 says the name is UTF-8; without it, it is the old DOS code page, read here as Latin-1.
    const name = new TextDecoder(flags & 0x0800 ? 'utf-8' : 'latin1').decode(bytes.subarray(o + 46, o + 46 + nameLen)).replace(/\\/g, '/');
    o += 46 + skip;
    if (name.endsWith('/')) continue;
    if (flags & 1) fail();                                   // encrypted
    if (method !== 0 && method !== 8) fail();
    total += usize;
    if (total > maxBytes) throw new ZipTooBig();
    entries.push({ name, method, csize, usize, local });
  }
  const out = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.local + 30 > bytes.length || dv.getUint32(e.local, true) !== 0x04034b50) fail();
    const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
    if (start + e.csize > bytes.length) fail();
    const packed = bytes.subarray(start, start + e.csize);
    const data = e.method === 0 ? packed.slice() : await inflate(packed).catch(fail);
    if (data.length !== e.usize) fail();
    out.set(e.name, data);
  }
  return out;
}
