import { describe, expect, it } from 'vitest';
import { defs } from '../../src/metrics/defs/si.js';
import { FRAME_DT_CAP_MS } from '../../src/metrics/replayRound.js';
import { buildTimeline } from '../../src/metrics/timeline.js';
import type { RoundInput } from '../../src/metrics/types.js';
import { ev, frame, frames, input, replayOf, standing4, stats } from './fixtures.js';

const run = (id: string, i: RoundInput) => defs.find((m) => m.id === id)!.compute({ ...i, timeline: i.replay ? buildTimeline(i.replay, i.marks) : null });

describe('special infected metrics', () => {
  const events = [
    ev('si_spawn', 'i1', 1000, null, 3), ev('pinned', 'i1', 2000, 's1'),
    ev('si_spawn', 'i2', 1000, null, 1), ev('pinned', 'i2', 3000, 's2'), ev('cleared', 's3', 7000, 's2'),
    ev('si_spawn', 'i3', 1000, null, 3), ev('skeet', 's1', 4000, 'i3'),
    ev('si_spawn', 'i4', 1000, null, 3), ev('dp', 'i4', 5000, 's3', 20),
    ev('si_spawn', 'i1', 8000, null, 2), ev('boom', 'i1', 9000, 's1'), ev('boom', 'i1', 9000, 's2'),
  ];

  it('hunter rates per hunter spawn', () => {
    expect(run('hunter.spawns', input({ events }))!.all).toEqual({ num: 3, den: 1 });
    expect(run('hunter.skeet_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
    expect(run('hunter.high_pounce_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
    expect(run('hunter.high_pounce_avg_damage', input({ events }))!.all).toEqual({ num: 20, den: 1 });
    expect(run('hunter.pounce_rate', input({ events }))!.all).toEqual({ num: 1, den: 3 });
  });

  it('smoker pulls and clear time', () => {
    expect(run('smoker.pull_rate', input({ events }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('smoker.clear_time_s', input({ events }))!.all).toEqual({ num: 4, den: 1 });
    expect(run('smoker.kill_clear_share', input({ events }))!.all).toEqual({ num: 1, den: 1 });
  });

  it('smoker clear time excludes a pull overtaken by a new pin before any clear', () => {
    const overtaken = [
      ev('si_spawn', 'i2', 1000, null, 1), ev('pinned', 'i2', 3000, 's2'),
      ev('si_spawn', 'i1', 1000, null, 3), ev('pinned', 'i1', 10000, 's2'),
      ev('cleared', 's3', 12000, 's2'),
    ];
    expect(run('smoker.clear_time_s', input({ events: overtaken }))).toBeNull();
    expect(run('smoker.kill_clear_share', input({ events: overtaken }))!.all).toEqual({ num: 0, den: 1 });
  });

  it('smoker.kill_clear_share is null with no pulls', () => {
    expect(run('smoker.kill_clear_share', input())).toBeNull();
  });

  it('boomer booms per spawn and pops need skill_detect', () => {
    expect(run('boomer.boomed_per_spawn', input({ events }))!.all).toEqual({ num: 2, den: 1 });
    expect(run('boomer.pop_rate', input({ events }))).toBeNull();
    expect(run('boomer.pop_rate', input({ events, hasStats: true, skillDetect: true, stats: stats([['s1', 'boomer_pops', 1]]) }))!.all)
      .toEqual({ num: 1, den: 1 });
  });

  it('boomer boomed per spawn only counts booms from an actor currently classed as boomer', () => {
    const mixed = [
      ev('si_spawn', 'i1', 1000, null, 2), ev('boom', 'i1', 2000, 's1'),
      ev('boom', 'i2', 2000, 's2'),
    ];
    expect(run('boomer.boomed_per_spawn', input({ events: mixed }))!.all).toEqual({ num: 1, den: 1 });
  });

  it('hunter lifetime from the replay', () => {
    const replay = replayOf(frames(0, 20_000, (t) => ({ surv: standing4, inf: [{ cls: 3, state: t >= 5000 && t < 9000 ? 3 : 1 | 128 }] })));
    expect(run('hunter.lifetime_s', input({ replay }))!.all).toEqual({ num: 4, den: 1 });
  });

  it('quad caps need per-round stats', () => {
    expect(run('si.quad_caps', input())).toBeNull();
    expect(run('si.quad_caps', input({ hasStats: true, stats: stats([['i1', 'quad_caps', 1]]) }))!.all).toEqual({ num: 1, den: 1 });
    expect(run('si.quad_caps', input({ hasStats: true, stats: stats([]) }))!.all).toEqual({ num: 0, den: 1 });
  });

  it('a quad cap counts once, though the plugin credits every infected player in it', () => {
    // Production, match 155 map 2 half 2: one quad cap, quad_caps=1 on all
    // four infected and times_quadded=1 on all four survivors.
    const s = stats([
      ['i1', 'quad_caps', 1], ['i2', 'quad_caps', 1], ['i3', 'quad_caps', 1], ['i4', 'quad_caps', 1],
      ['s1', 'times_quadded', 1], ['s2', 'times_quadded', 1], ['s3', 'times_quadded', 1], ['s4', 'times_quadded', 1],
    ]);
    expect(run('si.quad_caps', input({ hasStats: true, stats: s }))!.all).toEqual({ num: 1, den: 1 });
  });

  it('hunter damage per spawn needs round stats', () => {
    const twoSpawns = [ev('si_spawn', 'i1', 1000, null, 3), ev('si_spawn', 'i3', 1000, null, 3)];
    expect(run('hunter.damage_per_spawn', input({ events: twoSpawns }))).toBeNull();
    expect(run('hunter.damage_per_spawn', input({
      events: twoSpawns, hasStats: true, stats: stats([['i1', 'dmg_as_hunter', 30], ['i3', 'dmg_as_hunter', 10]]),
    }))!.all).toEqual({ num: 40, den: 2 });
  });

  it('si kills per minute needs stats and a replay timeline', () => {
    const replay = replayOf(frames(0, 60_000, () => ({ surv: standing4 })));
    expect(run('si.kills_per_min', input({ replay }))).toBeNull();
    expect(run('si.kills_per_min', input({ hasStats: true, stats: stats([['s1', 'sikill', 3]]) }))).toBeNull();
    expect(run('si.kills_per_min', input({ replay, hasStats: true, stats: stats([['s1', 'sikill', 3]]) }))!.all)
      .toEqual({ num: 3, den: 1 });
  });
});

describe('skill_detect gate for skeet and high-pounce metrics', () => {
  const events = [
    ev('si_spawn', 'i3', 1000, null, 3), ev('skeet', 's1', 4000, 'i3'),
    ev('si_spawn', 'i4', 1000, null, 3), ev('dp', 'i4', 5000, 's3', 20),
  ];

  it('is null for a round from before the skeet feed existed', () => {
    expect(run('hunter.skeet_rate', input({ events, startedAt: '2026-09-15 10:00:00' }))).toBeNull();
    expect(run('hunter.high_pounce_rate', input({ events, startedAt: '2026-09-15 10:00:00' }))).toBeNull();
    expect(run('hunter.high_pounce_avg_damage', input({ events, startedAt: '2026-09-15 10:00:00' }))).toBeNull();
  });

  it('is null for a round with stats where skill_detect was not loaded', () => {
    expect(run('hunter.skeet_rate', input({ events, hasStats: true, skillDetect: false }))).toBeNull();
    expect(run('hunter.high_pounce_rate', input({ events, hasStats: true, skillDetect: false }))).toBeNull();
    expect(run('hunter.high_pounce_avg_damage', input({ events, hasStats: true, skillDetect: false }))).toBeNull();
  });

  it('is computed for a recent round without stats, or any round with skill_detect on', () => {
    expect(run('hunter.skeet_rate', input({ events, startedAt: '2026-09-20 00:00:00' }))!.all).toEqual({ num: 1, den: 2 });
    expect(run('hunter.skeet_rate', input({ events, hasStats: true, skillDetect: true }))!.all).toEqual({ num: 1, den: 2 });
  });

  it('hunter skeet rate counts only skeets with a target', () => {
    const withUntargeted = [
      ev('si_spawn', 'i3', 1000, null, 3),
      ev('skeet', 's1', 4000, 'i3'),
      ev('skeet', 's2', 4500, null),
    ];
    expect(run('hunter.skeet_rate', input({ events: withUntargeted }))!.all).toEqual({ num: 1, den: 1 });
  });
});

describe('hunter lifetime frame-gap capping and open-life handling', () => {
  it('caps a per-frame gap at FRAME_DT_CAP_MS while the hunter stays alive', () => {
    const replay = replayOf([
      frame({ tMs: 0, surv: standing4, inf: [{ cls: 3, state: 1 | 128 }] }),
      frame({ tMs: 1000, surv: standing4, inf: [{ cls: 3, state: 3 }] }),
      frame({ tMs: 1000 + FRAME_DT_CAP_MS + 20_000, surv: standing4, inf: [{ cls: 3, state: 3 }] }),
      frame({ tMs: 1000 + FRAME_DT_CAP_MS + 20_000 + 100, surv: standing4, inf: [{ cls: 3, state: 1 | 128 }] }),
    ]);
    // Alive gap 1: 1000 -> 21000 (20000ms) capped to FRAME_DT_CAP_MS (1000ms).
    // Alive gap 2: 21000 -> 21100 (100ms), uncapped.
    expect(run('hunter.lifetime_s', input({ replay }))!.all).toEqual({ num: (FRAME_DT_CAP_MS + 100) / 1000, den: 1 });
  });

  it('drops a life still open at the last frame', () => {
    const replay = replayOf([
      frame({ tMs: 0, surv: standing4, inf: [{ cls: 3, state: 1 | 128 }] }),
      frame({ tMs: 1000, surv: standing4, inf: [{ cls: 3, state: 3 }] }),
      frame({ tMs: 2000, surv: standing4, inf: [{ cls: 3, state: 3 }] }),
    ]);
    expect(run('hunter.lifetime_s', input({ replay }))).toBeNull();
  });
});
