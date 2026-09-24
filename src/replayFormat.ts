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
/** Format version.
 *
 *  3: header bytes 156 and 157 carry a per-slot infected mask and a flag saying
 *  it was filled (see OFF). Frames are unchanged. Before this a reader had to
 *  assume slots 0 to 3 were survivors, which is false in every second half and
 *  for any roster recorded in join order.
 *  2: `cls` carries `m_survivorCharacter` for a survivor, where version 1
 *  always wrote 0. No record grew and no offset moved, so a version 1 file
 *  still decodes correctly; only the meaning of one byte for one team
 *  changed, which is exactly why the version check in `parseReplay` had to
 *  land first. */
export const VERSION = 3;

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
  /** Version 3: bit i set means roster slot i is on the infected side this
   *  round, and `sidesFlag` is 1 when the writer (or the serving route) filled
   *  the mask. Bytes 156 and 157 were zero padding in every earlier version,
   *  so an old file reads as "sides unknown" and falls back to slot order. */
  infectedMask: 156,
  sidesFlag: 157,
  /** 1 when frame bytes 6-7 carry line of sight (see `canSee`). Zero padding
   *  in every file written before 2026-09-23, so those read as "unknown". */
  losFlag: 158,
} as const;

export const INFECTED_MASK_OFFSET: number = OFF.infectedMask;
export const SIDES_FLAG_OFFSET: number = OFF.sidesFlag;
export const LOS_FLAG_OFFSET: number = OFF.losFlag;

export const TOKEN_BYTES = 32;
const MAP_BYTES = 32;

/** Where the session token starts in the header, exported so the byte-serving
 *  route can blank it without restating the offset.
 *
 *  A ranked match's token seeds the game server's `sv_password` in
 *  orchestrator.ts, and the header goes out to anyone who opens the public
 *  live page, so those 32 bytes are zeroed on the wire. Nothing downstream of
 *  the wire reads `header.token`: the one server-side consumer,
 *  `discoverMatchReplays`, reads the file on disk directly. */
export const TOKEN_OFFSET: number = OFF.token;

/** Header fields the live push reads or patches. The writer patches the
 *  index fields and the frame count when it closes a file. */
export const STARTED_UNIX_OFFSET: number = OFF.startedUnix;
export const INDEX_OFFSET_OFFSET: number = OFF.indexOffset;
export const FRAME_COUNT_OFFSET: number = OFF.frameCount;

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

/** Weapon ids as the plugin assigns them in `RplWeaponId`
 *  (`plugin/pug-match.sp:1010`). This is a second copy of that mapping, which
 *  is a cost worth paying here and nowhere else in this format: a wrong
 *  weapon name is visibly wrong on screen, whereas a wrong byte offset
 *  decodes into plausible nonsense. Keep it adjacent to ENTITY_KIND so a
 *  change to one is made in sight of the other. */
export const WEAPON_NAMES: Record<number, string> = {
  1: 'Pistol',
  2: 'SMG',
  3: 'Pump Shotgun',
  4: 'Auto Shotgun',
  5: 'Assault Rifle',
  6: 'Hunting Rifle',
  7: 'Pipe Bomb',
  8: 'Molotov',
  9: 'First Aid Kit',
  10: 'Pain Pills',
};

export function weaponName(id: number): string {
  return WEAPON_NAMES[id] ?? '';
}

/** Survivor character by the index the plugin records in `cls`, from format
 *  version 2 onward. Version 1 files always wrote 0 for a survivor, which is
 *  why a viewer must check the header version before believing this.
 *
 *  The order is assumed to be the engine's `m_survivorCharacter` order, but is
 *  NOT yet verified in game. A wrong order fails silently by putting the wrong
 *  survivor face on the right player, which reads as a viewer bug rather than a
 *  bad constant. Before deploying the version 2 plugin, record a round with known
 *  characters, check each survivor slot's cls byte, and correct this array if it
 *  disagrees. See "Verification still owed" in docs/superpowers/specs/2026-09-12-replay-viewer-design.md. */
export const SURVIVOR_CHARACTERS = ['bill', 'zoey', 'francis', 'louis'] as const;

/** Zombie class by `m_zombieClass`, which the plugin records in `cls` for
 *  infected players in every format version. */
