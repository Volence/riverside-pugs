import { describe, it, expect } from 'vitest';
import { STATE, type Frame } from '../src/replayFormat.js';
import { losView } from '../src/integrity/los.js';
import { pickClips } from '../src/integrity/ghostTrack.js';
import { hiddenGate, hiddenOccupancy, hiddenTrackWindows, scanHidden } from '../src/integrity/hidden.js';
import { cellKey, cellOf, type PriorTable } from '../src/integrity/aimPrior.js';
import { blank, header, scene } from './hiddenFixtures.js';

const LOS = losView(header());

describe('hiddenGate', () => {
  const f = scene()[10];
  const s = f.players[0], t = f.players[4];

  it('passes a spawned hunter nobody on the team can see', () => {
    expect(hiddenGate(f, s, t, LOS)).toBe('pass');
  });

  it('drops a hunter the survivor can see, or a teammate can', () => {
    expect(hiddenGate({ ...f, los: 1 << 0 }, s, t, LOS)).toBe('seen');
    expect(hiddenGate({ ...f, los: 1 << 4 }, s, t, LOS)).toBe('teamSees');
  });

  it('says unknown rather than hidden for a file without line of sight', () => {
    expect(hiddenGate(f, s, t, losView(header(false)))).toBe('losUnknown');
  });

  it('only scores living, spawned smokers, boomers and hunters', () => {
    expect(hiddenGate(f, s, { ...t, cls: 5 }, LOS)).toBe('notTarget');
    expect(hiddenGate(f, s, { ...t, state: t.state | STATE.GHOST }, LOS)).toBe('notTarget');
    expect(hiddenGate(f, { ...s, state: s.state | STATE.INCAP }, t, LOS)).toBe('notLive');
  });

  it('keeps the grace period and the minimum distance', () => {
    expect(hiddenGate({ ...f, tMs: 0 }, s, t, LOS)).toBe('inGrace');
    expect(hiddenGate(f, s, { ...t, x: 100, y: 0 }, LOS)).toBe('tooClose');
  });

  it('lets only something the survivor could see stand in the way', () => {
    // A spawned smoker (slot 5) on the hunter's bearing, 1000 units out.
    const smoker = { ...blank(5), state: STATE.PRESENT | STATE.ALIVE, cls: 1, x: 1000, y: 0 };
    const withSmoker = { ...f, players: f.players.map((p) => (p.slot === 5 ? smoker : p)) };
    // The survivor cannot see the smoker either (bit 1 clear): it explains nothing.
    expect(hiddenGate(withSmoker, s, t, LOS)).toBe('pass');
    // The survivor can see the smoker (bit 1 set): the crosshair has an innocent target.
    expect(hiddenGate({ ...withSmoker, los: 1 << 1 }, s, t, LOS)).toBe('occluded');
  });
});

describe('scanHidden', () => {
  it('tallies where every pair fell and passes the rest', () => {
    const frames = scene({ los: (i) => (i < 10 ? 1 << 0 : 0) });
    let passed = 0;
    const t = scanHidden(frames, 0, LOS, () => passed++);
    expect(t.considered).toBe(40);
    expect(t.seen).toBe(10);
    expect(t.passed).toBe(30);
    expect(passed).toBe(30);
  });
});

describe('metric D, hidden tracking', () => {
  it('finds a crosshair following a hidden hunter two frames late', () => {
    const frames = scene();
    const ws = hiddenTrackWindows(frames, 0, LOS).filter((w) => w.startMs >= frames[2].tMs);
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) {
      expect(w.lagFidelity).toBeGreaterThan(0.99);
      expect(w.targetCls).toBe(3);
    }
    expect(pickClips(ws, (w) => w.lagFidelity).length).toBeGreaterThan(0);
  });

  it('finds nothing when the survivor or a teammate could see the hunter', () => {
    expect(hiddenTrackWindows(scene({ los: () => 1 << 0 }), 0, LOS)).toEqual([]);
    expect(hiddenTrackWindows(scene({ los: () => 1 << 4 }), 0, LOS)).toEqual([]);
  });

  it('finds nothing in a file that does not record line of sight', () => {
    expect(hiddenTrackWindows(scene(), 0, losView(header(false)))).toEqual([]);
  });
});

/** A prior that puts probability `p` on every cell the hunter stood in. */
function priorOver(frames: Frame[], slot: number, p: number): PriorTable {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const t = f.players[slot];
    const c = cellOf(t.x, t.y);
    counts.set(cellKey(c.cx, c.cy), p * 1000);
  }
  return { frames: 1000, counts };
}

describe('metric E, hidden pre-aim', () => {
  it('counts blocks on a hidden hunter against what the map predicts, per class', () => {
    // On time, so the aim is inside E_DWELL every frame. tMs runs 5000 to 8900:
    // blocks 2, 3 and 4 of OCC_BLOCK_MS.
    const frames = scene({ lagFrames: 0 });
    const { occ, gates } = hiddenOccupancy(frames, 0, priorOver(frames, 4, 0.01), LOS);
    expect(gates.passed).toBe(40);
    expect(occ!.all!.blocks).toBe(3);
    expect(occ!.all!.observed).toBeCloseTo(3);
    expect(occ!.all!.expected).toBeCloseTo(0.03);
    expect(occ!.byClass.hunter).toEqual(occ!.all);
    expect(occ!.byClass.smoker).toBeNull();
    expect(occ!.byClass.boomer).toBeNull();
  });

  it('has no score without a prior, and still reports coverage', () => {
    const { occ, gates } = hiddenOccupancy(scene({ lagFrames: 0 }), 0, null, LOS);
    expect(occ).toBeNull();
    expect(gates.passed).toBe(40);
  });
});
