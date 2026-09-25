import { PLAYER_SLOTS, STATE, type Frame, type PlayerSample, type ReplayHeader } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';

/** Survivors in slots 0 and 1, infected in 4 and 5. Ranks: survivor 0 and 1,
 *  infected 0 and 1. Bits: (s0, i4) = 0, (s1, i4) = 4, (s0, i5) = 1, (s1, i5) = 5. */
export function header(losKnown = true): ReplayHeader {
  return {
    version: 3, token: '0'.repeat(32), ordinal: 1, half: 1, playerHz: 10, entityHz: 10, map: 'l4d_vs_hospital02_subway',
    startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['s0', 's1', '', '', 'i4', 'i5', '', ''], infectedMask: 0b110000, sidesKnown: true, losKnown,
  };
}

export function blank(slot: number): PlayerSample {
  return { slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0 };
}

export interface SceneOpts {
  n?: number;
  /** Frames the crosshair runs behind the hunter. */
  lagFrames?: number;
  amp?: number;
  /** Frame bytes 6-7 for frame i. Default 0: hidden from everyone. */
  los?: (i: number) => number;
  hunterCls?: number;
  yaw?: (i: number, angle: (k: number) => number) => number;
  extra?: (i: number, players: PlayerSample[]) => void;
}

/**
 * Survivor slot 0 at the origin; teammate slot 1 alive well off to the side
 * (bearing -90, never on the hunter's bearing); hunter slot 4 spawned and
 * swinging on an arc at 1200 units, so its bearing changes at a changing rate.
 */
export function scene(o: SceneOpts = {}): Frame[] {
  const n = o.n ?? 40, amp = o.amp ?? 15, lag = o.lagFrames ?? 2;
  const angle = (i: number) => amp * Math.sin(i / 3);
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const a = angle(i) * Math.PI / 180;
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE, yaw: o.yaw ? o.yaw(i, angle) : angle(i - lag) };
    players[1] = { ...blank(1), state: STATE.PRESENT | STATE.ALIVE, x: 0, y: -500 };
    players[4] = { ...blank(4), state: STATE.PRESENT | STATE.ALIVE, cls: o.hunterCls ?? 3, x: Math.cos(a) * 1200, y: Math.sin(a) * 1200 };
    o.extra?.(i, players);
    frames.push({ tMs: TUNING.SPAWN_GRACE_MS + i * 100, offset: 0, players, entities: [], los: o.los ? o.los(i) : 0 });
  }
  return frames;
}
