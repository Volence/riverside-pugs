import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { ENTITY_KIND, STATE, type EntitySample, type Frame, type PlayerSample } from '../../src/replayFormat.js';
import { unpausedFrames } from '../../src/integrity/round.js';
import { feedProgressPoints, halfSnapshots, progressTimeline, snapshotAt } from '../../src/winLive/snapshot.js';

const ALIVE = STATE.PRESENT | STATE.ALIVE;
function surv(slot: number, state: number, health: number, temp = 0): PlayerSample {
  return { slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state, health, temp, cls: 0, weapon: 0, clip: 0, reserve: 0, infected: false };
}
function tankPlayer(slot: number, health: number): PlayerSample {
  return { ...surv(slot, ALIVE, health), cls: 5, infected: true };
}
function tankEnt(ref: number, health: number): EntitySample {
  return { ref, kind: ENTITY_KIND.TANK_AI, state: ALIVE, x: 0, y: 0, z: 0, health };
}
function frame(tMs: number, players: PlayerSample[] = [], entities: EntitySample[] = []): Frame {
  return { tMs, players, entities, offset: 0 };
}
/** Frames every second from `from` to `to`, built by `make` from the time. */
function run(from: number, to: number, make: (t: number) => Frame): Frame[] {
  const out: Frame[] = [];
  for (let t = from; t <= to; t += 1000) out.push(make(t));
  return out;
}
const standing = [surv(0, ALIVE, 60, 20), surv(1, ALIVE, 100)];

describe('progressTimeline', () => {
  const at = progressTimeline([{ tMs: 0, prog: 0 }, { tMs: 10000, prog: 30 }, { tMs: 20000, prog: 20 }, { tMs: 30000, prog: 50 }]);
  it('is the furthest so far, interpolated', () => {
    expect(at(15000)).toBe(30);
    expect(at(20000)).toBe(30);
    expect(at(5000)).toBe(15);
    expect(at(25000)).toBe(40);
    expect(at(99999)).toBe(50);
  });
  it('is null before the first sample', () => {
    expect(progressTimeline([{ tMs: 1000, prog: 5 }])(500)).toBeNull();
    expect(progressTimeline([])(0)).toBeNull();
  });
  it('drops out-of-range progress', () => {
    const t = progressTimeline([{ tMs: 0, prog: -1 }, { tMs: 1000, prog: 101 }, { tMs: 2000, prog: 10 }]);
    expect(t(1000)).toBeNull();
    expect(t(2000)).toBe(10);
  });
});

describe('snapshotAt', () => {
  it('counts alive, down and capped health', () => {
    const f = frame(0, [
      surv(0, STATE.PRESENT, 0),
      surv(1, ALIVE | STATE.INCAP, 30),
      ...standing,
      surv(4, ALIVE, 100, 50),
    ]);
    const s = snapshotAt(f, 10, null);
    expect(s).toMatchObject({ alive: 4, down: 1, health: 180 + 100, prog: 10, tank: 'pending' });
  });
  it('counts the spec example: dead, incapped, two standing', () => {
    const f = frame(0, [surv(0, STATE.PRESENT, 0), surv(1, ALIVE | STATE.INCAP, 30), ...standing]);
    expect(snapshotAt(f, null, null)).toMatchObject({ alive: 3, down: 1, health: 180 });
  });
  it('counts a ledged survivor as down and ignores infected', () => {
    const f = frame(0, [surv(0, ALIVE | STATE.LEDGED, 40), tankPlayer(4, 6000)]);
    expect(snapshotAt(f, null, null)).toMatchObject({ alive: 1, down: 1, health: 0, tank: 'alive' });
  });
  it('reads a tank player and a tank entity as alive with a health fraction', () => {
    expect(snapshotAt(frame(0, [tankPlayer(4, 3000)]), null, null, 6000)).toMatchObject({ tank: 'alive', tankHealthFrac: 0.5 });
    expect(snapshotAt(frame(0, [], [tankEnt(9, 1500)]), null, null, 6000)).toMatchObject({ tank: 'alive', tankHealthFrac: 0.25 });
    expect(snapshotAt(frame(0, [], [tankEnt(9, 1500)]), null, null).tankHealthFrac).toBeNull();
  });
  it('gaps tank flow to progress while pending only', () => {
    expect(snapshotAt(frame(0), 20, 55).tankFlowGap).toBe(35);
    expect(snapshotAt(frame(0), null, 55).tankFlowGap).toBeNull();
    expect(snapshotAt(frame(0, [], [tankEnt(1, 100)]), 20, 55, 100).tankFlowGap).toBeNull();
  });
});

