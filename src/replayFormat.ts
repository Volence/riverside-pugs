/**
 * The replay file byte layout, defined once.
 *
 * This module is deliberately pure: buffers in, objects out, no filesystem.
 * That is what lets the format be tested exhaustively in milliseconds, and it
 * is why the encoder exists even though nothing in production writes a replay
 * from TypeScript. The real writer is SourcePawn in `plugin/pug-match.sp`, and
 * the encoder here is the reference it has to agree with. When the two
 * disagree the tests here still pass, so the in-game verification in the
 * plan's final task is what actually closes that loop.
 *
 * Everything is explicit little-endian, written byte by byte. Nothing is a
 * native word, so no reader ever has to agree with the game server about
 * endianness or struct padding.
 */

export const MAGIC = 'L4RP';
export const VERSION = 1;

export const HEADER_BYTES = 160;
export const PLAYER_SLOTS = 8;
export const PLAYER_RECORD_BYTES = 20;
export const PLAYER_BLOCK_BYTES = PLAYER_SLOTS * PLAYER_RECORD_BYTES; // 160
export const FRAME_HEADER_BYTES = 8;
export const ENTITY_RECORD_BYTES = 12;
export const INDEX_RECORD_BYTES = 8;

/** Yaw is stored as degrees * 100 in an int16. Range is +/- 327.67, which
 *  covers the +/- 180 a yaw can be with room to spare, at 0.01 degree
 *  resolution. Pitch needs no scale: it is a whole degree in an int8. */
export const YAW_SCALE = 100;

/** Header field offsets. Every one of these is a number the SourcePawn writer
 *  hardcodes too. Changing one here without changing it there produces a file
 *  that parses into plausible nonsense rather than an error. */
const OFF = {
  magic: 0, version: 4, ordinal: 6, half: 7,
  playerHz: 8, entityHz: 9,
  token: 12, map: 44,
  startedUnix: 76, indexOffset: 80, indexCount: 84,
  slots: 88,
  frameCount: 152,
} as const;

const TOKEN_BYTES = 32;
const MAP_BYTES = 32;

/** Player and entity state bits. A slot with state 0 is not occupied at all,
 *  which is distinct from a dead player: dead is PRESENT set and ALIVE clear. */
export const STATE = {
  PRESENT: 1 << 0,
  ALIVE: 1 << 1,
  INCAP: 1 << 2,
  LEDGED: 1 << 3,
  PINNED: 1 << 4,
  BILED: 1 << 5,
  BURNING: 1 << 6,
  /** Infected that has not spawned yet. The most competitively sensitive bit
   *  in the file, and the reason the live delay is enforced server-side. */
  GHOST: 1 << 7,
} as const;

/** What an entity record describes. Everything that is not one of the eight
 *  rostered players lands here, which is why AI tanks, survivor bots and AI
 *  special infected are entities rather than player records: the player block
 *  is the roster, and a bot never joins the roster.
 *
 *  AI special infected get one kind each rather than a shared kind plus a
 *  class field. A uint8 has 256 values and the record has no spare byte, so
 *  spending kinds is free and packing a class into spare bits is not. */
export const ENTITY_KIND = {
  COMMON: 1,
  WITCH: 2,
  TANK_ROCK: 3,
  TANK_AI: 4,
  SURVIVOR_BOT: 5,
  SMOKER_AI: 6,
  BOOMER_AI: 7,
  HUNTER_AI: 8,
} as const;

export interface ReplayHeader {
  version: number;
  token: string;
  ordinal: number;
  half: number;
  playerHz: number;
  entityHz: number;
  map: string;
  startedUnix: number;
  /** Byte offset of the keyframe index, or 0 when the file was never closed.
   *  Zero can never be a real offset because the header occupies byte zero. */
  indexOffset: number;
  indexCount: number;
  /** Frames written, patched into the header when the writer closes. 0 means
   *  the file was never closed, NOT that it is empty. It exists so indexing a
   *  replay is a 160 byte read rather than a full parse of a file that can run
   *  to 15 MB. A consumer that needs the true count of a never-closed file
   *  must parse it. */
  frameCount: number;
  /** SteamID64 as a decimal string per roster slot, or '' for an empty slot. */
  slots: string[];
}

export interface PlayerSample {
  slot: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  state: number;
  health: number; temp: number;
  cls: number; weapon: number;
  clip: number; reserve: number;
}

