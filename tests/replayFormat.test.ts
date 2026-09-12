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
    buf.set([0x58, 0x58, 0x58, 0x58], 0);
    expect(decodeHeader(buf)).toBeNull();
  });

  it('rejects a buffer shorter than the header', () => {
    expect(decodeHeader(encodeHeader(header()).subarray(0, 40))).toBeNull();
  });

  it('decodes a buffer that is a view into a larger ArrayBuffer', () => {
    const h = header();
    const encoded = encodeHeader(h);
    // Deliberately not at offset 0. Buffer.alloc hands out pooled memory with
    // a non-zero byteOffset all the time, so this is the common case in
    // production and the rare case in tests.
    const backing = new Uint8Array(encoded.length + 64);
    backing.set(encoded, 64);
    expect(decodeHeader(backing.subarray(64))).toEqual(h);
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

describe('format version', () => {
  it('refuses to parse a file from a newer writer', () => {
    const buf = Buffer.concat([
      encodeHeader(header({ version: VERSION + 1 })),
      encodeFrame(frame({ tMs: 1 })),
    ]);
    expect(parseReplay(buf)).toBeNull();
  });

  it('still parses the current version', () => {
    const buf = Buffer.concat([encodeHeader(header()), encodeFrame(frame({ tMs: 1 }))]);
    expect(parseReplay(buf)?.frames).toHaveLength(1);
  });

  // decodeHeader deliberately does NOT gate on version. Something has to be
  // able to read a newer file's header in order to say "this file is newer
  // than I am" instead of "this file is corrupt", and the browse listing does
  // exactly that.
  it('still reports the version of a newer file through decodeHeader', () => {
    const got = decodeHeader(encodeHeader(header({ version: VERSION + 1 })));
    expect(got?.version).toBe(VERSION + 1);
  });
});
