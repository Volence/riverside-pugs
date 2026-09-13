import { describe, it, expect } from 'vitest';
import { groupTicks, tickEntries } from './bookmarks';
import type { TimelineEntry } from './timeline';

const T: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', event: 'boom', actor: 'B', target: 'A', value: 0 },
  { seq: 2, tMs: 2000, kind: 'chat', actor: 'A', team: 'survivor', text: 'ugh' },
  { seq: 3, tMs: 3000, kind: 'event', event: 'dp', actor: 'H', target: 'C', value: 25 },
  { seq: 4, tMs: 4000, kind: 'event', event: 'boom', actor: 'B', target: 'A', value: 0 },
  { seq: 5, tMs: 5000, kind: 'event', event: 'death', actor: 'A', target: 'H', value: 0 },
  { seq: 6, tMs: 6000, kind: 'chat', actor: 'C', team: 'survivor', text: 'rip' },
  { seq: 7, tMs: 7000, kind: 'event', event: 'skeet', actor: 'A', target: 'H', value: 0 },
];

describe('tickEntries', () => {
  it('returns everything with no role when nobody is selected', () => {
    const ticks = tickEntries(T, null);
    expect(ticks).toHaveLength(7);
    expect(ticks.every((t) => t.role === null)).toBe(true);
  });

  it('keeps only the events the player was in, plus their own chat', () => {
    const seqs = tickEntries(T, 'A').map((t) => t.entry.seq);
    expect(seqs).toEqual([1, 2, 4, 5, 7]);
  });

  it('marks the side the player was on, per kind', () => {
    const byseq = Object.fromEntries(tickEntries(T, 'A').map((t) => [t.entry.seq, t.role]));
    expect(byseq[1]).toBe('suffered');   // got boomed
    expect(byseq[2]).toBeNull();          // own chat has no side
    expect(byseq[5]).toBe('suffered');   // died (victim-first kind)
    expect(byseq[7]).toBe('did');         // skeeted
  });

  it('sees the other side of the same events for the infected player', () => {
    const byseq = Object.fromEntries(tickEntries(T, 'H').map((t) => [t.entry.seq, t.role]));
    expect(byseq[3]).toBe('did');
    expect(byseq[5]).toBe('did');         // the kill
    expect(byseq[7]).toBe('suffered');   // got skeeted
  });

  it('selects nobody for a blank id rather than matching empty actors', () => {
    const blank: TimelineEntry[] = [
      { seq: 1, tMs: 0, kind: 'event', event: 'car_alarm', actor: '', target: null, value: 0 },
    ];
    expect(tickEntries(blank, '')).toEqual([]);
  });
});

describe('groupTicks', () => {
  it('groups events by kind and side, biggest group first, ties by first seq', () => {
    const groups = groupTicks(tickEntries(T, 'A'));
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Got boomed', 2], ['Deaths', 1], ['Skeets', 1],
    ]);
    expect(groups[0].role).toBe('suffered');
    expect(groups[0].items.map((i) => i.entry.seq)).toEqual([1, 4]);
  });

  it('leaves chat out of the groups', () => {
    const groups = groupTicks(tickEntries(T, 'A'));
    expect(groups.flatMap((g) => g.items).every((i) => i.entry.kind === 'event')).toBe(true);
  });

  it('is empty for an unselected tick list', () => {
    expect(groupTicks(tickEntries(T, null))).toEqual([]);
  });
});
