import { describe, it, expect } from 'vitest';
import { PLAYER_SLOTS, STATE, type Frame, type PlayerSample } from '../src/replayFormat.js';
import { TUNING } from '../src/integrity/constants.js';
import { aimError, pitchError } from '../src/integrity/geometry.js';
import { trackWindows } from '../src/integrity/ghostTrack.js';
import { busiestPair, injectTracker } from '../src/integrity/synthetic.js';

function blank(slot: number): PlayerSample {
  return { slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0 };
}

/** Survivor 0 jogs east looking dead north the whole time. Ghost 4 runs a
 *  weave 700 units off, up a slope. Ghost 5 exists for six frames only. */
function scene(n = 80): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / 10;
    const players = Array.from({ length: PLAYER_SLOTS }, (_, s) => blank(s));
    players[0] = { ...blank(0), state: STATE.PRESENT | STATE.ALIVE, x: Math.round(120 * t), yaw: 90, pitch: 0 };
    players[4] = {
      ...blank(4), state: STATE.PRESENT | STATE.GHOST,
      x: Math.round(700 + 150 * Math.sin(1.5 * t)), y: Math.round(-400 + 260 * t), z: 300,
    };
    if (i < 6) players[5] = { ...blank(5), state: STATE.PRESENT | STATE.GHOST, x: -900, y: 900 };
    frames.push({ tMs: TUNING.SPAWN_GRACE_MS + i * 100, offset: 0, players, entities: [] });
  }
  return frames;
}

const bestOf = (frames: Frame[]) => Math.max(0, ...trackWindows(frames, 0).map((w) => w.fidelity));

describe('injectTracker', () => {
  it('turns a survivor who never looked at the ghost into one who follows it', () => {
    expect(trackWindows(scene(), 0)).toEqual([]);
    const out = injectTracker(scene(), 0, 4, { lagMs: 0, noiseDeg: 0, noiseTauMs: 0, seed: 1 });
    expect(bestOf(out)).toBeGreaterThan(0.95);
  });

  it('puts the pitch on the ghost too, or the pitch gate would hide the whole injection', () => {
    const out = injectTracker(scene(), 0, 4, { lagMs: 0, noiseDeg: 0, noiseTauMs: 0, seed: 1 });
    for (const f of out) expect(Math.abs(pitchError(f.players[0], f.players[4]))).toBeLessThanOrEqual(1);
  });

  it('aims where the ghost WAS when there is lag, so the error grows with the ghost\'s speed', () => {
    const out = injectTracker(scene(), 0, 4, { lagMs: 150, noiseDeg: 0, noiseTauMs: 0, seed: 1 });
    const err = out.slice(5).map((f) => Math.abs(aimError(f.players[0].yaw, f.players[0], f.players[4])));
    expect(Math.max(...err)).toBeGreaterThan(1);
    expect(Math.max(...err)).toBeLessThan(TUNING.E_TRACK);
    expect(bestOf(out)).toBeLessThan(bestOf(injectTracker(scene(), 0, 4, { lagMs: 0, noiseDeg: 0, noiseTauMs: 0, seed: 1 })));
  });

  it('adds noise of the RMS it was asked for, the same every time for the same seed', () => {
    const opts = { lagMs: 0, noiseDeg: 2, noiseTauMs: 0, seed: 7 };
    const a = injectTracker(scene(400), 0, 4, opts), b = injectTracker(scene(400), 0, 4, opts);
    expect(a.map((f) => f.players[0].yaw)).toEqual(b.map((f) => f.players[0].yaw));
    const err = a.map((f) => aimError(f.players[0].yaw, f.players[0], f.players[4]));
    const rms = Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length);
    expect(rms).toBeGreaterThan(1.7);
    expect(rms).toBeLessThan(2.3);
  });

  it('costs less fidelity when the same noise is slow, as a hand is, than when it is white', () => {
    const white = injectTracker(scene(), 0, 4, { lagMs: 0, noiseDeg: 2, noiseTauMs: 0, seed: 3 });
    const slow = injectTracker(scene(), 0, 4, { lagMs: 0, noiseDeg: 2, noiseTauMs: 500, seed: 3 });
    expect(bestOf(slow)).toBeGreaterThan(bestOf(white));
  });

  it('touches nothing but that survivor\'s view, and only while the target is a ghost', () => {
    const before = scene();
    const spawned = scene();
    for (const f of spawned.slice(40)) f.players[4].state = STATE.PRESENT | STATE.ALIVE;
    const out = injectTracker(spawned, 0, 4, { lagMs: 0, noiseDeg: 0, noiseTauMs: 0, seed: 1 });
    expect(out[60].players[0].yaw).toBe(90);
    expect(out[10].players[0].yaw).not.toBe(90);
    expect(out[10].players[0].x).toBe(before[10].players[0].x);
    expect(out[10].players[4]).toEqual(before[10].players[4]);
    // The input is left alone.
    expect(spawned[10].players[0].yaw).toBe(90);
  });
});

describe('busiestPair', () => {
  it('picks the survivor and ghost with the most eligible frames between them', () => {
    expect(busiestPair(scene(), [0])).toMatchObject({ slot: 0, ghostSlot: 4 });
  });

  it('is null when no pair was ever eligible', () => {
    const frames = scene().map((f) => ({ ...f, tMs: f.tMs - TUNING.SPAWN_GRACE_MS }));
    expect(busiestPair(frames.slice(0, 40), [0])).toBeNull();
  });
});
