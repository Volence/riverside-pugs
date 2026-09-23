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
  closed: boolean;
  data: Buffer;
  final: FinalPatch | null;
}
export type ParsedPush = { ok: true; batch: PushBatch } | { ok: false; status: 400 | 413; error: string };
export type PushResult = { status: 200 | 409; length: number } | { status: 400; error: string };

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
  const { token, ordinal, half, offset, closed, data } = b;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return bad('bad token');
  if (!isU32(ordinal) || ordinal > 999) return bad('bad ordinal');
  if (half !== 1 && half !== 2) return bad('bad half');
  if (!isU32(offset)) return bad('bad offset');
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
  return { ok: true, batch: { token, ordinal, half, offset, closed: isClosed, data: bytes, final } };
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

/**
 * Apply one batch to the live copy. Synchronous on purpose: Node runs one
 * handler at a time, so the length read here cannot change before the write.
 */
export function applyPush(liveDir: string, b: PushBatch): PushResult {
  mkdirSync(liveDir, { recursive: true });
  const path = join(liveDir, liveFileName(b.token, b.ordinal, b.half));
  let length = sizeOf(path);

  if (b.offset === 0 && b.data.length > 0) {
    // The first batch carries the header. It must be whole, and it must name
    // the round it was pushed under.
    if (b.data.length < HEADER_BYTES) return { status: 400, error: 'the first batch must carry the whole header' };
    const h = decodeHeader(b.data);
    if (!h || h.token !== b.token || h.half !== b.half) {
      return { status: 400, error: 'the header does not match the batch' };
    }
    // A round restarted under the same name: the plugin reopened its file
    // from the top, so the copy starts again too. Otherwise the offset rule
    // would refuse this round for good.
    if (length > 0 && readU32(path, STARTED_UNIX_OFFSET) !== h.startedUnix) {
      truncateSync(path, 0);
      length = 0;
    }
  }

  const end = b.offset + b.data.length;
  if (b.offset < length && end <= length) {
    // Already written: a retry whose reply was lost. Answer, write nothing,
    // except the idempotent header patch of a repeated closing batch.
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
