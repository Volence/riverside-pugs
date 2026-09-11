import { describe, it, expect } from 'vitest';
import type { LiveEvent } from './api';
import { clearLatencies, clearLatencyByPlayer } from './clearLatency';

const p = (steamid: string) => ({ steamid, name: steamid });
const ev = (
  seq: number, kind: string, actor: string, target: string | null, tMs: number,
  over: Partial<LiveEvent> = {},
): LiveEvent => ({
  seq, kind, mapOrdinal: 0, half: 1, tMs,
  actor: p(actor), target: target ? p(target) : null, value: 0, ...over,
});

describe('clearLatencies', () => {
  it('measures the gap from the pin to the clear that ended it', () => {
    const out = clearLatencies([ev(1, 'pinned', 'si', 'surv', 1000), ev(2, 'cleared', 'mal', 'surv', 1910)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ clearer: 'mal', victim: 'surv', latencyMs: 910 });
  });

  it('accepts events newest-first, as the API serves them', () => {
    const out = clearLatencies([ev(2, 'cleared', 'mal', 'surv', 1910), ev(1, 'pinned', 'si', 'surv', 1000)]);
    expect(out[0].latencyMs).toBe(910);
  });

  it('pairs by victim, not by adjacency', () => {
    // Two survivors pinned at once. Sequence order would pair the clear with
    // the wrong pin and report 200ms instead of the real 1500ms.
    const out = clearLatencies([
      ev(1, 'pinned', 'si', 'alice', 1000),
      ev(2, 'pinned', 'si', 'bob', 2300),
      ev(3, 'cleared', 'mal', 'alice', 2500),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ victim: 'alice', latencyMs: 1500 });
  });

  it('drops a clear whose victim was never recorded as pinned', () => {
    // Every clear captured so far has an empty target, because bots are not
    // rostered. Guessing a pin for it would invent a latency.
    expect(clearLatencies([ev(1, 'pinned', 'si', null, 1000), ev(2, 'cleared', 'mal', null, 1910)]))
      .toEqual([]);
  });

  it('never pairs across a map or a half boundary', () => {
    expect(clearLatencies([
      ev(1, 'pinned', 'si', 'surv', 1000),
      ev(2, 'cleared', 'mal', 'surv', 500, { half: 2 }),
    ])).toEqual([]);
    expect(clearLatencies([
      ev(1, 'pinned', 'si', 'surv', 1000),
      ev(2, 'cleared', 'mal', 'surv', 500, { mapOrdinal: 1 }),
    ])).toEqual([]);
  });

  it('spends each pin once, so a second clear finds nothing', () => {
    const out = clearLatencies([
      ev(1, 'pinned', 'si', 'surv', 1000),
      ev(2, 'cleared', 'mal', 'surv', 1500),
      ev(3, 'cleared', 'mal', 'surv', 2000),
    ]);
    expect(out).toHaveLength(1);
  });

  it('ignores events with no round timing', () => {
    expect(clearLatencies([
      ev(1, 'pinned', 'si', 'surv', -1, { half: -1 }),
      ev(2, 'cleared', 'mal', 'surv', -1, { half: -1 }),
    ])).toEqual([]);
  });
});

describe('clearLatencyByPlayer', () => {
  it('averages per clearer and reports how many it is averaging', () => {
    const rows = clearLatencyByPlayer([
      ev(1, 'pinned', 'si', 'a', 0), ev(2, 'cleared', 'mal', 'a', 1000),
      ev(3, 'pinned', 'si', 'b', 0), ev(4, 'cleared', 'mal', 'b', 2000),
      ev(5, 'pinned', 'si', 'c', 0), ev(6, 'cleared', 'tami', 'c', 500),
    ]);
    expect(rows).toEqual([
      { steamid: 'tami', name: 'tami', avgMs: 500, count: 1 },
      { steamid: 'mal', name: 'mal', avgMs: 1500, count: 2 },
    ]);
  });
});

describe('ClearPair.seq', () => {
  it('carries the seq of the clear, so a feed row can find its own latency', () => {
    const out = clearLatencies([ev(1, 'pinned', 'si', 'surv', 1000), ev(7, 'cleared', 'mal', 'surv', 1910)]);
    expect(out[0].seq).toBe(7);
  });
});
