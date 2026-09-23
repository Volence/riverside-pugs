import {
  closeSync, mkdirSync, openSync, readSync, statSync, truncateSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  decodeHeader, HEADER_BYTES, INDEX_RECORD_BYTES,
  STARTED_UNIX_OFFSET, INDEX_OFFSET_OFFSET, FRAME_COUNT_OFFSET,
} from './replayFormat.js';

/**
 * Live replay bytes pushed by a game server.
 *
 * The site keeps a copy of the round's file in its live directory that is
 * always an exact prefix of the real file. That is the whole integrity
 * argument: a batch is written only when it starts exactly where the copy
 * ends, so a lost, repeated or reordered request can never leave a hole or a
 * duplicate, and the plugin resumes from whatever length it is told.
 *
 * The file name alone does not identify a round: the same token, ordinal and
 * half are reused when a round is aborted and restarted before the plugin
 * ever confirms the abort. Every batch therefore also carries `started`, the
 * round header's own `startedUnix`, and every write is checked against it: an
 * offset-0 batch replaces the copy only when its round is newer, and any
 * other batch is refused outright when it names a different round, even one
 * whose offset happens to coincide with where the current copy stands. See
 * `applyPush` for the concrete rules.
 */

/** Largest decoded batch accepted. The plugin sends at most 48 KiB. */
export const PUSH_MAX_DATA_BYTES = 64 * 1024;
/** Request body cap, enforced by fastify before parsing. Base64 of the data
 *  cap is 87,384 characters; the rest is room for the other fields. */
export const PUSH_BODY_LIMIT = 128 * 1024;
/** No live file grows past this. The plugin's own per-round cap
 *  (sm_pug_replay_max_mb) defaults to 64 MB, and a full round is 10 to 15. */
export const PUSH_MAX_FILE_BYTES = 64 * 1024 * 1024;

const TOKEN_RE = /^[0-9a-f]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface FinalPatch { indexOffset: number; indexCount: number; frameCount: number }
export interface PushBatch {
  token: string;
  ordinal: number;
  half: 1 | 2;
  offset: number;
  /** The round header's own `startedUnix`, the same value `encodeHeader`
   *  puts at STARTED_UNIX_OFFSET. Round identity, not just the file name:
   *  see the module doc comment. */
  started: number;
  closed: boolean;
  data: Buffer;
  final: FinalPatch | null;
}
export type ParsedPush = { ok: true; batch: PushBatch } | { ok: false; status: 400 | 413; error: string };
export type PushResult =
  | { status: 200; length: number }
  | { status: 409; length: number; error?: string }
  | { status: 400; error: string };

function isU32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff;
}

export function liveFileName(token: string, ordinal: number, half: number): string {
  return `pug_${token}_${ordinal}_${half}.rpl`;
}

/** Validate a request body. Nothing here touches the disk or the database. */
export function parsePush(body: unknown): ParsedPush {
  const bad = (error: string): ParsedPush => ({ ok: false, status: 400, error });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('expected a JSON object');
  const b = body as Record<string, unknown>;
  const { token, ordinal, half, offset, started, closed, data } = b;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return bad('bad token');
  if (!isU32(ordinal) || ordinal > 999) return bad('bad ordinal');
  if (half !== 1 && half !== 2) return bad('bad half');
  if (!isU32(offset)) return bad('bad offset');
  if (!isU32(started)) return bad('bad started');
  if (closed !== undefined && typeof closed !== 'boolean') return bad('bad closed');
  const isClosed = closed === true;
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64_RE.test(data)) return bad('bad data');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > PUSH_MAX_DATA_BYTES) return { ok: false, status: 413, error: 'batch too large' };
  if (bytes.length === 0 && !isClosed) return bad('empty batch');
  if (offset + bytes.length > PUSH_MAX_FILE_BYTES) return { ok: false, status: 413, error: 'file too large' };

  let final: FinalPatch | null = null;
  if (b.final !== undefined && b.final !== null) {
    if (!isClosed) return bad('final without closed');
    if (typeof b.final !== 'object' || Array.isArray(b.final)) return bad('bad final');
    const f = b.final as Record<string, unknown>;
    if (!isU32(f.indexOffset) || !isU32(f.indexCount) || !isU32(f.frameCount)) return bad('bad final');
    final = { indexOffset: f.indexOffset, indexCount: f.indexCount, frameCount: f.frameCount };
  }
  return { ok: true, batch: { token, ordinal, half, offset, started, closed: isClosed, data: bytes, final } };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readU32(path: string, at: number): number | null {
  const buf = Buffer.alloc(4);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    return readSync(fd, buf, 0, 4, at) === 4 ? buf.readUInt32LE(0) : null;
  } finally {
    closeSync(fd);
  }
}

