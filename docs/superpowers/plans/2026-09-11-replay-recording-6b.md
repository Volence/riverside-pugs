# Replay Recording (6b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every rostered player and every moving world entity at 10Hz into one binary replay file per round, index and prune those files, and capture chat, so that piece 3 has something to play back and piece 4 has positions to compute from.

**Architecture:** The plugin opens one `.rpl` file in `OnRoundIsLive`, samples on a repeating timer into a single `WriteFile` call per frame, and closes it in `EmitRoundEnd` after appending a keyframe index. The backend is never told about the file over UDP: it discovers replays by filename exactly as `discoverMatchDemos` already does for demos, and reads the header for everything else. `src/replayFormat.ts` is the single definition of the byte layout and is built first, so its encoder is the executable reference the SourcePawn writer gets checked against.

**Tech Stack:** SourcePawn 1.12 (spcomp under wine), TypeScript, Fastify, better-sqlite3, vitest, Node `Buffer`.

**Spec:** `docs/superpowers/specs/2026-09-11-replay-capture-design.md`

**Sibling plans:** 6a (round capture) shipped and is verified in game. 6c (admin storage panel) and piece 3 (the viewer) follow this.

## Global Constraints

- **No em dashes** anywhere: code, comments, docs, commit messages.
- **A replay failure must never affect a ranked result.** Nothing added here may throw into the match result or rating path. Follow the never-throws discipline of `src/demos.ts`.
- **Counters stay authoritative for totals.** Nothing here may be counted to produce a total.
- **Never restart the live server.** `plugin/stage.sh` copies one file and reloads.
- There is deliberately **no migration framework**. New columns go through `ensureColumn` in `src/db.ts`; new tables go in the `SCHEMA` string.
- UDP is lossy, unordered, and can duplicate. Every write triggered by a datagram must be an idempotent upsert.
- **Everything in the replay file is explicit little-endian, written byte by byte.** Never write a native word. The parser must never have to agree with the game server about endianness or struct padding.
- **The plugin never calls `FlushFile`.** The page cache serves a tailing reader without it, and a 10Hz flush is the most direct way to turn an estimated frame cost into a measured stall.
- **The plugin never scans the entity table on the sampling path.** The entity set is maintained in `OnEntityCreated` / `OnEntityDestroyed`.
- Plugin builds via `plugin/build.sh`, which copies sources into the Rotoblin scripting dir and compiles relative, because absolute unix paths break `spcomp` under wine. Any new source file must be copied in and trap-deleted the same way.
- Run tests with `npm test`. Typecheck with `npm run typecheck`.

## File Structure

| File | Responsibility |
|---|---|
| `src/replayFormat.ts` (new) | The byte layout, and nothing else. Pure encode/decode over `Buffer`, no filesystem. Both the reader and the tests build on it, and it is the reference the Pawn writer is checked against. |
| `src/replays.ts` (new) | Filesystem and database. Discovery by filename, indexing into `match_replays`, path resolution with traversal hardening, retention pruning and the free-space floor. Mirrors `src/demos.ts`. |
| `src/replayTail.ts` (new) | The live delay. A pure function over parsed frames answering "which of these may be released at this wall-clock instant". No socket, no timer. |
| `src/db.ts` | `match_replays` and `match_chat` added to `SCHEMA`. |
| `src/logParse.ts` | `CHAT` line decoded into a `chat` `LogEvent`. |
| `src/liveView.ts` | `recordChat` alongside `recordLiveEvent`. |
| `src/server.ts` | Dispatch `chat` to `recordChat`. |
| `src/config.ts` | `replayDir`, mirroring `demoDir`. |
| `plugin/pug-match.sp` | Chat hook, entity tracking, frame writer, four new cvars. |
| `plugin/TESTING.md` | The in-game runbook for this piece. |

---

### Task 1: Replay format module

The byte layout, defined once, in the place it can be tested for a fraction of the cost of testing it in Pawn. Every offset in this file is a number the plugin writer must match exactly, which is why the encoder exists at all: it is not only a test fixture, it is the reference implementation the Pawn writer is diffed against by eye during Task 7.

**Files:**
- Create: `src/replayFormat.ts`
- Test: `tests/replayFormat.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `MAGIC`, `VERSION`, `HEADER_BYTES`, `PLAYER_SLOTS`, `PLAYER_RECORD_BYTES`, `PLAYER_BLOCK_BYTES`, `FRAME_HEADER_BYTES`, `ENTITY_RECORD_BYTES`, `INDEX_RECORD_BYTES`, `STATE`, `ENTITY_KIND`, `YAW_SCALE`, `ReplayHeader`, `PlayerSample`, `EntitySample`, `Frame`, `Replay`, `encodeHeader(h: ReplayHeader): Buffer`, `decodeHeader(buf: Buffer): ReplayHeader | null`, `encodeFrame(f: Frame): Buffer`, `decodeFrames(buf: Buffer, from: number, end: number): { frames: Frame[]; truncatedBytes: number }`, `decodeIndex(buf: Buffer, h: ReplayHeader): { tMs: number; offset: number }[]`, `parseReplay(buf: Buffer): Replay | null`, `frameBytes(entityCount: number): number`

- [ ] **Step 1: Write the failing test**

```ts
// tests/replayFormat.test.ts
import { describe, it, expect } from 'vitest';
import {
  HEADER_BYTES, PLAYER_SLOTS, ENTITY_KIND, STATE, VERSION,
  encodeHeader, decodeHeader, encodeFrame, parseReplay, decodeIndex,
  type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const TOKEN = 'a'.repeat(32);

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 1, half: 2,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1785956274, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['76561198000000001', '76561198000000002', '', '', '', '', '', ''],
    ...over,
  };
}

function frame(over: Partial<Frame> = {}): Frame {
  return {
    tMs: 12345, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
    ...over,
  };
}

describe('replay header', () => {
  it('round-trips every field', () => {
    const h = header();
    const got = decodeHeader(encodeHeader(h));
    expect(got).toEqual(h);
  });

  it('is exactly HEADER_BYTES long', () => {
    expect(encodeHeader(header()).length).toBe(HEADER_BYTES);
  });

  it('round-trips an empty slot as an empty string, not "0"', () => {
    // A zeroed slot means nobody is rostered there. Decoding it as the string
    // "0" would make it look like a SteamID that just happens to be small.
    const got = decodeHeader(encodeHeader(header()));
    expect(got!.slots[7]).toBe('');
  });

  it('round-trips a frame count patched in at close', () => {
    // Indexing reads this instead of parsing the whole file, so a wrong value
    // here is a wrong row in match_replays that nothing later contradicts.
    const got = decodeHeader(encodeHeader(header({ frameCount: 4443 })));
    expect(got!.frameCount).toBe(4443);
  });

  it('rejects a buffer with the wrong magic', () => {
    const buf = encodeHeader(header());
    buf.write('XXXX', 0, 'ascii');
    expect(decodeHeader(buf)).toBeNull();
  });

  it('rejects a buffer shorter than the header', () => {
    expect(decodeHeader(encodeHeader(header()).subarray(0, 40))).toBeNull();
  });
});

describe('replay frame', () => {
  it('round-trips positions, yaw and pitch through their packed widths', () => {
    const f = frame();
    f.players[0] = {
      slot: 0, x: -8192, y: 16000, z: -31, yaw: -179.5, pitch: -42,
      state: STATE.PRESENT | STATE.ALIVE | STATE.BILED,
      health: 100, temp: 196, cls: 0, weapon: 7, clip: 5, reserve: 125,
    };
    const parsed = parseReplay(Buffer.concat([encodeHeader(header()), encodeFrame(f)]));
    expect(parsed!.frames[0].players[0]).toEqual(f.players[0]);
  });

  it('round-trips a variable-length entity block', () => {
    const f = frame({
      entities: [
        { ref: 9, kind: ENTITY_KIND.HUNTER_AI, state: STATE.ALIVE, x: 1, y: 2, z: 3, health: 250 },
        { ref: 11, kind: ENTITY_KIND.COMMON, state: STATE.ALIVE, x: -1, y: -2, z: -3, health: 50 },
        { ref: 12, kind: ENTITY_KIND.WITCH, state: STATE.ALIVE, x: 4, y: 5, z: 6, health: 1000 },
      ],
    });
    const parsed = parseReplay(Buffer.concat([encodeHeader(header()), encodeFrame(f)]));
    expect(parsed!.frames[0].entities).toEqual(f.entities);
  });

  it('reads the entity count from the frame, so frames of different lengths follow each other', () => {
    // This is the property the whole variable-length design rests on. If it
    // fails, frame two is parsed from the middle of frame one and every
    // subsequent frame is garbage.
    const a = frame({ tMs: 100, entities: [{ ref: 1, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 }] });
    const b = frame({ tMs: 200, entities: [] });
    const c = frame({ tMs: 300, entities: Array.from({ length: 30 }, (_, i) => ({
      ref: i + 1, kind: ENTITY_KIND.COMMON, state: 0, x: i, y: 0, z: 0, health: 50,
    })) });
    const parsed = parseReplay(Buffer.concat([encodeHeader(header()), encodeFrame(a), encodeFrame(b), encodeFrame(c)]));
    expect(parsed!.frames.map((f) => f.tMs)).toEqual([100, 200, 300]);
    expect(parsed!.frames[2].entities).toHaveLength(30);
  });

  it('reports each frame its own byte offset, which is what the index points at', () => {
    const parsed = parseReplay(Buffer.concat([encodeHeader(header()), encodeFrame(frame({ tMs: 1 })), encodeFrame(frame({ tMs: 2 }))]));
    expect(parsed!.frames[0].offset).toBe(HEADER_BYTES);
    expect(parsed!.frames[1].offset).toBe(HEADER_BYTES + encodeFrame(frame({ tMs: 1 })).length);
  });
});

describe('truncated files', () => {
  it('keeps every whole frame and reports the partial tail', () => {
    // A crash mid-round leaves exactly this: whole frames then a fragment.
    // Rounding down to the last whole frame is the documented recovery.
    const whole = Buffer.concat([encodeHeader(header()), encodeFrame(frame({ tMs: 1 })), encodeFrame(frame({ tMs: 2 }))]);
    const cut = whole.subarray(0, whole.length - 9);
    const parsed = parseReplay(cut);
    expect(parsed!.frames.map((f) => f.tMs)).toEqual([1]);
    expect(parsed!.truncatedBytes).toBe(encodeFrame(frame({ tMs: 2 })).length - 9);
  });

  it('parses a file whose index was never written', () => {
    // indexOffset stays 0 until the writer closes. Zero must mean "no index",
    // never "an index at byte zero", which is where the header itself lives.
    const buf = Buffer.concat([encodeHeader(header()), encodeFrame(frame({ tMs: 7 }))]);
    const parsed = parseReplay(buf);
    expect(parsed!.header.indexOffset).toBe(0);
    expect(decodeIndex(buf, parsed!.header)).toEqual([]);
    expect(parsed!.frames).toHaveLength(1);
  });
});

