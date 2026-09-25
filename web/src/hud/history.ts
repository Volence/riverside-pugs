/**
 * The editor's undo and redo: two stacks of whole values. A HudDesign is
 * never mutated (every edit builds a new one), so keeping the value before
 * an edit is all a step needs, and undo is putting it back.
 *
 * What counts as one step is the caller's business, told apart here by
 * which function it calls: `push` for a discrete edit (a checkbox, a
 * button, a Delete), `begin` and `commit` around a continuous gesture (a
 * canvas drag, a slider from first input to release, a number box from
 * focus to blur), and `nudgeStep` for arrow keys, which coalesce while the
 * same selection is nudged within NUDGE_WINDOW_MS of the last nudge.
 *
 * Pure and generic: the page keeps one of these in a ref next to its design.
 * History lives in memory only; a reload starts a fresh one.
 */

export const HISTORY_CAP = 100;
export const NUDGE_WINDOW_MS = 800;

export interface History<T> {
  past: T[];
  future: T[];
  /** The value a gesture started from, while one is under way. */
  pending: T | null;
  /** The last arrow-key nudge: which selection it moved and when, for coalescing. */
  nudge: { key: string; at: number } | null;
}

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [], pending: null, nudge: null };
}

/** Record `prev` as the value before one step. A new step clears the redo stack; the oldest step past the cap is dropped. */
function record<T>(h: History<T>, prev: T): History<T> {
  const past = [...h.past, prev];
  if (past.length > HISTORY_CAP) past.splice(0, past.length - HISTORY_CAP);
  return { past, future: [], pending: null, nudge: null };
}

/** One discrete edit: `prev` is the value it replaced. */
export function push<T>(h: History<T>, prev: T): History<T> {
  return record(h, prev);
}

/**
 * The start of a gesture. Every move of a drag calls this with the value
 * before that move, and only the first call counts, so the step the gesture
 * records runs from where it began, not from its last move.
 */
export function begin<T>(h: History<T>, prev: T): History<T> {
  return h.pending !== null ? h : { ...h, pending: prev, nudge: null };
}

/**
 * The end of a gesture. A gesture that ends where it began (a drag let go
 * where it was picked up) records nothing; `same` decides that, and the
 * page passes `sameJson` because a gesture always builds new objects.
 */
export function commit<T>(h: History<T>, current: T, same: (a: T, b: T) => boolean = Object.is): History<T> {
  if (h.pending === null) return h;
  if (same(h.pending, current)) return { ...h, pending: null };
  return record(h, h.pending);
}

/** Abandon a gesture (Escape or a lost pointer mid-drag): the caller puts `restore` back, and nothing is recorded. */
export function cancel<T>(h: History<T>): { h: History<T>; restore: T | null } {
  return { h: { ...h, pending: null }, restore: h.pending };
}

/**
 * An arrow-key nudge. Held or repeated arrows on the same selection are one
 * step while each press lands within NUDGE_WINDOW_MS of the last; a pause,
 * another selection or any other edit starts a new one.
 */
export function nudgeStep<T>(h: History<T>, prev: T, key: string, now: number): History<T> {
  const n = h.nudge;
  if (n && n.key === key && now - n.at <= NUDGE_WINDOW_MS) return { ...h, nudge: { key, at: now } };
  return { ...record(h, prev), nudge: { key, at: now } };
}

export function undo<T>(h: History<T>, current: T): { h: History<T>; value: T } | null {
  if (!h.past.length) return null;
  const value = h.past[h.past.length - 1];
  return { h: { past: h.past.slice(0, -1), future: [...h.future, current], pending: null, nudge: null }, value };
}

export function redo<T>(h: History<T>, current: T): { h: History<T>; value: T } | null {
  if (!h.future.length) return null;
  const value = h.future[h.future.length - 1];
  return { h: { past: [...h.past, current], future: h.future.slice(0, -1), pending: null, nudge: null }, value };
}

/** Value equality for designs, which are plain JSON. */
export function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
