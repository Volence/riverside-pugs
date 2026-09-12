import { describe, it, expect } from 'vitest';
import { activeEntries, type TimelineEntry } from './timeline';

const entries: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', text: 'pounce 20', actor: 'A', team: null },
  { seq: 2, tMs: 5000, kind: 'chat', text: 'nice', actor: 'B', team: 'survivor' },
  { seq: 3, tMs: 9000, kind: 'event', text: 'death 0', actor: 'C', team: null },
];

describe('activeEntries', () => {
  it('returns entries inside the window ending at now', () => {
    expect(activeEntries(entries, 6000, 5000).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('excludes anything in the future, which is the point', () => {
    expect(activeEntries(entries, 5000, 60_000).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('drops entries older than the window', () => {
    expect(activeEntries(entries, 9000, 1000).map((e) => e.seq)).toEqual([3]);
  });

  it('handles an empty list', () => {
    expect(activeEntries([], 1000)).toEqual([]);
  });
});