export const ZOMBIE_CLASSES = ['', 'smoker', 'boomer', 'hunter', 'witch', 'tank'] as const;

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
  /** Bit i set: slot i is infected this round. Meaningful only with `sidesKnown`. */
  infectedMask: number;
  /** Whether `infectedMask` was filled. Version 3 writers fill it at round
   *  start; the serving route fills it for older files of a known match.
   *  Without it a reader has only slot order to go on, which is wrong for
   *  every second half and for any roster that was not team-ordered. */
  sidesKnown: boolean;
  /** Whether frames record line of sight in bytes 6-7. False means unknown,
   *  never "nobody saw anything". Optional so hand-built headers need not set
   *  it; `decodeHeader` always does. */
  losKnown?: boolean;
}

export interface PlayerSample {
  slot: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  state: number;
  health: number; temp: number;
  cls: number; weapon: number;
  clip: number; reserve: number;
  /** Which side this slot is on, from the header's side mask when known and
   *  from slot order (0 to 3 survivors) when not. Optional only so hand-built
   *  fixtures need not set it; `decodeFrames` always does. */
  infected?: boolean;
}

/** Side of a roster slot as the header knows it. */
export function slotInfected(h: Pick<ReplayHeader, 'infectedMask' | 'sidesKnown'>, slot: number): boolean {
  return h.sidesKnown ? ((h.infectedMask >> slot) & 1) === 1 : slot >= 4;
}

/** Each slot's rank on its side, the numbering frame bytes 6-7 use: occupied
 *  slots on each side in slot order, at most four per side. -1 for an empty
 *  slot, a slot on the other side, a fifth player, or unknown sides. */
export function sideRanks(h: Pick<ReplayHeader, 'slots' | 'infectedMask' | 'sidesKnown'>): { survivor: number[]; infected: number[] } {
  const survivor = Array<number>(PLAYER_SLOTS).fill(-1);
  const infected = Array<number>(PLAYER_SLOTS).fill(-1);
  if (!h.sidesKnown) return { survivor, infected };
  let s = 0, i = 0;
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    if (!h.slots[slot]) continue;
    if ((h.infectedMask >> slot) & 1) { if (i < 4) infected[slot] = i++; }
    else if (s < 4) survivor[slot] = s++;
  }
  return { survivor, infected };
}

/** Could this survivor see this spawned infected in this frame. Null when the
 *  file does not record it or a slot has no rank on the side asked about:
 *  unknown is never the same as "could not see". `false` also covers pairs
 *  the writer skipped (survivor dead, incapped or ledge-hanging; infected
 *  dead, a ghost or a tank), so a reader must gate on the frame's STATE
 *  flags and `cls` before treating `false` as "hidden". */
export function canSee(h: ReplayHeader, f: Frame, survivorSlot: number, infectedSlot: number): boolean | null {
  if (!h.losKnown) return null;
  const { survivor, infected } = sideRanks(h);
  const sr = survivor[survivorSlot], ir = infected[infectedSlot];
  if (sr === undefined || ir === undefined || sr < 0 || ir < 0) return null;
  return (((f.los ?? 0) >> (sr * 4 + ir)) & 1) === 1;
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
  /** Frame bytes 6-7: bit survivorRank * 4 + infectedRank set when that
   *  survivor could see that spawned infected. Meaningful only when the
   *  header's `losKnown`; read it through `canSee`. */
  los?: number;
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

/** Buffer's read and write helpers are Node-only, and this module is imported
 *  by the browser too. A DataView over the same bytes is the isomorphic
 *  equivalent.
 *
 *  The three-argument constructor is load-bearing. A Node Buffer is usually a
 *  window into a shared pooled ArrayBuffer, so `new DataView(buf.buffer)`
 *  would read from the start of the pool rather than the start of this
 *  buffer, silently returning another allocation's bytes. */
function dv(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Node's 'ascii' encoding masks the high bit off in both directions. The
 *  mask here is not decoration: it is what keeps this a faithful port rather
 *  than a subtly wider encoding. */
function writeAscii(buf: Uint8Array, s: string, off: number, len: number): void {
  buf.fill(0, off, off + len);
  const n = Math.min(s.length, len);
  for (let i = 0; i < n; i++) buf[off + i] = s.charCodeAt(i) & 0x7f;
}

function readAscii(buf: Uint8Array, off: number, len: number): string {
  let end = off + len;
  for (let i = off; i < off + len; i++) {
    if (buf[i] === 0) { end = i; break; }
  }
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s;
}

export function encodeHeader(h: ReplayHeader): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES);
  const v = dv(buf);
  writeAscii(buf, MAGIC, OFF.magic, 4);
  v.setUint16(OFF.version, h.version, true);
  v.setUint8(OFF.ordinal, h.ordinal);
  v.setUint8(OFF.half, h.half);
  v.setUint8(OFF.playerHz, h.playerHz);
  v.setUint8(OFF.entityHz, h.entityHz);
  writeAscii(buf, h.token, OFF.token, TOKEN_BYTES);
  writeAscii(buf, h.map, OFF.map, MAP_BYTES);
  v.setUint32(OFF.startedUnix, h.startedUnix, true);
  v.setUint32(OFF.indexOffset, h.indexOffset, true);
  v.setUint32(OFF.indexCount, h.indexCount, true);
  v.setUint32(OFF.frameCount, h.frameCount, true);
  for (let i = 0; i < PLAYER_SLOTS; i++) {
    const raw = h.slots[i] ?? '';
    v.setBigUint64(OFF.slots + i * 8, raw === '' ? 0n : BigInt(raw), true);
  }
  v.setUint8(OFF.infectedMask, h.sidesKnown ? h.infectedMask & 0xff : 0);
  v.setUint8(OFF.sidesFlag, h.sidesKnown ? 1 : 0);
  v.setUint8(OFF.losFlag, h.losKnown ? 1 : 0);
  return buf;
}