describe('halfSnapshots', () => {
  const rr = (frames: Frame[]) => ({ frames, durationMs: 0, slots: [] });
  it('goes pending, alive with spawn health, then dead', () => {
    const frames = [
      ...run(0, 9000, (t) => frame(t, standing)),
      ...run(10000, 14000, (t) => frame(t, standing, [tankEnt(7, t < 12000 ? 6000 : t < 15000 ? 3000 : 1500)])),
      frame(15000, standing, [tankEnt(7, 1500)]),
      ...run(16000, 20000, (t) => frame(t, standing)),
    ];
    const s = halfSnapshots(rr(frames), () => null, 40);
    expect(s.map((x) => [x.tMs, x.tank, x.tankHealthFrac])).toEqual([
      [0, 'pending', null],
      [5000, 'pending', null],
      [10000, 'alive', 1],
      [15000, 'alive', 0.25],
      [20000, 'dead', null],
    ]);
  });
  it('takes the latest frame at or before each sample time, skipping holes', () => {
    const frames = [frame(0, standing), frame(4900, [surv(0, ALIVE, 10)]), frame(12000, standing)];
    const s = halfSnapshots(rr(frames), () => null, null);
    expect(s.map((x) => [x.tMs, x.health])).toEqual([[0, 180], [4900, 10]]);
  });
  it('keeps the pause clock: a feed sample pairs with the frame at its own tMs', () => {
    // Frames every 1 s to 20000, a 20 s pause, then 40000 onward. The clock is
    // not renumbered, so the frame after the gap still says 40000.
    const raw: Frame[] = [];
    for (let t = 0; t <= 20000; t += 1000) raw.push(frame(t, standing));
    for (let t = 40000; t <= 80000; t += 1000) raw.push(frame(t, standing));
    raw.push(frame(40000, standing)); // a stalled clock step, dropped
    const kept = unpausedFrames(raw);
    const prog = progressTimeline([{ tMs: 0, prog: 0 }, { tMs: 20000, prog: 20 }, { tMs: 40000, prog: 70 }, { tMs: 80000, prog: 90 }]);
    const s = halfSnapshots(rr(kept), prog, null, 10000);
    // 30000 falls in the hole and is skipped.
    expect(s.map((x) => x.tMs)).toEqual([0, 10000, 20000, 40000, 50000, 60000, 70000, 80000]);
    expect(s.find((x) => x.tMs === 40000)!.prog).toBe(70);
    // Pairing by index would put the 41st kept frame (tMs 60000) at prog 40.
    expect(s.find((x) => x.tMs === 60000)!.prog).toBe(80);
  });
  it('keeps a ghost tank pending', () => {
    const ghost = { ...tankPlayer(4, 6000), state: ALIVE | STATE.GHOST };
    const s = halfSnapshots(rr([frame(0, [...standing, ghost]), frame(5000, [...standing, ghost])]), () => null, 40);
    expect(s.map((x) => x.tank)).toEqual(['pending', 'pending']);
  });
  it('carries the tank through a pass, so health stays a continuous fraction', () => {
    const frames = [
      ...run(0, 4000, (t) => frame(t, standing, [tankEnt(7, 6000)])),
      ...run(5000, 9000, (t) => frame(t, [...standing, tankPlayer(4, 3000)])),
      ...run(10000, 10000, (t) => frame(t, [...standing, tankPlayer(5, 1500)])),
    ];
    const s = halfSnapshots(rr(frames), () => null, null);
    expect(s.map((x) => [x.tank, x.tankHealthFrac])).toEqual([['alive', 1], ['alive', 0.5], ['alive', 0.25]]);
  });
  it('does not call a one-frame gap a death, and has no flow gap then', () => {
    const frames = [
      ...run(0, 4000, (t) => frame(t, standing, [tankEnt(7, 6000)])),
      frame(5000, standing),
      ...run(6000, 10000, (t) => frame(t, standing, [tankEnt(7, 3000)])),
    ];
    const s = halfSnapshots(rr(frames), () => 10, 50);
    expect(s.map((x) => [x.tank, x.tankHealthFrac, x.tankFlowGap])).toEqual([
      ['alive', 1, null], ['alive', null, null], ['alive', 0.5, null]]);
  });
  it('has a null flow gap once dead, and a later tank starts a fresh life', () => {
    const frames = [
      ...run(0, 4000, (t) => frame(t, standing, [tankEnt(7, 6000)])),
      ...run(5000, 14000, (t) => frame(t, standing)),
      ...run(15000, 15000, (t) => frame(t, standing, [tankEnt(8, 4000)])),
    ];
    const s = halfSnapshots(rr(frames), () => 10, 50);
    expect(s.map((x) => [x.tMs, x.tank, x.tankHealthFrac, x.tankFlowGap])).toEqual([
      [0, 'alive', 1, null], [5000, 'alive', null, null], [10000, 'dead', null, null], [15000, 'alive', 1, null]]);
  });
  it('divides by the health seen so far, not a later peak', () => {
    const frames = [
      ...run(0, 4000, (t) => frame(t, standing, [tankEnt(7, 3000)])),
      ...run(5000, 9000, (t) => frame(t, standing, [tankEnt(7, 6000)])),
      frame(10000, standing, [tankEnt(7, 3000)]),
    ];
    const s = halfSnapshots(rr(frames), () => null, null);
    expect(s.map((x) => x.tankHealthFrac)).toEqual([1, 1, 0.5]);
  });
});

describe('feedProgressPoints', () => {
  it('joins spawns, downs and the end stamp for one half', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
    const lf = db.prepare(`INSERT INTO match_si_lives (match_id, ordinal, half, idx, steamid, zc, spawn_ms, spawn_prog, end_cause)
      VALUES (1, 0, ?, ?, 's', 1, ?, ?, 'killed')`);
    lf.run(1, 0, 5000, 10); lf.run(1, 1, null, null); lf.run(2, 0, 7000, 99);
    db.prepare(`INSERT INTO match_survivor_downs (match_id, ordinal, half, t_ms, steamid, kind, cause, prog)
      VALUES (1, 0, 1, 3000, 's', 'incap', 'x', 4), (1, 0, 1, 9000, 's', 'death', 'x', NULL)`).run();
    db.prepare('INSERT INTO match_round_feeds (match_id, ordinal, half, end_prog) VALUES (1, 0, 1, 88)').run();
    const key = { matchId: 1, ordinal: 0, half: 1 as const };
    expect(feedProgressPoints(db, key)).toEqual([{ tMs: 3000, prog: 4 }, { tMs: 5000, prog: 10 }]);
    expect(feedProgressPoints(db, key, 90000)).toEqual([{ tMs: 3000, prog: 4 }, { tMs: 5000, prog: 10 }, { tMs: 90000, prog: 88 }]);
  });
});
