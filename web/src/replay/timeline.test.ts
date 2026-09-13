import { describe, it, expect } from 'vitest';
import {
  activeEntries, bookmarkSeekMs, BOOKMARK_LEAD_MS, entryText, type TimelineEntry,
} from './timeline';

const entries: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', event: 'dp', actor: 'A', target: 'B', value: 20 },
  { seq: 2, tMs: 5000, kind: 'chat', actor: 'B', team: 'survivor', text: 'nice' },
  { seq: 3, tMs: 9000, kind: 'event', event: 'death', actor: 'C', target: null, value: 0 },
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

describe('entryText', () => {
  const nameOf = (id: string) => ({ A: 'volence', B: 'tino' }[id] ?? id);
  it('is the message for chat and the resolved phrase for an event', () => {
    expect(entryText(entries[1], nameOf)).toBe('nice');
    expect(entryText(entries[0], nameOf)).toBe('pounced tino for 20');
  });
});

describe('bookmarkSeekMs', () => {
  it('lands BOOKMARK_LEAD_MS before the event', () => {
    expect(bookmarkSeekMs(10000)).toBe(10000 - BOOKMARK_LEAD_MS);
    expect(bookmarkSeekMs(10000)).toBe(7000);
  });

  it('clamps at the start of the round rather than going negative', () => {
    expect(bookmarkSeekMs(1000)).toBe(0);
    expect(bookmarkSeekMs(0)).toBe(0);
  });
});
