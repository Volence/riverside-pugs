import { describe, it, expect } from 'vitest';
import {
  HEADER_BYTES, VERSION, LOS_FLAG_OFFSET,
  encodeHeader, decodeHeader, encodeFrame, decodeFrames, parseReplay,
  sideRanks, canSee, type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const ID = (n: number) => `7656119800000000${n}`;

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: 'a'.repeat(32), ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1790000000, indexOffset: 0, indexCount: 0, frameCount: 0,
    // Survivors in slots 0, 2, 5, 6; infected in 1, 3, 4, 7 (mask 0b10011010).
    slots: [ID(1), ID(2), ID(3), ID(4), ID(5), ID(6), ID(7), ID(8)],
    infectedMask: 0b10011010, sidesKnown: true, losKnown: true,
    ...over,
  };
}

function frame(los: number): Frame {
  return { tMs: 1000, players: [], entities: [], offset: 0, los };
}

function file(h: ReplayHeader, frames: Frame[]): Uint8Array {
  const parts = [encodeHeader(h), ...frames.map(encodeFrame)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('sideRanks', () => {
  it('ranks each side in slot order from the side mask', () => {
    expect(sideRanks(header())).toEqual({
      survivor: [0, -1, 1, -1, -1, 2, 3, -1],
      infected: [-1, 0, -1, 1, 2, -1, -1, 3],
    });
  });

  it('skips empty slots', () => {
    const h = header({ slots: [ID(1), '', ID(3), ID(4), '', '', '', ''], infectedMask: 0b1000 });
    expect(sideRanks(h)).toEqual({
      survivor: [0, -1, 1, -1, -1, -1, -1, -1],
      infected: [-1, -1, -1, 0, -1, -1, -1, -1],
    });
  });

  it('gives a fifth player on one side no rank', () => {
    const h = header({ infectedMask: 0 });
    expect(sideRanks(h).survivor).toEqual([0, 1, 2, 3, -1, -1, -1, -1]);
  });

  it('gives no ranks when the sides are not known', () => {
    const h = header({ sidesKnown: false });
    expect(sideRanks(h)).toEqual({ survivor: Array(8).fill(-1), infected: Array(8).fill(-1) });
  });
});

describe('visibility in frame bytes 6-7', () => {
  it('round-trips the flag and the bits', () => {
    const buf = file(header(), [frame(0b1000_0000_0000_0001)]);
    expect(buf[LOS_FLAG_OFFSET]).toBe(1);
    const r = parseReplay(buf)!;
    expect(r.header.losKnown).toBe(true);
    expect(r.frames[0].los).toBe(0b1000_0000_0000_0001);
  });

  it('reads an existing file (byte 158 zero) as unknown, frames unchanged', () => {
    const h = header({ losKnown: false });
    const buf = file(h, [frame(0)]);
    expect(decodeHeader(buf)!.losKnown).toBe(false);
    const { frames } = decodeFrames(buf, HEADER_BYTES, buf.length);
    expect(frames).toHaveLength(1);
    expect(frames[0].los).toBe(0);
  });

  it('answers canSee from the bit for that survivor and infected rank', () => {
    const h = header();
    // Survivor rank 1 (slot 2) sees infected rank 2 (slot 4): bit 1*4+2 = 6.
    const f = frame(1 << 6);
    expect(canSee(h, f, 2, 4)).toBe(true);
    expect(canSee(h, f, 0, 4)).toBe(false);
    expect(canSee(h, f, 2, 1)).toBe(false);
  });

  it('is null, never false, when the file does not record visibility', () => {
    expect(canSee(header({ losKnown: false }), frame(0xffff), 0, 1)).toBeNull();
  });

  it('is null for a slot that is not on the side asked about', () => {
    expect(canSee(header(), frame(0xffff), 1, 4)).toBeNull();
    expect(canSee(header(), frame(0xffff), 0, 2)).toBeNull();
  });
});
