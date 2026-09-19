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
  /** VPK header version: 1 (12-byte header, the default) or 2 (28-byte
   *  header, four extra uint32 fields this reader skips over without
   *  reading). Real campaigns ship both; nothing exercised the v2 offset
   *  until this option existed. */
  version?: 1 | 2;
}

/** Write a minimal, valid VPK containing one file, for parser tests.
 *  Only the shape src/vpk.ts reads is produced: one extension, one path, one
 *  filename. By default the data is stored inline in the dir file
 *  (archiveIndex 0x7fff, no preload, v1 header); pass `archiveIndex` and/or
 *  `preloadBytes` to build a file that is only partly, or not at all,
 *  reachable without opening a numbered archive, and `version: 2` to build
 *  the longer header instead. */
export function makeVpk(path: string, entry: VpkEntry): void {
  const body = Buffer.from(entry.body, 'utf8');
  const archiveIndex = entry.archiveIndex ?? 0x7fff;
  const preloadBytes = entry.preloadBytes ?? 0;
  const version = entry.version ?? 1;
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

  const header = Buffer.alloc(version === 2 ? 28 : 12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(tree.length, 8);
  // v2's four extra fields (data/MD5/signature section sizes) are never read
  // by src/vpk.ts; zero is enough to prove the reader skips past them to the
  // right tree offset rather than reading tree bytes as header fields.

  writeFileSync(path, Buffer.concat([header, tree, tail]));
}

/** Write a valid v1 VPK holding several files, every one stored inline.
 *  makeVpk above writes exactly one entry, which cannot express the case the
 *  consistency check exists for: a real campaign (it has a mission file) that
 *  ALSO ships a path the server enforces. Entries are grouped the way the
 *  format requires, by extension and then by directory, in first-seen order. */
export function makeVpkMulti(path: string, entries: Pick<VpkEntry, 'ext' | 'dir' | 'name' | 'body'>[]): void {
  const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
  const end = Buffer.from([0]);

  const byExt = new Map<string, Map<string, typeof entries>>();
  for (const e of entries) {
    const dirs = byExt.get(e.ext) ?? new Map<string, typeof entries>();
    byExt.set(e.ext, dirs);
    dirs.set(e.dir, [...(dirs.get(e.dir) ?? []), e]);
  }

  const tree: Buffer[] = [];
  const data: Buffer[] = [];
  let offset = 0;
  for (const [ext, dirs] of byExt) {
    tree.push(cstr(ext));
    for (const [dir, files] of dirs) {
      tree.push(cstr(dir));
      for (const f of files) {
        const body = Buffer.from(f.body, 'utf8');
        const meta = Buffer.alloc(18);
        meta.writeUInt32LE(0, 0);            // CRC, unchecked by the reader
        meta.writeUInt16LE(0, 4);            // no preload
        meta.writeUInt16LE(0x7fff, 6);       // data is in this file
        meta.writeUInt32LE(offset, 8);       // from the end of the tree
        meta.writeUInt32LE(body.length, 12);
        meta.writeUInt16LE(0xffff, 16);      // entry terminator
        tree.push(cstr(f.name), meta);
        data.push(body);
        offset += body.length;
      }
      tree.push(end);                        // end of this directory's files
    }
    tree.push(end);                          // end of this extension's directories
  }
  tree.push(end);                            // end of extensions

  const treeBuf = Buffer.concat(tree);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(treeBuf.length, 8);
  writeFileSync(path, Buffer.concat([header, treeBuf, ...data]));
}
