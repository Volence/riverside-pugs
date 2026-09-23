import { describe, expect, it } from 'vitest';
import { encodeFrame, encodeHeader, STATE, type Frame, type ReplayHeader } from '../../src/replayFormat.js';
import { decodeRoundReplay } from '../../src/metrics/replayRound.js';

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: 3, token: 'c'.repeat(32), ordinal: 0, half: 1, playerHz: 10, entityHz: 10,
    map: 'l4d_vs_hospital01_apartment', startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['1', '2', '', '', '', '', '', ''], infectedMask: 0b10, sidesKnown: true, losKnown: false, ...over,
  };
}
const idle = (slot: number) => ({ slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0 });
function frame(tMs: number): Frame {
  const players = Array.from({ length: 8 }, (_, s) => idle(s));
  players[0] = { ...idle(0), state: STATE.PRESENT | STATE.ALIVE, health: 100 };
  players[1] = { ...idle(1), state: STATE.PRESENT | STATE.ALIVE, health: 250, cls: 3 };
  return { tMs, players, entities: [], offset: 0 };
}
function bytes(h: ReplayHeader, frames: Frame[]): Uint8Array {
  const parts = [encodeHeader(h), ...frames.map(encodeFrame)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('decodeRoundReplay', () => {
  it('uses the header side mask and drops paused frames', () => {
    const r = decodeRoundReplay(bytes(header(), [frame(0), frame(100), frame(100), frame(100), frame(200)]), () => null)!;
    expect(r.frames.map((f) => f.tMs)).toEqual([0, 100, 200]);
    expect(r.frames[0].players[1].infected).toBe(true);
    expect(r.frames[0].players[0].infected).toBe(false);
    expect(r.durationMs).toBe(300);
  });

  it('caps a gap in the file at one second', () => {
    const r = decodeRoundReplay(bytes(header(), [frame(0), frame(100), frame(60_000)]), () => null)!;
    expect(r.durationMs).toBe(100 + 1000 + 100);
  });

  it('uses the fallback mask for a file without one, and gives up without it', () => {
    const old = header({ version: 2, sidesKnown: false, infectedMask: 0 });
    const withMask = decodeRoundReplay(bytes(old, [frame(0), frame(100)]), () => 0b01)!;
    expect(withMask.frames[0].players[0].infected).toBe(true);
    expect(decodeRoundReplay(bytes(old, [frame(0), frame(100)]), () => null)).toBeNull();
  });

  it('returns null for garbage and for fewer than two frames', () => {
    expect(decodeRoundReplay(new Uint8Array(10), () => null)).toBeNull();
    expect(decodeRoundReplay(bytes(header(), [frame(0)]), () => null)).toBeNull();
  });
});
