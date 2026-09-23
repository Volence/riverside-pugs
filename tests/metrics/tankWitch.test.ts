import { describe, expect, it } from 'vitest';
import { defs as tank } from '../../src/metrics/defs/tank.js';
import { defs as witch } from '../../src/metrics/defs/witch.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { ev, frames, input, replayOf, standing4, stats } from './fixtures.js';

const byId = (id: string) => [...tank, ...witch].find((m) => m.id === id)!;
const run = (id: string, i: RoundInput) => byId(id).compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

const tankReplay = replayOf(frames(0, 60_000, (t) => ({ surv: standing4, inf: t >= 20_000 && t < 50_000 ? [{ cls: 5 }] : [] })));

describe('tank metrics', () => {
  const events = [ev('tank_spawn', 'i1', 20_000), ev('incap', 's1', 30_000, 'i1'), ev('incap', 's2', 31_000, 'i2'),
    ev('death', 's3', 40_000, 'i1'), ev('tank_death', 's4', 50_000)];

  it('spawns, killed rate and lifetime', () => {
    expect(run('tank.spawns', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('tank.killed_rate', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('tank.killed_rate', input())).toBeNull();
    expect(run('tank.lifetime_s', input({ replay: tankReplay }))!.all).toEqual({ num: 30, den: 1 });
  });

  it('incaps and deaths caused by the tank player, per tank', () => {
    expect(run('tank.incaps_caused', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('tank.deaths_caused', input({ events }))!.all).toEqual({ num: 1, den: 1 });
  });

  it('damage per tank needs per-round stats', () => {
    const i = input({ events, hasStats: true, stats: stats([['i1', 'dmg_as_tank', 480]]) });
    expect(run('tank.damage_per_tank', i)!.all).toEqual({ num: 480, den: 1 });
    expect(run('tank.damage_per_tank', input({ events }))).toBeNull();
    expect(run('tank.rocks_per_tank', { ...i, skillDetect: false })).toBeNull();
  });

  it('counts an AI-only tank from the timeline even without a tank_spawn event', () => {
    const aiTankReplay = replayOf(frames(0, 30_000, (t) => ({ surv: standing4, tankAi: t >= 5000 && t < 25_000 })));
    const i = input({ replay: aiTankReplay, events: [ev('tank_death', 'i5', 25_000)] });
    expect(run('tank.spawns', i)!.all).toEqual({ num: 1, den: 1 });
    expect(run('tank.killed_rate', i)!.all).toEqual({ num: 1, den: 1 });
  });

  it('counts a tank passed between players (no replay) once, not per tank_take', () => {
    const passed = [ev('tank_spawn', 'i1', 1000), ev('tank_take', 'i2', 5000), ev('tank_death', 'i2', 9000)];
    expect(run('tank.spawns', input({ events: passed }))!.all).toEqual({ num: 1, den: 1 });
  });

  it('counts two tanks in sequence (no replay) as two', () => {
    const sequential = [ev('tank_spawn', 'i1', 1000), ev('tank_death', 'i1', 5000),
      ev('tank_spawn', 'i2', 10_000), ev('tank_death', 'i2', 15_000)];
    expect(run('tank.spawns', input({ events: sequential }))!.all).toEqual({ num: 2, den: 1 });
  });
});

describe('witch metrics', () => {
  const witchReplay = replayOf(frames(0, 30_000, (t) => ({ surv: standing4, witch: t >= 5000 && t < 25_000 ? [{ x: 400, y: 0 }] : [] })));

  it('counts witches and rates per witch', () => {
    const i = input({ replay: witchReplay, events: [ev('witch_aggro', 's1', 10_000), ev('witch_killed', 's1', 12_000)],
      hasStats: true, skillDetect: true, stats: stats([['s1', 'crowns', 1]]) });
    expect(run('witch.count', i)!.all).toEqual({ num: 1, den: 1 });
    expect(run('witch.startle_rate', i)!.all).toEqual({ num: 1, den: 1 });
    expect(run('witch.kill_rate', i)!.all).toEqual({ num: 1, den: 1 });
    expect(run('witch.crown_rate', i)!.all).toEqual({ num: 1, den: 1 });
  });

  it('counts incaps with no player attacker during the witch phase', () => {
    const i = input({ replay: witchReplay, events: [ev('incap', 's2', 11_000, null), ev('incap', 's3', 28_000, null)] });
    expect(run('witch.incaps', i)!.all).toEqual({ num: 1, den: 1 });
  });

  it('is null without a replay or without witches', () => {
    expect(run('witch.count', input())).toBeNull();
    expect(run('witch.startle_rate', input({ replay: tankReplay }))).toBeNull();
  });

  it('counts two witches present at once (different refs) as two', () => {
    const twoWitches = replayOf(frames(0, 10_000, () => ({
      surv: standing4, witch: [{ x: 400, y: 0, ref: 1 }, { x: -400, y: 0, ref: 2 }],
    })));
    expect(run('witch.count', input({ replay: twoWitches }))!.all).toEqual({ num: 2, den: 1 });
  });
});