describe('keyframe index', () => {
  it('round-trips and does not get parsed as frames', () => {
    const f1 = encodeFrame(frame({ tMs: 0 }));
    const f2 = encodeFrame(frame({ tMs: 10000 }));
    const indexOffset = HEADER_BYTES + f1.length + f2.length;
    const index = Buffer.alloc(16);
    index.writeUInt32LE(0, 0); index.writeUInt32LE(HEADER_BYTES, 4);
    index.writeUInt32LE(10000, 8); index.writeUInt32LE(HEADER_BYTES + f1.length, 12);
    const head = encodeHeader(header({ indexOffset, indexCount: 2, frameCount: 2 }));
    const buf = Buffer.concat([head, f1, f2, index]);

    const parsed = parseReplay(buf);
    // Two frames, not three: the index table sits after them and must be
    // excluded by indexOffset rather than fed to the frame decoder.
    expect(parsed!.frames).toHaveLength(2);
    expect(parsed!.truncatedBytes).toBe(0);
    expect(decodeIndex(buf, parsed!.header)).toEqual([
      { tMs: 0, offset: HEADER_BYTES },
      { tMs: 10000, offset: HEADER_BYTES + f1.length },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- replayFormat`
Expected: FAIL, cannot resolve `../src/replayFormat.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/replayFormat.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- replayFormat && npm run typecheck`
Expected: PASS, all cases green, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/replayFormat.ts tests/replayFormat.test.ts
git commit -m "feat(replay): define the replay file byte layout with a round-trip test"
```

---

### Task 2: Replay discovery and indexing

Files on disk become rows. This mirrors `src/demos.ts` closely enough that it should be read side by side with it, including the path-traversal hardening in `resolveDemoPath`: a filename that comes out of SQLite and goes into a file read is exactly the shape of bug that turns one bad row into arbitrary file disclosure.

The one real difference from demos is where the metadata comes from. A demo row needs only what the directory listing gives. A replay row needs `frames` and `sample_hz`, which live inside the file, so discovery reads each file's 160 byte header.

**Files:**
- Create: `src/replays.ts`
- Modify: `src/db.ts` (add `match_replays` to `SCHEMA`)
- Modify: `src/config.ts` (add `replayDir`)
- Test: `tests/replays.test.ts`

**Interfaces:**
- Consumes: `decodeHeader`, `parseReplay`, `HEADER_BYTES` from `src/replayFormat.ts`; `DB` from `src/db.ts`
- Produces: `ReplayFile`, `discoverMatchReplays(dir: string, token: string): ReplayFile[]`, `recordMatchReplays(db: DB, matchId: number, token: string, dir: string, opts?: { excludeOpen?: boolean }): number`, `resolveReplayPath(db: DB, matchId: number, ordinal: number, half: number, dir: string): { path: string; filename: string; bytes: number } | null`

- [ ] **Step 1: Add the table and the config field**

In `src/db.ts`, add to the `SCHEMA` template string, immediately after the `match_demos` table:

```sql
-- One row per replay file on disk. Mirrors match_demos: the bytes live on
-- disk, this is the index. The row deliberately OUTLIVES the file, so a
-- pruned replay can be reported as expired rather than 404ing: pruned_at is
-- set, the row stays.
--
-- frames and sample_hz are read from the file's own header rather than sent
-- over UDP. There is no REPLAY datagram: discovery is by filename, exactly
-- as discoverMatchDemos works, because the filename already carries the
-- match link by construction and a lost datagram would otherwise leave a
-- real file permanently unindexed.
CREATE TABLE IF NOT EXISTS match_replays (
  match_id  INTEGER NOT NULL REFERENCES matches(id),
  ordinal   INTEGER NOT NULL,
  half      INTEGER NOT NULL,
  filename  TEXT    NOT NULL,
  bytes     INTEGER NOT NULL,
  frames    INTEGER NOT NULL,
  sample_hz INTEGER NOT NULL,
  pruned_at TEXT,
  PRIMARY KEY (match_id, ordinal, half)
);
```

In `src/config.ts`, add to the `Config` interface next to `demoDir`:

```ts
  /** Directory the plugin writes .rpl replay files into. Empty disables replay
   *  indexing entirely, the same default and for the same reason as demoDir:
   *  the backend can only see these files when it shares a filesystem with the
   *  game server. */
  replayDir: string;
```

and to `loadConfig`, next to the `demoDir` line:

```ts
    replayDir: env.REPLAY_DIR ?? '',
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/replays.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { encodeHeader, encodeFrame, HEADER_BYTES, PLAYER_SLOTS, type Frame, type ReplayHeader, VERSION } from '../src/replayFormat.js';
import { discoverMatchReplays, recordMatchReplays, resolveReplayPath } from '../src/replays.js';

const TOKEN = 'b'.repeat(32);
let dir: string;

function head(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 1, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1785956274, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0, entities: [],
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
  };
}

/** Write a closed replay: frames, then an index, with the header patched the
 *  way the plugin patches it at close. */
function writeReplay(name: string, over: Partial<ReplayHeader>, frameCount: number): void {
  const frames = Array.from({ length: frameCount }, (_, i) => encodeFrame(emptyFrame(i * 100)));
  const body = Buffer.concat(frames);
  const index = Buffer.alloc(8);
  index.writeUInt32LE(0, 0);
  index.writeUInt32LE(HEADER_BYTES, 4);
  const h = head({ ...over, frameCount, indexOffset: HEADER_BYTES + body.length, indexCount: 1 });
  writeFileSync(join(dir, name), Buffer.concat([encodeHeader(h), body, index]));
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rpl-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('discoverMatchReplays', () => {
  it('finds files for this token and reads frames and rate from the header', () => {
    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 3);
    writeReplay(`pug_${TOKEN}_1_2.rpl`, { ordinal: 1, half: 2 }, 5);
    const found = discoverMatchReplays(dir, TOKEN);
    expect(found.map((f) => [f.ordinal, f.half, f.frames, f.sampleHz])).toEqual([
      [1, 1, 3, 10],
      [1, 2, 5, 10],
    ]);
  });

  it('ignores another match token, and anything that is not a replay', () => {
    writeReplay(`pug_${'c'.repeat(32)}_1_1.rpl`, { token: 'c'.repeat(32) }, 2);
    writeFileSync(join(dir, `pug_${TOKEN}_1_1.dem`), 'not a replay');
    writeFileSync(join(dir, 'random.rpl'), 'nope');
    expect(discoverMatchReplays(dir, TOKEN)).toEqual([]);
  });

  it('rejects a file whose header token disagrees with its filename', () => {
    // The name says one match, the bytes say another. Trusting the name would
    // file someone else's round under this match.
    writeReplay(`pug_${TOKEN}_1_1.rpl`, { token: 'd'.repeat(32) }, 2);
    expect(discoverMatchReplays(dir, TOKEN)).toEqual([]);
  });

  it('skips a file too short to hold a header', () => {
    writeFileSync(join(dir, `pug_${TOKEN}_2_1.rpl`), Buffer.alloc(10));
    expect(discoverMatchReplays(dir, TOKEN)).toEqual([]);
  });

  it('counts frames by parsing when the header says zero, which means never closed', () => {
    // A crash leaves frameCount 0. The frames written before it are still
    // good, so the row must report them rather than claim the file is empty.
    const body = Buffer.concat([encodeFrame(emptyFrame(0)), encodeFrame(emptyFrame(100))]);
    writeFileSync(join(dir, `pug_${TOKEN}_3_1.rpl`), Buffer.concat([encodeHeader(head({ ordinal: 3, half: 1 })), body]));
    const found = discoverMatchReplays(dir, TOKEN);
    expect(found).toHaveLength(1);
    expect(found[0].frames).toBe(2);
    expect(found[0].closed).toBe(false);
  });

  it('returns nothing for an unreadable directory rather than throwing', () => {
    expect(discoverMatchReplays(join(dir, 'nope'), TOKEN)).toEqual([]);
  });

  it('returns nothing when the directory is unset, which is the feature-off default', () => {
    expect(discoverMatchReplays('', TOKEN)).toEqual([]);
  });
});

describe('recordMatchReplays', () => {
  it('inserts a row per file and upserts on a second run', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;

    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 3);
    expect(recordMatchReplays(db, id, TOKEN, dir)).toBe(1);

    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 9);
    expect(recordMatchReplays(db, id, TOKEN, dir)).toBe(1);

    const rows = db.prepare('SELECT ordinal, half, frames FROM match_replays').all();
    expect(rows).toEqual([{ ordinal: 1, half: 1, frames: 9 }]);
  });

  it('skips a file that is still open when excludeOpen is set', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;

    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 3);
    const body = encodeFrame(emptyFrame(0));
    writeFileSync(join(dir, `pug_${TOKEN}_1_2.rpl`), Buffer.concat([encodeHeader(head({ ordinal: 1, half: 2 })), body]));

    expect(recordMatchReplays(db, id, TOKEN, dir, { excludeOpen: true })).toBe(1);
    const rows = db.prepare('SELECT half FROM match_replays').all();
    expect(rows).toEqual([{ half: 1 }]);
  });
});

describe('resolveReplayPath', () => {
  it('resolves a recorded replay to a real path', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;
    writeReplay(`pug_${TOKEN}_1_1.rpl`, { ordinal: 1, half: 1 }, 3);
    recordMatchReplays(db, id, TOKEN, dir);
    const got = resolveReplayPath(db, id, 1, 1, dir);
    expect(got!.path).toBe(join(dir, `pug_${TOKEN}_1_1.rpl`));
  });

  it('refuses a row whose filename escapes the replay directory', () => {
    // Rows are only ever written from a filtered listing, so this cannot
    // happen from the normal path. It is checked anyway because a database
    // value flowing into a file read is exactly how one bad row becomes
    // arbitrary file disclosure.
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;
    db.prepare(
      `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
       VALUES (?, 1, 1, '../../etc/passwd', 1, 1, 10)`,
    ).run(id);
    expect(resolveReplayPath(db, id, 1, 1, dir)).toBeNull();
  });

  it('returns null for a pruned replay whose row outlived its file', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'no_mercy', ?)`).run(TOKEN);
    const id = (db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as { id: number }).id;
    db.prepare(
      `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
       VALUES (?, 1, 1, ?, 1, 1, 10)`,
    ).run(id, `pug_${TOKEN}_1_1.rpl`);
    expect(resolveReplayPath(db, id, 1, 1, dir)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- replays`
Expected: FAIL, cannot resolve `../src/replays.js`.

- [ ] **Step 4: Write the implementation**

```ts
// src/replays.ts
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DB } from './db.js';
import { HEADER_BYTES, decodeHeader, parseReplay } from './replayFormat.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^pug_[0-9a-f]{32}_\d+_[12]\.rpl$/;

export interface ReplayFile {
  ordinal: number;
  half: number;
  filename: string;
  bytes: number;
  frames: number;
  sampleHz: number;
  /** False when the writer never patched a frame count into the header, which
   *  means the file is either still being written or was abandoned by a crash.
   *  Its frames are still good; only the count had to be recovered. */
  closed: boolean;
}

/** Read just the header of a replay, without pulling the whole file into
 *  memory. A full match is 10 to 15 MB per round and indexing happens on the
 *  request path, so reading 160 bytes matters. */
function readHeader(path: string): ReturnType<typeof decodeHeader> {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const got = readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (got < HEADER_BYTES) return null;
    return decodeHeader(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* nothing useful to do */ }
  }
}

/**
 * Find the replays belonging to one match.
 *
 * Discovery is by filename, exactly as `discoverMatchDemos` works and for the
 * same reason: the plugin names each file `pug_<token>_<ordinal>_<half>.rpl`
 * so the link between a file and its match is a property of the file itself,
 * surviving a backend restart or a match that ended badly. Unlike demos there
 * is no datagram announcing the file at all, so this listing is the only way a
 * replay is ever noticed.
 *
 * Never throws: a missing or unreadable directory yields no replays, because a
 * match result must never fail to record over a replay link.
 */
export function discoverMatchReplays(dir: string, token: string): ReplayFile[] {
  if (!dir || !TOKEN_RE.test(token)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const re = new RegExp(`^pug_${token}_(\\d+)_([12])\\.rpl$`);
  const out: ReplayFile[] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    let bytes: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch {
      continue;
    }
    const header = readHeader(path);
    if (!header) continue;
    // The name claims one match and the bytes claim another. Trusting the name
    // would file some other match's round under this one, so drop it.
    if (header.token !== token) continue;

    let frames = header.frameCount;
    const closed = frames > 0;
    if (!closed) {
      // Never closed, so the count was never patched in. Recovering it means
      // parsing, which is why the header carries the count at all: this branch
      // is the rare one, taken by a crashed or in-progress file.
      try {
        const parsed = parseReplay(readFileSync(path));
        frames = parsed ? parsed.frames.length : 0;
      } catch {
        frames = 0;
      }
    }
    out.push({
      ordinal: Number(m[1]), half: Number(m[2]),
      filename: name, bytes, frames, sampleHz: header.playerHz, closed,
    });
  }
  return out.sort((a, b) => a.ordinal - b.ordinal || a.half - b.half);
}

/**
 * Record a match's replays. Upserts, so re-running after a round closes
 * updates the frame count rather than failing. Returns the row count.
 *
 * `excludeOpen` drops files the writer has not closed, which during a live
 * match is the round in progress. At match completion the flag is off, because
 * by then every round has ended and a file still showing no frame count is a
 * crash worth recording rather than an unfinished write.
 */
export function recordMatchReplays(
  db: DB, matchId: number, token: string, dir: string,
  opts: { excludeOpen?: boolean } = {},
): number {
  let found = discoverMatchReplays(dir, token);
  if (opts.excludeOpen) found = found.filter((r) => r.closed);
  if (found.length === 0) return 0;
  const ins = db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, ordinal, half) DO UPDATE SET
       filename = excluded.filename, bytes = excluded.bytes,
       frames = excluded.frames, sample_hz = excluded.sample_hz`,
  );
  db.transaction(() => {
    for (const r of found) ins.run(matchId, r.ordinal, r.half, r.filename, r.bytes, r.frames, r.sampleHz);
  })();
  return found.length;
}

/**
 * Resolve a recorded replay to an on-disk path, or null.
 *
 * The stored filename is treated as untrusted even though rows are only ever
 * written from a directory listing filtered by a strict pattern, for the same
 * reason `resolveDemoPath` does it: a path that comes out of a database and
 * goes into a file read is exactly the shape of bug that turns a bad row into
 * arbitrary file disclosure.
 */
export function resolveReplayPath(
  db: DB, matchId: number, ordinal: number, half: number, dir: string,
): { path: string; filename: string; bytes: number } | null {
  if (!dir) return null;
  const row = db
    .prepare('SELECT filename FROM match_replays WHERE match_id = ? AND ordinal = ? AND half = ?')
    .get(matchId, ordinal, half) as { filename: string } | undefined;
  if (!row) return null;

  if (row.filename !== basename(row.filename)) return null;
  if (!NAME_RE.test(row.filename)) return null;

  const root = resolve(dir);
  const path = resolve(root, row.filename);
  if (path !== join(root, row.filename)) return null;
  if (!path.startsWith(root + '/')) return null;

  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { path, filename: row.filename, bytes: st.size };
  } catch {
    // Row survives a prune; the file does not. Absent, not an error.
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- replays config db && npm run typecheck`
Expected: PASS. The existing `config.test.ts` may assert the exact shape of `loadConfig`'s output; if it fails, add `replayDir: ''` to its expectation rather than changing the default.

- [ ] **Step 6: Wire indexing into the live path and into match completion**

Nothing calls `recordMatchReplays` yet, so no row would ever be written. The demo equivalent has three call sites; replays need two, at the same places and for the same reasons.

In `src/server.ts`, in the `round_end` branch (right after `recordRoundEnd`), add:

```ts
            // A round just closed, so the plugin has finished its replay file.
            // Rounds are the unit here, unlike demos which are per map, so this
            // is the earliest honest moment to index one. excludeOpen skips the
            // half that is already recording. Upserts, so an early scan is
            // corrected by the next one.
            const rr = deps.db.prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
              .get(ev.token) as { id: number } | undefined;
            if (rr) {
              recordMatchReplays(deps.db, rr.id, ev.token, deps.config.replayDir,
                { excludeOpen: true });
            }
```

and add `recordMatchReplays` to the imports.

In `src/orchestrator.ts`, directly below the `recordMatchDemos` block inside `if (persisted)`:

```ts
      // Same discipline as the demo scan above: after completion, never
      // before, and wrapped because a match result is not allowed to fail over
      // a replay link. excludeOpen is off here: every round has ended, so a
      // file still showing no frame count is a crash worth recording rather
      // than an unfinished write.
      try {
        const n = recordMatchReplays(this.db, matchId, match.token, this.replayDir);
        if (n > 0) console.log(`[orchestrator] recorded ${n} replay(s) for match ${matchId}`);
      } catch (err) {
        console.error(`[orchestrator] replay scan failed for match ${matchId} (non-fatal):`, err);
      }
```

`this.replayDir` follows however `this.demoDir` is already supplied to the orchestrator; add it the same way.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test && npm run typecheck
git add src/replays.ts src/db.ts src/config.ts src/server.ts src/orchestrator.ts tests/replays.test.ts tests/config.test.ts
git commit -m "feat(replay): discover replays by filename and index them from their headers"
```

---

### Task 3: Retention pruning and the free-space floor

The reason this ships in 6b rather than waiting for the admin panel in 6c: this box has already had one disk incident, `tv_autorecord` filling it at about 1.7 GB/day with nothing pruning, 7.76 GB removed by hand on 2026-09-10, root cause still open. 6b is the piece that starts writing 10 to 15 MB per match. Shipping the writer without the pruner is how that happens twice.

The free-space floor lives here rather than in the plugin because SourceMod exposes no disk-free native. The plugin's half of that job is a per-round byte cap, in Task 7.

**Files:**
- Create: `src/replayPrune.ts`
- Modify: `src/db.ts` (two new `DEFAULT_SETTINGS`)
- Test: `tests/replayPrune.test.ts`

**Interfaces:**
- Consumes: `DB` from `src/db.ts`; `getSetting` from `src/settings.ts`
- Produces: `PruneCandidate`, `PruneResult`, `planPrune(db: DB, dir: string, now: Date, retentionDays: number, freeBytes: number, floorBytes: number): PruneCandidate[]`, `prunePlan(db: DB, dir: string, plan: PruneCandidate[]): PruneResult`, `pruneReplays(db: DB, dir: string): PruneResult`

- [ ] **Step 1: Add the settings defaults**

In `src/db.ts`, add to `DEFAULT_SETTINGS`:

```ts
  replay_retention_days: '90',
  replay_free_floor_gb: '10',
```

Settings rather than env so they change without a redeploy, exactly as `map_pool` and `ready_seconds` already do.

- [ ] **Step 2: Write the failing test**

```ts
// tests/replayPrune.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { planPrune, prunePlan } from '../src/replayPrune.js';

const TOKEN = 'e'.repeat(32);
let dir: string;
let db: DB;

/** Insert a completed match that ended `daysAgo` days ago, with one replay
 *  file on disk and a row pointing at it. Returns the filename.
 *
 *  `bytes` is what the ROW claims, not the size of the file written. planPrune
 *  reasons from the indexed size, and the floor tests need multi-gigabyte
 *  values, which must never become multi-gigabyte allocations in a test. */
function seedReplay(daysAgo: number, ordinal: number, bytes = 1024): string {
  const token = TOKEN;
  db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token, ended_at)
     VALUES (1, 'completed', 'no_mercy', ?, datetime('now', ?))`,
  ).run(token, `-${daysAgo} days`);
  const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
  const filename = `pug_${token}_${ordinal}_1.rpl`;
  writeFileSync(join(dir, filename), Buffer.alloc(16));
  db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
     VALUES (?, ?, 1, ?, ?, 10, 10)`,
  ).run(id, ordinal, filename, bytes);
  return filename;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rplprune-'));
  db = openDb(':memory:');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('planPrune', () => {
  it('selects replays past the retention window', () => {
    seedReplay(120, 1);
    seedReplay(10, 2);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    expect(plan.map((c) => c.ordinal)).toEqual([1]);
  });

  it('leaves everything alone when nothing is old and space is fine', () => {
    seedReplay(10, 1);
    expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
  });

  it('never selects a replay of a match that is not completed', () => {
    // A live or configuring match's files are being written right now.
    // Deleting one mid-round is the one failure this whole module must not
    // have, so it is checked on the plan rather than only at delete time.
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, token, ended_at)
       VALUES (1, 'live', 'no_mercy', ?, datetime('now', '-200 days'))`,
    ).run(TOKEN);
    const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
    const filename = `pug_${TOKEN}_1_1.rpl`;
    writeFileSync(join(dir, filename), Buffer.alloc(10));
    db.prepare(
      `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
       VALUES (?, 1, 1, ?, 10, 10, 10)`,
    ).run(id, filename);
    expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
  });

  it('never selects a row that was already pruned', () => {
    seedReplay(120, 1);
    db.prepare(`UPDATE match_replays SET pruned_at = datetime('now')`).run();
    expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
  });

  it('takes the oldest first when free space is below the floor, even inside the window', () => {
    // The floor overrides the retention window, because a full disk stops the
    // game server, which matters more than keeping a three week old replay.
    seedReplay(30, 1);
    seedReplay(20, 2);
    seedReplay(10, 3);
    const plan = planPrune(db, dir, new Date(), 90, 1e9, 10e9);
    expect(plan[0].ordinal).toBe(1);
  });

  it('stops taking files once the floor would be cleared', () => {
    // 9 GB free, 10 GB floor, so 1 GB has to go. Each file here is 2 GB, so
    // exactly one file is enough and the second must be left alone.
    seedReplay(30, 1, 2e9);
    seedReplay(20, 2, 2e9);
    const plan = planPrune(db, dir, new Date(), 90, 9e9, 10e9);
    expect(plan).toHaveLength(1);
    expect(plan[0].ordinal).toBe(1);
  });
});

describe('prunePlan', () => {
  it('deletes the files and marks the rows, keeping the rows themselves', () => {
    const name = seedReplay(120, 1);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    const result = prunePlan(db, dir, plan);

    expect(result.deleted).toBe(1);
    expect(result.bytes).toBe(1024);
    expect(existsSync(join(dir, name))).toBe(false);

    const row = db.prepare('SELECT pruned_at FROM match_replays').get() as { pruned_at: string | null };
    // The row outlives the file so the UI can say "expired" rather than 404.
    expect(row.pruned_at).not.toBeNull();
  });

  it('marks a row whose file is already gone rather than failing', () => {
    seedReplay(120, 1);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    rmSync(join(dir, plan[0].filename));
    const result = prunePlan(db, dir, plan);
    expect(result.deleted).toBe(0);
    expect(result.missing).toBe(1);
    const row = db.prepare('SELECT pruned_at FROM match_replays').get() as { pruned_at: string | null };
    expect(row.pruned_at).not.toBeNull();
  });

  it('refuses a filename that escapes the replay directory', () => {
    seedReplay(120, 1);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    const result = prunePlan(db, dir, [{ ...plan[0], filename: '../../etc/passwd' }]);
    expect(result.deleted).toBe(0);
    expect(result.refused).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- replayPrune`
Expected: FAIL, cannot resolve `../src/replayPrune.js`.

- [ ] **Step 4: Write the implementation**

```ts
// src/replayPrune.ts
import { rmSync, statfsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DB } from './db.js';
import { getSetting } from './settings.js';

const NAME_RE = /^pug_[0-9a-f]{32}_\d+_[12]\.rpl$/;

export interface PruneCandidate {
  matchId: number;
  ordinal: number;
  half: number;
  filename: string;
  bytes: number;
}

export interface PruneResult {
  deleted: number;
  bytes: number;
  /** Rows whose file was already gone. Marked pruned anyway; not an error. */
  missing: number;
  /** Rows whose filename failed the path check and were left entirely alone. */
  refused: number;
}

/**
 * Decide what to delete. Pure apart from reading the database, so the dry run
 * the admin panel will need in 6c is this function called and shown.
 *
 * Two independent reasons a replay is selected:
 *   1. It is older than the retention window.
 *   2. Free space is below the floor, in which case the oldest are taken
 *      regardless of the window until the floor would be cleared. A full disk
 *      stops the game server, which outranks keeping a recent replay.
 *
 * A replay is only ever eligible when its match is completed. A live or
 * configuring match's files are being written right now.
 */
export function planPrune(
  db: DB, dir: string, now: Date, retentionDays: number,
  freeBytes: number, floorBytes: number,
): PruneCandidate[] {
  if (!dir) return [];
  const rows = db.prepare(
    `SELECT r.match_id AS matchId, r.ordinal, r.half, r.filename, r.bytes,
            m.ended_at AS endedAt
       FROM match_replays r
       JOIN matches m ON m.id = r.match_id
      WHERE r.pruned_at IS NULL
        AND m.state = 'completed'
      ORDER BY m.ended_at ASC, r.ordinal ASC, r.half ASC`,
  ).all() as (PruneCandidate & { endedAt: string | null })[];

  const cutoff = new Date(now.getTime() - retentionDays * 86400_000);
  const out: PruneCandidate[] = [];
  const taken = new Set<string>();

  for (const r of rows) {
    if (!r.endedAt) continue;
    // SQLite's datetime('now') is 'YYYY-MM-DD HH:MM:SS', which is not ISO
    // and is not reliably parsed. Make it ISO and stamp it UTC, which is what
    // SQLite wrote.
    if (new Date(r.endedAt.replace(' ', 'T') + 'Z') < cutoff) {
      out.push({ matchId: r.matchId, ordinal: r.ordinal, half: r.half, filename: r.filename, bytes: r.bytes });
      taken.add(r.filename);
    }
  }

  // Rows are already ordered oldest first, so the floor sweep just walks them.
  let projectedFree = freeBytes + out.reduce((n, c) => n + c.bytes, 0);
  for (const r of rows) {
    if (projectedFree >= floorBytes) break;
    if (taken.has(r.filename)) continue;
    out.push({ matchId: r.matchId, ordinal: r.ordinal, half: r.half, filename: r.filename, bytes: r.bytes });
    taken.add(r.filename);
    projectedFree += r.bytes;
  }
  return out;
}

/** Apply a plan. The row is marked rather than deleted, so a pruned replay can
 *  be reported as expired instead of 404ing. */
export function prunePlan(db: DB, dir: string, plan: PruneCandidate[]): PruneResult {
  const result: PruneResult = { deleted: 0, bytes: 0, missing: 0, refused: 0 };
  const root = resolve(dir);
  const mark = db.prepare(
    `UPDATE match_replays SET pruned_at = datetime('now')
      WHERE match_id = ? AND ordinal = ? AND half = ?`,
  );

  for (const c of plan) {
    // Same hardening as resolveReplayPath. Deletion is irreversible, so a
    // filename that is not exactly what we write is left untouched rather
    // than normalised into something plausible.
    if (c.filename !== basename(c.filename) || !NAME_RE.test(c.filename)) {
      result.refused++;
      continue;
    }
    const path = resolve(root, c.filename);
    if (path !== join(root, c.filename) || !path.startsWith(root + '/')) {
      result.refused++;
      continue;
    }
    let removed = false;
    try {
      rmSync(path);
      removed = true;
    } catch {
      // Already gone. The row still needs marking, or it is reconsidered
      // every single day forever.
      result.missing++;
    }
    if (removed) {
      result.deleted++;
      result.bytes += c.bytes;
    }
    mark.run(c.matchId, c.ordinal, c.half);
  }
  return result;
}

/** The daily job. Never throws: a prune failure must not take down the
 *  process that is recording ranked results. */
export function pruneReplays(db: DB, dir: string): PruneResult {
  const empty: PruneResult = { deleted: 0, bytes: 0, missing: 0, refused: 0 };
  if (!dir) return empty;
  try {
    const days = Number(getSetting(db, 'replay_retention_days') ?? '90');
    const floorGb = Number(getSetting(db, 'replay_free_floor_gb') ?? '10');
    const st = statfsSync(dir);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const plan = planPrune(db, dir, new Date(), days, freeBytes, floorGb * 1e9);
    if (plan.length === 0) return empty;
    const result = prunePlan(db, dir, plan);
    console.log(
      `[replay] pruned ${result.deleted} files, ${(result.bytes / 1e6).toFixed(1)} MB`
      + `, ${result.missing} already gone, ${result.refused} refused`,
    );
    return result;
  } catch (err) {
    console.error('[replay] prune failed', err);
    return empty;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- replayPrune && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Schedule the daily job**

In `src/server.ts`, next to wherever the process sets up its other long-lived timers, add:

```ts
  // Daily replay prune. Interval rather than cron because there is no
  // scheduler here and the exact hour does not matter: the window is 90 days.
  // unref so the timer never holds the process open in tests.
  const pruneTimer = setInterval(() => pruneReplays(deps.db, deps.config.replayDir), 24 * 60 * 60 * 1000);
  pruneTimer.unref();
```

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test && npm run typecheck
git add src/replayPrune.ts src/db.ts src/server.ts tests/replayPrune.test.ts
git commit -m "feat(replay): prune past the retention window and below the free space floor"
```

---

### Task 4: The live delay

The server-side hold that makes a public live replay safe. A top-down view showing every infected player's position is perfect information for anyone watching a ranked PUG on a second monitor, and the `GHOST` state bit makes it worse: it shows where an infected is about to spawn from. If the client applied the delay, someone would read the socket directly and ghost. So the backend never hands out a frame newer than `now - delay`.

Built and tested here as a pure function. The socket that calls it arrives with the viewer in piece 3.

**Files:**
- Create: `src/replayTail.ts`
- Test: `tests/replayTail.test.ts`

**Interfaces:**
- Consumes: `Frame` from `src/replayFormat.ts`
- Produces: `DEFAULT_DELAY_MS`, `releasableFrames(frames: Frame[], roundStartedUnixMs: number, nowMs: number, delayMs?: number): Frame[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/replayTail.test.ts
import { describe, it, expect } from 'vitest';
import { PLAYER_SLOTS, type Frame } from '../src/replayFormat.js';
import { DEFAULT_DELAY_MS, releasableFrames } from '../src/replayTail.js';

function f(tMs: number): Frame {
  return {
    tMs, offset: 0, entities: [],
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
  };
}

const START = 1_000_000_000_000;

describe('releasableFrames', () => {
  it('is ten seconds by default', () => {
    expect(DEFAULT_DELAY_MS).toBe(10_000);
  });

  it('releases only frames older than the delay', () => {
    const frames = [f(0), f(5_000), f(10_000), f(15_000)];
    // 20s into the round, so anything at or before t=10s is releasable.
    const got = releasableFrames(frames, START, START + 20_000);
    expect(got.map((x) => x.tMs)).toEqual([0, 5_000, 10_000]);
  });

  it('releases nothing at the very start of a round', () => {
    expect(releasableFrames([f(0), f(100)], START, START + 500)).toEqual([]);
  });

  it('releases everything long after the round ended', () => {
    const frames = [f(0), f(5_000)];
    expect(releasableFrames(frames, START, START + 600_000)).toHaveLength(2);
  });

  it('honours a custom delay', () => {
    const frames = [f(0), f(5_000)];
    expect(releasableFrames(frames, START, START + 6_000, 2_000).map((x) => x.tMs)).toEqual([0]);
  });

  it('refuses to release anything when the delay is zero or negative', () => {
    // Guards against a config value of 0 quietly turning the anti-ghosting
    // control off. Turning it off must be an explicit code change, not a
    // number someone typed into a settings row.
    const frames = [f(0), f(5_000)];
    expect(releasableFrames(frames, START, START + 600_000, 0)).toEqual([]);
    expect(releasableFrames(frames, START, START + 600_000, -1)).toEqual([]);
  });

  it('releases nothing when the round start is unknown', () => {
    // Without an origin there is no way to tell how old a frame is, and
    // guessing means guessing in the direction that leaks positions.
    expect(releasableFrames([f(0)], 0, START + 600_000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- replayTail`
Expected: FAIL, cannot resolve `../src/replayTail.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/replayTail.ts
import type { Frame } from './replayFormat.js';

/** How far behind live a viewer is held. This is an anti-ghosting control,
 *  not a buffering convenience: the live page is public, the frames carry
 *  every infected player's position, and the GHOST state bit shows where one
 *  is about to spawn from. Ten seconds is long enough that the information is
 *  spent by the time it is visible. */
export const DEFAULT_DELAY_MS = 10_000;

/**
 * Which of these frames may be sent to a viewer right now.
 *
 * Frames carry `tMs` relative to the round going live, and the round's
 * wall-clock start comes from `match_rounds.started_at`, so a frame's real
 * time is arithmetic with no clock synchronisation between the game server
 * and this process.
 *
 * Every failure mode returns fewer frames, never more. An unknown round start
 * or a nonsensical delay releases nothing at all, because the cost of holding
 * back a frame is a viewer waiting and the cost of releasing one early is a
 * player reading live infected positions.
 */
export function releasableFrames(
  frames: Frame[],
  roundStartedUnixMs: number,
  nowMs: number,
  delayMs: number = DEFAULT_DELAY_MS,
): Frame[] {
  if (delayMs <= 0) return [];
  if (!roundStartedUnixMs || roundStartedUnixMs <= 0) return [];
  const cutoffTMs = nowMs - delayMs - roundStartedUnixMs;
  if (cutoffTMs < 0) return [];
  return frames.filter((f) => f.tMs <= cutoffTMs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- replayTail && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/replayTail.ts tests/replayTail.test.ts
git commit -m "feat(replay): hold live frames behind a server-side delay"
```

---

### Task 5: Chat on the wire

Nothing in this deployment records chat today. The `EVENT` line cannot carry it: its four fields are `kind`, `actor`, `target` and an integer `value`, and chat is free text. So chat gets its own line and its own table.

The one detail that turns into a security bug if missed: **`msg=` must be the last field on the line**, and the parser must take the remainder of the line rather than tokenizing. `logParse.ts` already does exactly this for `MATCH_ROSTER`'s `name=`, for the same reason, and the comment there explains it. A message containing a space and an `=` could otherwise forge any field after it.

**Files:**
- Modify: `src/logParse.ts`
- Modify: `src/db.ts` (add `match_chat` to `SCHEMA`)
- Modify: `src/liveView.ts` (add `recordChat`)
- Modify: `src/server.ts` (dispatch)
- Test: `tests/logParse.test.ts`, `tests/liveView.test.ts`

**Interfaces:**
- Consumes: `LogEvent`, `parseLogDatagram` from `src/logParse.ts`
- Produces: a `{ kind: 'chat'; token: string; seq: number; half: number; tMs: number; steamid: string; team: 'a' | 'b' | null; message: string }` member of `LogEvent`; `recordChat(db: DB, token: string, ev: Extract<LogEvent, { kind: 'chat' }>): void`

- [ ] **Step 1: Write the failing parser test**

Append to `tests/logParse.test.ts`:

```ts
describe('CHAT', () => {
  const T = 'a'.repeat(32);
  const line = (s: string) => parseLogDatagram(Buffer.from(`L 09/11/2026 - 20:00:00: PUG ${T} ${s}\n`));

  it('parses a chat line', () => {
    expect(line('CHAT seq=7 half=1 t=4321 steamid=76561198000000001 team=a msg=rushing left')).toEqual({
      kind: 'chat', token: T, seq: 7, half: 1, tMs: 4321,
      steamid: '76561198000000001', team: 'a', message: 'rushing left',
    });
  });

  it('keeps a message containing spaces and equals signs intact', () => {
    // The attack this defends against: if msg were tokenized, a message of
    // "gg steamid=76561198000000009" could overwrite the speaker. Taking the
    // remainder of the line after the FIRST ' msg=' makes that impossible.
    const ev = line('CHAT seq=8 half=1 t=1 steamid=76561198000000001 team=b msg=gg steamid=76561198000000009 team=a');
    expect(ev).toMatchObject({
      steamid: '76561198000000001', team: 'b',
      message: 'gg steamid=76561198000000009 team=a',
    });
  });

  it('accepts an empty team as null rather than dropping the line', () => {
    expect(line('CHAT seq=9 half=1 t=1 steamid=76561198000000001 team= msg=hi')).toMatchObject({ team: null, message: 'hi' });
  });

  it('rejects a line with no msg field at all', () => {
    expect(line('CHAT seq=9 half=1 t=1 steamid=76561198000000001 team=a')).toBeNull();
  });

  it('rejects a bad steamid', () => {
    expect(line('CHAT seq=9 half=1 t=1 steamid=nope team=a msg=hi')).toBeNull();
  });

  it('rejects a non-positive seq', () => {
    expect(line('CHAT seq=0 half=1 t=1 steamid=76561198000000001 team=a msg=hi')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- logParse`
Expected: FAIL, the `CHAT` cases return null because the verb is unhandled.

- [ ] **Step 3: Implement the parser**

In `src/logParse.ts`, add to the `LogEvent` union:

```ts
  // In-game chat. Its own line type rather than an EVENT because EVENT's
  // fields are kind/actor/target/an integer value, and a message is free text.
  //
  // `seq` is the SAME counter EVENT uses, not a second one. One monotonic
  // sequence across both streams is what lets a viewer interleave a message
  // and a death in the order they really happened, and it reuses the dedupe
  // key that already exists.
  //
  // Unlike an event, chat is NOT gated on stats being active: the gate exists
  // to stop counters moving between rounds and during ready-up, which are
  // exactly the moments chat is most worth having. `tMs` is -1 then, the same
  // sentinel RoundMs() already returns.
  | {
      kind: 'chat'; token: string; seq: number; half: number; tMs: number;
      steamid: string; team: 'a' | 'b' | null; message: string;
    }
```

and add the case to the switch in `parseLogDatagram`:

```ts
    case 'CHAT': {
      const seq = intOf(rest.seq);
      if (seq === null || seq < 1) return null;
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      // The message is taken from the raw line rather than from kv(), because
      // chat contains spaces and very often contains '='. The plugin emits
      // msg= last on the line for exactly this reason, so everything after the
      // first ' msg=' is the message. Same treatment as MATCH_ROSTER's name=,
      // and for the same reason: tokenizing would let a message forge any
      // field that followed it.
      const at = line.indexOf(' msg=');
      if (at < 0) return null;
      const message = line.slice(at + ' msg='.length);
      if (!message) return null;
      // half and t are optional so a staged older plugin still parses.
      const half = halfOf(rest.half) ?? -1;
      const tMs = intOf(rest.t) ?? -1;
      return {
        kind: 'chat', token, seq, half, tMs,
        steamid: rest.steamid, team: teamOf(rest.team), message,
      };
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- logParse`
Expected: PASS.

- [ ] **Step 5: Add the table**

In `src/db.ts`, add to `SCHEMA` immediately after `match_live_events`:

```sql
-- In-game chat, from the same lossy UDP feed as match_live_events and with
-- the same discipline: cosmetic, never counted, never read when a result is
-- computed.
--
-- seq is the SAME counter match_live_events uses, so one monotonic sequence
-- orders chat and events together and a duplicated datagram upserts over
-- itself rather than producing a second copy of a message.
CREATE TABLE IF NOT EXISTS match_chat (
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  seq         INTEGER NOT NULL,
  map_ordinal INTEGER NOT NULL DEFAULT 0,
  -- -1 when the message was sent outside a live round, which is common and
  -- not an error: chat is deliberately not gated on stats being active.
  half        INTEGER NOT NULL DEFAULT -1,
  t_ms        INTEGER NOT NULL DEFAULT -1,
  steamid     TEXT    NOT NULL,
  team        TEXT,
  message     TEXT    NOT NULL,
  PRIMARY KEY (match_id, seq)
);
```

- [ ] **Step 6: Write the failing recorder test**

Append to `tests/liveView.test.ts`. That file already has a module-level `db`, a `TOKEN` constant and a `seedLive()` helper that inserts a live match and returns its id; use those rather than adding new ones.

```ts
describe('recordChat', () => {
  const chat = (over: Record<string, unknown> = {}) => ({
    kind: 'chat' as const, token: TOKEN, seq: 3, half: 1, tMs: 5000,
    steamid: '76561198000000001', team: 'a' as const, message: 'rushing left',
    ...over,
  });

  it('stores a message against the map in progress', () => {
    seedLive();
    recordChat(db, TOKEN, chat());
    const row = db.prepare('SELECT seq, half, t_ms, steamid, team, message, map_ordinal FROM match_chat').get();
    expect(row).toEqual({
      seq: 3, half: 1, t_ms: 5000, steamid: '76561198000000001',
      team: 'a', message: 'rushing left', map_ordinal: 0,
    });
  });

  it('upserts a duplicated datagram instead of storing it twice', () => {
    seedLive();
    recordChat(db, TOKEN, chat());
    recordChat(db, TOKEN, chat());
    const n = db.prepare('SELECT COUNT(*) AS n FROM match_chat').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('stores a message sent outside a live round, which carries half and t of -1', () => {
    // Chat is deliberately not gated on StatsActive, so this is the common
    // case between rounds and during ready-up, not an error.
    seedLive();
    recordChat(db, TOKEN, chat({ half: -1, tMs: -1 }));
    const row = db.prepare('SELECT half, t_ms FROM match_chat').get();
    expect(row).toEqual({ half: -1, t_ms: -1 });
  });

  it('ignores a token that is not a live match', () => {
    seedLive();
    recordChat(db, 'f'.repeat(32), chat({ token: 'f'.repeat(32), seq: 99 }));
    const n = db.prepare('SELECT COUNT(*) AS n FROM match_chat').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
```

- [ ] **Step 7: Implement the recorder**

In `src/liveView.ts`, directly below `recordLiveEvent`:

```ts
/** Store one chat message. Mirrors recordLiveEvent, including the deliberate
 *  choice NOT to re-stamp map_ordinal, half or t_ms on conflict: a duplicate
 *  datagram can arrive after the map it belongs to has ended, and re-stamping
 *  would move an old message onto the current map. The first write is the one
 *  that saw the right map. */
export function recordChat(
  db: DB, token: string,
  ev: Extract<LogEvent, { kind: 'chat' }>,
): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  const ordinal = currentOrdinal(db, id);
  db.prepare(
    `INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, seq) DO UPDATE SET
       steamid = excluded.steamid, team = excluded.team, message = excluded.message`,
  ).run(id, ev.seq, ordinal, ev.half, ev.tMs, ev.steamid, ev.team, ev.message);
  touch(db, id);
}
```

`currentOrdinal` is already defined in this file and is used by `recordRoundStart`; if it is declared below `recordLiveEvent`, no move is needed, function declarations hoist.

- [ ] **Step 8: Dispatch it**

In `src/server.ts`, add `recordChat` to the import from `./liveView.js`, and add the branch immediately after the `live_event` one:

```ts
          else if (ev.kind === 'chat') recordChat(deps.db, ev.token, ev);
```

- [ ] **Step 9: Run the full suite and commit**

```bash
npm test && npm run typecheck
git add src/logParse.ts src/db.ts src/liveView.ts src/server.ts tests/logParse.test.ts tests/liveView.test.ts
git commit -m "feat(chat): capture in-game chat on its own line and table"
```

---

### Task 6: Plugin chat emission

**Files:**
- Modify: `plugin/pug-match.sp`

**Interfaces:**
- Consumes: `EmitPug`, `RoundMs`, `g_iEventSeq`, `g_iClientRoster`, `g_sRosterId`, `g_iRosterTeam`, `g_iHalf`, all existing in this file
- Produces: the `CHAT` log line Task 5 parses

- [ ] **Step 1: Add the constant and the hook registration**

Near the other `#define`s at the top of `plugin/pug-match.sp`:

```sourcepawn
/** Longest chat message emitted. Long enough for anything anyone types in a
 *  PUG, short enough that a message cannot push a log line into truncation. */
#define CHAT_MAX_BYTES 128
```

In `OnPluginStart`, alongside the other `HookEventEx` registrations added by 6a:

```sourcepawn
	if (!HookEventEx("player_say", Event_PlayerSay))
		LogError("pug: player_say not hooked; chat will not be captured");
```

`HookEventEx` rather than `HookEvent` for the reason 6a established: `HookEvent` on an undefined event raises a native error, and raised inside `OnPluginStart` that aborts plugin load, which would take down roster enforcement and scoring for every ranked PUG. An absent event must cost one telemetry stream, not the match system.

- [ ] **Step 2: Add the handler**

Next to the other event handlers:

```sourcepawn
/** Strip anything that would break the log line, and cap the length.
 *
 *  A newline inside a log line IS a second log line as far as the reader is
 *  concerned, so an unstripped one lets a player inject a whole datagram.
 *  Everything else is left alone: the parser takes the remainder of the line
 *  after ' msg=', so spaces and '=' are already safe. */
void SanitizeChat(char[] text, int maxlen)
{
	int w = 0;
	int limit = maxlen - 1 < CHAT_MAX_BYTES ? maxlen - 1 : CHAT_MAX_BYTES;
	for (int r = 0; text[r] != '\0' && w < limit; r++)
	{
		if (text[r] == '\n' || text[r] == '\r') continue;
		text[w++] = text[r];
	}
	text[w] = '\0';
}

/** Chat is captured for any tracked match, NOT gated on StatsActive().
 *
 *  That gate exists to keep counters from moving between rounds and during
 *  ready-up. Chat has no counter to protect and those moments are exactly when
 *  the talking happens, so gating it there would throw away most of the value.
 *  RoundMs() returns -1 outside a live round, which the parser already treats
 *  as "no round timing".
 *
 *  Unrostered speakers are dropped, the same discipline EmitEvent follows: a
 *  spectator or admin must never appear in the match record. */
public void Event_PlayerSay(Event event, const char[] name, bool dontBroadcast)
{
	if (g_State == MS_None) return;
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client < 1 || client > MaxClients) return;
	int slot = g_iClientRoster[client];
	if (slot < 0) return;

	char text[256];
	event.GetString("text", text, sizeof(text));
	SanitizeChat(text, sizeof(text));
	if (text[0] == '\0') return;

	g_iEventSeq++;
	// msg= is LAST on the line, deliberately. The parser takes everything
	// after the first ' msg=' as the message, so any field emitted after it
	// could be forged by typing it into chat.
	EmitPug("CHAT seq=%d half=%d t=%d steamid=%s team=%s msg=%s",
		g_iEventSeq, g_iHalf, RoundMs(), g_sRosterId[slot],
		g_iRosterTeam[slot] == 1 ? "a" : "b", text);
}
```

- [ ] **Step 3: Compile**

Run: `cd plugin && ./build.sh`
Expected: `built: .../pug-match.smx`, no errors. Warnings about unused variables are failures here; fix them rather than ignoring them.

- [ ] **Step 4: Commit**

```bash
# pug-match.smx is a build artifact and is gitignored (.gitignore:5). Commit the
# source only; build.sh regenerates the binary.
git add plugin/pug-match.sp
git commit -m "feat(plugin): emit in-game chat on the CHAT line"
```

---

### Task 7: Plugin frame writer

The recorder. Everything in this task is on a path that runs ten times a second on a 100 tick server whose recorded p99 is already 11.25ms against a 10ms budget, so the two cost decisions below are not micro-optimisation, they are the reason the feature is affordable at all.

**Decision one: nothing scans the entity table.** Finding commons, the witch and the rock with `FindEntityByClassname` walks the whole entity table once per classname per frame. The set is tracked in `OnEntityCreated` and `OnEntityDestroyed` instead, holding entity *references* so a recycled index cannot alias onto a dead entity.

Players are different and are iterated directly: `MaxClients` is under twenty, so a client loop is already cheap, and it is the only way to see AI tanks, survivor bots and AI special infected, none of which `OnEntityCreated` reports usefully. So the rule is precisely: **world entities are tracked incrementally, players are iterated.**

**Decision two: one write call per frame.** The frame is packed into a byte array in Pawn and written with a single `WriteFile` at `size = 1`. A `WriteFileCell` per field would be roughly 190 native calls per frame. And `FlushFile` is never called: the page cache serves a tailing reader on the same box, and a 10Hz flush is the most direct way to turn an estimated cost into a measured stall.

**Files:**
- Modify: `plugin/pug-match.sp`

**Interfaces:**
- Consumes: `g_sToken`, `g_iMapCount`, `g_iHalf`, `g_sCurrentMap`, `g_iClientRoster`, `g_sRosterId`, `g_fRoundLiveAt`, `RoundMs()`, `TEAM_SURVIVOR`, `TEAM_INFECTED`, `ZC_SMOKER`, `ZC_BOOMER`, `ZC_HUNTER`, `ZC_TANK`
- Produces: `pug_<token>_<ordinal>_<half>.rpl` matching `src/replayFormat.ts` byte for byte

- [ ] **Step 1: Add the constants, globals and cvars**

Near the other `#define`s:

```sourcepawn
// Replay file layout. Every number here also exists in src/replayFormat.ts.
// Changing one without changing the other produces a file that parses into
// plausible nonsense rather than an error, which is why the in-game
// verification at the end of this plan reads a real file back.
#define RPL_VERSION        1
#define RPL_HEADER_BYTES   160
#define RPL_SLOTS          8
#define RPL_PLAYER_RECORD  20
#define RPL_PLAYER_BLOCK   160
#define RPL_FRAME_HEADER   8
#define RPL_ENTITY_RECORD  12
#define RPL_INDEX_RECORD   8
// A keyframe every 10 seconds, so a 6 minute round indexes in 36 entries.
#define RPL_KEYFRAME_MS    10000
// Hard ceiling on entities in one frame. Commons run 20 to 30 in a versus
// round; this is headroom, and overflow drops the excess rather than writing
// past the buffer.
#define RPL_MAX_ENTITIES   128
#define RPL_FRAME_MAX      (RPL_FRAME_HEADER + RPL_PLAYER_BLOCK + RPL_MAX_ENTITIES * RPL_ENTITY_RECORD)

// Entity kinds. Everything that is not one of the eight rostered players.
#define RPL_K_COMMON       1
#define RPL_K_WITCH        2
#define RPL_K_TANK_ROCK    3
#define RPL_K_TANK_AI      4
#define RPL_K_SURVIVOR_BOT 5
#define RPL_K_SMOKER_AI    6
#define RPL_K_BOOMER_AI    7
#define RPL_K_HUNTER_AI    8

// State bits, shared by player and entity records.
#define RPL_S_PRESENT      (1 << 0)
#define RPL_S_ALIVE        (1 << 1)
#define RPL_S_INCAP        (1 << 2)
#define RPL_S_LEDGED       (1 << 3)
#define RPL_S_PINNED       (1 << 4)
#define RPL_S_BILED        (1 << 5)
#define RPL_S_BURNING      (1 << 6)
#define RPL_S_GHOST        (1 << 7)
```

Near the other globals:

```sourcepawn
// ---------- replay recording ----------
ConVar g_cvReplayHz;                     // 0 = off. Instant rcon kill switch, no reload.
ConVar g_cvReplayEntityHz;               // world entity sample rate; <= player rate
ConVar g_cvReplayDir;                    // directory, relative to the game dir
ConVar g_cvReplayMaxMb;                  // per-round byte cap, a runaway bound

File g_hReplay;                          // null when not recording
Handle g_hReplayTimer;
int g_iReplayFrames;
int g_iReplayBytes;
/** Latched for the rest of the MATCH on any write failure. A replay problem
 *  must never turn into a match problem, so the recorder gives up completely
 *  rather than retrying every round. */
bool g_bReplayFailed;
/** Entity refs for world entities only: commons, the witch, the rock. Players
 *  are iterated instead, because MaxClients is small and because bots and AI
 *  specials are not visible any other way. */
ArrayList g_hRplEnts;
ArrayList g_hRplIndexT;                  // keyframe t_ms
ArrayList g_hRplIndexOff;                // keyframe byte offset
int g_iRplLastKeyMs;
int g_iRplEntityEveryN;                  // sample world entities 1 frame in N
int g_iRplFrameNo;
int g_iRplBuf[RPL_FRAME_MAX];            // one byte per cell, written in one call
```

In `OnPluginStart`:

```sourcepawn
	g_cvReplayHz = CreateConVar("sm_pug_replay_hz", "10",
		"Replay sample rate in Hz. 0 disables recording. Takes effect at the next round.",
		FCVAR_NOTIFY, true, 0.0, true, 20.0);
	g_cvReplayEntityHz = CreateConVar("sm_pug_replay_entity_hz", "10",
		"World entity sample rate in Hz. Clamped to the player rate.",
		FCVAR_NOTIFY, true, 0.0, true, 20.0);
	g_cvReplayDir = CreateConVar("sm_pug_replay_dir", "replays",
		"Directory for replay files, relative to the game dir. Empty disables recording.",
		FCVAR_NOTIFY);
	g_cvReplayMaxMb = CreateConVar("sm_pug_replay_max_mb", "64",
		"Per-round replay size cap in MB. A runaway bound, not a budget: a full round is 10 to 15 MB.",
		FCVAR_NOTIFY, true, 1.0, true, 512.0);

	g_hRplEnts = new ArrayList();
	g_hRplIndexT = new ArrayList();
	g_hRplIndexOff = new ArrayList();
```

- [ ] **Step 2: Add the byte packing helpers**

```sourcepawn
// ---------- replay byte packing ----------
// Explicit little-endian, one byte per cell, so the file never depends on how
// this machine lays out a native word. The whole buffer goes out in a single
// WriteFile at size = 1.

int RplU8(int pos, int v)
{
	g_iRplBuf[pos] = v & 0xFF;
	return pos + 1;
}

int RplU16(int pos, int v)
{
	g_iRplBuf[pos]     = v & 0xFF;
	g_iRplBuf[pos + 1] = (v >> 8) & 0xFF;
	return pos + 2;
}

int RplU32(int pos, int v)
{
	g_iRplBuf[pos]     = v & 0xFF;
	g_iRplBuf[pos + 1] = (v >> 8) & 0xFF;
	g_iRplBuf[pos + 2] = (v >> 16) & 0xFF;
	g_iRplBuf[pos + 3] = (v >> 24) & 0xFF;
	return pos + 4;
}

/** Clamp before packing. Source world bounds are +/- 16384 so a real position
 *  always fits an int16, but a detached or uninitialised entity can report
 *  something absurd, and wrapping it would draw a player on the far side of
 *  the map rather than at the edge. */
int RplClampI16(int v)
{
	if (v >  32767) return  32767;
	if (v < -32768) return -32768;
	return v;
}

int RplI16(int pos, int v)
{
	// Two's complement, so the byte pattern of a negative int16 is the low 16
	// bits of the negative int32. No separate path needed.
	return RplU16(pos, RplClampI16(v));
}

/** Fixed-width ASCII, nul padded. */
int RplStr(int pos, const char[] s, int len)
{
	// strlen hoisted out of the loop: inside it, this is quadratic.
	int n = strlen(s);
	if (n > len) n = len;
	for (int i = 0; i < len; i++) g_iRplBuf[pos + i] = (i < n) ? s[i] : 0;
	return pos + len;
}
```

- [ ] **Step 3: Add world entity tracking**

```sourcepawn
/** Which replay entity kind a world entity classname maps to, or 0 for one we
 *  do not record.
 *
 *  These three classnames are all in use by this deployment's own plugins:
 *  "infected" in l4dready.sp, "witch" in l4d1_random_witch_model.sp,
 *  "tank_rock" in l4d_ssi_teleport_fix.sp. Anything else is ignored. */
int RplWorldKind(const char[] classname)
{
	if (StrEqual(classname, "infected"))  return RPL_K_COMMON;
	if (StrEqual(classname, "witch"))     return RPL_K_WITCH;
	if (StrEqual(classname, "tank_rock")) return RPL_K_TANK_ROCK;
	return 0;
}

/** The whole reason the recorder is affordable.
 *
 *  The obvious implementation finds these with FindEntityByClassname on every
 *  frame, which walks the entity table once per classname, ten times a second,
 *  on a box that already overruns about 1% of its frames. Creation and
 *  destruction are events the engine raises anyway, so the work moves off the
 *  sampling path entirely and the per-frame cost becomes walking about thirty
 *  tracked references.
 *
 *  References, not indices: the engine recycles indices, and a stale index
 *  would silently start reporting a different entity's position. */
public void OnEntityCreated(int entity, const char[] classname)
{
	if (g_hRplEnts == null) return;
	if (RplWorldKind(classname) == 0) return;
	g_hRplEnts.Push(EntIndexToEntRef(entity));
}

public void OnEntityDestroyed(int entity)
{
	if (g_hRplEnts == null || entity < 0) return;
	int ref = EntIndexToEntRef(entity);
	int at = g_hRplEnts.FindValue(ref);
	if (at != -1) g_hRplEnts.Erase(at);
}
```

- [ ] **Step 4: Add the file open, header write, and close**

```sourcepawn
/** Open this round's replay file and write its header.
 *
 *  Every failure path here is silent to the match: replay recording simply
 *  does not happen. Nothing in this function may throw into the round going
 *  live. */
void RplOpen()
{
	RplClose();               // paranoia: a previous round that never closed
	if (g_bReplayFailed) return;
	if (g_State != MS_Live) return;

	int hz = g_cvReplayHz.IntValue;
	if (hz <= 0) return;

	char dir[PLATFORM_MAX_PATH];
	g_cvReplayDir.GetString(dir, sizeof(dir));
	if (dir[0] == '\0') return;
	if (!DirExists(dir) && !CreateDirectory(dir, 511))
	{
		LogError("pug: cannot create replay dir '%s'; recording disabled for this match", dir);
		g_bReplayFailed = true;
		return;
	}

	char path[PLATFORM_MAX_PATH];
	// Same naming convention as the demos, and for the same reason: the link
	// between a file and its match is a property of the filename, so it
	// survives a backend restart. There is no datagram announcing this file.
	Format(path, sizeof(path), "%s/pug_%s_%d_%d.rpl", dir, g_sToken, g_iMapCount, g_iHalf);
	g_hReplay = OpenFile(path, "wb");
	if (g_hReplay == null)
	{
		LogError("pug: cannot open '%s'; replay recording disabled for this match", path);
		g_bReplayFailed = true;
		return;
	}

	int entHz = g_cvReplayEntityHz.IntValue;
	if (entHz > hz) entHz = hz;
	g_iRplEntityEveryN = (entHz <= 0) ? 0 : (hz / entHz);
	if (g_iRplEntityEveryN < 1 && entHz > 0) g_iRplEntityEveryN = 1;

	int p = 0;
	p = RplStr(p, "L4RP", 4);
	p = RplU16(p, RPL_VERSION);
	p = RplU8(p, g_iMapCount);
	p = RplU8(p, g_iHalf);
	p = RplU8(p, hz);
	p = RplU8(p, entHz);
	p = RplU16(p, 0);                          // reserved, pads token to 12
	p = RplStr(p, g_sToken, 32);
	p = RplStr(p, g_sCurrentMap, 32);
	p = RplU32(p, GetTime());
	p = RplU32(p, 0);                          // indexOffset, patched at close
	p = RplU32(p, 0);                          // indexCount, patched at close
	for (int slot = 0; slot < RPL_SLOTS; slot++)
	{
		int id64[2];
		// An empty slot writes 0, which the reader decodes as "nobody", never
		// as a SteamID that happens to be small.
		if (slot < g_iRosterCount && g_sRosterId[slot][0] != '\0') StringToInt64(g_sRosterId[slot], id64);
		else { id64[0] = 0; id64[1] = 0; }
		p = RplU32(p, id64[0]);
		p = RplU32(p, id64[1]);
	}
	while (p < 152) p = RplU8(p, 0);
	p = RplU32(p, 0);                          // frameCount, patched at close
	while (p < RPL_HEADER_BYTES) p = RplU8(p, 0);

	if (!WriteFile(g_hReplay, g_iRplBuf, RPL_HEADER_BYTES, 1))
	{
		LogError("pug: replay header write failed; recording disabled for this match");
		RplFail();
		return;
	}

	g_iReplayFrames = 0;
	g_iReplayBytes = RPL_HEADER_BYTES;
	g_iRplLastKeyMs = -RPL_KEYFRAME_MS;        // forces a keyframe on frame one
	g_iRplFrameNo = 0;
	g_hRplIndexT.Clear();
	g_hRplIndexOff.Clear();

	float interval = 1.0 / float(hz);
	g_hReplayTimer = CreateTimer(interval, Timer_RplFrame, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
	PugDebug("replay: recording %s at %dHz (entities %dHz)", path, hz, entHz);
}

/** Give up on replays for the rest of the match. */
void RplFail()
{
	g_bReplayFailed = true;
	RplClose();
}

/** Close the file, appending the keyframe index and patching the header.
 *
 *  The index and the frame count cannot be known until now, which is why the
 *  header reserves space for them rather than carrying them up front. A file
 *  that was never closed therefore reads as indexless and frameless, which is
 *  exactly the truth about it, instead of carrying a plausible wrong offset. */
void RplClose()
{
	if (g_hReplayTimer != null)
	{
		KillTimer(g_hReplayTimer);
		g_hReplayTimer = null;
	}
	if (g_hReplay == null) return;

	int count = g_hRplIndexT.Length;
	int indexOffset = g_iReplayBytes;
	bool ok = true;

	if (count > 0)
	{
		int p = 0;
		for (int i = 0; i < count; i++)
		{
			// The buffer holds RPL_FRAME_MAX bytes, far more than any index
			// this loop writes for a round of sane length, but flush in
			// chunks anyway so a very long round cannot overrun it.
			if (p + RPL_INDEX_RECORD > RPL_FRAME_MAX)
			{
				if (!WriteFile(g_hReplay, g_iRplBuf, p, 1)) { ok = false; break; }
				p = 0;
			}
			p = RplU32(p, g_hRplIndexT.Get(i));
			p = RplU32(p, g_hRplIndexOff.Get(i));
		}
		if (ok && p > 0 && !WriteFile(g_hReplay, g_iRplBuf, p, 1)) ok = false;
	}

	if (ok)
	{
		// Patch indexOffset and indexCount at byte 80, then frameCount at 152.
		int p = 0;
		p = RplU32(p, count > 0 ? indexOffset : 0);
		p = RplU32(p, count);
		if (!FileSeek(g_hReplay, 80, SEEK_SET) || !WriteFile(g_hReplay, g_iRplBuf, 8, 1)) ok = false;
		if (ok)
		{
			RplU32(0, g_iReplayFrames);
			if (!FileSeek(g_hReplay, 152, SEEK_SET) || !WriteFile(g_hReplay, g_iRplBuf, 4, 1)) ok = false;
		}
	}
	if (!ok) LogError("pug: replay close incomplete; the file is still playable, seeking will be slow");

	delete g_hReplay;
	g_hReplay = null;
	PugDebug("replay: closed after %d frames, %d bytes", g_iReplayFrames, g_iReplayBytes);
}
```

- [ ] **Step 5: Add the sampler**

Every netprop read below was confirmed present on the player class in this deployment's own dump, `Rotoblin-AZMod/SourceCode/dump_data/netprops.txt`: `m_isIncapacitated`, `m_isHangingFromLedge`, `m_isGhost`, `m_healthBuffer`, `m_vomitStart`, `m_burnPercent`, `m_hActiveWeapon`, `m_iClip1`, `m_iPrimaryAmmoType`, `m_iAmmo`. Do not substitute an L4D2 name for any of them.

```sourcepawn
/** How long a boomer biling keeps a survivor marked.
 *
 *  m_vomitStart is the game time the biling started, not a boolean, so the
 *  bit is derived from how long ago it was. This duration is the one number
 *  in the sampler that was not read off a netprop dump, so confirm it in game:
 *  a wrong value here shows the bile overlay for the wrong length of time and
 *  nothing else. */
#define RPL_BILE_SECONDS 20.0

/** State bits for one in-game client. */
int RplClientState(int client, bool ghost)
{
	int state = RPL_S_PRESENT;
	if (IsPlayerAlive(client)) state |= RPL_S_ALIVE;
	if (GetEntPropFloat(client, Prop_Send, "m_burnPercent") > 0.0) state |= RPL_S_BURNING;
	float vomit = GetEntPropFloat(client, Prop_Send, "m_vomitStart");
	if (vomit > 0.0 && GetGameTime() - vomit < RPL_BILE_SECONDS) state |= RPL_S_BILED;
	if (GetClientTeam(client) == TEAM_SURVIVOR)
	{
		if (GetEntProp(client, Prop_Send, "m_isIncapacitated")) state |= RPL_S_INCAP;
		if (GetEntProp(client, Prop_Send, "m_isHangingFromLedge")) state |= RPL_S_LEDGED;
		if (g_iPinnedBy[client] > 0) state |= RPL_S_PINNED;
	}
	else if (ghost) state |= RPL_S_GHOST;
	return state;
}

bool RplIsGhost(int client)
{
	return GetClientTeam(client) == TEAM_INFECTED
		&& GetEntProp(client, Prop_Send, "m_isGhost") != 0;
}

/** Which entity kind a non-rostered in-game client is. */
int RplBotKind(int client)
{
	if (GetClientTeam(client) == TEAM_SURVIVOR) return RPL_K_SURVIVOR_BOT;
	if (GetClientTeam(client) != TEAM_INFECTED) return 0;
	switch (GetEntProp(client, Prop_Send, "m_zombieClass"))
	{
		case ZC_SMOKER: return RPL_K_SMOKER_AI;
		case ZC_BOOMER: return RPL_K_BOOMER_AI;
		case ZC_HUNTER: return RPL_K_HUNTER_AI;
		case ZC_TANK:   return RPL_K_TANK_AI;
	}
	return 0;
}

/** Weapon classname to a small id. The viewer renders a label per id, so the
 *  numbers only have to be stable, not meaningful. 0 is "none or unknown",
 *  which is also what an infected player records. */
int RplWeaponId(const char[] cls)
{
	if (StrEqual(cls, "weapon_pistol"))          return 1;
	if (StrEqual(cls, "weapon_smg"))             return 2;
	if (StrEqual(cls, "weapon_pumpshotgun"))     return 3;
	if (StrEqual(cls, "weapon_autoshotgun"))     return 4;
	if (StrEqual(cls, "weapon_rifle"))           return 5;
	if (StrEqual(cls, "weapon_hunting_rifle"))   return 6;
	if (StrEqual(cls, "weapon_pipe_bomb"))       return 7;
	if (StrEqual(cls, "weapon_molotov"))         return 8;
	if (StrEqual(cls, "weapon_first_aid_kit"))   return 9;
	if (StrEqual(cls, "weapon_pain_pills"))      return 10;
	return 0;
}

public Action Timer_RplFrame(Handle timer)
{
	if (g_hReplay == null)
	{
		g_hReplayTimer = null;
		return Plugin_Stop;
	}

	int tMs = RoundMs();
	// -1 means the round is not live. Nothing to time a frame against, so
	// skip rather than write a frame the viewer cannot place.
	if (tMs < 0) return Plugin_Continue;

	// Keyframe BEFORE the frame is written, so the recorded offset is where
	// this frame actually begins.
	if (tMs - g_iRplLastKeyMs >= RPL_KEYFRAME_MS)
	{
		g_hRplIndexT.Push(tMs);
		g_hRplIndexOff.Push(g_iReplayBytes);
		g_iRplLastKeyMs = tMs;
	}

	bool sampleEntities = g_iRplEntityEveryN > 0 && (g_iRplFrameNo % g_iRplEntityEveryN) == 0;
	g_iRplFrameNo++;

	// One pass over clients, building both the slot lookup and the list of
	// non-rostered clients. The naive version loops MaxClients once per slot,
	// which is eight times the work for no benefit.
	int slotClient[RPL_SLOTS];
	int bots[MAXPLAYERS + 1];
	int botCount = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c)) continue;
		int slot = g_iClientRoster[c];
		if (slot >= 0 && slot < RPL_SLOTS) slotClient[slot] = c;
		else if (IsPlayerAlive(c)) bots[botCount++] = c;
	}

	// Player block first, at a fixed offset, then entities appended after it.
	// The entity count is not known until they are gathered, so the frame
	// header is patched once the whole frame is packed.
	int p = RPL_FRAME_HEADER;
	float pos[3], ang[3];

	for (int slot = 0; slot < RPL_SLOTS; slot++)
	{
		int client = slotClient[slot];
		if (client == 0)
		{
			// Empty slot: an all-zero record, which decodes as state 0, which
			// is "not present". Distinct from a dead player, who is PRESENT
			// with ALIVE clear.
			for (int i = 0; i < RPL_PLAYER_RECORD; i++) p = RplU8(p, 0);
			continue;
		}
		GetClientAbsOrigin(client, pos);
		GetClientEyeAngles(client, ang);

		bool survivor = GetClientTeam(client) == TEAM_SURVIVOR;
		int temp = 0, weaponId = 0, clip = 0, reserve = 0;
		if (survivor)
		{
			// Temporary health decays continuously, so it is a float on the
			// entity and has to be floored rather than read as an int. It is
			// carried separately from permanent health because the viewer
			// draws a two-tone bar, and because a temp health jump is the
			// signal the deferred pills detection will need.
			float tempF = GetEntPropFloat(client, Prop_Send, "m_healthBuffer");
			if (tempF > 0.0) temp = RoundToFloor(tempF);

			int wep = GetEntPropEnt(client, Prop_Send, "m_hActiveWeapon");
			if (wep > 0 && IsValidEntity(wep))
			{
				char wcls[64];
				GetEntityClassname(wep, wcls, sizeof(wcls));
				weaponId = RplWeaponId(wcls);
				clip = GetEntProp(wep, Prop_Send, "m_iClip1");
				int ammoType = GetEntProp(wep, Prop_Send, "m_iPrimaryAmmoType");
				if (ammoType >= 0) reserve = GetEntProp(client, Prop_Send, "m_iAmmo", _, ammoType);
			}
		}

		p = RplI16(p, RoundToNearest(pos[0]));
		p = RplI16(p, RoundToNearest(pos[1]));
		p = RplI16(p, RoundToNearest(pos[2]));
		p = RplI16(p, RoundToNearest(ang[1] * 100.0));    // yaw, 0.01 degree
		// Pitch is -89..89 degrees, so its low byte IS its int8 two's
		// complement representation. The mask is what makes that explicit.
		p = RplU8(p, RoundToNearest(ang[0]) & 0xFF);
		p = RplU8(p, RplClientState(client, RplIsGhost(client)));
		p = RplU16(p, GetClientHealth(client));
		p = RplU16(p, temp);
		p = RplU8(p, survivor ? 0 : GetEntProp(client, Prop_Send, "m_zombieClass"));
		p = RplU8(p, weaponId);
		p = RplU16(p, clip);
		p = RplU16(p, reserve);
	}

	int entCount = 0;

	// Non-rostered clients: survivor bots, AI specials, the AI tank. Iterated
	// rather than tracked, because MaxClients is under twenty and because
	// OnEntityCreated does not usefully report a bot taking a slot.
	for (int i = 0; i < botCount && entCount < RPL_MAX_ENTITIES; i++)
	{
		int c = bots[i];
		int kind = RplBotKind(c);
		if (kind == 0) continue;
		GetClientAbsOrigin(c, pos);
		p = RplU16(p, c);
		p = RplU8(p, kind);
		p = RplU8(p, RplClientState(c, RplIsGhost(c)));
		p = RplI16(p, RoundToNearest(pos[0]));
		p = RplI16(p, RoundToNearest(pos[1]));
		p = RplI16(p, RoundToNearest(pos[2]));
		p = RplU16(p, GetClientHealth(c));
		entCount++;
	}

	// World entities, from the incrementally maintained set. Walked backwards
	// so erasing a stale ref does not skip the next element.
	if (sampleEntities)
	{
		for (int i = g_hRplEnts.Length - 1; i >= 0; i--)
		{
			int ref = g_hRplEnts.Get(i);
			int ent = EntRefToEntIndex(ref);
			if (ent == INVALID_ENT_REFERENCE || !IsValidEntity(ent))
			{
				// OnEntityDestroyed is the normal removal path; this catches
				// anything that slipped past it, e.g. across a map change.
				g_hRplEnts.Erase(i);
				continue;
			}
			if (entCount >= RPL_MAX_ENTITIES) break;
			char cls[64];
			GetEntityClassname(ent, cls, sizeof(cls));
			int kind = RplWorldKind(cls);
			if (kind == 0) continue;
			GetEntPropVector(ent, Prop_Send, "m_vecOrigin", pos);
			p = RplU16(p, ent);
			p = RplU8(p, kind);
			p = RplU8(p, RPL_S_ALIVE);
			p = RplI16(p, RoundToNearest(pos[0]));
			p = RplI16(p, RoundToNearest(pos[1]));
			p = RplI16(p, RoundToNearest(pos[2]));
			// A rock has no meaningful health. A witch's is what makes a crown
			// visible in the timeline, so it is worth the two bytes.
			p = RplU16(p, kind == RPL_K_TANK_ROCK ? 0 : GetEntProp(ent, Prop_Data, "m_iHealth"));
			entCount++;
		}
	}

	// Patch the frame header now that the count is known.
	RplU32(0, tMs);
	RplU16(4, entCount);
	RplU16(6, 0);

	// One call for the whole frame. No FlushFile, ever: the page cache serves
	// a tailing reader on this box, and a 10Hz flush is the most direct way to
	// turn an estimated cost into a measured stall.
	if (!WriteFile(g_hReplay, g_iRplBuf, p, 1))
	{
		LogError("pug: replay frame write failed at frame %d; recording disabled for this match", g_iReplayFrames);
		RplFail();
		return Plugin_Stop;
	}
	g_iReplayFrames++;
	g_iReplayBytes += p;

	// The plugin's half of the disk protection. SourceMod exposes no
	// disk-free-space native, so the backend owns the real free-space floor
	// and this is a runaway bound: a full round is 10 to 15 MB, the default
	// cap is 64. Hitting it closes cleanly, keeping every frame so far.
	if (g_iReplayBytes >= g_cvReplayMaxMb.IntValue * 1024 * 1024)
	{
		LogError("pug: replay hit the %d MB cap after %d frames; closing this round's file",
			g_cvReplayMaxMb.IntValue, g_iReplayFrames);
		RplClose();
		return Plugin_Stop;
	}
	return Plugin_Continue;
}
```

- [ ] **Step 6: Compile and check the record widths by eye**

Run: `cd plugin && ./build.sh`
Expected: `built: .../pug-match.smx`, no errors. `RplOpen` and `RplClose` are not called by anything until Step 7, so a "symbol is never used" warning for those two is expected here and must be gone after Step 8.

Then count the packing calls against `src/replayFormat.ts` before going near the server, because a mismatch here produces plausible nonsense rather than an error:

- Header: the writes in `RplOpen` must land `magic` at 0, `version` 4, `ordinal` 6, `half` 7, `playerHz` 8, `entityHz` 9, `token` 12, `map` 44, `startedUnix` 76, `indexOffset` 80, `indexCount` 84, slots 88, `frameCount` 152, total 160.
- Player record: `x y z yaw` as four int16 (0,2,4,6), `pitch` int8 (8), `state` uint8 (9), `health` uint16 (10), `temp` uint16 (12), `cls` uint8 (14), `weapon` uint8 (15), `clip` uint16 (16), `reserve` uint16 (18), total 20.
- Entity record: `ref` uint16 (0), `kind` uint8 (2), `state` uint8 (3), `x y z` int16 (4,6,8), `health` uint16 (10), total 12.

- [ ] **Step 7: Wire the lifecycle into the existing round hooks**

In `OnRoundIsLive`, at the very end of the `if (g_State == MS_Live)` block, after the `ROUND_START` emission:

```sourcepawn
		RplOpen();
```

In `EmitRoundEnd`, immediately before `g_fRoundLiveAt = 0.0;`:

```sourcepawn
	// Close before the round timing is cleared: RplClose logs the frame count
	// and nothing after this point can produce another frame.
	RplClose();
```

In `OnMapStart` and in whatever function resets match state (the one that clears `g_sToken`), add:

```sourcepawn
	RplClose();
```

and in the match-state reset only, also clear the failure latch so the next match gets a fresh start:

```sourcepawn
	g_bReplayFailed = false;
```

In `OnPluginEnd`:

```sourcepawn
	RplClose();
```

- [ ] **Step 8: Compile**

Run: `cd plugin && ./build.sh`
Expected: `built: .../pug-match.smx`, no errors and no warnings.

- [ ] **Step 9: Commit**

```bash
# Source only. pug-match.smx is gitignored (.gitignore:5) as a build artifact.
git add plugin/pug-match.sp
git commit -m "feat(plugin): record 10Hz replay frames to a per-round binary file"
```

---

### Task 8: In-game verification and the frame-time gate

Nothing above proves the plugin and the parser agree. The TypeScript tests pass against the TypeScript encoder, and the Pawn writer is a second implementation of the same layout written by hand. **This task is where that loop closes**, and it is the task the whole plan exists to reach.

The frame-time comparison is an acceptance criterion, not a footnote. The box's recorded baseline p99 is 11.25ms against a 10ms budget at 100 tick, so roughly 1% of frames already overrun and there is no headroom to spend carelessly.

**Files:**
- Create: `scripts/dump-replay.ts`
- Modify: `plugin/TESTING.md`

- [ ] **Step 1: Write the inspection script**

```ts
// scripts/dump-replay.ts
// Read a replay written by the plugin and print what it contains.
// Usage: npx tsx scripts/dump-replay.ts <file.rpl>
import { readFileSync } from 'node:fs';
import { decodeIndex, parseReplay, ENTITY_KIND, STATE } from '../src/replayFormat.js';

const path = process.argv[2];
if (!path) { console.error('usage: tsx scripts/dump-replay.ts <file.rpl>'); process.exit(1); }

const buf = readFileSync(path);
const replay = parseReplay(buf);
if (!replay) { console.error('not a replay file (bad magic or too short)'); process.exit(1); }

const { header, frames, truncatedBytes } = replay;
console.log('header', header);
console.log('frames', frames.length, 'truncatedBytes', truncatedBytes);
console.log('index', decodeIndex(buf, header).length, 'keyframes');

if (frames.length >= 2) {
  const span = frames[frames.length - 1].tMs - frames[0].tMs;
  console.log('duration', (span / 1000).toFixed(1), 's');
  console.log('effective hz', (((frames.length - 1) * 1000) / span).toFixed(2));
}

const kindName = Object.fromEntries(Object.entries(ENTITY_KIND).map(([k, v]) => [v, k]));
const mid = frames[Math.floor(frames.length / 2)];
if (mid) {
  console.log('--- middle frame, t =', mid.tMs, 'ms ---');
  for (const p of mid.players) {
    if (!(p.state & STATE.PRESENT)) continue;
    console.log(
      ` slot ${p.slot} ${header.slots[p.slot] || '(no steamid)'}`,
      `pos ${p.x},${p.y},${p.z} yaw ${p.yaw}`,
      `hp ${p.health}+${p.temp} wep ${p.weapon} ${p.clip}/${p.reserve}`,
      `state 0x${p.state.toString(16)}`,
    );
  }
  const byKind: Record<string, number> = {};
  for (const e of mid.entities) byKind[kindName[e.kind] ?? `unknown(${e.kind})`] = (byKind[kindName[e.kind] ?? `unknown(${e.kind})`] ?? 0) + 1;
  console.log(' entities', mid.entities.length, byKind);
}
```

- [ ] **Step 2: Stage the plugin**

```bash
cd plugin && ./stage.sh --solo
```

`--solo` also sets `sm_pug_min_orient 1` and `sm_pug_debug 1`, which is what makes a one-person test produce a settled orientation mapping and verbose logging. `stage.sh` copies one file and calls `sm plugins load`: no restart, no map change, nobody dropped.

- [ ] **Step 3: Confirm the cvars exist and recording is on**

```bash
./stage.sh --status
```

Expected: `sm_pug_replay_hz 10`, `sm_pug_replay_entity_hz 10`, `sm_pug_replay_dir replays`, `sm_pug_replay_max_mb 64`. A missing cvar means the staged `.smx` is the old one and nothing below is meaningful.

- [ ] **Step 4: Play a round solo**

Start a match with `!load_4v4p`, ready up, and play a few minutes of a half, then end the round. Move around, get bots into the shot, shoot commons, and if you can, get pinned once. The point is to produce variety, not to play well.

- [ ] **Step 5: Confirm the file exists and is growing**

```bash
ls -la /home/l4d/l4d1-server/left4dead/replays/
```

Expected: one `pug_<token>_<ordinal>_<half>.rpl` per round played, tens to hundreds of KB per minute. Zero bytes means `RplOpen` failed; check `addons/sourcemod/logs/errors_*.log`.

- [ ] **Step 6: Pull a file back and read it**

```bash
scp l4d@<host>:/home/l4d/l4d1-server/left4dead/replays/pug_*.rpl /tmp/
npx tsx scripts/dump-replay.ts /tmp/pug_<token>_1_1.rpl
```

Expected, and each of these is a distinct thing that can be wrong:
- `header.token` matches the filename, `map` is the real map name, `ordinal` and `half` are right.
- `effective hz` is close to 10.00. Materially below means the timer is being starved and the sample rate is a lie.
- `truncatedBytes` is 0 and `index` is non-zero. Non-zero truncation on a cleanly ended round means `RplClose` did not run.
- `header.slots[0]` is your SteamID64. A wrong or zero value means `StringToInt64` packing is wrong and every slot mapping in the viewer will be wrong.
- Your player record's `pos` changes between frames and is within roughly +/- 16384.
- `hp` is 100 or below with a plausible temp value, `wep`/`clip`/`reserve` match what you were holding.
- `entities` in the middle frame contains `SURVIVOR_BOT` entries for the bots and `COMMON` entries for the commons.

**The single most likely failure is a layout disagreement**, where the Pawn writer and `replayFormat.ts` put a field at different offsets. The symptom is not an error: it is plausible-looking nonsense, for example health in the thousands or positions that jump wildly. If that happens, compare the offsets in `RplOpen`/`Timer_RplFrame` against `OFF` and the record layouts in `src/replayFormat.ts` field by field.

- [ ] **Step 7: Run the frame-time gate**

This is the acceptance criterion. With `l4d_tickstats` capturing, play roughly five minutes at each setting, changing it live by rcon:

```bash
python3 ../deploy/rcon.py "sm_pug_replay_hz 0"
# play ~5 minutes
python3 ../deploy/rcon.py "sm_pug_replay_hz 10"
# play ~5 minutes
```

Compare p99 and p999 between the two captures. Record both numbers in `plugin/TESTING.md` whatever the outcome.

- **p99 unchanged:** ship at 10Hz.
- **p99 moves measurably:** set `sm_pug_replay_entity_hz 5` and re-measure. Entities are the larger half of the per-frame work, and halving them is visually identical after viewer interpolation.
- **Still moving with entities at 5Hz:** set `sm_pug_replay_hz 5` and re-measure.
- **Still moving at 5Hz/5Hz:** stop. The design's cost estimate is wrong, and that is a finding worth having before anything is built on top of it. Leave `sm_pug_replay_hz 0` on the box and write up what was measured.

- [ ] **Step 8: Confirm chat landed**

```bash
sqlite3 data/pug.db "SELECT seq, half, t_ms, team, message FROM match_chat ORDER BY seq DESC LIMIT 10;"
```

Expected: what you typed, intact, including any message containing spaces. Say something with an `=` in it and confirm it survives whole. No rows at all means `player_say` did not hook; check the SourceMod error log for the `LogError` from Task 6.

- [ ] **Step 9: Confirm indexing happened on its own**

Indexing is wired into `round_end` and into match completion, so no manual step should be needed. Check:

```bash
sqlite3 data/pug.db "SELECT match_id, ordinal, half, frames, sample_hz, bytes FROM match_replays;"
```

Expected: one row per round file, `frames` matching what `dump-replay.ts` reported, `sample_hz` 10.

No rows at all, with files present on disk, means `REPLAY_DIR` is unset or points somewhere other than `sm_pug_replay_dir` resolves to. Those two are separate settings on separate sides of the box and nothing forces them to agree, which makes this the most likely configuration mistake in the whole piece. `sm_pug_replay_dir` is relative to the game dir, so `replays` means `<gamedir>/left4dead/replays`, and `REPLAY_DIR` must be the absolute path to that same directory.

- [ ] **Step 10: Record the result and commit the runbook**

```bash
git add plugin/TESTING.md scripts/dump-replay.ts
git commit -m "docs(plugin): add the replay recording verification runbook"
```
