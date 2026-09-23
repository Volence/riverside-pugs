import { describe, expect, it } from 'vitest';
import { defs as tank } from '../../src/metrics/defs/tank.js';
import { defs as witch } from '../../src/metrics/defs/witch.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { STATE } from '../../src/replayFormat.js';
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
    const i = input({ replay: aiTankReplay, events: [ev('tank_death', 's1', 25_000)] });
    expect(run('tank.spawns', i)!.all).toEqual({ num: 1, den: 1 });
    expect(run('tank.killed_rate', i)!.all).toEqual({ num: 1, den: 1 });
  });

  it('killed_rate counts only tank_death events whose actor is a survivor, not frustration passes', () => {
    // The plugin also fires tank_death with the tank player himself as the
    // actor when the tank is passed to another player on frustration
    // (plugin/pug-match.sp, Event_PlayerDeath around line 4034). That is not
    // a survivor kill.
    const passOnly = [ev('tank_spawn', 'i1', 1000), ev('tank_death', 'i1', 5000)];
    const i = input({ events: passOnly });
    expect(run('tank.killed_rate', i)!.all).toEqual({ num: 0, den: 1 });

    const passThenKill = [ev('tank_spawn', 'i1', 1000), ev('tank_death', 'i1', 5000),
      ev('tank_spawn', 'i2', 10_000), ev('tank_death', 's1', 15_000)];
    const j = input({ events: passThenKill });
    expect(run('tank.spawns', j)!.all).toEqual({ num: 2, den: 1 });
    expect(run('tank.killed_rate', j)!.all).toEqual({ num: 1, den: 2 });
  });

  it('killed_rate never exceeds 1 without a replay (an AI tank with no tank_spawn plus a player tank)', () => {
    const aiThenPlayer = [ev('tank_spawn', 'i1', 1000), ev('tank_death', 's1', 5000), ev('tank_death', 's2', 9000)];
    expect(run('tank.killed_rate', input({ events: aiThenPlayer }))!.all).toEqual({ num: 1, den: 1 });
  });

  describe('a tank passed on frustration (no tank_spawn or tank_take for the new holder)', () => {
    // i1 spawns the tank at 20 s and holds it to 30 s; i2 holds it from 30 s
    // to 50 s. Only i1's tank_spawn is in the events.
    const passed = replayOf(frames(0, 60_000, (t) => ({
      surv: standing4,
      inf: t < 20_000 ? [] : t < 30_000 ? [{ cls: 5 }]
        : t < 50_000 ? [{ cls: 0, state: STATE.PRESENT }, { cls: 5 }] : [],
    })));
    const events = [ev('tank_spawn', 'i1', 20_000), ev('incap', 's1', 25_000, 'i1'), ev('incap', 's2', 35_000, 'i2'),
      ev('death', 's3', 40_000, 'i2'), ev('incap', 's4', 55_000, 'i2'), ev('tank_death', 's4', 50_000)];

    it('credits the second holder from the replay', () => {
      const i = input({ replay: passed, events });
      expect(run('tank.spawns', i)!.all).toEqual({ num: 1, den: 1 });
      expect(run('tank.incaps_caused', i)!.all).toEqual({ num: 2, den: 1 });
      expect(run('tank.deaths_caused', i)!.all).toEqual({ num: 1, den: 1 });
    });

    it('does not credit a ghost tank or an attacker the replay has no slot for', () => {
      const ghost = replayOf(frames(0, 60_000, () => ({ surv: standing4, inf: [{ cls: 5, state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST }] })));
      const i = input({ replay: ghost, events: [ev('incap', 's1', 25_000, 'i1')] });
      expect(run('tank.incaps_caused', i)).toBeNull();
      const noSlots = input({ replay: replayOf(passed.frames, ['s1', 's2', 's3', 's4', '', '', '', '']), events });
      // Falls back to the event rule: only i1 (tank_spawn) counts.
      expect(run('tank.incaps_caused', noSlots)!.all).toEqual({ num: 1, den: 1 });
    });

    it('without a replay keeps the event rule (only the holder with a tank_spawn counts)', () => {
      const i = input({ events });
      expect(run('tank.incaps_caused', i)!.all).toEqual({ num: 1, den: 1 });
      expect(run('tank.deaths_caused', i)!.all).toEqual({ num: 0, den: 1 });
    });
  });

  it('lifetime_killed_s counts only tanks the survivors killed', () => {
    expect(run('tank.lifetime_killed_s', input({ replay: tankReplay, events }))!.all).toEqual({ num: 30, den: 1 });
    // No death event near the end of the interval (cut short by the round ending).
    const openEnded = replayOf(frames(0, 30_000, (t) => ({ surv: standing4, inf: t >= 10_000 ? [{ cls: 5 }] : [] })));
    expect(run('tank.lifetime_killed_s', input({ replay: openEnded, events: [ev('tank_spawn', 'i1', 10_000)] }))).toBeNull();
    // A frustration pass (tank player as the actor) is not a survivor kill.
    expect(run('tank.lifetime_killed_s', input({ replay: tankReplay, events: [ev('tank_death', 'i1', 50_000)] }))).toBeNull();
    // A kill too far from the interval's end does not match.
    expect(run('tank.lifetime_killed_s', input({ replay: tankReplay, events: [ev('tank_death', 's1', 52_000)] }))).toBeNull();
    expect(run('tank.lifetime_killed_s', input({ events }))).toBeNull();
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