export function decodeHeader(buf: Uint8Array): ReplayHeader | null {
  if (buf.length < HEADER_BYTES) return null;
  if (readAscii(buf, OFF.magic, 4) !== MAGIC) return null;
  const v = dv(buf);
  const slots: string[] = [];
  for (let i = 0; i < PLAYER_SLOTS; i++) {
    const raw = v.getBigUint64(OFF.slots + i * 8, true);
    slots.push(raw === 0n ? '' : raw.toString());
  }
  return {
    version: v.getUint16(OFF.version, true),
    token: readAscii(buf, OFF.token, TOKEN_BYTES),
    ordinal: v.getUint8(OFF.ordinal),
    half: v.getUint8(OFF.half),
    playerHz: v.getUint8(OFF.playerHz),
    entityHz: v.getUint8(OFF.entityHz),
    map: readAscii(buf, OFF.map, MAP_BYTES),
    startedUnix: v.getUint32(OFF.startedUnix, true),
    indexOffset: v.getUint32(OFF.indexOffset, true),
    indexCount: v.getUint32(OFF.indexCount, true),
    frameCount: v.getUint32(OFF.frameCount, true),
    slots,
    infectedMask: v.getUint8(OFF.infectedMask),
    sidesKnown: v.getUint8(OFF.sidesFlag) === 1,
    losKnown: v.getUint8(OFF.losFlag) === 1,
  };
}

export function frameBytes(entityCount: number): number {
  return FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES + entityCount * ENTITY_RECORD_BYTES;
}

export function encodeFrame(f: Frame): Uint8Array {
  const buf = new Uint8Array(frameBytes(f.entities.length));
  const v = dv(buf);
  v.setUint32(0, f.tMs, true);
  v.setUint16(4, f.entities.length, true);
  v.setUint16(6, (f.los ?? 0) & 0xffff, true);
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    const p = f.players[slot];
    const o = FRAME_HEADER_BYTES + slot * PLAYER_RECORD_BYTES;
    if (!p) continue;
    v.setInt16(o, p.x, true);
    v.setInt16(o + 2, p.y, true);
    v.setInt16(o + 4, p.z, true);
    v.setInt16(o + 6, Math.round(p.yaw * YAW_SCALE), true);
    v.setInt8(o + 8, p.pitch);
    v.setUint8(o + 9, p.state);
    v.setUint16(o + 10, p.health, true);
    v.setUint16(o + 12, p.temp, true);
    v.setUint8(o + 14, p.cls);
    v.setUint8(o + 15, p.weapon);
    v.setUint16(o + 16, p.clip, true);
    v.setUint16(o + 18, p.reserve, true);
  }
  let o = FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES;
  for (const e of f.entities) {
    v.setUint16(o, e.ref, true);
    v.setUint8(o + 2, e.kind);
    v.setUint8(o + 3, e.state);
    v.setInt16(o + 4, e.x, true);
    v.setInt16(o + 6, e.y, true);
    v.setInt16(o + 8, e.z, true);
    v.setUint16(o + 10, e.health, true);
    o += ENTITY_RECORD_BYTES;
  }
  return buf;
}

