import { describe, it, expect } from 'vitest';
import { appendChunk, replayUrl, type ReplayState } from './source';
import {
  encodeHeader, encodeFrame, HEADER_BYTES, PLAYER_SLOTS, frameBytes, VERSION,
  type ReplayHeader, type Frame,
} from '../../../src/replayFormat';

const TOKEN = 'a'.repeat(32);

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1_785_956_274, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const EMPTY: ReplayState = { header: null, frames: [], cursor: 0 };

describe('appendChunk', () => {
  it('reads the header out of the first chunk', () => {
    const chunk = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
    const got = appendChunk(EMPTY, chunk, 0);
    expect(got.header?.map).toBe('l4d_vs_farm01_hilltop');
    expect(got.frames).toHaveLength(1);
    expect(got.cursor).toBe(HEADER_BYTES + frameBytes(0));
  });

  it('gives frames in the first chunk absolute offsets', () => {
    const chunk = concat([encodeHeader(header()), encodeFrame(emptyFrame(0)), encodeFrame(emptyFrame(100))]);
    const got = appendChunk(EMPTY, chunk, 0);
    expect(got.frames.map((f) => f.offset))
      .toEqual([HEADER_BYTES, HEADER_BYTES + frameBytes(0)]);
  });

  // The reason this function exists. A later chunk starts at `base` bytes into
  // the file, and decodeFrames numbers offsets from the start of whatever it
  // was handed. Without the shift, every frame after the first poll claims to
  // live in the header.
  it('shifts a later chunk by its base offset', () => {
    const first = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
    const state = appendChunk(EMPTY, first, 0);
    const base = state.cursor;

    const second = concat([encodeFrame(emptyFrame(100)), encodeFrame(emptyFrame(200))]);
    const got = appendChunk(state, second, base);

    expect(got.frames).toHaveLength(3);
    expect(got.frames.map((f) => f.offset))
      .toEqual([HEADER_BYTES, base, base + frameBytes(0)]);
    expect(got.cursor).toBe(base + frameBytes(0) * 2);
  });

  it('ignores an empty chunk, which is what a poll with nothing new returns', () => {
    const first = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
    const state = appendChunk(EMPTY, first, 0);
    const got = appendChunk(state, new Uint8Array(0), state.cursor);
    expect(got.frames).toHaveLength(1);
    expect(got.cursor).toBe(state.cursor);
  });

  it('returns the state unchanged when the first chunk is not a replay', () => {
    const got = appendChunk(EMPTY, new Uint8Array(HEADER_BYTES).fill(7), 0);
    expect(got.header).toBeNull();
    expect(got.frames).toEqual([]);
  });
});

describe('replayUrl', () => {
  it('builds a file url', () => {
    expect(replayUrl({ kind: 'file', name: `pug_${TOKEN}_0_1.rpl` }, 0))
      .toBe(`/api/replays/file/pug_${TOKEN}_0_1.rpl?since=0`);
  });

  it('builds a match url', () => {
    expect(replayUrl({ kind: 'match', matchId: 8, ordinal: 1, half: 2 }, 320))
      .toBe('/api/replays/match/8/1/2?since=320');
  });
});