/** Read `length` bytes at `at`, or null when the file is missing or shorter
 *  than that. Used only to compare an overlapping batch against what is
 *  already on disk; never to serve a read. */
function readRange(path: string, at: number, length: number): Buffer | null {
  if (length === 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    return readSync(fd, buf, 0, length, at) === length ? buf : null;
  } finally {
    closeSync(fd);
  }
}

/** Write the values RplClose patches into the real file's header, so the
 *  copy ends byte for byte equal to it. Only into a whole header, and only an
 *  index that lies inside the file: a bad patch would make a seek jump into
 *  nonsense, and skipping it only makes seeking slow. */
function patchFinal(path: string, f: FinalPatch, length: number): void {
  if (length < HEADER_BYTES) return;
  if (f.indexCount > 0 && f.indexOffset + f.indexCount * INDEX_RECORD_BYTES > length) return;
  const idx = Buffer.alloc(8);
  idx.writeUInt32LE(f.indexOffset, 0);
  idx.writeUInt32LE(f.indexCount, 4);
  const frames = Buffer.alloc(4);
  frames.writeUInt32LE(f.frameCount, 0);
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, idx, 0, 8, INDEX_OFFSET_OFFSET);
    writeSync(fd, frames, 0, 4, FRAME_COUNT_OFFSET);
  } finally {
    closeSync(fd);
  }
}

/** Directories `applyPush` has already ensured exist, so a busy round is not
 *  paying for a `mkdirSync` stat on every single batch. Safe across rounds
 *  and across live directories: creating a directory that is already there
 *  is a no-op, this only skips asking. */
const ensuredDirs = new Set<string>();
function ensureDir(dir: string): void {
  if (ensuredDirs.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

/**
 * Apply one batch to the live copy. Synchronous on purpose: Node runs one
 * handler at a time, so the length and header read here cannot change before
 * the write.
 *
 * Round identity, not just offset, decides what is accepted:
 * - An offset-0 batch whose round is older than the one already on disk
 *   (`started` smaller) is refused with 409 'stale round' and the file is
 *   left untouched. An offset-0 batch whose round is newer replaces the
 *   copy. This is what stops a late offset-0 batch from an old round, sent
 *   before a restart but processed after it, from truncating a newer round's
 *   copy and grafting old bytes onto it.
 * - Any other batch whose `started` does not match the copy's own header is
 *   refused with 409, regardless of what offset it claims. Offset alone
 *   cannot tell two rounds apart: a stray old-round batch can land on an
 *   offset that happens to equal the new round's current length.
 * - A batch that overlaps bytes already written is accepted, without
 *   writing, only when those bytes are identical to what is on disk. Anything
 *   else, including a same-second restart (same `started`, different
 *   content), is refused rather than silently kept or silently overwritten.
 */
export function applyPush(liveDir: string, b: PushBatch): PushResult {
  ensureDir(liveDir);
  const path = join(liveDir, liveFileName(b.token, b.ordinal, b.half));
  let length = sizeOf(path);
  let existingStarted: number | null = length >= HEADER_BYTES ? readU32(path, STARTED_UNIX_OFFSET) : null;

  if (b.offset === 0 && b.data.length > 0) {
    // The first batch carries the header. It must be whole, and it must name
    // the exact round the file name already encodes: same token, half and
    // ordinal.
    if (b.data.length < HEADER_BYTES) return { status: 400, error: 'the first batch must carry the whole header' };
    const h = decodeHeader(b.data);
    if (!h || h.token !== b.token || h.half !== b.half || h.ordinal !== b.ordinal) {
      return { status: 400, error: 'the header does not match the batch' };
    }
    if (existingStarted !== null && existingStarted !== b.started) {
      if (b.started > existingStarted) {
        truncateSync(path, 0);
        length = 0;
        existingStarted = null;
      } else {
        return { status: 409, length, error: 'stale round' };
      }
    }
  } else if (b.offset !== 0 && existingStarted !== null && existingStarted !== b.started) {
    return { status: 409, length, error: 'stale round' };
  }

  const end = b.offset + b.data.length;
  if (b.offset < length) {
    if (end > length) return { status: 409, length };
    const onDisk = readRange(path, b.offset, b.data.length);
    if (onDisk === null || !onDisk.equals(b.data)) return { status: 409, length };
    // Already written, byte for byte: a retry whose reply was lost. Write
    // nothing, except the idempotent header patch of a repeated closing batch.
    if (b.closed && b.final && end === length) patchFinal(path, b.final, length);
    return { status: 200, length };
  }
  if (b.offset !== length) return { status: 409, length };

  if (b.data.length > 0) {
    const fd = openSync(path, 'a');
    try {
      writeSync(fd, b.data);
    } finally {
      closeSync(fd);
    }
  }
  if (b.closed && b.final) patchFinal(path, b.final, end);
  return { status: 200, length: end };
}
