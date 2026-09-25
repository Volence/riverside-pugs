import { describe, it, expect } from 'vitest';
import {
  emptyHistory, push, begin, commit, cancel, undo, redo, nudgeStep, sameJson, HISTORY_CAP, NUDGE_WINDOW_MS,
} from './history';

describe('history, steps', () => {
  it('undoes and redoes one step at a time', () => {
    let h = push(emptyHistory<number>(), 1);        // 1 became 2
    h = push(h, 2);                                 // 2 became 3
    const u1 = undo(h, 3)!;
    expect(u1.value).toBe(2);
    const u2 = undo(u1.h, 2)!;
    expect(u2.value).toBe(1);
    expect(undo(u2.h, 1)).toBeNull();
    const r1 = redo(u2.h, 1)!;
    expect(r1.value).toBe(2);
    const r2 = redo(r1.h, 2)!;
    expect(r2.value).toBe(3);
    expect(redo(r2.h, 3)).toBeNull();
  });

  it('clears the redo stack when a new edit follows an undo', () => {
    const u = undo(push(emptyHistory<number>(), 1), 2)!;
    const h = push(u.h, 1);
    expect(h.future).toEqual([]);
    expect(redo(h, 5)).toBeNull();
  });

  it('keeps the newest 100 steps and drops the oldest', () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < 150; i++) h = push(h, i);
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toBe(50);
    expect(h.past[99]).toBe(149);
  });
});

describe('history, gestures', () => {
  it('records a whole gesture as one step from where it began', () => {
    let h = begin(emptyHistory<number>(), 10);
    h = begin(h, 11);                               // later moves of the same gesture keep the start
    h = commit(h, 14);
    expect(h.past).toEqual([10]);
    expect(h.pending).toBeNull();
    expect(undo(h, 14)!.value).toBe(10);
  });

  it('records nothing for a gesture that ends where it began', () => {
    const h = commit(begin(emptyHistory<{ x: number }>(), { x: 1 }), { x: 1 }, sameJson);
    expect(h.past).toEqual([]);
    expect(h.pending).toBeNull();
  });

  it('does nothing on a commit with no gesture under way', () => {
    const h = emptyHistory<number>();
    expect(commit(h, 3)).toBe(h);
  });

  it('hands back the start of a cancelled gesture and records nothing', () => {
    const r = cancel(begin(emptyHistory<number>(), 7));
    expect(r.restore).toBe(7);
    expect(r.h.past).toEqual([]);
    expect(r.h.pending).toBeNull();
  });
});

describe('history, arrow-key nudges', () => {
  it('coalesces nudges of the same selection within the window into one step', () => {
    let h = nudgeStep(emptyHistory<number>(), 0, 'a', 1000);
    h = nudgeStep(h, 1, 'a', 1000 + NUDGE_WINDOW_MS);          // exactly at the window: still the same step
    h = nudgeStep(h, 2, 'a', 1000 + NUDGE_WINDOW_MS + 500);    // the window runs from the last nudge
    expect(h.past).toEqual([0]);
  });

  it('starts a new step after a pause, for another selection, or after any other edit', () => {
    let h = nudgeStep(emptyHistory<number>(), 0, 'a', 0);
    h = nudgeStep(h, 1, 'a', NUDGE_WINDOW_MS + 1);
    expect(h.past).toEqual([0, 1]);
    h = nudgeStep(h, 2, 'b', NUDGE_WINDOW_MS + 2);
    expect(h.past).toEqual([0, 1, 2]);
    h = push(h, 3);
    h = nudgeStep(h, 4, 'b', NUDGE_WINDOW_MS + 3);
    expect(h.past).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('sameJson', () => {
  it('compares by value', () => {
    expect(sameJson({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
  });
});
