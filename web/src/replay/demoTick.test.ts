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
});
