import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/preact';
import { _setFoldDefault } from './hud/LayersPanel';

/**
 * What every HUD editor test file shares: a clean slate around each test and
 * the pointer helpers. The editor's tests were one 3,500-line file that took
 * a minute on one worker; split by area (Hud.test.tsx, Hud.import, Hud.panels,
 * Hud.tab, Hud.items) they run side by side.
 */
export function setupHudTests(): void {
  beforeEach(() => {
    // Each test starts from a clean slate: a saved design or a leftover hash
    // from one test must not change what the next one sees.
    localStorage.clear();
    location.hash = '';
    // Most tests reach a piece in Layers directly; the folding tests turn this off.
    _setFoldDefault(true);
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    location.hash = '';
    // A spy restored on the last line of its own test stays installed if an
    // earlier assertion throws, and every later test in the file then runs
    // against it. Restoring here happens either way.
    vi.restoreAllMocks();
  });
}

/** Where `needle` first occurs in `hay`, or -1. */
export function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** happy-dom lays nothing out: a 1:1 box makes client pixels HUD units. */
/** One element's rows in Layers: your own health lists pieces named like the teammate card's. */
export const layer = (label: string) => within(screen.getByRole('group', { name: `Layers: ${label}` }));
export const team = () => layer('Teammates');

export const unitCanvas = (container: Element) => {
  const canvas = container.querySelector('canvas') as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return canvas;
};
export type Keys = { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean };
/** A press and release on one spot: a click. */
export const clickAt = (canvas: HTMLElement, x: number, y: number, keys: Keys = {}) => {
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y, pointerId: 1, ...keys });
  fireEvent.pointerUp(canvas, { clientX: x, clientY: y, pointerId: 1, ...keys });
};
/** A drag, with Alt held unless told otherwise, so the numbers are the pointer's and not a snap's. */
export const dragFrom = (canvas: HTMLElement, from: [number, number], to: [number, number], keys: Keys = { altKey: true }) => {
  fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1], pointerId: 1, ...keys });
  fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1], pointerId: 1, ...keys });
  fireEvent.pointerUp(canvas, { clientX: to[0], clientY: to[1], pointerId: 1, ...keys });
};
