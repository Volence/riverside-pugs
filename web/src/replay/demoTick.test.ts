import { describe, it, expect } from 'vitest';
import { demoTickAt } from './demoTick';

describe('demoTickAt', () => {
  it('adds the round time at the server tickrate to the go-live tick', () => {
    expect(demoTickAt({ tick: 4000, hz: 100 }, 0)).toBe(4000);
    expect(demoTickAt({ tick: 4000, hz: 100 }, 12_345)).toBe(5235);
    expect(demoTickAt({ tick: 0, hz: 30 }, 1000)).toBe(30);
  });

  it('never lands before the go-live tick', () => {
    expect(demoTickAt({ tick: 4000, hz: 100 }, -50)).toBe(4000);
  });

  // The replay clock is game time, which stands still through a pause, while
  // the demo keeps recording ticks. Each shift is a pause: at round time tMs
  // the demo went on for `ticks` more than the round clock did.
  it('adds the demo ticks of every pause the moment is past', () => {
    const sync = { tick: 4000, hz: 100, shifts: [{ tMs: 10_000, ticks: 6600 }, { tMs: 30_000, ticks: 250 }] };
    expect(demoTickAt(sync, 5_000)).toBe(4500);
    // The frozen moment itself is the last tick before the pause.
    expect(demoTickAt(sync, 10_000)).toBe(5000);
    expect(demoTickAt(sync, 10_010)).toBe(5001 + 6600);
    expect(demoTickAt(sync, 40_000)).toBe(8000 + 6600 + 250);
  });

  it('reads an empty shift list like none', () => {
    expect(demoTickAt({ tick: 4000, hz: 100, shifts: [] }, 1000)).toBe(4100);
  });
});