export interface EntitySample {
  /** Engine entity index. Indices are recycled, so two entities far apart in
   *  time can share one. Treat this as an identity hint for interpolation,
   *  never as a durable key. */
  ref: number;
  kind: number;
  state: number;
  x: number; y: number; z: number;
  health: number;
}

export interface Frame {
  tMs: number;
  players: PlayerSample[];
  entities: EntitySample[];
  /** Byte offset this frame starts at. Filled in by the decoder; ignored by
   *  the encoder. This is what the keyframe index stores. */
  offset: number;
}

export interface Replay {
  header: ReplayHeader;
  frames: Frame[];
  /** Bytes of a partial final frame that were dropped. Non-zero means the
   *  writer died mid-frame, which is expected after a crash and is not an
   *  error. */
  truncatedBytes: number;
}

function writeAscii(buf: Buffer, s: string, off: number, len: number): void {
  buf.fill(0, off, off + len);
  buf.write(s.slice(0, len), off, len, 'ascii');
}

function readAscii(buf: Buffer, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('ascii');
}

export function encodeHeader(h: ReplayHeader): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES);
  buf.write(MAGIC, OFF.magic, 4, 'ascii');
  buf.writeUInt16LE(h.version, OFF.version);
  buf.writeUInt8(h.ordinal, OFF.ordinal);
  buf.writeUInt8(h.half, OFF.half);
  buf.writeUInt8(h.playerHz, OFF.playerHz);
  buf.writeUInt8(h.entityHz, OFF.entityHz);
  writeAscii(buf, h.token, OFF.token, TOKEN_BYTES);
  writeAscii(buf, h.map, OFF.map, MAP_BYTES);
  buf.writeUInt32LE(h.startedUnix, OFF.startedUnix);
  buf.writeUInt32LE(h.indexOffset, OFF.indexOffset);
  buf.writeUInt32LE(h.indexCount, OFF.indexCount);
  buf.writeUInt32LE(h.frameCount, OFF.frameCount);
  for (let i = 0; i < PLAYER_SLOTS; i++) {
    const raw = h.slots[i] ?? '';
    buf.writeBigUInt64LE(raw === '' ? 0n : BigInt(raw), OFF.slots + i * 8);
  }
  return buf;
}

export function decodeHeader(buf: Buffer): ReplayHeader | null {
  if (buf.length < HEADER_BYTES) return null;
  if (readAscii(buf, OFF.magic, 4) !== MAGIC) return null;
  const slots: string[] = [];
  for (let i = 0; i < PLAYER_SLOTS; i++) {
    const raw = buf.readBigUInt64LE(OFF.slots + i * 8);
    slots.push(raw === 0n ? '' : raw.toString());
  }
  return {
    version: buf.readUInt16LE(OFF.version),
    token: readAscii(buf, OFF.token, TOKEN_BYTES),
    ordinal: buf.readUInt8(OFF.ordinal),
    half: buf.readUInt8(OFF.half),
    playerHz: buf.readUInt8(OFF.playerHz),
    entityHz: buf.readUInt8(OFF.entityHz),
    map: readAscii(buf, OFF.map, MAP_BYTES),
    startedUnix: buf.readUInt32LE(OFF.startedUnix),
    indexOffset: buf.readUInt32LE(OFF.indexOffset),
    indexCount: buf.readUInt32LE(OFF.indexCount),
    frameCount: buf.readUInt32LE(OFF.frameCount),
    slots,
  };
}

export function frameBytes(entityCount: number): number {
  return FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES + entityCount * ENTITY_RECORD_BYTES;
}

