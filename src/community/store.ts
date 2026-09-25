import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Free space the box must keep after a community file lands. The replay
 * pruner's floor on Dallas is 10 GB (see the demo disk pressure note), so this
 * sits 2 GB above it: a shared HUD must never be what pushes the box into the
 * pruner's emergency deletes, let alone a full disk.
 */
export const FLOOR_BYTES = 12 * 1024 ** 3;

const HEX64 = /^[0-9a-f]{64}$/;

export type FileKind = 'preview' | 'import';

const FOLDER: Record<FileKind, string> = { preview: 'previews', import: 'imports' };
const EXT: Record<FileKind, string> = { preview: '.png', import: '.vpk' };

/** Prefix of an in-flight write. The sweep deletes any left behind by a crash. */
export const TEMP_PREFIX = '.tmp-';

export interface CommunityStoreOpts {
  dir: string;
  /** Bytes free on the store's disk. Injected in tests, so the floor check
   *  does not depend on how full the machine running them is. */
  freeBytes?: () => Promise<number>;
  /** The total budget, read at call time, so a change to community_store_mb
   *  applies without a restart. */
  maxBytes: () => number;
  /** Injected in tests to prove a failed rename leaves no file behind. */
  rename?: (from: string, to: string) => void;
}

/**
 * The community files on local disk: previews/<sha256>.png and
 * imports/<hudId>.vpk. Both are content addressed, so a name that exists is
 * never written again, and every name is checked against 64 lowercase hex
 * before it is joined onto a path.
 */
export class CommunityStore {
  readonly dir: string;
  private readonly freeBytes: () => Promise<number>;
  private readonly maxBytes: () => number;
  private readonly renameFn: (from: string, to: string) => void;

  constructor(opts: CommunityStoreOpts) {
    this.dir = opts.dir;
    this.freeBytes = opts.freeBytes
      ?? (async () => { const s = await statfs(this.dir); return s.bsize * s.bavail; });
    this.maxBytes = opts.maxBytes;
    this.renameFn = opts.rename ?? renameSync;
    for (const kind of Object.keys(FOLDER) as FileKind[]) {
      mkdirSync(this.folder(kind), { recursive: true });
    }
  }

  folder(kind: FileKind): string {
    return join(this.dir, FOLDER[kind]);
  }

  private path(kind: FileKind, name: string): string {
    if (!HEX64.test(name)) throw new Error(`bad community file name: ${name}`);
    return join(this.folder(kind), name + EXT[kind]);
  }

  /** Temp name in the same folder, so the rename is atomic on one filesystem.
   *  A failure anywhere removes the temp file and rethrows. */
  private write(kind: FileKind, name: string, bytes: Uint8Array): boolean {
    const final = this.path(kind, name);
    if (exists(final)) return false;
    const temp = join(this.folder(kind), TEMP_PREFIX + randomUUID());
    try {
      writeFileSync(temp, bytes, { flag: 'wx' });
      this.renameFn(temp, final);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
    return true;
  }

  putPreview(bytes: Uint8Array): { name: string; wrote: boolean } {
    const name = createHash('sha256').update(bytes).digest('hex');
    return { name, wrote: this.write('preview', name, bytes) };
  }

  /** The id is the import's hudId, which the caller has already checked
   *  against the VPK's contents. */
  putImport(id: string, bytes: Uint8Array): { wrote: boolean } {
    return { wrote: this.write('import', id, bytes) };
  }

  private read(kind: FileKind, name: string): Buffer | null {
    if (!HEX64.test(name)) return null;
    try {
      return readFileSync(this.path(kind, name));
    } catch {
      return null;
    }
  }

  readPreview(sha: string): Buffer | null { return this.read('preview', sha); }
  readImport(id: string): Buffer | null { return this.read('import', id); }

  has(kind: FileKind, name: string): boolean {
    return HEX64.test(name) && exists(this.path(kind, name));
  }

  remove(kind: FileKind, name: string): void {
    if (!HEX64.test(name)) return;
    rmSync(this.path(kind, name), { force: true });
  }

  /** Every entry in a folder, temp files included, for the sweep. */
  list(kind: FileKind): { file: string; name: string | null; mtimeMs: number }[] {
    const out: { file: string; name: string | null; mtimeMs: number }[] = [];
    for (const file of readdirSync(this.folder(kind))) {
      const full = join(this.folder(kind), file);
      let mtimeMs: number;
      try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
      const name = file.endsWith(EXT[kind]) ? file.slice(0, -EXT[kind].length) : null;
      out.push({ file: full, name: name && HEX64.test(name) ? name : null, mtimeMs });
    }
    return out;
  }

  usedBytes(): number {
    let total = 0;
    for (const kind of Object.keys(FOLDER) as FileKind[]) {
      for (const file of readdirSync(this.folder(kind))) {
        try { total += statSync(join(this.folder(kind), file)).size; } catch { /* gone meanwhile */ }
      }
    }
    return total;
  }

  /** Whether `extra` more bytes fit both the budget and the disk floor. */
  async canTake(extra: number): Promise<boolean> {
    if (this.usedBytes() + extra > this.maxBytes()) return false;
    return (await this.freeBytes()) - extra >= FLOOR_BYTES;
  }
}

function exists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}
