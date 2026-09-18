import { writeFileSync } from 'node:fs';

/** Write a minimal, valid VPK v1 containing one file, for parser tests.
 *  Only the shape src/vpk.ts reads is produced: one extension, one path, one
 *  filename, data stored inline in the dir file. */
export function makeVpk(path: string, entry: { ext: string; dir: string; name: string; body: string }): void {
  const body = Buffer.from(entry.body, 'utf8');
  const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

  const meta = Buffer.alloc(18);
  meta.writeUInt32LE(0, 0);          // CRC, unchecked by the reader
  meta.writeUInt16LE(0, 4);          // preload bytes
  meta.writeUInt16LE(0x7fff, 6);     // archive index: this file
  meta.writeUInt32LE(0, 8);          // offset, from the end of the tree
  meta.writeUInt32LE(body.length, 12);
  meta.writeUInt16LE(0xffff, 16);    // entry terminator

  const tree = Buffer.concat([
    cstr(entry.ext), cstr(entry.dir), cstr(entry.name), meta,
    Buffer.from([0]), // end of filenames
    Buffer.from([0]), // end of paths
    Buffer.from([0]), // end of extensions
  ]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(tree.length, 8);

  writeFileSync(path, Buffer.concat([header, tree, body]));
}