export function encodeFrame(f: Frame): Buffer {
  const buf = Buffer.alloc(frameBytes(f.entities.length));
  buf.writeUInt32LE(f.tMs, 0);
  buf.writeUInt16LE(f.entities.length, 4);
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    const p = f.players[slot];
    const o = FRAME_HEADER_BYTES + slot * PLAYER_RECORD_BYTES;
    if (!p) continue;
    buf.writeInt16LE(p.x, o);
    buf.writeInt16LE(p.y, o + 2);
    buf.writeInt16LE(p.z, o + 4);
    buf.writeInt16LE(Math.round(p.yaw * YAW_SCALE), o + 6);
    buf.writeInt8(p.pitch, o + 8);
    buf.writeUInt8(p.state, o + 9);
    buf.writeUInt16LE(p.health, o + 10);
    buf.writeUInt16LE(p.temp, o + 12);
    buf.writeUInt8(p.cls, o + 14);
    buf.writeUInt8(p.weapon, o + 15);
    buf.writeUInt16LE(p.clip, o + 16);
    buf.writeUInt16LE(p.reserve, o + 18);
  }
  let o = FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES;
  for (const e of f.entities) {
    buf.writeUInt16LE(e.ref, o);
    buf.writeUInt8(e.kind, o + 2);
    buf.writeUInt8(e.state, o + 3);
    buf.writeInt16LE(e.x, o + 4);
    buf.writeInt16LE(e.y, o + 6);
    buf.writeInt16LE(e.z, o + 8);
    buf.writeUInt16LE(e.health, o + 10);
    o += ENTITY_RECORD_BYTES;
  }
  return buf;
}

/** Decode frames from `from` up to `end`. `end` excludes the keyframe index,
 *  which lives after the last frame and would otherwise be decoded as one. */
export function decodeFrames(
  buf: Buffer, from: number, end: number,
): { frames: Frame[]; truncatedBytes: number } {
  const frames: Frame[] = [];
  let off = from;
  while (off + FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES <= end) {
    const tMs = buf.readUInt32LE(off);
    const count = buf.readUInt16LE(off + 4);
    const size = frameBytes(count);
    // A frame whose declared entity count runs past the end is the partial
    // tail of a writer that died mid-frame. Stop; do not guess.
    if (off + size > end) break;
    const players: PlayerSample[] = [];
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      const o = off + FRAME_HEADER_BYTES + slot * PLAYER_RECORD_BYTES;
      players.push({
        slot,
        x: buf.readInt16LE(o), y: buf.readInt16LE(o + 2), z: buf.readInt16LE(o + 4),
        yaw: buf.readInt16LE(o + 6) / YAW_SCALE,
        pitch: buf.readInt8(o + 8),
        state: buf.readUInt8(o + 9),
        health: buf.readUInt16LE(o + 10),
        temp: buf.readUInt16LE(o + 12),
        cls: buf.readUInt8(o + 14),
        weapon: buf.readUInt8(o + 15),
        clip: buf.readUInt16LE(o + 16),
        reserve: buf.readUInt16LE(o + 18),
      });
    }
    const entities: EntitySample[] = [];
    let eo = off + FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES;
    for (let i = 0; i < count; i++) {
      entities.push({
        ref: buf.readUInt16LE(eo),
        kind: buf.readUInt8(eo + 2),
        state: buf.readUInt8(eo + 3),
        x: buf.readInt16LE(eo + 4), y: buf.readInt16LE(eo + 6), z: buf.readInt16LE(eo + 8),
        health: buf.readUInt16LE(eo + 10),
      });
      eo += ENTITY_RECORD_BYTES;
    }
    frames.push({ tMs, players, entities, offset: off });
    off += size;
  }
  return { frames, truncatedBytes: end - off };
}

export function decodeIndex(buf: Buffer, h: ReplayHeader): { tMs: number; offset: number }[] {
  if (h.indexOffset <= 0 || h.indexCount <= 0) return [];
  const out: { tMs: number; offset: number }[] = [];
  for (let i = 0; i < h.indexCount; i++) {
    const o = h.indexOffset + i * INDEX_RECORD_BYTES;
    if (o + INDEX_RECORD_BYTES > buf.length) break;
    out.push({ tMs: buf.readUInt32LE(o), offset: buf.readUInt32LE(o + 4) });
  }
  return out;
}

/** Parse a whole replay. Never throws: a malformed file yields null and a
 *  truncated one yields every whole frame it did contain. */
export function parseReplay(buf: Buffer): Replay | null {
  const header = decodeHeader(buf);
  if (!header) return null;
  // An index means the writer closed cleanly and the frames stop where it
  // begins. No index means the file was never closed, so frames run to EOF
  // and the last one may be a fragment.
  const end = header.indexOffset > 0 && header.indexOffset <= buf.length
    ? header.indexOffset
    : buf.length;
  const { frames, truncatedBytes } = decodeFrames(buf, HEADER_BYTES, end);
  return { header, frames, truncatedBytes };
}
