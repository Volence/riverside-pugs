import { describe, it, expect } from 'vitest';
import { ENTITY_KIND, STATE } from '../../../src/replayFormat';
import { tooltipText } from './tooltipText';

const sample = (over: Record<string, unknown>) => ({
  slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: STATE.PRESENT | STATE.ALIVE, health: 100, temp: 0,
  cls: 0, weapon: 0, clip: 0, reserve: 0, infected: false, ...over,
});
const base = {
  slots: ['A', '', '', '', 'H', '', '', ''], names: { A: 'alice', H: 'hank' }, version: 2,
  timeline: [{ seq: 3, tMs: 61000, kind: 'event' as const, event: 'dp', actor: 'H', target: 'A', value: 24 }],
  witchStartled: false,
};

describe('tooltipText', () => {
  it('names a survivor with character, states and health, never the SteamID', () => {
    const players = [sample({ slot: 0, cls: 2, health: 34, temp: 20, state: STATE.PRESENT | STATE.ALIVE | STATE.BILED })];
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 0 }, { ...base, players }))
      .toBe('alice · Francis · Biled · 34 + 20');
  });
  it('names an infected by class, and a ghost only as unspawned', () => {
    const hunter = sample({ slot: 4, cls: 3, infected: true, health: 250 });
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 4 }, { ...base, players: [hunter] })).toBe('hank · Hunter · 250');
    const ghost = sample({ slot: 4, cls: 3, infected: true, state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST });
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 4 }, { ...base, players: [ghost] })).toBe('hank · Hunter · unspawned');
  });
  it('falls back to the slot label with no roster', () => {
    const players = [sample({ slot: 1, health: 100 })];
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 1 }, { ...base, players, version: 1 })).toBe('S2 · 100');
  });
  it('describes entities, including a startled witch and a tank with health', () => {
    const ctx = { ...base, players: [] };
    expect(tooltipText({ kind: 'entity', px: 0, py: 0, r: 1, entityKind: ENTITY_KIND.WITCH, health: 1000, state: 0 }, ctx)).toBe('Witch');
    expect(tooltipText({ kind: 'entity', px: 0, py: 0, r: 1, entityKind: ENTITY_KIND.WITCH, health: 1000, state: 0 }, { ...ctx, witchStartled: true })).toBe('Witch · startled');
    expect(tooltipText({ kind: 'entity', px: 0, py: 0, r: 1, entityKind: ENTITY_KIND.TANK_AI, health: 6200, state: 0 }, ctx)).toBe('AI tank · 6200');
    expect(tooltipText({ kind: 'entity', px: 0, py: 0, r: 1, entityKind: ENTITY_KIND.TANK_ROCK, health: 0, state: 0 }, ctx)).toBe('Rock');
  });
  it('reads a marker as the time and the event sentence', () => {
    expect(tooltipText({ kind: 'marker', px: 0, py: 0, r: 1, seq: 3 }, { ...base, players: [] })).toBe('1:01 · hank pounced alice for 24');
    expect(tooltipText({ kind: 'marker', px: 0, py: 0, r: 1, seq: 99 }, { ...base, players: [] })).toBeNull();
  });
  it('names an unrostered actor as unknown, not the slot 1 label', () => {
    const tl = [{ seq: 7, tMs: 5000, kind: 'event' as const, event: 'dp', actor: 'Z', target: 'A', value: 10 }];
    expect(tooltipText({ kind: 'marker', px: 0, py: 0, r: 1, seq: 7 }, { ...base, players: [], timeline: tl }))
      .toBe('0:05 · unknown pounced alice for 10');
  });
  it('shows only Dead for a dead player, never the status flags they were also carrying', () => {
    const dead = sample({ slot: 0, cls: 2, state: STATE.PRESENT | STATE.BILED, health: 0 });
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 0 }, { ...base, players: [dead] }))
      .toBe('alice · Francis · Dead');
  });
});