/** Decode frames from `from` up to `end`. `end` excludes the keyframe index,
 *  which lives after the last frame and would otherwise be decoded as one. */
export function decodeFrames(
  buf: Uint8Array, from: number, end: number,
  sideOf: (slot: number) => boolean = (slot) => slot >= 4,
): { frames: Frame[]; truncatedBytes: number } {
  const v = dv(buf);
  const frames: Frame[] = [];
  let off = from;
  while (off + FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES <= end) {
    const tMs = v.getUint32(off, true);
    const count = v.getUint16(off + 4, true);
    const los = v.getUint16(off + 6, true);
    const size = frameBytes(count);
    // A frame whose declared entity count runs past the end is the partial
    // tail of a writer that died mid-frame. Stop; do not guess.
    if (off + size > end) break;
    const players: PlayerSample[] = [];
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      const o = off + FRAME_HEADER_BYTES + slot * PLAYER_RECORD_BYTES;
      players.push({
        slot,
        x: v.getInt16(o, true), y: v.getInt16(o + 2, true), z: v.getInt16(o + 4, true),
        yaw: v.getInt16(o + 6, true) / YAW_SCALE,
        pitch: v.getInt8(o + 8),
        state: v.getUint8(o + 9),
        health: v.getUint16(o + 10, true),
        temp: v.getUint16(o + 12, true),
        cls: v.getUint8(o + 14),
        weapon: v.getUint8(o + 15),
        clip: v.getUint16(o + 16, true),
        reserve: v.getUint16(o + 18, true),
        infected: sideOf(slot),
      });
    }
    const entities: EntitySample[] = [];
    let eo = off + FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES;
    for (let i = 0; i < count; i++) {
      entities.push({
        ref: v.getUint16(eo, true),
        kind: v.getUint8(eo + 2),
        state: v.getUint8(eo + 3),
        x: v.getInt16(eo + 4, true), y: v.getInt16(eo + 6, true), z: v.getInt16(eo + 8, true),
        health: v.getUint16(eo + 10, true),
      });
      eo += ENTITY_RECORD_BYTES;
    }
    frames.push({ tMs, players, entities, offset: off, los });
    off += size;
  }
  return { frames, truncatedBytes: end - off };
}

export function decodeIndex(buf: Uint8Array, h: ReplayHeader): { tMs: number; offset: number }[] {
  if (h.indexOffset <= 0 || h.indexCount <= 0) return [];
  const v = dv(buf);
  const out: { tMs: number; offset: number }[] = [];
  for (let i = 0; i < h.indexCount; i++) {
    const o = h.indexOffset + i * INDEX_RECORD_BYTES;
    if (o + INDEX_RECORD_BYTES > buf.length) break;
    out.push({ tMs: v.getUint32(o, true), offset: v.getUint32(o + 4, true) });
  }
  return out;
}

/** Parse a whole replay. Never throws: a malformed file yields null and a
 *  truncated one yields every whole frame it did contain. */
export function parseReplay(buf: Uint8Array): Replay | null {
  const header = decodeHeader(buf);
  if (!header) return null;
  // A newer writer may have changed a record's size or the meaning of a
  // field. Either way the bytes after this header decode into something that
  // looks fine and is wrong, so refusing is the only safe answer. Older
  // versions stay readable: this is a ceiling, not an equality check.
  if (header.version > VERSION) return null;
  // An index means the writer closed cleanly and the frames stop where it
  // begins. No index means the file was never closed, so frames run to EOF
  // and the last one may be a fragment.
  const end = header.indexOffset > 0 && header.indexOffset <= buf.length
    ? header.indexOffset
    : buf.length;
  const { frames, truncatedBytes } = decodeFrames(buf, HEADER_BYTES, end, (slot) => slotInfected(header, slot));
  return { header, frames, truncatedBytes };
}
