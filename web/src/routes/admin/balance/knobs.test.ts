import { describe, expect, it } from 'vitest';
import { formatKnob, serverStateText, snapKnob, stepDecimals } from './knobs';

const tank = { cvar: 't', label: 'Tank', group: 'tank', type: 'int' as const, min: 6000, max: 10000, step: 250, baseline: '8000' };
const flow = { cvar: 'f', label: 'Flow', group: 'b', type: 'float' as const, min: 0.1, max: 0.3, step: 0.05, baseline: '0.10' };

describe('knob values', () => {
  it('formats and snaps to the grid and range', () => {
    expect(stepDecimals(0.05)).toBe(2);
    expect(formatKnob(flow, 0.1)).toBe('0.10');
    expect(snapKnob(tank, '7600')).toBe('7500');
    expect(snapKnob(tank, '99999')).toBe('10000');
    expect(snapKnob(flow, '0.17')).toBe('0.15');
    expect(snapKnob(flow, 'abc')).toBe('0.10');
  });
});

describe('serverStateText', () => {
  const s = { serverId: 1, name: 'dallas', lastError: null, writtenAt: null, confirmedAt: null, seen: null, mismatch: null };
  it('says what each state means', () => {
    expect(serverStateText({ ...s, state: 'pending' }, 7)).toBe('waiting for the server to be free');
    expect(serverStateText({ ...s, state: 'failed', lastError: 'refused' }, 7)).toBe('write failed: refused, retrying');
    expect(serverStateText({ ...s, state: 'written' }, 7)).toBe('written, awaiting first match');
    expect(serverStateText({ ...s, state: 'written', seen: { patchId: 3, number: 3, at: 'x' }, mismatch: 'c:a 1 -> 2' }, 7))
      .toBe('expected #7, saw #3: c:a 1 -> 2');
    expect(serverStateText({ ...s, state: 'confirmed', confirmedAt: '2026-09-24 10:00:00' }, 7)).toMatch(/^confirmed/);
  });
});
