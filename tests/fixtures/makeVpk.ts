import { writeFileSync } from 'node:fs';

export interface VpkEntry {
  ext: string;
  dir: string;
  name: string;
  body: string;
  /** Defaults to 0x7fff ("in this file"). Pass a real archive index to
   *  simulate a file whose non-preload bytes live in a numbered archive
   *  (pak01_NNN.vpk) that src/vpk.ts deliberately never opens. */
  archiveIndex?: number;
  /** Bytes of `body` copied inline right after the entry struct. Real VPKs
   *  do this regardless of archive index. Defaults to 0. */
  preloadBytes?: number;
}

/** Write a minimal, valid VPK v1 containing one file, for parser tests.
 *  Only the shape src/vpk.ts reads is produced: one extension, one path, one
 *  filename. By default the data is stored inline in the dir file
 *  (archiveIndex 0x7fff, no preload); pass `archiveIndex` and/or
 *  `preloadBytes` to build a file that is only partly, or not at all,
 *  reachable without opening a numbered archive. */
export function makeVpk(path: string, entry: VpkEntry): void {
  const body = Buffer.from(entry.body, 'utf8');
  const archiveIndex = entry.archiveIndex ?? 0x7fff;
  const preloadBytes = entry.preloadBytes ?? 0;
  const preload = body.subarray(0, preloadBytes);
  // When the data lives in this file, whatever was not preloaded follows the
  // tree. When it lives in a numbered archive, there is nothing else to
  // write here; `length` still records how many bytes are out there so the
  // reader can tell the file is incomplete.
  const tail = archiveIndex === 0x7fff ? body.subarray(preloadBytes) : Buffer.alloc(0);
  const remaining = body.length - preloadBytes;

  const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

  const meta = Buffer.alloc(18);
  meta.writeUInt32LE(0, 0);              // CRC, unchecked by the reader
  meta.writeUInt16LE(preloadBytes, 4);
  meta.writeUInt16LE(archiveIndex, 6);
  meta.writeUInt32LE(0, 8);              // offset, from the end of the tree
  meta.writeUInt32LE(remaining, 12);
  meta.writeUInt16LE(0xffff, 16);        // entry terminator

  const tree = Buffer.concat([
    cstr(entry.ext), cstr(entry.dir), cstr(entry.name), meta, preload,
    Buffer.from([0]), // end of filenames
    Buffer.from([0]), // end of paths
    Buffer.from([0]), // end of extensions
  ]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(tree.length, 8);

  writeFileSync(path, Buffer.concat([header, tree, tail]));
}
