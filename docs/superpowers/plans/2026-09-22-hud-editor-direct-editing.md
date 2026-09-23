# HUD Editor Phase 1b: Direct Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The HUD editor feels like a design tool: undo and redo, one click picks the deepest piece under the pointer, a drag on something not yet picked moves its whole section, several pieces or elements move, align and scale together, handles resize on every side and corner, snap guides show while dragging, a Layers list, one toolbar, a context panel that shows only what the selection can do, a right-click menu, and Delete hides. The Phase 1 known issue (a scaled or moved team running off the screen) is fixed with an on-screen clamp in the generator.

**Architecture:** Four new pure modules carry the logic, so the page holds none of its own: `history.ts` (undo stacks over whole `HudDesign` values), `guides.ts` (box geometry, snapping and guide lines), `selection.ts` (the `Selection` type and what a hover, click, drag, box or key means, all measured from `elementRect`, `teamCardRects`, `childRects` and `cardChild`), and `edit.ts` (every design edit the page applies: the Phase 1 helpers moved out of `Hud.tsx` plus the group, handle and hide edits). `mock.ts` draws hover outlines, frames, handles, the box and guides from a widened `HudView`, and `Hud.tsx` is split into `Toolbar`, `LayersPanel`, `ContextPanel` and `ContextMenu` components under `web/src/routes/hud/`, keeping only state and wiring.

**Tech Stack:** TypeScript, Preact, Vite, vitest (happy-dom project `web`), canvas 2D. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-hud-editor-direct-editing-design.md` (binding). It builds on Phase 1, `docs/superpowers/specs/2026-09-22-hud-editor-teammate-cards-design.md`, built by `docs/superpowers/plans/2026-09-22-hud-editor-teammate-cards.md`.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). Never touch the main checkout or `master`. Do not push. Nothing is deployed.
- No server code, no database, no plugin, no new npm dependencies. Everything is under `web/` plus `docs/`.
- Never use em dashes anywhere: code, comments, UI copy, test names, commit messages. Use commas, colons, parentheses or separate sentences.
- Match the surrounding explanatory comment style: block comments that say why, as in `web/src/hud/build.ts`.
- Commit after every task with a plain-English message. All commands run from the worktree root.
- Never use `git stash`. To set work aside, make a temporary commit on this branch.
- Tests: `npx vitest run --project web <path>`. Types: `npm run typecheck`. Build: `npm run build`.
- Preview equals file: every position the canvas draws or hit-tests comes from the generator's own trees (`buildTrees`, `elementRect`, `teamCardRects`, `childRects`, `cardChild`, `cardFrame`). Every hit, handle, hover outline and guide is measured from those; no module under `web/src/hud/` or the page computes a card or child position on its own.
- Designs are always valid: every gesture, box, key and menu action goes through the existing clamps (`clampOverride`, `clampChild`, `clampSpan`, the unfitted-card clamp in `placeChild`); an out-of-range value is clamped, never rejected.
- Nothing changes what a download contains except the on-screen team clamp of Task 3: every edit still lands in `HudDesign` through the fields Phase 1 defined.

## File Structure

```
web/src/hud/history.ts            NEW. Undo and redo stacks over whole values: steps, gestures, nudge coalescing, the 100-entry cap
web/src/hud/history.test.ts       NEW
web/src/hud/guides.ts             NEW. Box geometry (Handle, CORNERS, ALL_HANDLES, unionBox) and snapping with guide lines (snapMove, snapEdges)
web/src/hud/guides.test.ts        NEW
web/src/hud/selection.ts          NEW. Selection, hit resolution (hover, click, drag, box, Ctrl+A), Escape, breadcrumb, sanitize, frames, box, handles, snap targets, menu actions
web/src/hud/selection.test.ts     NEW
web/src/hud/edit.ts               NEW. The Phase 1 edit helpers moved out of Hud.tsx, plus resetChild, group moves, scales and aligns, handle resizes, nudgeSelection, hide and reset
web/src/hud/edit.test.ts          NEW. The Phase 1 helper tests moved out of Hud.test.tsx, plus the new edits
web/src/hud/build.ts              keepOnScreen and the on-screen team clamp in teamLayout; cardFrame
web/src/hud/build.test.ts         the clamp, cardFrame; one Phase 1 expectation updated (the scaled Row now lifts)
web/src/hud/mock.ts               HudView widened (frames, box, handles, hover, marquee, guides); drawHud takes several selected ids; the old per-element selection drawing and childCornerAt removed
web/src/hud/mock.test.ts          the new drawing; the two Phase 1 outline tests rewritten against selectionFrames; childCornerAt tests removed
web/src/routes/hud/controls.tsx   NEW. Shared control bits: Slider, Field, patchNum, the colour helpers, Edit and EditMode, endsOn, typedInto
web/src/routes/hud/ContextPanel.tsx NEW. ElementControls, TeamControls, ChildControls (moved), CardControls, PiecesControls, ElementsControls, ContextPanel
web/src/routes/hud/LayersPanel.tsx NEW. The Layers list
web/src/routes/hud/Toolbar.tsx    NEW. Undo, Redo, side, state, Preset, Aspect, Backdrop, Font, Download
web/src/routes/hud/ContextMenu.tsx NEW. The right-click menu
web/src/routes/Hud.tsx            state (design, history, selection, hover, drag), wiring and layout; toUnits, decodeUpload, assetsFor, StyleRow stay here
web/src/routes/Hud.test.tsx       page tests; helper tests moved to edit.test.ts; snap test removed
web/src/styles/app.css            hud__canvaswrap, hud__crumbs, hud__layers and rows, hud__align, hud__tbsep, hud__download, hud__menu; the .hud grid gains the Layers column
```

## Decisions this plan makes where the spec leaves a detail open, or where the code differs

- **The on-screen clamp measures the drawn team, not the container.** The spec says `min(start, extent - size)` with `size` the container. Stock's own container is 100 tall at `r75`, so it already hangs 25 units off the bottom in the untouched file, and clamping the container would move every stock design's cards up 25. The clamp therefore uses how far the team reaches into its container: along the direction, the offset plus three pitches plus one card (the container's own size in Row and Column); across it, the offset plus one card, or for an unfitted card the content box's far edge scaled. Untouched and unscaled designs do not move; a scaled Row lifts (stock at 1.25 goes from `r75` to `r90`), a moved Column comes back on screen. Free is not clamped (its container is the screen, and each card keeps its 8-unit `clampSpan`).
- **A moved team's stored `x`/`y` can sit past the edge the file clamps it to.** The file and the canvas agree (both use `at`); `nudge` now starts from the drawn position, so a key press back from the edge moves the team at once.
- **The on-screen clamp keeps `max(0, ...)` on the start**, as the spec says, so a team moved off the top or left comes back to 0.
- **History compares by JSON** (`sameJson`) to decide that a gesture or a step changed nothing; a whole design is compared only at the end of a gesture or on a discrete step, never per pointer move.
- **Undo keys are skipped only in typing boxes** (`text`, `number`, `search`, `email`, `url` inputs, textareas, contenteditable). A focused checkbox, slider or button still gets the editor's undo.
- **Arrow keys, Delete, Escape and Ctrl+A** work while the canvas or the Layers list has focus; Tab cycling stays on the canvas only.
- **A plain drag that starts on empty canvas does nothing**, and neither does its release; only a click on empty canvas clears the selection.
- **Shift+drag always draws a box**, even when it starts on a picked piece. The box replaces the selection rather than adding to it.
- **Cards are picked one at a time.** A Shift+click on a Free card selects that card alone.
- **In Free, a drag on a card while the Teammates are selected moves that card** (the Teammates container is the screen and cannot move), and selects it.
- **No handles on the Teammates element in Free** (its box is the whole screen; the Scale slider stays), and none on a Free card, as the spec's table says.
- **Resizing snaps only where the size is free**: a free element and a `wh` piece without Shift. Ratio-locked resizes (scale, square, the Items icon size, several pieces) do not snap, because snapping one edge would break the ratio.
- **Handle hit slack is 5 screen pixels**, and the nearest handle wins, so a thin health bar's side handle is reachable between its corners.
- **A click is a press and release within 3 screen pixels** (client pixels, as the spec says), anything longer is a drag.
- **Hover** outlines exactly what `clickSelect` would pick with the current Ctrl state (so a piece hover outlines it in every card) and labels it with the breadcrumb's last label. It is hidden while dragging.
- **The breadcrumb's ancestor segments are buttons named "Up to <label>"**, so their accessible names never collide with the Layers rows; the last segment is plain text.
- **Layers is always expanded.** Teammates lists Card 1..4 in Free, then every registry piece, the splatter included, since the Layers list is now the only way to reach a hidden or decorative piece. State pieces carry a muted note: "shown when down", "shown when dead", "shown when talking".
- **Removing the added health number** moves from the old checkbox to a "Remove the health number" button in its controls; the Layers `＋ Health number` row adds it.
- **The note "Edits inside a card apply to every teammate's card."** moves into the piece controls and the several-pieces controls.
- **Selection after a design change** runs through `sanitize`: elements off the current side are dropped; pieces that stopped existing are dropped, and if none remain the Teammates are selected (the Phase 1 "steps back to the teammates" rule); a card outside Free becomes the Teammates. The preview state never drops a selection.
- **Preset change, import and share-link load** keep an element selection and climb a card or piece selection to the Teammates (Phase 1 `dropPicks`). Switching side clears the selection.
- **Right-click** acts on the whole selection when the thing under the pointer is part of it; otherwise it selects that thing and acts on it. The menu offers Hide and Reset for elements and pieces, Select whole card for a piece in Free, Select Teammates for a piece or a card. A card has no Hide (the spec) and no Reset.
- **Delete on an element with no Visible control** (the custom crosshair) does nothing.
- **Group scale of pieces** caps each size to the unfitted card first, then clamps positions inside it, as `placeChild` does, so the design stays valid when a scale would overflow.
- **Element scale by handle** rounds the scale to 0.01 and clamps it to 0.5..2; the element moves only when the dragged corner is on its left or top, so a bottom-right drag keeps a file-anchored element's own anchor.
- **The Scale, Gap and opacity sliders, number boxes, colour pickers and the design name** are gestures (one undo step each); checkboxes, selects, buttons, uploads, imports, share links, preset changes and resets are steps.

---

### Task 1: `history.ts`, the undo and redo stacks

**Files:**
- Create: `web/src/hud/history.ts`
- Test: `web/src/hud/history.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HISTORY_CAP = 100`, `NUDGE_WINDOW_MS = 800`
  - `interface History<T> { past: T[]; future: T[]; pending: T | null; nudge: { key: string; at: number } | null }`
  - `emptyHistory<T>(): History<T>`
  - `push<T>(h: History<T>, prev: T): History<T>` (one step; clears the future and any nudge run)
  - `begin<T>(h: History<T>, prev: T): History<T>` (starts a gesture; a second call keeps the first start)
  - `commit<T>(h: History<T>, current: T, same?: (a: T, b: T) => boolean): History<T>`
  - `cancel<T>(h: History<T>): { h: History<T>; restore: T | null }`
  - `nudgeStep<T>(h: History<T>, prev: T, key: string, now: number): History<T>`
  - `undo<T>(h: History<T>, current: T): { h: History<T>; value: T } | null`
  - `redo<T>(h: History<T>, current: T): { h: History<T>; value: T } | null`
  - `sameJson(a: unknown, b: unknown): boolean`

- [ ] **Step 1: Write the failing tests**

Create `web/src/hud/history.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/history.test.ts`
Expected: FAIL, `Failed to resolve import "./history"`.

- [ ] **Step 3: Implement**

Create `web/src/hud/history.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud/history.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/history.ts web/src/hud/history.test.ts
git commit -m "Add the HUD editor's undo history: steps, gestures, coalesced nudges, a 100-step cap"
```

---

### Task 2: `edit.ts`, the Phase 1 edit helpers moved out of the page

**Files:**
- Create: `web/src/hud/edit.ts`, `web/src/hud/edit.test.ts`
- Modify: `web/src/routes/Hud.tsx`, `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `elementRect`, `teamLayout`, `teamCardRects`, `isFreeTeam`, `cardChild` (`build.ts`); `clampOverride`, `clampChild`, `baseTeam`, `DEFAULT_DESIGN` (`design.ts`); `elementById` (`elements.ts`); `teamChild` (`children.ts`); `screenW`, `SCREEN_H` (`units.ts`).
- Produces, all moved from `Hud.tsx` unchanged: `clampSpan(v, size, extent, min): number` (now exported), `nudge(design, id, dx, dy)`, `elementsTouched(d)`, `hasOverrides(d)`, `resetElement(d, id)`, `cardOffset(design)`, `withTeamDir(d, dir)`, `placeCard(design, card, x, y)`, `nudgeCard(design, card, dx, dy)`, `patchChild(design, name, p)`, `placeChild(design, name, x, y)`, `nudgeChild(design, name, dx, dy)`, `resizeChild(design, name, start, dw, dh)`. New: `resetChild(d: HudDesign, name: string): HudDesign`, extracted from `ChildControls`' reset. Nothing outside `Hud.test.tsx` imports these from `routes/Hud` (checked: `main.tsx` imports only the default export), so `Hud.tsx` does not re-export them.

- [ ] **Step 1: Move the helper tests and write the failing test**

Create `web/src/hud/edit.test.ts` with the Phase 1 helper tests cut from `web/src/routes/Hud.test.tsx` (the `describe` blocks `nudge`, `what counts as an edit`, `the teammate layout helpers`, `patchChild`, `moving a teammate card child` and `nudgeCard`), unchanged, under this header, plus the new `resetChild` block:

```ts
import { describe, it, expect } from 'vitest';
import {
  nudge, nudgeCard, hasOverrides, elementsTouched, resetElement, withTeamDir, placeCard, patchChild,
  placeChild, nudgeChild, resizeChild, resetChild,
} from './edit';
import { DEFAULT_DESIGN } from './design';
import { teamCardRects } from './build';

describe('resetChild', () => {
  it('drops a child edit and keeps an added child added', () => {
    const edited = patchChild(patchChild(DEFAULT_DESIGN, 'HealthNumber', { on: true, x: 90 }), 'Head', { w: 30, h: 30 });
    const once = resetChild(edited, 'HealthNumber');
    expect(once.children.teamColumn).toEqual({ HealthNumber: { on: true }, Head: { w: 30, h: 30 } });
    expect(resetChild(resetChild(once, 'Head'), 'HealthNumber').children.teamColumn).toEqual({ HealthNumber: { on: true } });
    // The last edit gone: no empty teamColumn map is left behind.
    expect(resetChild(patchChild(DEFAULT_DESIGN, 'Head', { x: 5 }), 'Head').children.teamColumn).toBeUndefined();
  });
});
```

In `web/src/routes/Hud.test.tsx`, replace the import block at the top with:

```ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { snap, toUnits } from './Hud';
import Hud from './Hud';
```

and delete the six `describe` blocks moved above. `describe('snap', ...)` and `describe('toUnits', ...)` stay.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/edit.test.ts`
Expected: FAIL, `Failed to resolve import "./edit"`.

- [ ] **Step 3: Implement**

Create `web/src/hud/edit.ts`. Its body is the code cut from `web/src/routes/Hud.tsx`, unchanged except that `clampSpan` gains `export`: the functions `clampSpan`, `nudge`, `elementsTouched`, `hasOverrides`, `resetElement`, `cardOffset`, `withTeamDir`, `placeCard`, `nudgeCard`, `patchChild`, `placeChild`, `nudgeChild` and `resizeChild`, each with its doc comment, in that order, then `resetChild`. The header:

```ts
/**
 * Every edit the HUD editor page applies to a design, as pure functions
 * from one HudDesign to the next. The page decides which one a gesture or a
 * control means and records it in its history; nothing here knows about
 * pointers, keys or the DOM. Every result goes through the same clamps the
 * validator uses, so a design built here is always one the generator takes.
 *
 * Positions are read back from the generator (elementRect, teamCardRects,
 * cardChild), never worked out here, so an edit starts from exactly what the
 * canvas draws.
 */
import {
  clampOverride, clampChild, baseTeam, DEFAULT_DESIGN,
  type HudDesign, type ElementOverride, type TeamDir, type ChildOverride,
} from './design';
import { screenW, SCREEN_H } from './units';
import { elementById } from './elements';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, cardChild } from './build';
import { teamChild } from './children';
```

The new function, appended at the end:

```ts
/**
 * "Reset this child": drop the child's edits. Resetting an added child (the
 * stock health number) keeps it added: only its own Remove control takes it
 * away. The last edit gone, the card's map goes too, so a reset design is
 * the same value as one never touched.
 */
export function resetChild(d: HudDesign, name: string): HudDesign {
  const def = teamChild(name);
  const kids = { ...(d.children.teamColumn ?? {}) };
  const on = kids[name]?.on;
  delete kids[name];
  if (def?.addable && on !== undefined) kids[name] = { on };
  const children: HudDesign['children'] = { ...d.children, teamColumn: kids };
  if (Object.keys(kids).length === 0) delete children.teamColumn;
  return { ...d, children };
}
```

In `web/src/routes/Hud.tsx`:

- Delete the moved functions (`clampSpan` through `resizeChild`, lines 45 to 276 of the Phase 1 file, keeping `toUnits`, `snap`, `decodeUpload`, `fontBytes` and `assetsFor`).
- Replace the imports of `design`, `build` and `children` with:

```ts
import {
  loadDesign, saveDesign, validateDesign, safeName, encodeShare, decodeShare, clampOverride, clampChild, DEFAULT_DESIGN, baseTeam,
  type HudDesign, type ElementOverride, type StyleOverride, type RangeKey, type TeamDir, type ChildOverride, type ChildRangeKey,
} from '../hud/design';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, cardChild, baseHasChild, packHud, type BuildAssets } from '../hud/build';
import { TEAM_PANEL, teamChild } from '../hud/children';
import {
  clampSpan, nudge, elementsTouched, hasOverrides, resetElement, cardOffset, withTeamDir, placeCard, nudgeCard,
  patchChild, placeChild, nudgeChild, resizeChild, resetChild,
} from '../hud/edit';
```

- In `ChildControls`, replace the whole `const reset = () => setDesign((d) => { ... });` block with:

```ts
  const reset = () => setDesign((d) => resetChild(d, name));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud/edit.test.ts web/src/routes/Hud.test.tsx && npm run typecheck`
Expected: PASS, no type errors. The moved tests pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/edit.ts web/src/hud/edit.test.ts web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Move the HUD editor's design edits out of the page into hud/edit.ts, and add resetChild"
```

---

### Task 3: Keep the whole team on screen, and report the card frame

**Files:**
- Modify: `web/src/hud/build.ts`, `web/src/hud/edit.ts`
- Test: `web/src/hud/build.test.ts`, `web/src/hud/edit.test.ts`

**Interfaces:**
- Consumes: `teamLayout`, `growBack`, `cardFit`, `cardWork` (`build.ts`); `parsePos`, `formatPos` (`units.ts`).
- Produces:
  - `keepOnScreen(start: number, reach: number, extent: number): number` = `max(0, min(start, extent - reach))`.
  - `teamLayout` sets `at.xpos` / `at.ypos` whenever the clamp moves the Row or Column container on that axis (so `teamPass`, `elementRect` and `teamCardRects` all follow).
  - `interface CardFrame { shift: { x: number; y: number }; k: number }` and `cardFrame(design: HudDesign): CardFrame`: a teammate-card child stored at `(x, y)` is drawn in card `c` at `(c.x + (x - shift.x) * k, c.y + (y - shift.y) * k)`.
  - `nudge` (in `edit.ts`) starts from the drawn position `elementRect` reports instead of the stored `x`/`y`.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/build.test.ts`, change the import line to add `keepOnScreen` and `cardFrame`:

```ts
import { buildHud, elementRect, teamLayout, packHud, buildTrees, cardChild, baseHasChild, teamCardRects, isFreeTeam, growBack, keepOnScreen, cardFrame } from './build';
```

In the test `leaves a Row where it was, and a moved team where the player put it`, rename it and change its first expectation, because the scaled Row is exactly the Phase 1 known issue this task fixes:

```ts
  it('leaves a Row where it was along the screen, lifts it just enough to end on it, and leaves a moved team where the player put it', () => {
    // Fitted, gap 30, scale 1.5: the cards reach 108 into a container at r75,
    // so the container lifts to r108 and the cards end on the bottom edge.
    const row = kvFind(layoutOf(buildHud(design({ elements: { teamColumn: { fit: true, gap: 30, scale: 1.5 } } }))), ['CHudTeamDisplay'])!;
    expect([kvGet(row, 'xpos'), kvGet(row, 'ypos')]).toEqual(['0', 'r108']);
```

(the rest of that test is unchanged). Add a new `describe` after `describe('a team container anchored to the far edge grows back toward it', ...)`:

```ts
describe('the whole team stays on screen', () => {
  it('lifts a scaled Row off the bottom edge so its cards end on the screen', () => {
    const d = design({ elements: { teamColumn: { fit: true, scale: 1.25 } } });
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ x: 0, y: 390 });
    expect(teamCardRects(d, '16:9')[0]).toMatchObject({ y: 435, h: 45 });
    expect(kvGet(kvFind(layoutOf(buildHud(d)), ['CHudTeamDisplay'])!, 'ypos')).toBe('r90');
  });

  it('keeps a moved team switched to Column on screen', () => {
    // 237 tall at y 300 would end at 537: it comes up to 243, the last card ending on the edge.
    const d = design({ elements: { teamColumn: { fit: true, dir: 'column', x: 500, y: 300 } } });
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ x: 500, y: 243, h: 237 });
    const last = teamCardRects(d, '16:9')[3];
    expect(last.y + last.h).toBe(480);
  });

  it('brings a team moved past the top and left edges back to 0', () => {
    const d = design({ elements: { teamColumn: { fit: true, x: -50, y: -20 } } });
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ x: 0, y: 0 });
    const c = kvFind(layoutOf(buildHud(d)), ['CHudTeamDisplay'])!;
    expect([kvGet(c, 'xpos'), kvGet(c, 'ypos')]).toEqual(['0', '0']);
  });

  it('leaves an unscaled team exactly where the preset puts it, fitted or not', () => {
    // Stock's own container hangs 25 off the bottom, but its cards do not: nothing moves.
    expect(elementRect(DEFAULT_DESIGN, 'teamColumn', '16:9')).toMatchObject({ y: 405 });
    expect(teamCardRects(DEFAULT_DESIGN, '16:9')[0]).toMatchObject({ x: 13, y: 441 });
    expect(elementRect(design({ elements: { teamColumn: { gap: 30 } } }), 'teamColumn', '16:9')).toMatchObject({ y: 405 });
    const modern = design({ preset: 'modern', elements: { teamColumn: { fit: true } } });
    expect(elementRect(modern, 'teamColumn', '16:9')).toMatchObject({ x: 8, y: 332 });
  });

  it('clamps a start so the reach ends on the screen, never before 0', () => {
    expect(keepOnScreen(405, 90, 480)).toBe(390);
    expect(keepOnScreen(405, 72, 480)).toBe(405);
    expect(keepOnScreen(-20, 72, 480)).toBe(0);
    expect(keepOnScreen(300, 900, 853)).toBe(0);
  });
});

describe('cardFrame', () => {
  it("reports the frame a child's stored numbers are drawn in, the one the generator used", () => {
    expect(cardFrame(DEFAULT_DESIGN)).toEqual({ shift: { x: 13, y: 36 }, k: 1 });
    expect(cardFrame(design({ elements: { teamColumn: { scale: 1.5 } } }))).toEqual({ shift: { x: 0, y: 0 }, k: 1.5 });
    const c = teamCardRects(DEFAULT_DESIGN, '16:9')[1];
    const f = cardFrame(DEFAULT_DESIGN);
    const info = cardChild(DEFAULT_DESIGN, 'Head')!;
    const head = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Head')!;
    expect(head.x).toBe(c.x + (info.x - f.shift.x) * f.k);
    expect(head.y).toBe(c.y + (info.y - f.shift.y) * f.k);
  });
});
```

In `web/src/hud/edit.test.ts`, add `import { elementRect } from './build';` (merge into the existing `./build` import) and, inside `describe('nudge', ...)`:

```ts
  it('nudges a team from where it is drawn, so a press back from the edge moves it at once', () => {
    let d = DEFAULT_DESIGN;
    for (let i = 0; i < 5; i++) d = nudge(d, 'teamColumn', -1, 0);
    expect(elementRect(d, 'teamColumn', d.aspect).x).toBe(0);
    d = nudge(d, 'teamColumn', 1, 0);
    expect(elementRect(d, 'teamColumn', d.aspect).x).toBe(1);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/build.test.ts web/src/hud/edit.test.ts`
Expected: FAIL. `keepOnScreen` and `cardFrame` are not exported; the scaled Row still reads `r75`; the moved column sits at 300; the team nudged past the edge sits at -4.

- [ ] **Step 3: Implement**

In `web/src/hud/build.ts`, directly below `growBack`, add:

```ts
/**
 * Where a team container starts along one axis so the whole team is on
 * screen: no further than `extent - reach`, which puts the team's far edge
 * on the screen's, and never before 0. `reach` is how far into the
 * container the drawn team extends, not the container's own size: stock's
 * container is 100 tall at r75 and so already hangs 25 off the bottom in the
 * untouched file, while its cards stop well short of that. Measuring the
 * cards is what keeps an untouched or unscaled design exactly where the
 * preset puts it, while a scaled Row, or a moved team switched to Column,
 * comes back on screen.
 */
export function keepOnScreen(start: number, reach: number, extent: number): number {
  return Math.max(0, Math.min(start, extent - reach));
}
```

In `teamLayout`, replace the final `return out;` (the one after the `growBack` block, at the end of the function) with:

```ts
  // The whole team stays on screen, in both axes, after scaling and layout.
  // Along the direction the team reaches three pitches plus one card past its
  // offset; across it, one card. A fitted card is the content, so that is
  // the offset plus the card; an unfitted card reaches as far as its content
  // does, scaled, since the rest of the file card draws nothing. The start is
  // where teamPass would otherwise write the container: grown back, moved by
  // the player, or the file's own. Moving it is one more `at`, so the file,
  // elementRect and teamCardRects follow it together.
  const content = box ?? cardFit(design);
  const reach = (a: 'x' | 'y') => {
    const wh = a === 'x' ? 'w' : 'h';
    const pitches = (dir === 'row') === (a === 'x') ? spacing * 3 : 0;
    const last = box ? offset[a] + card[wh] : content ? (content[a] + content[wh]) * k : card[wh];
    return pitches + last;
  };
  for (const a of ['x', 'y'] as const) {
    const pos = a === 'x' ? 'xpos' : 'ypos';
    const extent = a === 'x' ? screenW(design.aspect) : SCREEN_H;
    const grown = out.at?.[pos];
    const start = grown !== undefined ? parsePos(grown, extent)
      : el.move && o?.[a] !== undefined ? o[a]! : parsePos(kvGet(panel, pos) ?? '0', extent);
    const kept = keepOnScreen(start, reach(a), extent);
    if (Math.round(kept) !== Math.round(start)) {
      out.at = { ...out.at, [pos]: formatPos(kept, a === 'x' ? out.container.w : out.container.h, extent) };
    }
  }
  return out;
```

Below `cardFit`, add:

```ts
/** How a teammate-card child's stored numbers land on screen. */
export interface CardFrame { shift: { x: number; y: number }; k: number }

/**
 * The frame the generator draws a teammate-card child in: fitPass shifts
 * every child by the content box's top-left (when fitted), then scalePass
 * multiplies by the element's scale. A child stored at (x, y) is drawn in
 * card c at (c.x + (x - shift.x) * k, c.y + (y - shift.y) * k). The page
 * uses it to turn a pointer delta into stored units and to draw a piece's
 * snap guides where the piece is drawn, from the generator's own numbers.
 */
export function cardFrame(design: HudDesign): CardFrame {
  const { box } = cardWork(design);
  const shift = design.elements.teamColumn?.fit && box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
  return { shift, k: design.elements.teamColumn?.scale ?? 1 };
}
```

In `web/src/hud/edit.ts`, in `nudge`, replace

```ts
  const o = design.elements[id];
  const base = elementRect(design, id, design.aspect);
  const extentW = screenW(design.aspect);
  const x = clampSpan((o?.x ?? base.x) + dx, base.w, extentW, 8);
  const y = clampSpan((o?.y ?? base.y) + dy, base.h, SCREEN_H, 8);
```

with

```ts
  // From where the element is drawn, not the stored x and y: a team the
  // on-screen clamp holds at the edge is drawn there whatever it stores, and
  // a press back from the edge must move it at once.
  const o = design.elements[id];
  const base = elementRect(design, id, design.aspect);
  const extentW = screenW(design.aspect);
  const x = clampSpan(base.x + dx, base.w, extentW, 8);
  const y = clampSpan(base.y + dy, base.h, SCREEN_H, 8);
```

and in its doc comment replace the sentence "Goes through `elementRect`, the same function the canvas and the generator use, so a nudge before any drag starts from exactly where the element is drawn." with "Starts from `elementRect`, the same function the canvas and the generator use, so every nudge starts from exactly where the element is drawn."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes/Hud.test.tsx && npm run typecheck`
Expected: PASS. The parity loop in `team geometry: the canvas and the file agree` still passes (the clamp is one more `at`, which the file and `elementRect` share). If any other existing test pins a team position, it is a scaled or moved team the clamp now lifts: recompute it from `keepOnScreen` and note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/build.ts web/src/hud/build.test.ts web/src/hud/edit.ts web/src/hud/edit.test.ts
git commit -m "Keep the whole teammate team on screen after scaling and layout, report the card frame, and nudge from where an element is drawn"
```

---

### Task 4: `guides.ts`, box geometry and snapping

**Files:**
- Create: `web/src/hud/guides.ts`
- Test: `web/src/hud/guides.test.ts`

**Interfaces:**
- Consumes: `Box` (`design.ts`).
- Produces:
  - `type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'`, `CORNERS: Handle[]` (`nw ne se sw`), `ALL_HANDLES: Handle[]` (corners first, then `n e s w`)
  - `unionBox(rects: Box[]): Box | null`
  - `SNAP_UNITS = 4`
  - `interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number }` (an `x` guide is a vertical line at `x = at` from `y = from` to `y = to`; a `y` guide the horizontal twin)
  - `interface Snap { dx: number; dy: number; guides: Guide[] }` (corrections to add to the pointer delta)
  - `snapMove(moving: Box, targets: Box[], threshold?: number): Snap`
  - `snapEdges(box: Box, handle: Handle, targets: Box[], threshold?: number): Snap`

- [ ] **Step 1: Write the failing tests**

Create `web/src/hud/guides.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { snapMove, snapEdges, unionBox, SNAP_UNITS } from './guides';

const SCREEN = { x: 0, y: 0, w: 853, h: 480 };

describe('snapMove', () => {
  it('snaps a near edge, a far edge or a centre to the screen within 4 units', () => {
    expect(snapMove({ x: 3, y: 100, w: 100, h: 20 }, [SCREEN]).dx).toBe(-3);
    expect(snapMove({ x: 750, y: 100, w: 100, h: 20 }, [SCREEN]).dx).toBe(3);
    expect(snapMove({ x: 375, y: 100, w: 100, h: 20 }, [SCREEN]).dx).toBe(1.5);
    expect(snapMove({ x: 2, y: 231, w: 20, h: 20 }, [SCREEN])).toMatchObject({ dx: -2, dy: -1 });
  });

  it('leaves a box more than 4 units from everything alone', () => {
    expect(SNAP_UNITS).toBe(4);
    expect(snapMove({ x: 200, y: 100, w: 100, h: 20 }, [SCREEN])).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(snapMove({ x: 5, y: 100, w: 100, h: 20 }, [SCREEN]).dx).toBe(0);
  });

  it("snaps to another box's edges and returns the guide spanning both", () => {
    const got = snapMove({ x: 100, y: 10, w: 50, h: 50 }, [{ x: 152, y: 200, w: 40, h: 40 }]);
    expect(got).toEqual({ dx: 2, dy: 0, guides: [{ axis: 'x', at: 152, from: 10, to: 240 }] });
  });

  it('prefers the nearest candidate', () => {
    expect(snapMove({ x: 10, y: 0, w: 10, h: 10 }, [{ x: 11, y: 500, w: 2, h: 1 }]).dx).toBe(1);
  });

  it('draws a guide for an exact alignment too', () => {
    const got = snapMove({ x: 0, y: 100, w: 100, h: 20 }, [SCREEN]);
    expect(got.dx).toBe(0);
    expect(got.guides).toContainEqual({ axis: 'x', at: 0, from: 0, to: 480 });
  });
});

describe('snapEdges', () => {
  it('snaps only the edges the handle moves', () => {
    const target = { x: 112, y: 300, w: 10, h: 10 };
    expect(snapEdges({ x: 10, y: 10, w: 100, h: 50 }, 'e', [target])).toEqual({
      dx: 2, dy: 0, guides: [{ axis: 'x', at: 112, from: 10, to: 310 }],
    });
    expect(snapEdges({ x: 10, y: 10, w: 100, h: 50 }, 'w', [target])).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(snapEdges({ x: 10, y: 3, w: 100, h: 50 }, 'n', [SCREEN]).dy).toBe(-3);
    expect(snapEdges({ x: 10, y: 3, w: 100, h: 50 }, 's', [SCREEN]).dy).toBe(0);
  });
});

describe('unionBox', () => {
  it('bounds every box, or is null for none', () => {
    expect(unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }])).toEqual({ x: 0, y: 0, w: 30, h: 15 });
    expect(unionBox([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/guides.test.ts`
Expected: FAIL, `Failed to resolve import "./guides"`.

- [ ] **Step 3: Implement**

Create `web/src/hud/guides.ts`:

```ts
/**
 * Box geometry the editor's gestures share, and snapping. While a section,
 * a card or a piece moves, its edges and centre lines snap to the targets'
 * edges and centre lines within SNAP_UNITS HUD units, and a guide line is
 * returned for every alignment the snapped box then makes, so the page can
 * draw a pink line for each. Resizing snaps only the edges the dragged
 * handle moves. Pure: the caller picks the targets (from the generator's
 * rects) and decides whether Alt turned snapping off.
 */
import type { Box } from './design';

/** A handle on a selection's box: a side or a corner, named by compass point. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw'];
/** Corners first, so a tiny box whose corners and sides overlap still offers its corners. */
export const ALL_HANDLES: Handle[] = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'];

export const SNAP_UNITS = 4;

export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number }
export interface Snap { dx: number; dy: number; guides: Guide[] }

/** The box around every box given, or null for none. */
export function unionBox(rects: Box[]): Box | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  const r = Math.max(...rects.map((b) => b.x + b.w)), b = Math.max(...rects.map((q) => q.y + q.h));
  return { x, y, w: r - x, h: b - y };
}

/** A box's two edges and its centre line along one axis. */
const lines = (lo: number, size: number) => [lo, lo + size / 2, lo + size];

/** The smallest correction that puts one of `mine` on one of `theirs`, within `threshold` (inclusive), or null. */
function nearest(mine: number[], theirs: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const m of mine) {
    for (const t of theirs) {
      const d = t - m;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/**
 * One guide per target line that one of `at` now sits on, spanning the
 * moving box and that target across the other axis, so the line runs
 * between the two things it aligns.
 */
function guidesOn(axis: 'x' | 'y', at: number[], moving: Box, targets: Box[]): Guide[] {
  const out = new Map<string, Guide>();
  for (const t of targets) {
    const tl = axis === 'x' ? lines(t.x, t.w) : lines(t.y, t.h);
    const from = axis === 'x' ? Math.min(moving.y, t.y) : Math.min(moving.x, t.x);
    const to = axis === 'x' ? Math.max(moving.y + moving.h, t.y + t.h) : Math.max(moving.x + moving.w, t.x + t.w);
    for (const a of at) if (tl.some((l) => Math.abs(l - a) < 0.01)) out.set(`${a}:${from}:${to}`, { axis, at: a, from, to });
  }
  return [...out.values()];
}

/**
 * Snap a moving box (already at the pointer's position) to the targets:
 * each axis independently, the nearest line pair within `threshold`.
 */
export function snapMove(moving: Box, targets: Box[], threshold = SNAP_UNITS): Snap {
  const sx = nearest(lines(moving.x, moving.w), targets.flatMap((t) => lines(t.x, t.w)), threshold);
  const sy = nearest(lines(moving.y, moving.h), targets.flatMap((t) => lines(t.y, t.h)), threshold);
  const at = { ...moving, x: moving.x + (sx ?? 0), y: moving.y + (sy ?? 0) };
  const guides = [
    ...(sx === null ? [] : guidesOn('x', lines(at.x, at.w), at, targets)),
    ...(sy === null ? [] : guidesOn('y', lines(at.y, at.h), at, targets)),
  ];
  return { dx: sx ?? 0, dy: sy ?? 0, guides };
}

/**
 * Snap a box being resized by `handle` (already at the pointer's size): only
 * the edges that handle moves are candidates. The corrections add to the
 * pointer delta the same way for every handle, since a left or top edge
 * moves with the delta just as a right or bottom one does.
 */
export function snapEdges(box: Box, handle: Handle, targets: Box[], threshold = SNAP_UNITS): Snap {
  const mx = handle.includes('e') ? [box.x + box.w] : handle.includes('w') ? [box.x] : [];
  const my = handle.includes('s') ? [box.y + box.h] : handle.includes('n') ? [box.y] : [];
  const sx = nearest(mx, targets.flatMap((t) => lines(t.x, t.w)), threshold);
  const sy = nearest(my, targets.flatMap((t) => lines(t.y, t.h)), threshold);
  const guides = [
    ...(sx === null ? [] : guidesOn('x', [mx[0] + sx], box, targets)),
    ...(sy === null ? [] : guidesOn('y', [my[0] + sy], box, targets)),
  ];
  return { dx: sx ?? 0, dy: sy ?? 0, guides };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud/guides.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/guides.ts web/src/hud/guides.test.ts
git commit -m "Add snapping for the HUD editor: edges and centres within 4 units, with guide lines, and shared box geometry"
```

---

### Task 5: `selection.ts`, what a pointer gesture means

**Files:**
- Create: `web/src/hud/selection.ts`
- Test: `web/src/hud/selection.test.ts`

**Interfaces:**
- Consumes: `hitTest`, `childAt`, `visibleElements`, `Side` (`mock.ts`); `elementRect`, `teamCardRects`, `isFreeTeam`, `cardChild`, `CardFrame` (`build.ts`); `childRects`, `hiddenInState`, `CardState` (`render.ts`); `TEAM_PANEL`, `teamChild` (`children.ts`); `elementById` (`elements.ts`); `baseTeam`, `Box`, `HudDesign` (`design.ts`); `unionBox`, `CORNERS`, `ALL_HANDLES`, `Handle`, `Guide` (`guides.ts`); `screenW`, `SCREEN_H` (`units.ts`).
- Produces:
  - `type Selection = { kind: 'none' } | { kind: 'elements'; ids: string[] } | { kind: 'card'; card: number } | { kind: 'children'; names: string[]; card: number }`, `NONE`, `TEAMMATES` (`{ kind: 'elements', ids: ['teamColumn'] }`)
  - `interface Mods { shift: boolean; ctrl: boolean }`, `interface Hit { element: string | null; card: number | null; child: string | null }`
  - `hitAt(design, side, state, ux, uy): Hit`
  - `targetOf(design, hit, ctrl?): Selection` (the deepest level, or one up with Ctrl)
  - `pick(sel, target, shift): Selection` (Shift adds or removes at the same level, otherwise replaces)
  - `clickSelect(design, sel, hit, mods): Selection`
  - `isPicked(design, sel, hit): boolean`
  - `type Intent = { kind: 'box' } | { kind: 'move'; sel: Selection } | { kind: 'none' }`, `dragIntent(design, sel, hit, mods): Intent`
  - `drawnPieces(design, state): string[]` (registry order; drawn in the state, visible, not decoration)
  - `boxSelect(design, side, state, a: {x, y}, b: {x, y}): Selection`
  - `selectAll(design, side, state, sel): Selection`
  - `climb(design, sel): Selection`
  - `interface Crumb { label: string; sel: Selection }`, `breadcrumb(design, sel): Crumb[]`, `selectionLabel(design, sel): string`
  - `sanitize(design, side, sel): Selection` (returns `sel` itself, `===`, when nothing changed)
  - `selectionKey(sel): string`, `selectedIds(sel): string[]`
  - `selectionFrames(design, sel): Box[]`, `selectionBox(design, sel): Box | null`
  - `handlesFor(design, sel): Handle[]`, `handlePoint(box, h): { x: number; y: number }`, `handleAt(box, handles, ux, uy, slack): Handle | null`
  - `pieceTargets(design, state, moving: string[]): Box[]` (unfitted card frame), `sectionTargets(design, side, sel): Box[]` (screen units)
  - `pieceGuideToScreen(g: Guide, card: Box, f: CardFrame): Guide`
  - `type MenuAction = 'hide' | 'reset' | 'selectCard' | 'selectTeam'`, `menuActions(design, sel): MenuAction[]`

- [ ] **Step 1: Write the failing tests**

Create `web/src/hud/selection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { teamCardRects, cardFrame } from './build';
import { childRects, type CardState } from './render';
import { withTeamDir, patchChild } from './edit';
import {
  NONE, TEAMMATES, hitAt, targetOf, clickSelect, dragIntent, boxSelect, selectAll, climb, breadcrumb, selectionLabel,
  sanitize, selectedIds, selectionFrames, selectionBox, handlesFor, handlePoint, handleAt, pieceTargets, sectionTargets,
  pieceGuideToScreen, menuActions, drawnPieces, type Selection, type Mods,
} from './selection';

const D = DEFAULT_DESIGN;
const FREE = withTeamDir(DEFAULT_DESIGN, 'free');
const plain: Mods = { shift: false, ctrl: false };
const shift: Mods = { shift: true, ctrl: false };
const ctrl: Mods = { shift: false, ctrl: true };
// Card 2 of the fitted stock row is drawn at (153, 441), 121 x 36. Its
// portrait covers (153, 443) to (176, 466), its health bar (177, 457) to
// (273, 464); (273, 442) is on the card but on no piece (only the splatter).
const HEAD2 = { x: 164, y: 454 };
const HEALTH2 = { x: 200, y: 460 };
const EMPTY2 = { x: 273, y: 442 };
const click = (d: HudDesign, sel: Selection, p: { x: number; y: number }, mods = plain, state: CardState = 'healthy') =>
  clickSelect(d, sel, hitAt(d, 'survivor', state, p.x, p.y), mods);

describe('click', () => {
  it('picks the piece under the pointer in one click', () => {
    expect(click(D, NONE, HEAD2)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
  });

  it('picks what the preview state draws there', () => {
    expect(click(D, NONE, HEAD2, plain, 'down')).toEqual({ kind: 'children', names: ['Incapacitated'], card: 1 });
  });

  it('picks the element where no piece is, and nothing on empty screen', () => {
    expect(click(D, NONE, EMPTY2)).toEqual(TEAMMATES);
    expect(click(D, NONE, { x: 780, y: 430 })).toEqual({ kind: 'elements', ids: ['ownHealth'] });
    expect(click(D, TEAMMATES, { x: 426, y: 100 })).toEqual(NONE);
  });

  it('picks a Free card where no piece is', () => {
    expect(click(FREE, NONE, EMPTY2)).toEqual({ kind: 'card', card: 1 });
    expect(click(FREE, NONE, HEAD2)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
  });

  it('climbs one level with Ctrl', () => {
    expect(click(D, NONE, HEAD2, ctrl)).toEqual(TEAMMATES);
    expect(click(FREE, NONE, HEAD2, ctrl)).toEqual({ kind: 'card', card: 1 });
    expect(click(FREE, NONE, EMPTY2, ctrl)).toEqual(TEAMMATES);
  });

  it('adds and removes with Shift at the same level, and starts again at another', () => {
    const one = click(D, NONE, HEAD2);
    const two = click(D, one, HEALTH2, shift);
    expect(two).toEqual({ kind: 'children', names: ['Head', 'Health'], card: 1 });
    expect(click(D, two, HEAD2, shift)).toEqual({ kind: 'children', names: ['Health'], card: 1 });
    const el = click(D, two, { x: 780, y: 430 }, shift);
    expect(el).toEqual({ kind: 'elements', ids: ['ownHealth'] });
    const els = click(D, el, { x: 100, y: 300 }, shift);
    expect(els).toEqual({ kind: 'elements', ids: ['ownHealth', 'chat'] });
    expect(click(D, els, { x: 426, y: 100 }, shift)).toBe(els);                  // Shift on nothing keeps the selection
    expect(click(D, el, { x: 780, y: 430 }, shift)).toEqual(NONE);               // the last one taken away
  });
});

describe('drag', () => {
  it('moves the outermost section when the drag starts on something not selected', () => {
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(D, NONE, hit, plain)).toEqual({ kind: 'move', sel: TEAMMATES });
    const free = hitAt(FREE, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(FREE, NONE, free, plain)).toEqual({ kind: 'move', sel: { kind: 'card', card: 1 } });
    // The Free Teammates cannot move as one, so a drag on a card moves that card.
    expect(dragIntent(FREE, TEAMMATES, free, plain)).toEqual({ kind: 'move', sel: { kind: 'card', card: 1 } });
  });

  it('moves the selection when the drag starts on part of it, in any card', () => {
    const sel: Selection = { kind: 'children', names: ['Head', 'Health'], card: 0 };
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(D, sel, hit, plain)).toEqual({ kind: 'move', sel });
  });

  it('draws a box with Shift, and does nothing from empty screen', () => {
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(dragIntent(D, NONE, hit, shift)).toEqual({ kind: 'box' });
    expect(dragIntent(D, NONE, hitAt(D, 'survivor', 'healthy', 426, 100), plain)).toEqual({ kind: 'none' });
  });
});

describe('box and Ctrl+A', () => {
  it('picks the drawn pieces a box started inside a card touches', () => {
    expect(boxSelect(D, 'survivor', 'healthy', { x: 200, y: 456 }, { x: 240, y: 470 }))
      .toEqual({ kind: 'children', names: ['Health', 'Name'], card: 1 });
  });

  it('picks the elements a box started outside the cards touches, or nothing', () => {
    expect(boxSelect(D, 'survivor', 'healthy', { x: 5, y: 300 }, { x: 40, y: 420 }))
      .toEqual({ kind: 'elements', ids: ['teamColumn', 'chat'] });
    expect(boxSelect(D, 'survivor', 'healthy', { x: 400, y: 20 }, { x: 420, y: 40 })).toEqual(NONE);
  });

  it('selects every drawn piece of the card, or every visible element of the side', () => {
    const piece: Selection = { kind: 'children', names: ['Head'], card: 1 };
    expect(selectAll(D, 'survivor', 'healthy', piece)).toEqual({ kind: 'children', names: ['Head', 'Health', 'Name', 'Items', 'Status'], card: 1 });
    expect(selectAll(D, 'survivor', 'down', piece)).toEqual({ kind: 'children', names: ['Health', 'Name', 'Items', 'Status', 'Incapacitated'], card: 1 });
    expect(selectAll(D, 'survivor', 'healthy', NONE)).toEqual({ kind: 'elements',
      ids: ['ownHealth', 'teamColumn', 'weaponSelection', 'chat', 'targetId', 'progressBar', 'xhair'] });
  });

  it('never counts a hidden piece or decoration as drawn', () => {
    expect(drawnPieces(D, 'healthy')).toEqual(['Head', 'Health', 'Name', 'Items', 'Status']);
    expect(drawnPieces(patchChild(D, 'Name', { visible: false }), 'healthy')).toEqual(['Head', 'Health', 'Items', 'Status']);
  });
});

describe('levels', () => {
  it('climbs one level on Escape', () => {
    expect(climb(D, { kind: 'children', names: ['Head'], card: 1 })).toEqual(TEAMMATES);
    expect(climb(FREE, { kind: 'children', names: ['Head'], card: 1 })).toEqual({ kind: 'card', card: 1 });
    expect(climb(FREE, { kind: 'card', card: 1 })).toEqual(TEAMMATES);
    expect(climb(D, TEAMMATES)).toEqual(NONE);
  });

  it('names the path for the breadcrumb', () => {
    const labels = (d: HudDesign, s: Selection) => breadcrumb(d, s).map((c) => c.label);
    expect(labels(D, { kind: 'children', names: ['Health'], card: 1 })).toEqual(['Teammates', 'Health bar']);
    expect(labels(FREE, { kind: 'children', names: ['Health'], card: 1 })).toEqual(['Teammates', 'Card 2', 'Health bar']);
    expect(labels(D, { kind: 'children', names: ['Head', 'Health', 'Name'], card: 0 })).toEqual(['Teammates', '3 pieces']);
    expect(labels(FREE, { kind: 'card', card: 1 })).toEqual(['Teammates', 'Card 2']);
    expect(labels(D, { kind: 'elements', ids: ['chat', 'ownHealth'] })).toEqual(['2 elements']);
    expect(breadcrumb(FREE, { kind: 'children', names: ['Health'], card: 1 })[1].sel).toEqual({ kind: 'card', card: 1 });
    expect(selectionLabel(D, { kind: 'elements', ids: ['chat'] })).toBe('Chat');
  });

  it('keeps a selection that still applies and drops what does not', () => {
    const els: Selection = { kind: 'elements', ids: ['chat', 'ownHealth'] };
    expect(sanitize(D, 'survivor', els)).toBe(els);
    expect(sanitize(D, 'infected', els)).toEqual({ kind: 'elements', ids: ['chat'] });
    const added = patchChild(D, 'HealthNumber', { on: true });
    const kids: Selection = { kind: 'children', names: ['Head', 'HealthNumber'], card: 0 };
    expect(sanitize(added, 'survivor', kids)).toBe(kids);
    expect(sanitize(D, 'survivor', kids)).toEqual({ kind: 'children', names: ['Head'], card: 0 });
    expect(sanitize(D, 'survivor', { kind: 'children', names: ['HealthNumber'], card: 0 })).toEqual(TEAMMATES);
    expect(sanitize(D, 'survivor', { kind: 'card', card: 1 })).toEqual(TEAMMATES);
    expect(selectedIds({ kind: 'children', names: ['Head'], card: 0 })).toEqual(['teamColumn']);
  });
});

describe('what the canvas draws for a selection', () => {
  it('frames a piece in every drawn card, from the generated tree', () => {
    const frames = selectionFrames(D, { kind: 'children', names: ['Head'], card: 0 });
    const cards = teamCardRects(D, D.aspect).slice(0, 3);
    expect(frames).toEqual(cards.map((c) => {
      const r = childRects(D, 'teamColumn', { x: c.x, y: c.y }, 1).find((x) => x.name === 'Head')!;
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }));
  });

  it('frames the Free teammates as their three cards, not the screen', () => {
    expect(selectionFrames(FREE, TEAMMATES)).toEqual(teamCardRects(FREE, FREE.aspect).slice(0, 3));
  });

  it("boxes several pieces in the card they were picked in", () => {
    expect(selectionBox(D, { kind: 'children', names: ['Head', 'Health'], card: 1 })).toEqual({ x: 153, y: 443, w: 120, h: 23 });
    expect(selectionBox(D, NONE)).toBeNull();
  });

  it('offers the handles the spec table lists', () => {
    const el = (id: string) => handlesFor(D, { kind: 'elements', ids: [id] });
    expect(el('ownHealth')).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(el('chat')).toEqual(['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']);
    expect(el('targetId')).toEqual([]);
    expect(handlesFor(FREE, TEAMMATES)).toEqual([]);
    expect(handlesFor(FREE, { kind: 'card', card: 0 })).toEqual([]);
    const piece = (names: string[]) => handlesFor(D, { kind: 'children', names, card: 0 });
    expect(piece(['Health'])).toHaveLength(8);
    expect(piece(['Head'])).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(piece(['Items'])).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(piece(['Head', 'Health'])).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(handlesFor(D, { kind: 'elements', ids: ['chat', 'ownHealth'] })).toEqual([]);
  });

  it('places handles on the box and finds the nearest one under the pointer', () => {
    const box = { x: 0, y: 0, w: 100, h: 10 };
    expect(handlePoint(box, 'se')).toEqual({ x: 100, y: 10 });
    expect(handlePoint(box, 'n')).toEqual({ x: 50, y: 0 });
    const all = handlesFor(D, { kind: 'elements', ids: ['chat'] });
    expect(handleAt(box, all, 100, 5, 5)).toBe('e');
    expect(handleAt(box, all, 100, 1, 5)).toBe('ne');
    expect(handleAt(box, all, 50, 50, 5)).toBeNull();
  });
});

describe('snap targets', () => {
  it('snaps a piece to the unfitted card and the other drawn pieces', () => {
    expect(pieceTargets(D, 'healthy', ['Head'])).toEqual([
      { x: 0, y: 0, w: 150, h: 150 },
      { x: 37, y: 52, w: 96, h: 7 }, { x: 13, y: 60, w: 120, h: 12 },
      { x: 39, y: 36, w: 50, h: 14 }, { x: 64, y: 38, w: 70, h: 12 },
    ]);
  });

  it('snaps a section to the screen and the other visible elements of the side', () => {
    const got = sectionTargets(D, 'survivor', { kind: 'elements', ids: ['chat'] });
    expect(got[0]).toEqual({ x: 0, y: 0, w: 853, h: 480 });
    expect(got).toContainEqual({ x: 728, y: 389, w: 125, h: 91 });
    expect(got).not.toContainEqual({ x: 10, y: 275, w: 320, h: 120 });
    const cards = teamCardRects(FREE, FREE.aspect);
    const free = sectionTargets(FREE, 'survivor', { kind: 'card', card: 1 });
    expect(free).toContainEqual(cards[0]);
    expect(free).not.toContainEqual(cards[1]);
  });

  it("draws a piece's guide where the piece is drawn", () => {
    const card = teamCardRects(D, D.aspect)[1];
    expect(pieceGuideToScreen({ axis: 'x', at: 37, from: 36, to: 72 }, card, cardFrame(D)))
      .toEqual({ axis: 'x', at: 177, from: 441, to: 477 });
  });
});

describe('the right-click menu', () => {
  it('offers what applies to the selection', () => {
    expect(menuActions(D, { kind: 'elements', ids: ['chat'] })).toEqual(['hide', 'reset']);
    expect(menuActions(D, { kind: 'children', names: ['Head'], card: 0 })).toEqual(['hide', 'reset', 'selectTeam']);
    expect(menuActions(FREE, { kind: 'children', names: ['Head'], card: 0 })).toEqual(['hide', 'reset', 'selectCard', 'selectTeam']);
    expect(menuActions(FREE, { kind: 'card', card: 0 })).toEqual(['selectTeam']);
    expect(menuActions(D, NONE)).toEqual([]);
  });
});

describe('targetOf', () => {
  it('is what a hover outlines: the deepest thing, or one up with Ctrl', () => {
    const hit = hitAt(D, 'survivor', 'healthy', HEAD2.x, HEAD2.y);
    expect(targetOf(D, hit)).toEqual({ kind: 'children', names: ['Head'], card: 1 });
    expect(targetOf(D, hit, true)).toEqual(TEAMMATES);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/selection.test.ts`
Expected: FAIL, `Failed to resolve import "./selection"`.

- [ ] **Step 3: Implement**

Create `web/src/hud/selection.ts`:

```ts
/**
 * What a pointer gesture on the canvas means, and what a selection covers,
 * as pure functions of the design, so the page holds no hit logic of its
 * own. Everything measured here comes from the generator's trees
 * (elementRect, teamCardRects, childRects, cardChild), as Phase 1 requires:
 * a hit, a frame, a handle or a snap target is wherever the file puts it.
 *
 * A selection is one of four levels: nothing, one or more elements of the
 * current side, one Free teammate card, or pieces of the teammate card.
 * Pieces live in the one teammate card file, so picking a piece in any card
 * picks it in all of them; `card` only says which card it was picked in, for
 * the breadcrumb and the handles.
 */
import { baseTeam, type Box, type HudDesign } from './design';
import { elementById } from './elements';
import { cardChild, elementRect, isFreeTeam, teamCardRects, type CardFrame } from './build';
import { childRects, hiddenInState, type CardState } from './render';
import { childAt, hitTest, visibleElements, type Side } from './mock';
import { TEAM_PANEL, teamChild } from './children';
import { screenW, SCREEN_H } from './units';
import { ALL_HANDLES, CORNERS, unionBox, type Guide, type Handle } from './guides';

export type Selection =
  | { kind: 'none' }
  | { kind: 'elements'; ids: string[] }
  | { kind: 'card'; card: number }
  | { kind: 'children'; names: string[]; card: number };

export const NONE: Selection = { kind: 'none' };
export const TEAMMATES: Selection = { kind: 'elements', ids: ['teamColumn'] };

export interface Mods { shift: boolean; ctrl: boolean }
/** Everything under a point, one field per level: the element, the teammate card (in any layout), the piece. */
export interface Hit { element: string | null; card: number | null; child: string | null }

/** Card 4 shows only while spectating a full team: never drawn, never a target. */
const TEAM_CARDS = 3;
const inside = (r: Box, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const touches = (a: Box, b: Box) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
const plain = ({ x, y, w, h }: Box): Box => ({ x, y, w, h });
const drawnCards = (design: HudDesign): Box[] => teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).map(plain);

export function hitAt(design: HudDesign, side: Side, state: CardState, ux: number, uy: number): Hit {
  const element = hitTest(design, side, ux, uy);
  if (element !== 'teamColumn') return { element, card: null, child: null };
  const piece = childAt(design, state, ux, uy);
  const card = piece ? piece.card : drawnCards(design).findIndex((c) => inside(c, ux, uy));
  return { element, card: card >= 0 ? card : null, child: piece ? piece.name : null };
}

/**
 * The thing a click picks: the deepest level under the pointer (a drawn
 * piece, else a Free card, else the element), or with Ctrl one level up.
 * It is also what a hover outlines.
 */
export function targetOf(design: HudDesign, hit: Hit, ctrl = false): Selection {
  if (!hit.element) return NONE;
  const levels: Selection[] = [];
  if (hit.child) levels.push({ kind: 'children', names: [hit.child], card: hit.card ?? 0 });
  if (hit.element === 'teamColumn' && isFreeTeam(design) && hit.card !== null) levels.push({ kind: 'card', card: hit.card });
  levels.push({ kind: 'elements', ids: [hit.element] });
  return ctrl && levels.length > 1 ? levels[1] : levels[0];
}

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * Combine a newly picked target with the selection, as the canvas and the
 * Layers list both do. Without Shift the target replaces it. With Shift, an
 * element toggles among elements and a piece among pieces; at another level
 * (or a card, which is picked alone) the target starts a new selection, and
 * Shift on nothing keeps what there is.
 */
export function pick(sel: Selection, target: Selection, shift: boolean): Selection {
  if (!shift) return target;
  if (target.kind === 'none') return sel;
  if (sel.kind === 'elements' && target.kind === 'elements') {
    const ids = toggle(sel.ids, target.ids[0]);
    return ids.length ? { kind: 'elements', ids } : NONE;
  }
  if (sel.kind === 'children' && target.kind === 'children') {
    const names = toggle(sel.names, target.names[0]);
    return names.length ? { kind: 'children', names, card: sel.card } : NONE;
  }
  return target;
}

export function clickSelect(design: HudDesign, sel: Selection, hit: Hit, mods: Mods): Selection {
  return pick(sel, targetOf(design, hit, mods.ctrl), mods.shift);
}

/**
 * Whether a press lands on something already selected, so a drag from it
 * moves the selection. A picked piece counts in every card. The Free
 * Teammates never count: their container is the screen and cannot move, so
 * a drag on one of their cards moves that card instead.
 */
export function isPicked(design: HudDesign, sel: Selection, hit: Hit): boolean {
  switch (sel.kind) {
    case 'elements':
      return hit.element !== null && sel.ids.includes(hit.element) && !(hit.element === 'teamColumn' && isFreeTeam(design));
    case 'card': return isFreeTeam(design) && hit.card === sel.card;
    case 'children': return hit.child !== null && sel.names.includes(hit.child);
    default: return false;
  }
}

export type Intent = { kind: 'box' } | { kind: 'move'; sel: Selection } | { kind: 'none' };

/**
 * What a drag means once the pointer has moved past a click. Shift draws a
 * box. A drag on part of the selection moves the selection; anywhere else it
 * moves the outermost section under the pointer (the element, or in Free the
 * card) and selects it, so no key is needed to move a section.
 */
export function dragIntent(design: HudDesign, sel: Selection, hit: Hit, mods: Mods): Intent {
  if (mods.shift) return { kind: 'box' };
  if (isPicked(design, sel, hit)) return { kind: 'move', sel };
  if (!hit.element) return { kind: 'none' };
  if (hit.element === 'teamColumn' && isFreeTeam(design)) {
    return hit.card === null ? { kind: 'none' } : { kind: 'move', sel: { kind: 'card', card: hit.card } };
  }
  return { kind: 'move', sel: { kind: 'elements', ids: [hit.element] } };
}

/**
 * The teammate-card pieces the preview draws in `state`, in registry order:
 * the file has them, they are visible, the state shows them, and they are
 * not decoration (the splatter and the card background are never targets).
 */
export function drawnPieces(design: HudDesign, state: CardState): string[] {
  return TEAM_PANEL.children.filter((def) => {
    const info = cardChild(design, def.name);
    return def.role !== 'decor' && !!info && info.visible && !hiddenInState('teamColumn', def.name, state);
  }).map((def) => def.name);
}

/** The drawn pieces of one card with their rects, in registry order. */
function piecesIn(design: HudDesign, state: CardState, card: Box): (Box & { name: string })[] {
  const rects = childRects(design, 'teamColumn', { x: card.x, y: card.y }, 1);
  return drawnPieces(design, state).flatMap((name) => {
    const r = rects.find((x) => x.name === name);
    return r ? [{ name, ...plain(r) }] : [];
  });
}

/** An element's targets on screen: the Free teammates are their three cards, anything else its own rect. */
function sectionRects(design: HudDesign, id: string): Box[] {
  return id === 'teamColumn' && isFreeTeam(design) ? drawnCards(design) : [plain(elementRect(design, id, design.aspect))];
}

/**
 * A Shift+drag box from `a` to `b`. Started inside a drawn teammate card it
 * picks every drawn piece of that card it touches; otherwise every visible
 * element of the side it touches. It replaces the selection.
 */
export function boxSelect(design: HudDesign, side: Side, state: CardState, a: { x: number; y: number }, b: { x: number; y: number }): Selection {
  const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  if (side === 'survivor' && elementRect(design, 'teamColumn', design.aspect).visible) {
    const cards = drawnCards(design);
    const card = cards.findIndex((c) => inside(c, a.x, a.y));
    if (card >= 0) {
      const names = piecesIn(design, state, cards[card]).filter((r) => touches(r, box)).map((r) => r.name);
      return names.length ? { kind: 'children', names, card } : NONE;
    }
  }
  const ids = visibleElements(side)
    .filter((el) => elementRect(design, el.id, design.aspect).visible && sectionRects(design, el.id).some((r) => touches(r, box)))
    .map((el) => el.id);
  return ids.length ? { kind: 'elements', ids } : NONE;
}

/** Ctrl+A: with pieces picked, every drawn piece of that card; otherwise every visible element of the side. */
export function selectAll(design: HudDesign, side: Side, state: CardState, sel: Selection): Selection {
  if (sel.kind === 'children') {
    const names = drawnPieces(design, state);
    return names.length ? { kind: 'children', names, card: sel.card } : sel;
  }
  const ids = visibleElements(side).filter((el) => elementRect(design, el.id, design.aspect).visible).map((el) => el.id);
  return ids.length ? { kind: 'elements', ids } : NONE;
}

/** Escape: pieces climb to their card (Free) or the Teammates, a card to the Teammates, anything else to nothing. */
export function climb(design: HudDesign, sel: Selection): Selection {
  if (sel.kind === 'children') return isFreeTeam(design) ? { kind: 'card', card: sel.card } : TEAMMATES;
  if (sel.kind === 'card') return TEAMMATES;
  return NONE;
}

export interface Crumb { label: string; sel: Selection }

/** The path shown at the canvas corner: each segment selects its level. */
export function breadcrumb(design: HudDesign, sel: Selection): Crumb[] {
  const team: Crumb = { label: elementById('teamColumn')!.label, sel: TEAMMATES };
  switch (sel.kind) {
    case 'none': return [];
    case 'elements':
      return [{ label: sel.ids.length === 1 ? elementById(sel.ids[0])!.label : `${sel.ids.length} elements`, sel }];
    case 'card': return [team, { label: `Card ${sel.card + 1}`, sel }];
    case 'children': {
      const leaf: Crumb = { label: sel.names.length === 1 ? teamChild(sel.names[0])!.label : `${sel.names.length} pieces`, sel };
      return isFreeTeam(design) ? [team, { label: `Card ${sel.card + 1}`, sel: { kind: 'card', card: sel.card } }, leaf] : [team, leaf];
    }
  }
}

/** What a selection is called: the breadcrumb's last label, as the hover label shows it. */
export function selectionLabel(design: HudDesign, sel: Selection): string {
  const crumbs = breadcrumb(design, sel);
  return crumbs.length ? crumbs[crumbs.length - 1].label : '';
}

/**
 * The selection after the design or the side changed (an undo, an import,
 * a preset, the health number removed): kept when it still names something
 * that exists, trimmed when part of it went, and when every picked piece
 * went, the Teammates, as Phase 1 stepped back to them. Returns `sel` itself
 * when nothing changed, so the page's state update is a no-op.
 */
export function sanitize(design: HudDesign, side: Side, sel: Selection): Selection {
  const onSide = (id: string) => visibleElements(side).some((e) => e.id === id);
  switch (sel.kind) {
    case 'none': return sel;
    case 'elements': {
      const ids = sel.ids.filter(onSide);
      return ids.length === sel.ids.length ? sel : ids.length ? { kind: 'elements', ids } : NONE;
    }
    case 'card':
      if (side !== 'survivor') return NONE;
      return isFreeTeam(design) ? sel : TEAMMATES;
    case 'children': {
      if (side !== 'survivor') return NONE;
      const names = sel.names.filter((n) => cardChild(design, n) !== null);
      return names.length === sel.names.length ? sel : names.length ? { ...sel, names } : TEAMMATES;
    }
  }
}

/** Identifies a selection for nudge coalescing: the same key is the same selection. */
export function selectionKey(sel: Selection): string {
  return JSON.stringify(sel);
}

/** The element ids a selection touches: a card or pieces belong to the Teammates. */
export function selectedIds(sel: Selection): string[] {
  if (sel.kind === 'elements') return sel.ids;
  return sel.kind === 'none' ? [] : ['teamColumn'];
}

/** One outline per selected thing as drawn: an element's rect, the Free Teammates' cards, a card, a piece in every card. */
export function selectionFrames(design: HudDesign, sel: Selection): Box[] {
  switch (sel.kind) {
    case 'none': return [];
    case 'elements': return sel.ids.flatMap((id) => sectionRects(design, id));
    case 'card': return [plain(teamCardRects(design, design.aspect)[sel.card])];
    case 'children':
      return drawnCards(design).flatMap((c) => childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1)
        .filter((r) => sel.names.includes(r.name)).map(plain));
  }
}

/** The box the handles sit on: for pieces, around them in the card they were picked in. */
export function selectionBox(design: HudDesign, sel: Selection): Box | null {
  if (sel.kind === 'children') {
    const c = teamCardRects(design, design.aspect)[sel.card];
    return unionBox(childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1).filter((r) => sel.names.includes(r.name)).map(plain));
  }
  return unionBox(selectionFrames(design, sel));
}

/**
 * The handles the spec's table gives a selection. Elements: eight for a
 * free-size element, four corners for a scaled one, none otherwise, and
 * none for the Free Teammates (their box is the screen). A card: none (the
 * cards share one size). One piece: eight for width and height, four
 * corners for square art or the item icons. Several pieces: four corners.
 * Several elements: none.
 */
export function handlesFor(design: HudDesign, sel: Selection): Handle[] {
  if (sel.kind === 'elements') {
    if (sel.ids.length !== 1) return [];
    const id = sel.ids[0];
    const el = elementById(id);
    if (!el || (id === 'teamColumn' && isFreeTeam(design))) return [];
    return el.resize === 'free' ? ALL_HANDLES : el.resize === 'scale' ? CORNERS : [];
  }
  if (sel.kind === 'children') {
    if (sel.names.length > 1) return CORNERS;
    const def = teamChild(sel.names[0]);
    if (!def) return [];
    if (def.box === 'wh') return ALL_HANDLES;
    return def.box === 'square' || def.font ? CORNERS : [];
  }
  return [];
}

export function handlePoint(box: Box, h: Handle): { x: number; y: number } {
  const x = h.includes('w') ? box.x : h.includes('e') ? box.x + box.w : box.x + box.w / 2;
  const y = h.includes('n') ? box.y : h.includes('s') ? box.y + box.h : box.y + box.h / 2;
  return { x, y };
}

/** The nearest handle within `slack` HUD units of the point, so a thin box's side handle is reachable between its corners. */
export function handleAt(box: Box, handles: Handle[], ux: number, uy: number, slack: number): Handle | null {
  let best: { h: Handle; d: number } | null = null;
  for (const h of handles) {
    const p = handlePoint(box, h);
    const d = Math.max(Math.abs(ux - p.x), Math.abs(uy - p.y));
    if (d <= slack && (!best || d < best.d)) best = { h, d };
  }
  return best ? best.h : null;
}

/**
 * What moving pieces snap to, in the card file's unfitted frame (the frame
 * a ChildOverride is stored in): the unfitted card, which is what the
 * Phase 1 drag clamps to, and the other drawn pieces.
 */
export function pieceTargets(design: HudDesign, state: CardState, moving: string[]): Box[] {
  const p = baseTeam(design.preset).card;
  const out: Box[] = [{ x: 0, y: 0, w: p.w, h: p.h }];
  for (const name of drawnPieces(design, state)) {
    if (moving.includes(name)) continue;
    const c = cardChild(design, name);
    if (c) out.push({ x: c.x, y: c.y, w: c.w, h: c.h });
  }
  return out;
}

/** What a moving element or Free card snaps to, in screen units: the screen, and every other visible thing of the side. */
export function sectionTargets(design: HudDesign, side: Side, sel: Selection): Box[] {
  const out: Box[] = [{ x: 0, y: 0, w: screenW(design.aspect), h: SCREEN_H }];
  for (const el of visibleElements(side)) {
    if (sel.kind === 'elements' && sel.ids.includes(el.id)) continue;
    if (!elementRect(design, el.id, design.aspect).visible) continue;
    const rects = sectionRects(design, el.id);
    out.push(...(el.id === 'teamColumn' && sel.kind === 'card' ? rects.filter((_, i) => i !== sel.card) : rects));
  }
  return out;
}

/** A piece's guide, found in the unfitted frame, drawn where the piece is drawn in `card`. */
export function pieceGuideToScreen(g: Guide, card: Box, f: CardFrame): Guide {
  const X = (v: number) => card.x + (v - f.shift.x) * f.k;
  const Y = (v: number) => card.y + (v - f.shift.y) * f.k;
  return g.axis === 'x' ? { axis: 'x', at: X(g.at), from: Y(g.from), to: Y(g.to) } : { axis: 'y', at: Y(g.at), from: X(g.from), to: X(g.to) };
}

export type MenuAction = 'hide' | 'reset' | 'selectCard' | 'selectTeam';

/** The right-click menu for a selection. A card cannot be hidden alone, and has no reset of its own. */
export function menuActions(design: HudDesign, sel: Selection): MenuAction[] {
  switch (sel.kind) {
    case 'elements': return ['hide', 'reset'];
    case 'card': return ['selectTeam'];
    case 'children': return isFreeTeam(design) ? ['hide', 'reset', 'selectCard', 'selectTeam'] : ['hide', 'reset', 'selectTeam'];
    default: return [];
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud/selection.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/selection.ts web/src/hud/selection.test.ts
git commit -m "Add the HUD editor's selection model: click, Ctrl and Shift, drag intent, box, Ctrl+A, Escape, breadcrumb, frames, handles, snap targets"
```

---

### Task 6: Group edits for teammate-card pieces

**Files:**
- Modify: `web/src/hud/edit.ts`
- Test: `web/src/hud/edit.test.ts`

**Interfaces:**
- Consumes: `cardChild`, `CardChild` (`build.ts`); `baseTeam`, `clampChild`, `Box` (`design.ts`); `teamChild` (`children.ts`); `unionBox`, `Handle` (`guides.ts`); `placeChild`, `patchChild`, `resetChild` (this file).
- Produces:
  - `startsOf(design: HudDesign, names: string[]): Record<string, CardChild>` (where each piece is now, unfitted frame)
  - `moveChildren(design, names, starts: Record<string, CardChild>, dx: number, dy: number): HudDesign` (unscaled units; one clamp for the group so spacing holds)
  - `placeChildren(design, names, x: number, y: number): HudDesign` (the group box's top-left to (x, y))
  - `cornerFactor(start: Box, handle: Handle, dx: number, dy: number): number` (at least 0.05)
  - `anchorOf(box: Box, handle: Handle): { x: number; y: number }` (the corner opposite the handle)
  - `scaleChildren(design, names, starts: Record<string, CardChild>, anchor: { x: number; y: number }, f: number): HudDesign`
  - `type Align = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom'`, `alignedAt(r: Box, box: Box, how: Align): { x: number; y: number }`
  - `alignChildren(design, names, how: Align): HudDesign`
  - `setChildrenVisible(design, names, visible: boolean): HudDesign`
  - `resetChildren(design, names): HudDesign`

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/edit.test.ts`, extend the `./edit` import with `startsOf, moveChildren, placeChildren, scaleChildren, cornerFactor, anchorOf, alignChildren, setChildrenVisible, resetChildren`, add `import { cardChild } from './build';` (merged into the existing `./build` import), and append:

```ts
describe('moving several pieces', () => {
  // Stock, fitted: Head (13, 38, 23 x 23), Health (37, 52, 96 x 7), in the unfitted 150 x 150 card.
  const both = ['Head', 'Health'];

  it('moves every piece by the same amount', () => {
    const d = moveChildren(DEFAULT_DESIGN, both, startsOf(DEFAULT_DESIGN, both), 5, -2);
    expect(d.children.teamColumn).toEqual({ Head: { x: 18, y: 36 }, Health: { x: 42, y: 50 } });
  });

  it('clamps the group as one, so the pieces keep their spacing at the card edge', () => {
    const s = startsOf(DEFAULT_DESIGN, both);
    expect(moveChildren(DEFAULT_DESIGN, both, s, -100, -100).children.teamColumn).toEqual({ Head: { x: 0, y: 0 }, Health: { x: 24, y: 14 } });
    // The health bar reaches the right edge first: 150 - 96 - 37 = 17 is all the room there is.
    expect(moveChildren(DEFAULT_DESIGN, both, s, 100, 0).children.teamColumn).toEqual({ Head: { x: 30, y: 38 }, Health: { x: 54, y: 52 } });
  });

  it('places the group by its box', () => {
    const d = placeChildren(DEFAULT_DESIGN, both, 20, 40);
    expect(d.children.teamColumn).toEqual({ Head: { x: 20, y: 40 }, Health: { x: 44, y: 54 } });
  });

  it('never moves a piece that cannot move', () => {
    const d = moveChildren(DEFAULT_DESIGN, ['BackgroundImage'], startsOf(DEFAULT_DESIGN, ['BackgroundImage']), 5, 5);
    expect(d).toBe(DEFAULT_DESIGN);
  });
});

describe('scaling several pieces', () => {
  const names = ['Head', 'Health', 'Name'];

  it('scales positions and sizes about the anchor, square stays square, fonts scale', () => {
    const d = scaleChildren(DEFAULT_DESIGN, names, startsOf(DEFAULT_DESIGN, names), { x: 13, y: 38 }, 0.5);
    expect(d.children.teamColumn).toEqual({
      Head: { w: 12, h: 12, x: 13, y: 38 },
      Health: { w: 48, h: 4, x: 25, y: 45 },
      Name: { w: 60, h: 6, fontSize: 6, x: 13, y: 49 },
    });
  });

  it('scales the item icons by their size', () => {
    const d = scaleChildren(DEFAULT_DESIGN, ['Items'], startsOf(DEFAULT_DESIGN, ['Items']), { x: 39, y: 36 }, 1.5);
    expect(d.children.teamColumn!.Items).toEqual({ fontSize: 27, x: 39, y: 36 });
  });

  it('keeps every piece inside the unfitted card however far it scales', () => {
    const d = scaleChildren(DEFAULT_DESIGN, ['Head', 'Health'], startsOf(DEFAULT_DESIGN, ['Head', 'Health']), { x: 13, y: 38 }, 2);
    for (const n of ['Head', 'Health']) {
      const c = cardChild(d, n)!;
      expect(c.x, n).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w, n).toBeLessThanOrEqual(150);
      expect(c.y + c.h, n).toBeLessThanOrEqual(150);
    }
    expect(d.children.teamColumn!.Head).toMatchObject({ w: 46, h: 46 });
    expect(d.children.teamColumn!.Health).toEqual({ w: 150, h: 14, x: 0, y: 66 });
  });

  it('turns a corner drag into one factor, the larger change winning', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(cornerFactor(box, 'se', 50, 0)).toBe(1.5);
    expect(cornerFactor(box, 'nw', -50, 0)).toBe(1.5);
    expect(cornerFactor(box, 'se', 10, 20)).toBe(1.4);
    expect(cornerFactor(box, 'se', -1000, 0)).toBe(0.05);
    expect(anchorOf(box, 'se')).toEqual({ x: 0, y: 0 });
    expect(anchorOf(box, 'nw')).toEqual({ x: 100, y: 50 });
  });
});

describe('aligning several pieces', () => {
  // Head spans x 13..36, y 38..61; Status x 64..134, y 38..50. Their box: x 13..134, y 38..61.
  const two = ['Head', 'Status'];
  const at = (how: Parameters<typeof alignChildren>[2]) => alignChildren(DEFAULT_DESIGN, two, how).children.teamColumn;

  it('aligns six ways against the group box', () => {
    expect(at('left')).toEqual({ Head: { x: 13, y: 38 }, Status: { x: 13, y: 38 } });
    expect(at('right')).toEqual({ Head: { x: 111, y: 38 }, Status: { x: 64, y: 38 } });
    expect(at('centre')).toEqual({ Head: { x: 62, y: 38 }, Status: { x: 39, y: 38 } });
    expect(at('top')).toEqual({ Head: { x: 13, y: 38 }, Status: { x: 64, y: 38 } });
    expect(at('middle')).toEqual({ Head: { x: 13, y: 38 }, Status: { x: 64, y: 44 } });
    expect(at('bottom')).toEqual({ Head: { x: 13, y: 38 }, Status: { x: 64, y: 49 } });
  });
});

describe('visibility and reset for several pieces', () => {
  it('hides and shows them all, and resets them all', () => {
    const hidden = setChildrenVisible(DEFAULT_DESIGN, ['Head', 'Name'], false);
    expect(hidden.children.teamColumn).toEqual({ Head: { visible: false }, Name: { visible: false } });
    expect(resetChildren(hidden, ['Head', 'Name']).children.teamColumn).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/edit.test.ts`
Expected: FAIL, `startsOf` (and the rest) is not exported by `./edit`.

- [ ] **Step 3: Implement**

In `web/src/hud/edit.ts`, change the imports to:

```ts
import {
  clampOverride, clampChild, baseTeam, DEFAULT_DESIGN,
  type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type Box,
} from './design';
import { screenW, SCREEN_H } from './units';
import { elementById } from './elements';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, cardChild, type CardChild } from './build';
import { teamChild } from './children';
import { unionBox, type Handle } from './guides';
```

and append:

```ts
// --- several pieces of the teammate card at once ---

/** Where each named piece is now, in the unfitted frame: what a gesture starts from. Pieces the file lacks are left out. */
export function startsOf(design: HudDesign, names: string[]): Record<string, CardChild> {
  const out: Record<string, CardChild> = {};
  for (const n of names) {
    const c = cardChild(design, n);
    if (c) out[n] = c;
  }
  return out;
}

/**
 * Move pieces by (dx, dy) from where a gesture started them, unscaled units.
 * The delta is clamped once for the whole group, against the unfitted card
 * (the Phase 1 drag clamp), so the pieces keep their spacing when the group
 * meets an edge instead of piling up against it one by one. Pieces that
 * cannot move (the splatter) are skipped.
 */
export function moveChildren(
  design: HudDesign, names: string[], starts: Record<string, CardChild>, dx: number, dy: number,
): HudDesign {
  const p = baseTeam(design.preset).card;
  const list = names.filter((n) => teamChild(n)?.move && starts[n]);
  if (!list.length) return design;
  const cx = Math.min(Math.min(...list.map((n) => p.w - starts[n].w - starts[n].x)), Math.max(Math.max(...list.map((n) => -starts[n].x)), dx));
  const cy = Math.min(Math.min(...list.map((n) => p.h - starts[n].h - starts[n].y)), Math.max(Math.max(...list.map((n) => -starts[n].y)), dy));
  let d = design;
  for (const n of list) d = placeChild(d, n, starts[n].x + cx, starts[n].y + cy);
  return d;
}

/** The group X and Y boxes: put the pieces' box at (x, y), moving all of them. */
export function placeChildren(design: HudDesign, names: string[], x: number, y: number): HudDesign {
  const starts = startsOf(design, names);
  const box = unionBox(Object.values(starts));
  return box ? moveChildren(design, names, starts, x - box.x, y - box.y) : design;
}

/**
 * One proportional factor from a corner drag: the box's new width or height
 * over its old, whichever changed more, never below 0.05 so a drag past the
 * opposite corner cannot flip or vanish the selection.
 */
export function cornerFactor(start: Box, handle: Handle, dx: number, dy: number): number {
  const sx = handle.includes('w') ? -dx : dx;
  const sy = handle.includes('n') ? -dy : dy;
  const fx = (start.w + sx) / (start.w || 1);
  const fy = (start.h + sy) / (start.h || 1);
  return Math.max(0.05, Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy);
}

/** The point that stays put while a handle drags: the corner (or side) opposite it. */
export function anchorOf(box: Box, handle: Handle): { x: number; y: number } {
  return { x: handle.includes('w') ? box.x + box.w : box.x, y: handle.includes('n') ? box.y + box.h : box.y };
}

/**
 * Scale pieces by `f` about `anchor`, from where the gesture started them:
 * positions and sizes both, so the group grows or shrinks as one. Square art
 * stays square; a label scales its text size with its box, and the item
 * icons (no box of their own) scale their icon size. Each size is capped to
 * the unfitted card first and each position then clamped inside it, as
 * placeChild does, so any factor leaves a valid design.
 */
export function scaleChildren(
  design: HudDesign, names: string[], starts: Record<string, CardChild>, anchor: { x: number; y: number }, f: number,
): HudDesign {
  const p = baseTeam(design.preset).card;
  let d = design;
  for (const n of names) {
    const def = teamChild(n);
    const s = starts[n];
    if (!def || !s) continue;
    const patch: Partial<ChildOverride> = {};
    let w = s.w, h = s.h;
    if (def.box === 'square') {
      w = h = Math.min(p.w, p.h, Math.max(1, Math.round(s.w * f)));
    } else if (def.box === 'wh') {
      w = Math.min(p.w, Math.max(1, Math.round(s.w * f)));
      h = Math.min(p.h, Math.max(1, Math.round(s.h * f)));
    }
    if (def.box !== 'none') { patch.w = clampChild('w', w); patch.h = clampChild('h', h); }
    if (def.font && s.fontTall !== undefined) patch.fontSize = clampChild('fontSize', Math.round(s.fontTall * f));
    if (def.move) {
      const x = anchor.x + (s.x - anchor.x) * f, y = anchor.y + (s.y - anchor.y) * f;
      patch.x = clampChild('x', Math.round(Math.min(Math.max(0, p.w - w), Math.max(0, x))));
      patch.y = clampChild('y', Math.round(Math.min(Math.max(0, p.h - h), Math.max(0, y))));
    }
    d = patchChild(d, n, patch);
  }
  return d;
}

export type Align = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/** Where `r` goes to line up with `box` one way; the other axis stays. */
export function alignedAt(r: Box, box: Box, how: Align): { x: number; y: number } {
  switch (how) {
    case 'left': return { x: box.x, y: r.y };
    case 'centre': return { x: box.x + box.w / 2 - r.w / 2, y: r.y };
    case 'right': return { x: box.x + box.w - r.w, y: r.y };
    case 'top': return { x: r.x, y: box.y };
    case 'middle': return { x: r.x, y: box.y + box.h / 2 - r.h / 2 };
    case 'bottom': return { x: r.x, y: box.y + box.h - r.h };
  }
}

/** Align pieces against the box around them, through placeChild's clamp. */
export function alignChildren(design: HudDesign, names: string[], how: Align): HudDesign {
  const starts = startsOf(design, names);
  const box = unionBox(Object.values(starts));
  if (!box) return design;
  let d = design;
  for (const [n, s] of Object.entries(starts)) {
    if (!teamChild(n)?.move) continue;
    const at = alignedAt(s, box, how);
    d = placeChild(d, n, at.x, at.y);
  }
  return d;
}

export function setChildrenVisible(design: HudDesign, names: string[], visible: boolean): HudDesign {
  return names.reduce((d, n) => patchChild(d, n, { visible }), design);
}

export function resetChildren(design: HudDesign, names: string[]): HudDesign {
  return names.reduce((d, n) => resetChild(d, n), design);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud/edit.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/edit.ts web/src/hud/edit.test.ts
git commit -m "Move, scale, align, hide and reset several teammate-card pieces together, clamped inside the card"
```

---

### Task 7: Element edits, handle resizes, nudge, hide and reset for any selection

**Files:**
- Modify: `web/src/hud/edit.ts`
- Test: `web/src/hud/edit.test.ts`

**Interfaces:**
- Consumes: `Selection` (`selection.ts`, type only); `Handle`, `CORNERS`, `unionBox` (`guides.ts`); `elementRect`, `teamCardRects`, `isFreeTeam`, `CardChild` (`build.ts`); `clampOverride`, `clampChild`, `baseTeam` (`design.ts`); Task 6's `cornerFactor`, `anchorOf`, `alignedAt`, `moveChildren`, `startsOf`, `setChildrenVisible`, `resetChildren`.
- Produces:
  - `placeElement(design, id, x, y): HudDesign` (rounded, `clampSpan` 8-unit floor, `clampOverride`; unchanged `===` for an element that cannot move or the Free Teammates)
  - `moveElements(design, ids, starts: Record<string, Box>, dx, dy): HudDesign`
  - `moveCard(design, card, start: Box, dx, dy): HudDesign`
  - `alignElements(design, ids, how: Align): HudDesign`
  - `scaleElement(design, id, start: { rect: Box; scale: number }, handle: Handle, dx, dy): HudDesign`
  - `resizeBox(start: Box, handle: Handle, dx, dy, keepRatio: boolean, min: number): Box`
  - `resizeElement(design, id, start: Box, handle: Handle, dx, dy, keepRatio?: boolean): HudDesign`
  - `resizeChild(design, name, start: CardChild, handle: Handle, dx, dy, keepRatio?: boolean): HudDesign` (replaces the Phase 1 `resizeChild(design, name, start, dw, dh)`, which was the `se` handle only)
  - `nudgeSelection(design, sel: Selection, dx, dy): HudDesign`
  - `setSelectionVisible(design, sel, visible): HudDesign`, `hideSelection(design, sel): HudDesign`, `resetSelection(design, sel): HudDesign`

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/edit.test.ts`, extend the `./edit` import with `placeElement, moveElements, moveCard, alignElements, scaleElement, resizeBox, resizeElement, nudgeSelection, hideSelection, setSelectionVisible, resetSelection`. Replace the Phase 1 test `resizes square art keeping it square, and anything else freely, inside the card` (in `describe('moving a teammate card child', ...)`) with:

```ts
  it('resizes square art keeping it square, and anything else freely, inside the card', () => {
    const head = { x: 13, y: 38, w: 23, h: 23, visible: true };
    const health = { x: 37, y: 52, w: 96, h: 7, visible: true };
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'se', 5, 2).children.teamColumn!.Head).toEqual({ w: 28, h: 28 });
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'se', 500, 0).children.teamColumn!.Head).toEqual({ w: 112, h: 112 });
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'se', -48, 0).children.teamColumn!.Health).toEqual({ w: 48, h: 7 });
  });

  it('resizes from any handle, the opposite edge staying put', () => {
    const head = { x: 13, y: 38, w: 23, h: 23, visible: true };
    const health = { x: 37, y: 52, w: 96, h: 7, visible: true };
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'w', -10, 0).children.teamColumn!.Health).toEqual({ w: 106, h: 7, x: 27 });
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'n', 0, -3).children.teamColumn!.Health).toEqual({ w: 96, h: 10, y: 49 });
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'nw', -5, -2).children.teamColumn!.Head).toEqual({ w: 28, h: 28, x: 8, y: 33 });
    // A square piece has no side handles.
    expect(resizeChild(DEFAULT_DESIGN, 'Head', head, 'e', 5, 0)).toBe(DEFAULT_DESIGN);
  });

  it('keeps the ratio on a side handle with Shift', () => {
    const health = { x: 37, y: 52, w: 96, h: 7, visible: true };
    expect(resizeChild(DEFAULT_DESIGN, 'Health', health, 'e', 10, 0, true).children.teamColumn!.Health).toEqual({ w: 106, h: 8 });
  });

  it('scales the item icons by a corner, and nothing else resizes them', () => {
    const items = { x: 39, y: 36, w: 50, h: 14, visible: true, fontTall: 18 };
    expect(resizeChild(DEFAULT_DESIGN, 'Items', items, 'se', 0, 7).children.teamColumn!.Items).toEqual({ fontSize: 27 });
    expect(resizeChild(DEFAULT_DESIGN, 'Items', items, 'e', 10, 0)).toBe(DEFAULT_DESIGN);
  });
```

and append:

```ts
describe('element edits', () => {
  it('places an element rounded and on screen, and leaves one the game places alone', () => {
    expect(placeElement(DEFAULT_DESIGN, 'chat', 40.4, 60.6).elements.chat).toEqual({ x: 40, y: 61 });
    // clampSpan would allow 8 - 320 = -312; the validator's floor of -200 is tighter for a box this wide.
    expect(placeElement(DEFAULT_DESIGN, 'chat', -900, 0).elements.chat).toEqual({ x: -200, y: 0 });
    expect(placeElement(DEFAULT_DESIGN, 'targetId', 5, 5)).toBe(DEFAULT_DESIGN);
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(placeElement(free, 'teamColumn', 5, 5)).toBe(free);
  });

  it('moves several elements by the same amount from where they started', () => {
    const starts = { chat: { x: 10, y: 275, w: 320, h: 120 }, ownHealth: { x: 728, y: 389, w: 125, h: 91 } };
    const d = moveElements(DEFAULT_DESIGN, ['chat', 'ownHealth'], starts, -5, 10);
    expect(d.elements.chat).toEqual({ x: 5, y: 285 });
    expect(d.elements.ownHealth).toEqual({ x: 723, y: 399 });
  });

  it('moves a Free card from where it started, keeping 8 units on screen', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    const start = teamCardRects(free, free.aspect)[0];
    expect(teamCardRects(moveCard(free, 0, start, 100, -200), free.aspect)[0]).toMatchObject({ x: 113, y: 241 });
    expect(teamCardRects(moveCard(free, 0, start, -5000, 0), free.aspect)[0].x).toBe(8 - 121);
  });

  it('aligns several elements against their box', () => {
    const left = alignElements(DEFAULT_DESIGN, ['chat', 'progressBar'], 'left');
    expect(left.elements.chat).toEqual({ x: 10, y: 275 });
    expect(left.elements.progressBar).toEqual({ x: 10, y: 250 });
    const top = alignElements(DEFAULT_DESIGN, ['chat', 'progressBar'], 'top');
    expect(top.elements.chat).toEqual({ x: 10, y: 250 });
  });

  it('scales an element by a corner, proportionally, from the opposite corner, clamped 0.5 to 2', () => {
    const start = { rect: { x: 728, y: 389, w: 125, h: 91 }, scale: 1 };
    // Dragging the top-left corner out by half: the bottom-right corner stays on the screen's.
    expect(scaleElement(DEFAULT_DESIGN, 'ownHealth', start, 'nw', -62.5, -45.5).elements.ownHealth).toEqual({ scale: 1.5, x: 666, y: 344 });
    // The bottom-right corner: the element keeps its own position (and its file anchor).
    expect(scaleElement(DEFAULT_DESIGN, 'ownHealth', start, 'se', 125, 0).elements.ownHealth).toEqual({ scale: 2 });
    expect(scaleElement(DEFAULT_DESIGN, 'ownHealth', start, 'se', 1000, 0).elements.ownHealth).toEqual({ scale: 2 });
    expect(scaleElement(DEFAULT_DESIGN, 'ownHealth', start, 'se', -1000, 0).elements.ownHealth).toEqual({ scale: 0.5 });
    expect(scaleElement(DEFAULT_DESIGN, 'chat', start, 'se', 10, 10)).toBe(DEFAULT_DESIGN);
  });

  it('resizes a free-size element from any handle, 20 units at least', () => {
    const chat = { x: 10, y: 275, w: 320, h: 120 };
    expect(resizeElement(DEFAULT_DESIGN, 'chat', chat, 'w', -30, 0).elements.chat).toEqual({ x: -20, w: 350, h: 120 });
    expect(resizeElement(DEFAULT_DESIGN, 'chat', chat, 'e', -400, 0).elements.chat).toEqual({ w: 20, h: 120 });
    expect(resizeElement(DEFAULT_DESIGN, 'chat', chat, 'e', 32, 0, true).elements.chat).toEqual({ w: 352, h: 132 });
    expect(resizeElement(DEFAULT_DESIGN, 'ownHealth', chat, 'e', 10, 0)).toBe(DEFAULT_DESIGN);
  });

  it('computes a resized box with the opposite edge fixed', () => {
    const b = { x: 10, y: 10, w: 100, h: 50 };
    expect(resizeBox(b, 'nw', 10, 5, false, 1)).toEqual({ x: 20, y: 15, w: 90, h: 45 });
    expect(resizeBox(b, 'w', 200, 0, false, 20)).toEqual({ x: 90, y: 10, w: 20, h: 50 });
    expect(resizeBox(b, 's', 0, 25, true, 1)).toEqual({ x: 10, y: 10, w: 150, h: 75 });
  });
});

describe('edits for any selection', () => {
  it('nudges whatever is selected', () => {
    expect(nudgeSelection(DEFAULT_DESIGN, { kind: 'elements', ids: ['chat', 'ownHealth'] }, 1, 0).elements)
      .toMatchObject({ chat: { x: 11, y: 275 }, ownHealth: { x: 729, y: 389 } });
    expect(nudgeSelection(DEFAULT_DESIGN, { kind: 'children', names: ['Head', 'Health'], card: 0 }, 0, 1).children.teamColumn)
      .toEqual({ Head: { x: 13, y: 39 }, Health: { x: 37, y: 53 } });
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(nudgeSelection(free, { kind: 'card', card: 0 }, 5, 0).elements.teamColumn!.slots![0]).toEqual({ x: 5, y: 405 });
    expect(nudgeSelection(DEFAULT_DESIGN, { kind: 'none' }, 1, 1)).toBe(DEFAULT_DESIGN);
  });

  it('hides elements and pieces, never a card, and skips an element with no Visible control', () => {
    const els = hideSelection(DEFAULT_DESIGN, { kind: 'elements', ids: ['chat', 'ownHealth', 'xhair'] });
    expect(els.elements.chat).toEqual({ visible: false });
    expect(els.elements.ownHealth).toEqual({ visible: false });
    expect(els.elements.xhair).toBeUndefined();
    const kids = hideSelection(DEFAULT_DESIGN, { kind: 'children', names: ['Head', 'Name'], card: 0 });
    expect(kids.children.teamColumn).toEqual({ Head: { visible: false }, Name: { visible: false } });
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(hideSelection(free, { kind: 'card', card: 1 })).toBe(free);
    expect(setSelectionVisible(els, { kind: 'elements', ids: ['chat'] }, true).elements.chat).toEqual({ visible: true });
  });

  it('resets elements and pieces', () => {
    const moved = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { x: 5 } } };
    expect(resetSelection(moved, { kind: 'elements', ids: ['chat'] }).elements.chat).toBeUndefined();
    const edited = patchChild(DEFAULT_DESIGN, 'Head', { x: 5 });
    expect(resetSelection(edited, { kind: 'children', names: ['Head'], card: 0 }).children.teamColumn).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/edit.test.ts`
Expected: FAIL. `placeElement` and the rest are not exported, and `resizeChild` still takes `(design, name, start, dw, dh)`.

- [ ] **Step 3: Implement**

In `web/src/hud/edit.ts`, add to the imports:

```ts
import { CORNERS } from './guides';
import type { Selection } from './selection';
```

(merge `CORNERS` into the existing `./guides` import line: `import { unionBox, CORNERS, type Handle } from './guides';`).

Replace the whole Phase 1 `resizeChild` (its doc comment and body) with:

```ts
/**
 * A box resized by one handle from `start` by (dx, dy): the dragged edges
 * move, the opposite edges stay put, no side below `min`. With `keepRatio`
 * a side handle carries the other dimension along in proportion (Shift on a
 * side handle). Corners are never ratio-locked here; square art and scaled
 * elements lock their own ratio.
 */
export function resizeBox(start: Box, handle: Handle, dx: number, dy: number, keepRatio: boolean, min: number): Box {
  let w = start.w, h = start.h;
  if (handle.includes('e')) w = start.w + dx;
  if (handle.includes('w')) w = start.w - dx;
  if (handle.includes('s')) h = start.h + dy;
  if (handle.includes('n')) h = start.h - dy;
  w = Math.max(min, Math.round(w));
  h = Math.max(min, Math.round(h));
  if (keepRatio && (handle === 'e' || handle === 'w')) h = Math.max(min, Math.round((start.h * w) / (start.w || 1)));
  if (keepRatio && (handle === 'n' || handle === 's')) w = Math.max(min, Math.round((start.w * h) / (start.h || 1)));
  return {
    x: handle.includes('w') ? start.x + start.w - w : start.x,
    y: handle.includes('n') ? start.y + start.h - h : start.y,
    w, h,
  };
}

/**
 * Resize one teammate-card piece by a handle from where the gesture started
 * it, unscaled units, inside the unfitted card. Width-and-height pieces take
 * any of the eight handles, and a left or top handle moves the origin so the
 * opposite edge stays put. Square art takes the corners only and grows by
 * the larger of the two deltas, keeping its ratio. The item icons have no
 * box of their own: a corner scales their icon size in proportion.
 */
export function resizeChild(
  design: HudDesign, name: string, start: CardChild, handle: Handle, dx: number, dy: number, keepRatio = false,
): HudDesign {
  const def = teamChild(name);
  if (!def) return design;
  const p = baseTeam(design.preset).card;
  if (def.box === 'none') {
    if (!def.font || start.fontTall === undefined || !CORNERS.includes(handle)) return design;
    return patchChild(design, name, { fontSize: clampChild('fontSize', Math.round(start.fontTall * cornerFactor(start, handle, dx, dy))) });
  }
  if (def.box === 'square') {
    if (!CORNERS.includes(handle)) return design;
    const grow = Math.max(handle.includes('w') ? -dx : dx, handle.includes('n') ? -dy : dy);
    const room = Math.min(handle.includes('w') ? start.x + start.w : p.w - start.x, handle.includes('n') ? start.y + start.h : p.h - start.y);
    const side = clampChild('w', Math.round(Math.min(Math.max(1, room), Math.max(1, start.w + grow))));
    const patch: Partial<ChildOverride> = { w: side, h: side };
    if (handle.includes('w')) patch.x = clampChild('x', start.x + start.w - side);
    if (handle.includes('n')) patch.y = clampChild('y', start.y + start.h - side);
    return patchChild(design, name, patch);
  }
  const b = resizeBox(start, handle, dx, dy, keepRatio, 1);
  // Inside the unfitted card: an edge dragged past the card stops at it.
  const left = Math.max(0, b.x), top = Math.max(0, b.y);
  const right = Math.min(p.w, b.x + b.w), bottom = Math.min(p.h, b.y + b.h);
  const patch: Partial<ChildOverride> = { w: clampChild('w', Math.max(1, right - left)), h: clampChild('h', Math.max(1, bottom - top)) };
  if (handle.includes('w')) patch.x = clampChild('x', left);
  if (handle.includes('n')) patch.y = clampChild('y', top);
  return patchChild(design, name, patch);
}
```

Append at the end of the file:

```ts
// --- elements, cards and whole selections ---

/**
 * Put an element's top-left at (x, y), rounded, keeping 8 units of it on
 * screen as a drag always has (clampSpan) and inside the validator's range.
 * An element the game places, or the Free Teammates (each card places
 * itself), is returned unchanged, `===`.
 */
export function placeElement(design: HudDesign, id: string, x: number, y: number): HudDesign {
  const el = elementById(id);
  if (!el || !el.move || (id === 'teamColumn' && isFreeTeam(design))) return design;
  const r = elementRect(design, id, design.aspect);
  const o = design.elements[id];
  const px = clampOverride('x', Math.round(clampSpan(x, r.w, screenW(design.aspect), 8)));
  const py = clampOverride('y', Math.round(clampSpan(y, r.h, SCREEN_H, 8)));
  return { ...design, elements: { ...design.elements, [id]: { ...o, x: px, y: py } } };
}

/** Move elements by (dx, dy) from where a gesture started them. */
export function moveElements(design: HudDesign, ids: string[], starts: Record<string, Box>, dx: number, dy: number): HudDesign {
  return ids.reduce((d, id) => (starts[id] ? placeElement(d, id, starts[id].x + dx, starts[id].y + dy) : d), design);
}

/** Move a Free card by (dx, dy) from where a gesture started it, keeping 8 units on screen. */
export function moveCard(design: HudDesign, card: number, start: Box, dx: number, dy: number): HudDesign {
  const W = screenW(design.aspect);
  return placeCard(design, card, clampSpan(start.x + dx, start.w, W, 8), clampSpan(start.y + dy, start.h, SCREEN_H, 8));
}

/** Align elements against the box around them. Ones that cannot move stay, and still count toward the box. */
export function alignElements(design: HudDesign, ids: string[], how: Align): HudDesign {
  const rects = Object.fromEntries(ids.map((id) => {
    const { x, y, w, h } = elementRect(design, id, design.aspect);
    return [id, { x, y, w, h }];
  }));
  const box = unionBox(Object.values(rects));
  if (!box) return design;
  return ids.reduce((d, id) => {
    const at = alignedAt(rects[id], box, how);
    return placeElement(d, id, at.x, at.y);
  }, design);
}

/**
 * Scale an element by a corner handle: one proportional factor from the
 * drag, applied to the scale the gesture started at, rounded to 0.01 and
 * clamped to the validator's 0.5..2. The opposite corner stays put, so a
 * left or top corner also moves the element by the size it gained, read
 * back from elementRect at the new scale. A right or bottom corner leaves
 * the position alone, so an element still on its file anchor keeps it.
 */
export function scaleElement(
  design: HudDesign, id: string, start: { rect: Box; scale: number }, handle: Handle, dx: number, dy: number,
): HudDesign {
  const el = elementById(id);
  if (!el || el.resize !== 'scale') return design;
  const o = design.elements[id] ?? {};
  const scale = clampOverride('scale', Math.round(start.scale * cornerFactor(start.rect, handle, dx, dy) * 100) / 100);
  const next: HudDesign = { ...design, elements: { ...design.elements, [id]: { ...o, scale } } };
  if (!handle.includes('w') && !handle.includes('n')) return next;
  const r = elementRect(next, id, next.aspect);
  const a = anchorOf(start.rect, handle);
  return placeElement(next, id, handle.includes('w') ? a.x - r.w : start.rect.x, handle.includes('n') ? a.y - r.h : start.rect.y);
}

/**
 * Resize a free-size element (the chat box) by any handle from where the
 * gesture started it, 20 units at least as the Phase 1 corner drag had it,
 * through the validator's ranges. A left or top handle moves the origin.
 */
export function resizeElement(
  design: HudDesign, id: string, start: Box, handle: Handle, dx: number, dy: number, keepRatio = false,
): HudDesign {
  const el = elementById(id);
  if (!el || el.resize !== 'free') return design;
  const b = resizeBox(start, handle, dx, dy, keepRatio, 20);
  const next: ElementOverride = { ...(design.elements[id] ?? {}), w: clampOverride('w', b.w), h: clampOverride('h', b.h) };
  if (handle.includes('w')) next.x = clampOverride('x', b.x);
  if (handle.includes('n')) next.y = clampOverride('y', b.y);
  return { ...design, elements: { ...design.elements, [id]: next } };
}

/** Arrow keys: move whatever is selected by (dx, dy), through each level's own clamp. */
export function nudgeSelection(design: HudDesign, sel: Selection, dx: number, dy: number): HudDesign {
  switch (sel.kind) {
    case 'elements': return sel.ids.reduce((d, id) => nudge(d, id, dx, dy), design);
    case 'card': return nudgeCard(design, sel.card, dx, dy);
    case 'children': return moveChildren(design, sel.names, startsOf(design, sel.names), dx, dy);
    default: return design;
  }
}

/**
 * Show or hide a selection: elements with a Visible control and pieces. A
 * Free card cannot be hidden alone (the game draws every teammate's card),
 * so a card selection is returned unchanged.
 */
export function setSelectionVisible(design: HudDesign, sel: Selection, visible: boolean): HudDesign {
  if (sel.kind === 'children') return setChildrenVisible(design, sel.names, visible);
  if (sel.kind !== 'elements') return design;
  return sel.ids.reduce((d, id) => {
    if (!elementById(id)?.props.includes('visible')) return d;
    return { ...d, elements: { ...d.elements, [id]: { ...(d.elements[id] ?? {}), visible } } };
  }, design);
}

/** Delete and Backspace, and the menu's Hide. */
export function hideSelection(design: HudDesign, sel: Selection): HudDesign {
  return setSelectionVisible(design, sel, false);
}

/** The menu's Reset: elements back to a fresh design's, pieces back to the file's. */
export function resetSelection(design: HudDesign, sel: Selection): HudDesign {
  if (sel.kind === 'children') return resetChildren(design, sel.names);
  if (sel.kind === 'elements') return sel.ids.reduce((d, id) => resetElement(d, id), design);
  return design;
}
```

In `web/src/routes/Hud.tsx`, `onPointerMove` still calls the Phase 1 signature. Change

```ts
      setDesign((cur) => (d.mode === 'resize'
        ? resizeChild(cur, d.name, s, dux / scale, duy / scale)
```

to

```ts
      setDesign((cur) => (d.mode === 'resize'
        ? resizeChild(cur, d.name, { ...s, visible: true }, 'se', dux / scale, duy / scale)
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes/Hud.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/edit.ts web/src/hud/edit.test.ts web/src/routes/Hud.tsx
git commit -m "Add element moves, aligns and handle scaling, eight-handle resizing, and nudge, hide and reset for any selection"
```

---

### Task 8: `mock.ts` draws frames, handles, hover, the box and guides

**Files:**
- Modify: `web/src/hud/mock.ts`, `web/src/routes/Hud.tsx`
- Test: `web/src/hud/mock.test.ts`

**Interfaces:**
- Consumes: `Box` (`design.ts`); `Guide` (`guides.ts`); `selectionFrames`, `TEAMMATES`, `NONE`, `Selection` (`selection.ts`, tests and the page).
- Produces:
  - `interface HudView { state?: CardState; frames?: Box[]; box?: Box | null; handles?: { x: number; y: number }[]; hover?: { rects: Box[]; label: string } | null; marquee?: Box | null; guides?: Guide[] }` (all HUD units; `card` and `child` are gone)
  - `drawHud(ctx, pxW, pxH, design, side, selected: string | readonly string[] | null, onAsset?, view?)`: `selected` now only decides which hidden elements are still drawn dimmed; every outline comes from `view`.
  - The private `drawSelection`, `drawCardSelection` and `drawChildSelection` are removed. `childCornerAt` stays until Task 12.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/mock.test.ts`, add `import { selectionFrames, TEAMMATES } from './selection';`. Replace the test `outlines each card instead of the whole screen, the selected one solid` with:

```ts
  it('outlines each card instead of the whole screen when the Free teammates are selected', () => {
    const strokes: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    drawHud(ctx, 853, 480, FREE, 'survivor', 'teamColumn', undefined, { frames: selectionFrames(FREE, TEAMMATES) });
    for (const c of teamCardRects(FREE, FREE.aspect).slice(0, 3)) expect(strokes).toContainEqual([c.x, c.y, c.w, c.h]);
    expect(strokes).not.toContainEqual([0, 0, 853, 480]);
  });
```

Replace the test `outlines the selected child in every drawn card` with:

```ts
  it('outlines a selected piece in every drawn card', () => {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const strokes: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    const frames = selectionFrames(DEFAULT_DESIGN, { kind: 'children', names: ['Head'], card: 0 });
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', 'teamColumn', undefined, { frames });
    for (const c of teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect).slice(0, 3)) {
      const head = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Head')!;
      expect(strokes).toContainEqual([head.x, head.y, head.w, head.h]);
    }
  });
```

and append a new block:

```ts
describe('selection chrome', () => {
  const recording = () => {
    const strokes: number[][] = [];
    const fills: number[][] = [];
    const dashes: number[][] = [];
    const texts: string[] = [];
    const path: (string | number)[][] = [];
    const ctx = fakeCtx(() => {}, undefined, texts);
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    ctx.fillRect = ((...a: number[]) => { fills.push(a); }) as typeof ctx.fillRect;
    ctx.setLineDash = ((d: number[]) => { dashes.push(d); }) as typeof ctx.setLineDash;
    ctx.moveTo = ((...a: number[]) => { path.push(['M', ...a]); }) as typeof ctx.moveTo;
    ctx.lineTo = ((...a: number[]) => { path.push(['L', ...a]); }) as typeof ctx.lineTo;
    return { ctx, strokes, fills, dashes, texts, path };
  };

  it('draws the selection box and a 7-pixel handle centred on each handle point', () => {
    const r = recording();
    const box = { x: 100, y: 50, w: 40, h: 20 };
    drawHud(r.ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { box, handles: [{ x: 100, y: 50 }, { x: 140, y: 70 }] });
    expect(r.strokes).toContainEqual([100, 50, 40, 20]);
    expect(r.fills).toContainEqual([96.5, 46.5, 7, 7]);
    expect(r.fills).toContainEqual([136.5, 66.5, 7, 7]);
  });

  it('scales HUD units to canvas pixels, and keeps handles 7 pixels', () => {
    const r = recording();
    drawHud(r.ctx, 960, 540, DEFAULT_DESIGN, 'survivor', null, undefined, { box: { x: 100, y: 50, w: 40, h: 20 }, handles: [{ x: 100, y: 50 }] });
    expect(r.strokes).toContainEqual([112.5, 56.25, 45, 22.5]);
    expect(r.fills).toContainEqual([109, 52.75, 7, 7]);
  });

  it('draws the hover outline dashed, with its name', () => {
    const r = recording();
    drawHud(r.ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { hover: { rects: [{ x: 10, y: 20, w: 30, h: 40 }], label: 'Portrait' } });
    expect(r.strokes).toContainEqual([10, 20, 30, 40]);
    expect(r.dashes).toContainEqual([3, 3]);
    expect(r.texts).toContain('Portrait');
  });

  it('draws the Shift+drag box filled and outlined', () => {
    const r = recording();
    drawHud(r.ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { marquee: { x: 5, y: 6, w: 70, h: 80 } });
    expect(r.strokes).toContainEqual([5, 6, 70, 80]);
    expect(r.fills).toContainEqual([5, 6, 70, 80]);
  });

  it('draws each guide as a line across its span', () => {
    const r = recording();
    drawHud(r.ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, {
      guides: [{ axis: 'x', at: 100, from: 10, to: 200 }, { axis: 'y', at: 50, from: 0, to: 853 }],
    });
    expect(r.path).toContainEqual(['M', 100, 10]);
    expect(r.path).toContainEqual(['L', 100, 200]);
    expect(r.path).toContainEqual(['M', 0, 50]);
    expect(r.path).toContainEqual(['L', 853, 50]);
  });

  it('still draws a hidden element dimmed when it is one of several selected', () => {
    const hidden = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { visible: false } } };
    const texts: string[] = [];
    drawHud(fakeCtx(() => {}, undefined, texts), 853, 480, hidden, 'survivor', ['ownHealth', 'chat']);
    expect(texts).toContain('Francis: got it');
    const without: string[] = [];
    drawHud(fakeCtx(() => {}, undefined, without), 853, 480, hidden, 'survivor', ['ownHealth']);
    expect(without).not.toContain('Francis: got it');
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/mock.test.ts`
Expected: FAIL. `HudView` has no `frames`, `box`, `handles`, `hover`, `marquee` or `guides` (type errors surface as failed expectations: nothing is drawn for them), and `drawHud` does not accept an array.

- [ ] **Step 3: Implement**

In `web/src/hud/mock.ts`, add to the imports:

```ts
import type { Box } from './design';
import type { Guide } from './guides';
```

(merge `Box` into the existing `import type { HudDesign } from './design';` line). Replace the `HudView` interface with:

```ts
/**
 * What the page asks the canvas to show beyond the design, all in HUD
 * units, all measured by selection.ts from the generator's trees: the
 * teammate card state, the selection's outlines (one per selected thing as
 * drawn, so a piece is outlined in every card), the box its handles sit on
 * and the handle points, the hover outline and its name, the Shift+drag box,
 * and the snap guides of a drag under way.
 */
export interface HudView {
  state?: CardState;
  frames?: Box[];
  box?: Box | null;
  handles?: { x: number; y: number }[];
  hover?: { rects: Box[]; label: string } | null;
  marquee?: Box | null;
  guides?: Guide[];
}
```

Delete the functions `drawChildSelection`, `drawSelection` and `drawCardSelection`, and add in their place:

```ts
/** Handles are a fixed size on screen, whatever the canvas scale. */
const HANDLE_PX = 7;
const GUIDE = '#ff4fa3';
const MARQUEE = 'rgba(153,204,255,0.9)';
const MARQUEE_FILL = 'rgba(153,204,255,0.13)';

function drawFrames(ctx: CanvasRenderingContext2D, frames: Box[], k: number, accent: string) {
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  for (const f of frames) ctx.strokeRect(f.x * k, f.y * k, f.w * k, f.h * k);
  ctx.restore();
}

/** The selection's box, thin, and a white square with an accent edge on each handle point. */
function drawHandles(ctx: CanvasRenderingContext2D, box: Box | null, points: { x: number; y: number }[], k: number, accent: string) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = accent;
  if (box) ctx.strokeRect(box.x * k, box.y * k, box.w * k, box.h * k);
  for (const p of points) {
    const x = p.x * k - HANDLE_PX / 2, y = p.y * k - HANDLE_PX / 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, HANDLE_PX, HANDLE_PX);
    ctx.strokeRect(x, y, HANDLE_PX, HANDLE_PX);
  }
  ctx.restore();
}

/** What a click would pick: a dashed white outline and its name in a small label above the first rect. */
function drawHover(ctx: CanvasRenderingContext2D, hover: { rects: Box[]; label: string }, k: number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const r of hover.rects) ctx.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
  ctx.setLineDash([]);
  const first = hover.rects[0];
  if (first && hover.label) {
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const w = ctx.measureText(hover.label).width + 8;
    const x = first.x * k, y = Math.max(0, first.y * k - 16);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(x, y, w, 14);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(hover.label, x + 4, y + 11);
  }
  ctx.restore();
}

function drawMarquee(ctx: CanvasRenderingContext2D, m: Box, k: number) {
  ctx.save();
  ctx.fillStyle = MARQUEE_FILL;
  ctx.fillRect(m.x * k, m.y * k, m.w * k, m.h * k);
  ctx.strokeStyle = MARQUEE;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(m.x * k, m.y * k, m.w * k, m.h * k);
  ctx.restore();
}

function drawGuides(ctx: CanvasRenderingContext2D, guides: Guide[], k: number) {
  ctx.save();
  ctx.strokeStyle = GUIDE;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const g of guides) {
    ctx.beginPath();
    if (g.axis === 'x') { ctx.moveTo(g.at * k, g.from * k); ctx.lineTo(g.at * k, g.to * k); }
    else { ctx.moveTo(g.from * k, g.at * k); ctx.lineTo(g.to * k, g.at * k); }
    ctx.stroke();
  }
  ctx.restore();
}
```

Replace `drawHud`'s signature and body with:

```ts
export function drawHud(
  ctx: CanvasRenderingContext2D, pxW: number, pxH: number, design: HudDesign, side: Side,
  selected: string | readonly string[] | null, onAsset?: () => void, view: HudView = {},
): void {
  const k = pxH / SCREEN_H;
  const accent = accentColour(ctx);
  // A hidden element is still drawn, dimmed, while it is selected, so the
  // player can see what they are editing; every outline comes from `view`.
  const picked: readonly string[] = selected === null ? [] : typeof selected === 'string' ? [selected] : selected;

  for (const el of visibleElements(side)) {
    const u = rectFor(design, el.id);
    const hidden = !u.visible;
    if (hidden && !picked.includes(el.id)) continue;

    const r: Rect = { x: u.x * k, y: u.y * k, w: u.w * k, h: u.h * k };
    const paint = PAINTERS[el.id];
    if (!paint) continue;

    if (hidden) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      paint(ctx, r, design, k, onAsset, view);
      ctx.restore();
      drawHiddenOutline(ctx, r);
    } else {
      paint(ctx, r, design, k, onAsset, view);
    }
  }

  if (view.frames?.length) drawFrames(ctx, view.frames, k, accent);
  if (view.box || view.handles?.length) drawHandles(ctx, view.box ?? null, view.handles ?? [], k, accent);
  if (view.hover) drawHover(ctx, view.hover, k);
  if (view.marquee) drawMarquee(ctx, view.marquee, k);
  if (view.guides?.length) drawGuides(ctx, view.guides, k);
}
```

and in its doc comment replace the last sentence ("`view` carries what the page shows beyond the design: ...") with "`view` carries what the page shows beyond the design: the teammate card state and the selection chrome, drawn over everything else."

In `web/src/routes/Hud.tsx`, add the imports

```ts
import { NONE, selectionFrames, type Selection } from '../hud/selection';
```

and in the draw effect replace

```ts
    drawHud(ctx, w, h, design, side, selected, () => setImgTick((t) => t + 1), { state: cardState, card: selectedCard, child: selectedChild });
```

with

```ts
    // The page still keeps three picks; they map onto one Selection for drawing.
    const picked: Selection = selectedChild ? { kind: 'children', names: [selectedChild], card: selectedCard ?? 0 }
      : selectedCard !== null ? { kind: 'card', card: selectedCard }
        : selected ? { kind: 'elements', ids: [selected] } : NONE;
    drawHud(ctx, w, h, design, side, selected, () => setImgTick((t) => t + 1), { state: cardState, frames: selectionFrames(design, picked) });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes/Hud.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/mock.ts web/src/hud/mock.test.ts web/src/routes/Hud.tsx
git commit -m "Draw the HUD editor's selection frames, handles, hover outline, drag box and snap guides from one view"
```

---

### Task 9: Split the page's controls into `routes/hud/`

**Files:**
- Create: `web/src/routes/hud/controls.tsx`, `web/src/routes/hud/ContextPanel.tsx`
- Modify: `web/src/routes/Hud.tsx`

**Interfaces:**
- Consumes: the Phase 1 components in `Hud.tsx`.
- Produces, moved unchanged apart from `export`:
  - `controls.tsx`: `Slider`, `Field`, `type Patch`, `patchNum`, `hexOf`, `alphaPct`, `withHex`, `withAlphaPct`, and a new `type SetDesign = (fn: (d: HudDesign) => HudDesign) => void`.
  - `ContextPanel.tsx`: `TeamControls`, `ElementControls`, `ChildList`, `ChildControls` (and the private `LAYOUT_LABELS`).
- This task changes no behaviour, so it has no new test: the whole existing page suite is its test.

- [ ] **Step 1: Create `controls.tsx`**

Create `web/src/routes/hud/controls.tsx` with this header, then the functions `Slider`, `Field`, the `Patch` type, `patchNum`, `hexOf`, `alphaPct`, `withHex` and `withAlphaPct` cut from `web/src/routes/Hud.tsx` with their doc comments, each given `export`:

```tsx
/**
 * The small pieces every HUD editor control is built from: a labelled
 * slider, a fieldset, the guarded number-box patch, and the colour helpers
 * that turn design.ts's "r g b a" strings into what a colour input and an
 * opacity slider need.
 */
import type { ComponentChildren } from 'preact';
import { clampOverride, type HudDesign, type ElementOverride, type RangeKey } from '../../hud/design';

export type SetDesign = (fn: (d: HudDesign) => HudDesign) => void;
```

In the moved `Field`, change `children: preact.ComponentChildren` to `children: ComponentChildren`.

- [ ] **Step 2: Create `ContextPanel.tsx`**

Create `web/src/routes/hud/ContextPanel.tsx` with this header, then `LAYOUT_LABELS`, `TeamControls`, `ElementControls`, `ChildList` and `ChildControls` cut from `Hud.tsx` with their doc comments, the four components given `export`, and every `setDesign: (fn: (d: HudDesign) => HudDesign) => void` prop type written as `setDesign: SetDesign`:

```tsx
/**
 * The side panel's controls: what the selection can do. Built only from the
 * registries (elements.ts, children.ts), with every default read back from
 * the generator, so a freshly reset thing shows real numbers.
 */
import {
  clampOverride, clampChild, type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type ChildRangeKey,
} from '../../hud/design';
import { elementById, type HudElement } from '../../hud/elements';
import { elementRect, teamLayout, cardChild, baseHasChild } from '../../hud/build';
import { TEAM_PANEL, teamChild } from '../../hud/children';
import { cardOffset, withTeamDir, placeCard, patchChild, resetElement, resetChild } from '../../hud/edit';
import { Slider, Field, patchNum, hexOf, alphaPct, withHex, withAlphaPct, type Patch, type SetDesign } from './controls';
```

- [ ] **Step 3: Update `Hud.tsx`**

Delete the moved code from `web/src/routes/Hud.tsx` and add:

```ts
import { ElementControls, ChildList, ChildControls } from './hud/ContextPanel';
import { hexOf, alphaPct, withHex, withAlphaPct } from './hud/controls';
```

(`StyleRow`, which stays in `Hud.tsx`, uses the four colour helpers.) Then remove every import no remaining line of `Hud.tsx` references. The candidates are `clampOverride`, `clampChild`, `ElementOverride`, `RangeKey`, `TeamDir`, `ChildOverride`, `ChildRangeKey`, `HudElement`, `baseHasChild`, `TEAM_PANEL`, `cardOffset`, `withTeamDir`, `patchChild`, `resetElement` and `resetChild`; the canvas handlers still use `teamChild`, `placeCard`, `nudgeCard`, `placeChild`, `nudgeChild`, `resizeChild`, `clampSpan` and `baseTeam`, which stay. `npm run typecheck` does not flag unused imports, so check each candidate with `grep -n "<name>" web/src/routes/Hud.tsx`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck && npm run build`
Expected: PASS, no type errors, the build succeeds. Nothing behaves differently.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/hud/controls.tsx web/src/routes/hud/ContextPanel.tsx web/src/routes/Hud.tsx
git commit -m "Move the HUD editor's side-panel controls out of the page into routes/hud"
```

---

### Task 10: Undo and redo on the page

**Files:**
- Modify: `web/src/routes/hud/controls.tsx`, `web/src/routes/hud/ContextPanel.tsx`, `web/src/routes/Hud.tsx`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `emptyHistory`, `push`, `begin`, `commit`, `cancel`, `nudgeStep`, `undo`, `redo`, `sameJson`, `History` (`history.ts`, imported as `* as undoStack` because `Hud.tsx` already uses the global `history.replaceState`).
- Produces:
  - `controls.tsx`: `type EditMode = 'step' | 'gesture' | { nudge: string }`, `type Edit = (fn: (d: HudDesign) => HudDesign, mode?: EditMode) => void`, `endsOn(end: () => void): { onBlur: () => void; onKeyDown: (e: KeyboardEvent) => void }`, `typedInto(t: EventTarget | null): boolean`; `Slider` gains `onEnd?: () => void`; `type Patch = (p: Partial<ElementOverride>, mode?: EditMode) => void`; `patchNum` patches as a gesture. `SetDesign` is removed.
  - `ContextPanel.tsx`: every component takes `edit: Edit; end: () => void` instead of `setDesign`.
  - `Hud.tsx`: every design change goes through `edit(fn, mode)`; `endGesture()`, `cancelGesture()`, `doUndo()`, `doRedo()`; Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y (Cmd on macOS) on the window, skipped in typing boxes; Undo and Redo buttons in the toolbar; a canvas drag is one gesture, arrow nudges coalesce.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, add inside `describe('Hud page', ...)`:

```ts
  const undoKey = (extra: Partial<KeyboardEventInit> = {}) =>
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, ...extra });

  it('undoes and redoes with Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const x = () => screen.getByLabelText('X') as HTMLInputElement;
    fireEvent.input(x(), { target: { value: '42' } });
    fireEvent.blur(x());
    undoKey();
    expect(x().value).toBe('10');
    undoKey({ shiftKey: true });
    expect(x().value).toBe('42');
    undoKey();
    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
    expect(x().value).toBe('42');
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(x().value).toBe('10');
  });

  it('undoes and redoes with the toolbar buttons, which are off when there is nothing to do', () => {
    render(<Hud />);
    const undoBtn = () => screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    const redoBtn = () => screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
    expect(undoBtn().disabled).toBe(true);
    expect(redoBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByLabelText('Visible'));
    expect(undoBtn().disabled).toBe(false);
    fireEvent.click(undoBtn());
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(redoBtn());
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(false);
  });

  it('leaves Ctrl+Z to the browser while typing in a number box', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const x = () => screen.getByLabelText('X') as HTMLInputElement;
    fireEvent.input(x(), { target: { value: '42' } });
    fireEvent.keyDown(x(), { key: 'z', ctrlKey: true });
    expect(x().value).toBe('42');
    fireEvent.blur(x());
    undoKey();
    expect(x().value).toBe('10');
  });

  it('makes typing into a number box one step, however many edits it takes', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const x = () => screen.getByLabelText('X') as HTMLInputElement;
    for (const v of ['4', '42', '420']) fireEvent.input(x(), { target: { value: v } });
    fireEvent.keyDown(x(), { key: 'Enter' });
    undoKey();
    expect(x().value).toBe('10');
  });

  it('makes a slider drag one step', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    const gap = () => screen.getByRole('slider', { name: /^Gap/ }) as HTMLInputElement;
    for (const v of ['20', '25', '30']) fireEvent.input(gap(), { target: { value: v } });
    fireEvent.change(gap());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(gap().value).toBe('19');
  });

  it('makes one canvas drag one step', () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // Alt keeps snapping out of it (it arrives with the selection model), so the numbers are the pointer's.
    fireEvent.pointerDown(canvas, { clientX: 133, clientY: 442, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 183, clientY: 342, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 233, clientY: 242, pointerId: 1, altKey: true });
    fireEvent.pointerUp(canvas, { clientX: 233, clientY: 242, pointerId: 1, altKey: true });
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('113');
    undoKey();
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('13');
    // The Layout change before it is its own step.
    undoKey();
    expect(screen.queryByLabelText('Card 1 X')).toBeNull();
  });

  it('coalesces a run of arrow-key nudges into one step', () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    for (let i = 0; i < 3; i++) fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    undoKey();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('10');
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL. There is no Undo button and no undo key handling, so every new test fails on its first undo.

- [ ] **Step 3: Implement `controls.tsx`**

In `web/src/routes/hud/controls.tsx`, replace the `SetDesign` type with:

```ts
/**
 * How a control's change is recorded in the undo history: a discrete
 * `step`, part of a `gesture` that ends when the control lets go (a slider
 * released, a number box blurred), or an arrow-key nudge that coalesces with
 * the previous one on the same selection.
 */
export type EditMode = 'step' | 'gesture' | { nudge: string };
/** The page's one way to change the design: every control calls it. */
export type Edit = (fn: (d: HudDesign) => HudDesign, mode?: EditMode) => void;

/** A number box's gesture ends where typing ends: on blur, or on Enter. */
export function endsOn(end: () => void): { onBlur: () => void; onKeyDown: (e: KeyboardEvent) => void } {
  return { onBlur: end, onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') end(); } };
}

/**
 * Whether a key press lands in a box the browser keeps its own undo for.
 * There Ctrl+Z undoes the typing, not the design; everywhere else (the
 * canvas, a checkbox, a slider, a button) the editor's undo applies.
 */
export function typedInto(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
  return t.tagName === 'INPUT' && ['text', 'number', 'search', 'email', 'url'].includes((t as HTMLInputElement).type);
}
```

Replace `Slider` with:

```tsx
/** One labelled slider with a live readout, matching Crosshair.tsx's. A drag is one gesture: `onEnd` fires on release. */
export function Slider(
  { label, value, min, max, step, onInput, onEnd }:
  { label: string; value: number; min: number; max: number; step: number; onInput: (n: number) => void; onEnd?: () => void },
) {
  return (
    <label class="hud__row">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onInput={(e) => onInput(parseFloat((e.target as HTMLInputElement).value))}
        onChange={onEnd}
      />
      <output class="num">{value}</output>
    </label>
  );
}
```

Change `export type Patch = (p: Partial<ElementOverride>) => void;` to

```ts
export type Patch = (p: Partial<ElementOverride>, mode?: EditMode) => void;
```

and in `patchNum` change `if (Number.isFinite(n)) patch(to(clampOverride(key, n)));` to

```ts
  if (Number.isFinite(n)) patch(to(clampOverride(key, n)), 'gesture');
```

- [ ] **Step 4: Implement `ContextPanel.tsx`**

Replace the body of `web/src/routes/hud/ContextPanel.tsx` below its header comment with:

```tsx
import {
  clampOverride, clampChild, type HudDesign, type ElementOverride, type TeamDir, type ChildOverride, type ChildRangeKey,
} from '../../hud/design';
import { elementById, type HudElement } from '../../hud/elements';
import { elementRect, teamLayout, cardChild, baseHasChild } from '../../hud/build';
import { TEAM_PANEL, teamChild } from '../../hud/children';
import { cardOffset, withTeamDir, placeCard, patchChild, resetElement, resetChild } from '../../hud/edit';
import {
  Slider, Field, patchNum, endsOn, hexOf, alphaPct, withHex, withAlphaPct, type Edit, type EditMode, type Patch,
} from './controls';

const LAYOUT_LABELS: Record<TeamDir, string> = { row: 'Row', column: 'Column', free: 'Free' };

/**
 * Layout controls for a team element. One Layout select serves both: the
 * survivor team offers Row, Column and Free, the infected row (whose cards
 * the game places itself) only what its registry entry lists, and only the
 * onChange branches, not the select itself. The survivor team's cards step
 * by the Gap between them (0 to 200, units at scale 1) outside Free, plus
 * Fit, and in Free one X and Y per card, card 4 included, since it shows
 * only while spectating a full team and is otherwise unreachable. The
 * infected row keeps its single spacing number.
 */
export function TeamControls(
  { design, edit, end, el, o, patch, selectedCard, onPickCard }: {
    design: HudDesign; edit: Edit; end: () => void; el: HudElement; o: ElementOverride;
    patch: Patch; selectedCard: number | null; onPickCard: (card: number | null) => void;
  },
) {
  if (!el.team) return null;
  const team = el.team;
  const t = teamLayout(design, el);
  const options = team.file ? (['row', 'column', 'free'] as const) : team.dirs;
  const onLayoutChange = (e: Event) => {
    const dir = (e.target as HTMLSelectElement).value as TeamDir;
    if (team.file) { onPickCard(null); edit((d) => withTeamDir(d, dir)); }
    else patch({ dir: dir as 'row' | 'column' });
  };
  // The boxes show and take where the card is drawn, the slot plus the fit offset.
  const off = cardOffset(design);
  const setSlot = (i: number, key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    edit((d) => {
      const cur = d.elements.teamColumn?.slots?.[i];
      if (!cur) return d;
      const o2 = cardOffset(d);
      return placeCard(d, i, key === 'x' ? n : cur.x + o2.x, key === 'y' ? n : cur.y + o2.y);
    }, 'gesture');
  };
  return (
    <>
      <label class="hud__row">
        <span>Layout</span>
        <select value={t.dir} onChange={onLayoutChange}>
          {options.map((d) => <option key={d} value={d}>{LAYOUT_LABELS[d]}</option>)}
        </select>
        <span />
      </label>
      {team.file ? (
        <>
          {t.dir !== 'free' && (
            <Slider
              label="Gap" value={Math.max(0, Math.round(t.gap ?? 0))} min={0} max={200} step={1}
              onInput={(gap) => patch({ gap: clampOverride('gap', gap) }, 'gesture')} onEnd={end}
            />
          )}
          <label class="hud__check">
            <input
              type="checkbox" checked={o.fit === true}
              onChange={(e) => patch({ fit: (e.target as HTMLInputElement).checked })}
            />
            <span>Fit the card to its contents</span>
          </label>
          {t.dir === 'free' && o.slots && (
            <>
              <p class="muted hud__note">
                Drag each card on the canvas, or type its position. Card 4 shows only while you spectate a full team.
              </p>
              {selectedCard !== null && <p class="hud__note">{`Teammate card ${selectedCard + 1}`}</p>}
              {o.slots.map((s, i) => (
                <div class="hud__row2" key={i}>
                  <label class="hud__field">
                    <span>{`Card ${i + 1} X`}</span>
                    <input type="number" value={Math.round(s.x + off.x)} onFocus={() => onPickCard(i)} onInput={(e) => setSlot(i, 'x', e)} {...endsOn(end)} />
                  </label>
                  <label class="hud__field">
                    <span>{`Card ${i + 1} Y`}</span>
                    <input type="number" value={Math.round(s.y + off.y)} onFocus={() => onPickCard(i)} onInput={(e) => setSlot(i, 'y', e)} {...endsOn(end)} />
                  </label>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <label class="hud__row">
          <span>Spacing</span>
          <input
            type="number" value={t.spacing}
            onInput={(e) => patchNum(patch, e, 'spacing', (n) => ({ spacing: n }))} {...endsOn(end)}
          />
          <span />
        </label>
      )}
    </>
  );
}

/**
 * The controls for whichever element is selected, built only from what its
 * registry entry allows. `elementRect` supplies every default shown when the
 * design has no override yet, so a freshly reset element shows real numbers
 * rather than blanks.
 */
export function ElementControls(
  { design, edit, end, id, selectedCard, onPickCard }: {
    design: HudDesign; edit: Edit; end: () => void; id: string;
    selectedCard: number | null; onPickCard: (card: number | null) => void;
  },
) {
  const el = elementById(id);
  if (!el) return null;
  const o = design.elements[id] ?? {};
  const rect = elementRect(design, id, design.aspect);
  // In Free each card places itself, so the element's own X and Y would move nothing.
  const free = !!el.team?.file && teamLayout(design, el).dir === 'free';
  const patch: Patch = (p, mode: EditMode = 'step') => edit((d) => (
    { ...d, elements: { ...d.elements, [id]: { ...(d.elements[id] ?? {}), ...p } } }
  ), mode);
  const reset = () => edit((d) => resetElement(d, id));

  return (
    <Field legend={el.label}>
      {el.props.includes('visible') && (
        <label class="hud__check">
          <input
            type="checkbox" checked={o.visible ?? rect.visible}
            onChange={(e) => patch({ visible: (e.target as HTMLInputElement).checked })}
          />
          <span>Visible</span>
        </label>
      )}

      {!el.move && (
        <p class="muted hud__note">The game places this one. It can be hidden but not moved.</p>
      )}

      {id === 'xhair' && (
        <>
          <label class="hud__check">
            <input
              type="checkbox" checked={design.hideGameCrosshair === true}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                edit((d) => {
                  const next = { ...d };
                  if (on) next.hideGameCrosshair = true; else delete next.hideGameCrosshair;
                  return next;
                });
              }}
            />
            <span>Hide the game's crosshair</span>
          </label>
          <p class="muted hud__note">Hides the game's own crosshair so an image crosshair can replace it.</p>
        </>
      )}

      {id === 'siHealth' && (
        <p class="muted hud__note">Shown as the Hunter; the Tank uses the same file.</p>
      )}

      {el.move && !free && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(o.x ?? rect.x)} onInput={(e) => patchNum(patch, e, 'x', (x) => ({ x }))} {...endsOn(end)} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(o.y ?? rect.y)} onInput={(e) => patchNum(patch, e, 'y', (y) => ({ y }))} {...endsOn(end)} />
          </label>
        </div>
      )}

      {el.resize === 'free' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input
              type="number" min={20} value={Math.round(o.w ?? rect.w)}
              onInput={(e) => patchNum(patch, e, 'w', (n) => ({ w: Math.max(20, n) }))} {...endsOn(end)}
            />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input
              type="number" min={20} value={Math.round(o.h ?? rect.h)}
              onInput={(e) => patchNum(patch, e, 'h', (n) => ({ h: Math.max(20, n) }))} {...endsOn(end)}
            />
          </label>
        </div>
      )}

      {el.resize === 'scale' && (
        <Slider label="Scale" value={o.scale ?? 1} min={0.5} max={2} step={0.05} onInput={(scale) => patch({ scale }, 'gesture')} onEnd={end} />
      )}

      <TeamControls design={design} edit={edit} end={end} el={el} o={o} patch={patch} selectedCard={selectedCard} onPickCard={onPickCard} />

      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this element</button>
    </Field>
  );
}

/**
 * The teammate card's insides: one pill per registry child, struck through
 * when hidden, and the only way to reach a hidden or tiny one, as the
 * element list is for elements. A child the preset's file lacks (the stock
 * health number) is a checkbox that adds it; once added it gets a pill too.
 */
export function ChildList(
  { design, edit, selectedChild, onPick }: {
    design: HudDesign; edit: Edit; selectedChild: string | null; onPick: (name: string) => void;
  },
) {
  return (
    <Field legend="Inside the card">
      <div class="hud__list">
        {TEAM_PANEL.children.map((def) => {
          const info = cardChild(design, def.name);
          if (!info) return null;                              // an addable child that is off: its checkbox is below
          return (
            <button
              key={def.name} type="button"
              class={`hud__pill${def.name === selectedChild ? ' is-active' : ''}${info.visible ? '' : ' hud__pill--hidden'}`}
              onClick={() => onPick(def.name)}
            >
              {def.label}
            </button>
          );
        })}
      </div>
      {TEAM_PANEL.children.filter((def) => def.addable && !baseHasChild(design.preset, def.name)).map((def) => (
        <label key={def.name} class="hud__check">
          <input
            type="checkbox" checked={design.children.teamColumn?.[def.name]?.on === true}
            onChange={(e) => { const on = (e.target as HTMLInputElement).checked; edit((d) => patchChild(d, def.name, { on })); }}
          />
          <span>{def.label}</span>
        </label>
      ))}
      <p class="muted hud__note">Edits inside a card apply to every teammate's card.</p>
    </Field>
  );
}

/**
 * The controls for one child of the teammate card, built only from its
 * registry entry. Numbers are unscaled units in the card file's own frame
 * (what a ChildOverride stores), read back through cardChild so a child
 * with no edits shows real numbers. Square art gets one Size; labels a text
 * size and, where the game honours it, a colour.
 */
export function ChildControls(
  { design, edit, end, name, onBack }: {
    design: HudDesign; edit: Edit; end: () => void; name: string; onBack: () => void;
  },
) {
  const def = teamChild(name);
  const info = cardChild(design, name);
  if (!def || !info) return null;
  const o = design.children.teamColumn?.[name] ?? {};
  const patch = (p: Partial<ChildOverride>, mode: EditMode = 'step') => edit((d) => patchChild(d, name, p), mode);
  // The same guard and clamp as patchNum, through the child table.
  const num = (e: Event, key: ChildRangeKey, to: (n: number) => Partial<ChildOverride>) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(n)) patch(to(clampChild(key, n)), 'gesture');
  };
  const colour = o.color ?? info.color ?? '255 255 255 255';
  const reset = () => edit((d) => resetChild(d, name));

  return (
    <Field legend={def.label}>
      <label class="hud__check">
        <input type="checkbox" checked={o.visible ?? info.visible} onChange={(e) => patch({ visible: (e.target as HTMLInputElement).checked })} />
        <span>Visible</span>
      </label>
      {def.move && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(info.x)} onInput={(e) => num(e, 'x', (x) => ({ x }))} {...endsOn(end)} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(info.y)} onInput={(e) => num(e, 'y', (y) => ({ y }))} {...endsOn(end)} />
          </label>
        </div>
      )}
      {def.box === 'wh' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (w) => ({ w }))} {...endsOn(end)} />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input type="number" value={Math.round(info.h)} onInput={(e) => num(e, 'h', (h) => ({ h }))} {...endsOn(end)} />
          </label>
        </div>
      )}
      {def.box === 'square' && (
        <label class="hud__row">
          <span>Size</span>
          <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (s) => ({ w: s, h: s }))} {...endsOn(end)} />
          <span />
        </label>
      )}
      {def.font && (
        <label class="hud__row">
          <span>{def.box === 'none' ? 'Icon size' : 'Text size'}</span>
          <input type="number" min={6} max={64} value={o.fontSize ?? info.fontTall ?? 12} onInput={(e) => num(e, 'fontSize', (fontSize) => ({ fontSize }))} {...endsOn(end)} />
          <span />
        </label>
      )}
      {def.colour && (
        <div class="hud__stylerow">
          <span class="hud__stylerow-label">Colour</span>
          <input
            type="color" aria-label={`${def.label} colour`} value={hexOf(colour)}
            onInput={(e) => patch({ color: withHex(colour, (e.target as HTMLInputElement).value) }, 'gesture')}
            onChange={end}
          />
          <input
            type="range" min={0} max={100} step={1} aria-label={`${def.label} opacity`} value={alphaPct(colour)}
            onInput={(e) => patch({ color: withAlphaPct(colour, parseFloat((e.target as HTMLInputElement).value)) }, 'gesture')}
            onChange={end}
          />
        </div>
      )}
      {def.note && <p class="muted hud__note">{def.note}</p>}
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this child</button>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={onBack}>Back to Teammates</button>
    </Field>
  );
}
```

- [ ] **Step 5: Implement the page's history**

In `web/src/routes/Hud.tsx`:

Add the imports:

```ts
import * as undoStack from '../hud/history';
import { endsOn, typedInto, type Edit, type EditMode } from './hud/controls';
```

Replace `const [design, setDesign] = useState<HudDesign>(loadDesign);` with:

```ts
  const [design, setDesignState] = useState<HudDesign>(loadDesign);
  // The design as of the last edit, read synchronously: two edits in one
  // event (a gesture's end, then a step) must each see the other's result,
  // which a state value only shows on the next render.
  const current = useRef(design);
  // The undo stacks. A ref, like `current`, so recording a step never waits
  // for a render; `histTick` re-renders the Undo and Redo buttons.
  const hist = useRef(undoStack.emptyHistory<HudDesign>());
  const [, setHistTick] = useState(0);
  const apply = (next: HudDesign) => { current.current = next; setDesignState(next); };

  /**
   * The page's one way to change the design. A step records the value it
   * replaced; a gesture records its start once and is closed by endGesture;
   * a nudge coalesces with the last one on the same selection. A step or a
   * nudge first closes any gesture still open, so a control that never
   * signalled its end still cannot merge into the next edit. An edit that
   * changes nothing records nothing.
   */
  const edit: Edit = (fn, mode: EditMode = 'step') => {
    const cur = current.current;
    const next = fn(cur);
    if (next === cur) return;
    if (mode === 'gesture') {
      hist.current = undoStack.begin(hist.current, cur);
    } else {
      hist.current = undoStack.commit(hist.current, cur, undoStack.sameJson);
      if (undoStack.sameJson(cur, next)) return;
      hist.current = typeof mode === 'object'
        ? undoStack.nudgeStep(hist.current, cur, mode.nudge, Date.now())
        : undoStack.push(hist.current, cur);
    }
    apply(next);
    setHistTick((t) => t + 1);
  };
  const endGesture = () => {
    if (hist.current.pending === null) return;
    hist.current = undoStack.commit(hist.current, current.current, undoStack.sameJson);
    setHistTick((t) => t + 1);
  };
  /** Escape or a lost pointer mid-drag: put the design back where the gesture began, recording nothing. */
  const cancelGesture = () => {
    const { h, restore } = undoStack.cancel(hist.current);
    hist.current = h;
    if (restore) apply(restore);
  };
  const doUndo = () => {
    endGesture();
    const r = undoStack.undo(hist.current, current.current);
    if (!r) return;
    hist.current = r.h;
    apply(r.value);
    setHistTick((t) => t + 1);
  };
  const doRedo = () => {
    endGesture();
    const r = undoStack.redo(hist.current, current.current);
    if (!r) return;
    hist.current = r.h;
    apply(r.value);
    setHistTick((t) => t + 1);
  };

  // Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo (Cmd on macOS), anywhere on
  // the page but inside a typing box, where the browser's own undo applies.
  // Registered once: the handlers read only refs and state setters.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || typedInto(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
```

Then replace every remaining `setDesign(` call in `Hud.tsx` as follows:

- `onPointerMove` (all three branches: child, card, element): `setDesign((cur) => ...)` becomes `edit((cur) => ..., 'gesture')`.
- `onPointerUp`: after `drag.current = null;` add `endGesture();`.
- `onKeyDown`, the arrow branch: replace the three `setDesign((d) => nudgeChild(...))`, `setDesign((d) => nudgeCard(...))`, `setDesign((d) => nudge(...))` calls with `edit((d) => ..., { nudge: key })`, computing before them (directly after `e.preventDefault();`):

```ts
    // Which selection this nudge moves: a run of nudges on the same one is one undo step.
    const key = [selected, selectedCard, selectedChild].join(':');
```
- `onKeyDown`, the Escape branch: at its top add `if (drag.current) { cancelGesture(); drag.current = null; return; }`.
- `changePreset`, `onSlotUpload`, `importDesign`, the share-link effect (`setDesign(decoded)`), the advanced toggle, the Aspect and Font selects: `setDesign(...)` becomes `edit(...)` with the same function (a plain value `setDesign(decoded)` becomes `edit(() => decoded)`, and `setDesign(next)` in `importDesign` becomes `edit(() => next)`).
- `patchStyle` becomes

```ts
  const patchStyle = (id: string, p: Partial<StyleOverride>, mode: EditMode = 'step') => edit((d) => ({
    ...d, styles: { ...d.styles, [id]: { ...(d.styles[id] ?? { kind: 'stock' }), ...p } },
  }), mode);
```

- The design Name input becomes

```tsx
          <input
            type="text" value={design.name}
            onInput={(e) => edit((d) => ({ ...d, name: (e.target as HTMLInputElement).value }), 'gesture')}
            {...endsOn(endGesture)}
          />
```

- The side-panel components: `<ChildControls design={design} setDesign={setDesign} ...` becomes `<ChildControls design={design} edit={edit} end={endGesture} ...`, `<ElementControls design={design} setDesign={setDesign} ...` becomes `<ElementControls design={design} edit={edit} end={endGesture} ...`, and `<ChildList design={design} setDesign={setDesign} ...` becomes `<ChildList design={design} edit={edit} ...`.

In `StyleRow`, change the `onChange` prop type to `onChange: (p: Partial<StyleOverride>, mode?: EditMode) => void;`, add a prop `onEnd: () => void`, and change the colour and opacity inputs to:

```tsx
      <input
        type="color" aria-label={`${slot.label} colour`} value={hexOf(color)}
        onInput={(e) => onChange({ color: withHex(color, (e.target as HTMLInputElement).value) }, 'gesture')}
        onChange={onEnd}
      />
      <input
        type="range" min={0} max={100} step={1} aria-label={`${slot.label} opacity`} value={alphaPct(color)}
        onInput={(e) => onChange({ color: withAlphaPct(color, parseFloat((e.target as HTMLInputElement).value)) }, 'gesture')}
        onChange={onEnd}
      />
```

and both `<StyleRow ...>` usages get `onChange={(p, mode) => patchStyle(slot.id, p, mode)} onEnd={endGesture}`.

At the start of the toolbar (`<div class="hud__toolbar">`), add:

```tsx
            <button
              type="button" class="btn btn--ghost btn--sm" aria-label="Undo" title="Undo (Ctrl+Z)"
              disabled={!hist.current.past.length} onClick={doUndo}
            >
              ↶ Undo
            </button>
            <button
              type="button" class="btn btn--ghost btn--sm" aria-label="Redo" title="Redo (Ctrl+Shift+Z)"
              disabled={!hist.current.future.length} onClick={doRedo}
            >
              ↷ Redo
            </button>
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS, no type errors. `grep -n "setDesign(" web/src/routes/Hud.tsx web/src/routes/hud/*.tsx` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/hud/controls.tsx web/src/routes/hud/ContextPanel.tsx web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Add undo and redo to the HUD editor: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y and toolbar buttons, one step per drag, slider or typed box"
```

---

### Task 11: The selection model on the canvas

**Files:**
- Modify: `web/src/routes/Hud.tsx`, `web/src/styles/app.css`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: Task 5's `NONE`, `TEAMMATES`, `hitAt`, `targetOf`, `pick`, `clickSelect`, `dragIntent`, `boxSelect`, `climb`, `breadcrumb`, `selectionLabel`, `sanitize`, `selectionKey`, `selectedIds`, `selectionFrames`, `sectionTargets`, `pieceTargets`, `pieceGuideToScreen`, `Selection`, `Hit`, `Mods`, `Crumb`; Task 4's `snapMove`, `unionBox`, `Guide`, `Snap`; Task 6 and 7's `startsOf`, `moveChildren`, `moveElements`, `moveCard`, `nudgeSelection`; Task 3's `cardFrame`; Task 10's `edit`, `endGesture`, `cancelGesture`.
- Produces: the page holds one `Selection` (the three Phase 1 picks `selected`, `selectedCard`, `selectedChild` are gone); a click (press and release within 3 screen pixels) picks through `clickSelect`; a drag moves the selection or the section under the pointer through `dragIntent`, with snap guides (Alt turns them off); Shift+drag draws a box; hover outlines what a click would pick; Escape climbs, or cancels a drag under way; the breadcrumb sits at the canvas corner. The Phase 1 `snap()` is removed (replaced by `guides.ts`).

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, change the Hud import line to `import { toUnits } from './Hud';`, delete `describe('snap', ...)`, and add these helpers directly above `describe('Hud page', ...)`:

```ts
/** happy-dom lays nothing out: a 1:1 box makes client pixels HUD units. */
const unitCanvas = (container: HTMLElement) => {
  const canvas = container.querySelector('canvas') as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return canvas;
};
type Keys = { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean };
/** A press and release on one spot: a click. */
const clickAt = (canvas: HTMLElement, x: number, y: number, keys: Keys = {}) => {
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y, pointerId: 1, ...keys });
  fireEvent.pointerUp(canvas, { clientX: x, clientY: y, pointerId: 1, ...keys });
};
/** A drag, with Alt held unless told otherwise, so the numbers are the pointer's and not a snap's. */
const dragFrom = (canvas: HTMLElement, from: [number, number], to: [number, number], keys: Keys = { altKey: true }) => {
  fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1], pointerId: 1, ...keys });
  fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1], pointerId: 1, ...keys });
  fireEvent.pointerUp(canvas, { clientX: to[0], clientY: to[1], pointerId: 1, ...keys });
};
```

Delete the three Phase 1 canvas tests `drags a Free teammate card on the canvas`, `in Free, drags an unselected card even over its children, and reaches children only in the selected card` and `picks a child inside the selected teammates on the canvas, drags it, and steps back up with Escape`, and add inside `describe('Hud page', ...)`:

```ts
  // The stock fitted row: card 1 at (13, 441), its portrait (13, 443) to (36, 466).
  it('picks a piece in one click, shows its path, and climbs back up with Escape', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Up to Teammates' })).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText(/select an element/i)).toBeTruthy();
  });

  it('picks one level up with Ctrl+click, and from the breadcrumb', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454, { ctrlKey: true });
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    clickAt(canvas, 24, 454);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Up to Teammates' }));
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
  });

  it('moves the whole team when a drag starts on a piece not yet picked', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    dragFrom(canvas, [24, 454], [24, 404]);
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('355');
  });

  it('moves just the picked piece when the drag starts on it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    dragFrom(canvas, [24, 454], [34, 454]);
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('23');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('38');
  });

  it('snaps a moving piece to the others unless Alt is held', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    // Moved 10 right the portrait's centre is 2.5 short of the health bar's left edge (37), so it snaps there.
    dragFrom(canvas, [24, 454], [34, 454], {});
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('26');
  });

  it('cancels a drag with Escape, putting everything back and recording nothing', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    fireEvent.pointerDown(canvas, { clientX: 24, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 44, clientY: 454, pointerId: 1, altKey: true });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('33');
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('in Free, picks a piece of any card in one click, and a drag on another card moves that card', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    // Card 2 sits at (153, 441); (160, 450) is its portrait.
    clickAt(canvas, 160, 450);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Up to Card 2' })).toBeTruthy();
    // (133, 442) is on card 1 but on none of its pieces.
    dragFrom(canvas, [133, 442], [233, 242]);
    expect(screen.getByText('Teammate card 1')).toBeTruthy();
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('113');
    expect((screen.getByLabelText('Card 1 Y') as HTMLInputElement).value).toBe('241');
  });

  it('clears the selection with a click on empty screen', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 426, 100);
    expect(screen.getByText(/select an element/i)).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL. With the Phase 1 two-level selection, a first click on a portrait selects the Teammates, there is no breadcrumb, and Escape does not restore a drag.

- [ ] **Step 3: Implement**

In `web/src/styles/app.css`, below the `.hud__canvas` rule, add:

```css
/* The canvas and what floats over it: the breadcrumb at its corner and,
 * later, the right-click menu. */
.hud__canvaswrap { position: relative; }
.hud__crumbs {
  position: absolute; left: var(--sp-2); top: var(--sp-2);
  display: flex; align-items: center; gap: var(--sp-1);
  padding: 2px var(--sp-2); background: rgba(0, 0, 0, 0.65);
  font-size: var(--fs-dense); color: var(--text-bright);
}
.hud__crumbs button { background: none; border: 0; padding: 0; color: var(--text-muted); font: inherit; cursor: pointer; }
.hud__crumbs button:hover { color: var(--text-bright); text-decoration: underline; }
```

In `web/src/routes/Hud.tsx`:

Delete `snap` and its doc comment. Change the first import to `import { Fragment } from 'preact';` plus `import { useEffect, useRef, useState } from 'preact/hooks';`, and make the `hud/*` imports:

```ts
import {
  loadDesign, saveDesign, validateDesign, safeName, encodeShare, decodeShare, DEFAULT_DESIGN,
  type HudDesign, type StyleOverride, type Box,
} from '../hud/design';
import { screenW, SCREEN_H, type Aspect } from '../hud/units';
import { elementById } from '../hud/elements';
import { elementRect, teamLayout, teamCardRects, cardFrame, packHud, type BuildAssets, type CardChild } from '../hud/build';
import { drawHud, visibleElements, type Side } from '../hud/mock';
import type { CardState } from '../hud/render';
import { SLOTS, type StyleSlot } from '../hud/slots';
import type { Preset } from '../hud/base';
import * as undoStack from '../hud/history';
import { elementsTouched, hasOverrides, moveElements, moveCard, moveChildren, startsOf, nudgeSelection } from '../hud/edit';
import { snapMove, unionBox, type Guide, type Snap } from '../hud/guides';
import {
  NONE, TEAMMATES, hitAt, targetOf, pick, clickSelect, dragIntent, boxSelect, climb, breadcrumb, selectionLabel,
  sanitize, selectionKey, selectedIds, selectionFrames, sectionTargets, pieceTargets, pieceGuideToScreen,
  type Selection, type Hit, type Mods, type Crumb,
} from '../hud/selection';
import { ElementControls, ChildList, ChildControls } from './hud/ContextPanel';
import { endsOn, typedInto, hexOf, alphaPct, withHex, withAlphaPct, type Edit, type EditMode } from './hud/controls';
```

Replace everything from `type Rect4 = ...` to the end of the file with:

```tsx
/** A press on the canvas: where it started and what was under it, until it becomes a click or a drag. */
interface Press { cx: number; cy: number; ux: number; uy: number; mods: Mods; hit: Hit; moved: boolean }

/**
 * What a drag is doing, with where everything started: each pointer move
 * applies the whole delta to the start, so rounding and clamps never drift
 * over a long drag.
 */
type Drag =
  | { kind: 'elements'; ids: string[]; starts: Record<string, Box> }
  | { kind: 'card'; card: number; start: Box }
  | { kind: 'children'; names: string[]; card: number; starts: Record<string, CardChild> }
  | { kind: 'box' };

/** A press and release within this many screen pixels is a click; anything further is a drag. */
const CLICK_PX = 3;
const NO_SNAP: Snap = { dx: 0, dy: 0, guides: [] };

const CARD_STATES: { key: CardState; label: string }[] = [
  { key: 'healthy', label: 'Healthy' }, { key: 'down', label: 'Down' }, { key: 'dead', label: 'Dead' },
];

/** The selection's path at the canvas corner. Each ancestor is a button that selects its level; the last is where you are. */
function Crumbs({ crumbs, onSelect }: { crumbs: Crumb[]; onSelect: (s: Selection) => void }) {
  if (!crumbs.length) return null;
  return (
    <nav class="hud__crumbs" aria-label="Selection path">
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">›</span>}
          {i < crumbs.length - 1
            ? <button type="button" aria-label={`Up to ${c.label}`} onClick={() => onSelect(c.sel)}>{c.label}</button>
            : <span>{c.label}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

const modsOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods => ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });

export default function Hud() {
  const [design, setDesignState] = useState<HudDesign>(loadDesign);
  // The design as of the last edit, read synchronously: two edits in one
  // event (a gesture's end, then a step) must each see the other's result,
  // which a state value only shows on the next render.
  const current = useRef(design);
  // The undo stacks. A ref, like `current`, so recording a step never waits
  // for a render; `histTick` re-renders the Undo and Redo buttons.
  const hist = useRef(undoStack.emptyHistory<HudDesign>());
  const [, setHistTick] = useState(0);
  const apply = (next: HudDesign) => { current.current = next; setDesignState(next); };

  /**
   * The page's one way to change the design. A step records the value it
   * replaced; a gesture records its start once and is closed by endGesture;
   * a nudge coalesces with the last one on the same selection. A step or a
   * nudge first closes any gesture still open, so a control that never
   * signalled its end still cannot merge into the next edit. An edit that
   * changes nothing records nothing.
   */
  const edit: Edit = (fn, mode: EditMode = 'step') => {
    const cur = current.current;
    const next = fn(cur);
    if (next === cur) return;
    if (mode === 'gesture') {
      hist.current = undoStack.begin(hist.current, cur);
    } else {
      hist.current = undoStack.commit(hist.current, cur, undoStack.sameJson);
      if (undoStack.sameJson(cur, next)) return;
      hist.current = typeof mode === 'object'
        ? undoStack.nudgeStep(hist.current, cur, mode.nudge, Date.now())
        : undoStack.push(hist.current, cur);
    }
    apply(next);
    setHistTick((t) => t + 1);
  };
  const endGesture = () => {
    if (hist.current.pending === null) return;
    hist.current = undoStack.commit(hist.current, current.current, undoStack.sameJson);
    setHistTick((t) => t + 1);
  };
  /** Escape or a lost pointer mid-drag: put the design back where the gesture began, recording nothing. */
  const cancelGesture = () => {
    const { h, restore } = undoStack.cancel(hist.current);
    hist.current = h;
    if (restore) apply(restore);
  };
  const doUndo = () => {
    endGesture();
    const r = undoStack.undo(hist.current, current.current);
    if (!r) return;
    hist.current = r.h;
    apply(r.value);
    setHistTick((t) => t + 1);
  };
  const doRedo = () => {
    endGesture();
    const r = undoStack.redo(hist.current, current.current);
    if (!r) return;
    hist.current = r.h;
    apply(r.value);
    setHistTick((t) => t + 1);
  };

  const [side, setSide] = useState<Side>('survivor');
  const [sel, setSel] = useState<Selection>(NONE);
  // A new design wholesale (another preset, an import, a share link) keeps
  // an element selection and climbs a card or pieces to the Teammates.
  const dropPicks = () => setSel((s) => (s.kind === 'card' || s.kind === 'children' ? TEAMMATES : s));
  // Which state the teammate cards are previewed in. Game code picks it in
  // game; this only changes the picture, never the design or the file.
  const [cardState, setCardState] = useState<CardState>('healthy');
  const [backdrop, setBackdrop] = useState<Backdrop>('scene');
  const [status, setStatus] = useState('');
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  // What the pointer is over while nothing is pressed, and whether Ctrl is
  // held: the hover outline shows exactly what a click would pick.
  const [hover, setHover] = useState<{ hit: Hit; ctrl: boolean } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  // The reader's own screenshot for the "My screenshot" backdrop. A ref
  // rather than state, like Crosshair.tsx's `shot`: it is never rendered
  // directly, only drawn into the canvas, so a re-render is driven by the
  // tick counter below instead of by the image itself.
  const shot = useRef<HTMLImageElement | null>(null);
  const [imgTick, setImgTick] = useState(0);

  // The press and the drag under way, if any. Refs rather than state: they
  // change on every pointermove and must never themselves trigger a render.
  const press = useRef<Press | null>(null);
  const drag = useRef<Drag | null>(null);

  // Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo (Cmd on macOS), anywhere on
  // the page but inside a typing box, where the browser's own undo applies.
  // Registered once: the handlers read only refs and state setters.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || typedInto(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // One effect draws everything, so the canvas can never disagree with the
  // design it is supposed to be showing, and every outline in it comes from
  // selection.ts's measurements of the generated trees.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    // 1:1 pixels: the backing store matches the CSS box, which is itself
    // locked to the design's aspect ratio by the inline aspect-ratio style.
    const rect = c.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

    const shotSize = shot.current ? { w: shot.current.naturalWidth, h: shot.current.naturalHeight } : null;
    drawBackdrop(ctx, w, h, backdrop, shot.current, shotSize);
    const hovered = hover && !press.current ? targetOf(design, hover.hit, hover.ctrl) : NONE;
    drawHud(ctx, w, h, design, side, selectedIds(sel), () => setImgTick((t) => t + 1), {
      state: cardState,
      frames: selectionFrames(design, sel),
      hover: hovered.kind === 'none' ? null : { rects: selectionFrames(design, hovered), label: selectionLabel(design, hovered) },
      marquee,
      guides,
    });
  }, [design, side, sel, backdrop, imgTick, cardState, hover, guides, marquee]);

  // The preview draws labels in Roboto Condensed, the Modern preset's real
  // font and the closest shipped stand-in for stock's Trade Gothic. Canvas
  // text only uses a web font once the browser has it, so register the two
  // faces on mount and redraw when they arrive. happy-dom has no FontFace,
  // and a browser that refuses is left drawing the fallback stack.
  useEffect(() => {
    try {
      const faces = [new FontFace('Roboto Condensed', `url(${regularUrl})`),
                     new FontFace('Roboto Condensed', `url(${boldUrl})`, { weight: '700' })];
      for (const f of faces) document.fonts.add(f);
      Promise.all(faces.map((f) => f.load())).then(() => setImgTick((t) => t + 1)).catch(() => { /* fallback stack stays */ });
    } catch { /* no FontFace here: the fallback stack stays */ }
  }, []);

  // A selection the design or the side no longer has is trimmed or dropped:
  // after an undo, an import, a removed health number, a layout change.
  useEffect(() => { setSel((s) => sanitize(design, side, s)); }, [design, side]);

  // Debounced rather than immediate: a drag changes the design on every
  // pointermove, and an undebounced save would run a synchronous
  // JSON.stringify plus localStorage.setItem on every one of those ticks.
  // Resetting this timer on each change coalesces a burst (a drag, a
  // held-down arrow key, a slider) into one write once motion settles,
  // while a single change still lands within 300ms either way.
  useEffect(() => {
    const t = setTimeout(() => saveDesign(design), 300);
    return () => clearTimeout(t);
  }, [design]);

  // Mount only: a share link is meant to be consumed once. Re-running this
  // whenever `design` changes would try to re-import the same link every
  // time the reader so much as drags an element.
  useEffect(() => {
    if (!location.hash.startsWith('#d=')) return;
    const raw = location.hash.slice(3);
    let cancelled = false;
    (async () => {
      const decoded = await decodeShare(raw);
      if (cancelled) return;
      if (!decoded) {
        setStatus('That link is damaged.');
      } else {
        let apply = true;
        if (hasOverrides(design)) {
          apply = await confirm({
            title: 'Load the HUD design from this link? It will replace the one saved on this browser.',
            confirmLabel: 'Load link', cancelLabel: 'Keep mine',
          });
        }
        if (!cancelled && apply) { edit(() => decoded); dropPicks(); }
      }
      if (!cancelled) history.replaceState(null, '', location.pathname + location.search);
    })();
    return () => { cancelled = true; };
    // `design` is deliberately read only from the closure captured at mount:
    // this effect must run exactly once, not on every subsequent edit.
  }, []);

  const pointerUnits = (e: { clientX: number; clientY: number }) => toUnits(e, canvas.current!.getBoundingClientRect());

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;                            // the right button opens the menu instead
    const c = canvas.current;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    endGesture();
    const { ux, uy } = pointerUnits(e);
    press.current = { cx: e.clientX, cy: e.clientY, ux, uy, mods: modsOf(e), hit: hitAt(current.current, side, cardState, ux, uy), moved: false };
    drag.current = null;
    setHover(null);
  };

  /** What a drag of this selection starts from: every position read back from the generator. */
  const dragFor = (s: Selection, d: HudDesign): Drag | null => {
    switch (s.kind) {
      case 'elements':
        return { kind: 'elements', ids: s.ids, starts: Object.fromEntries(s.ids.map((id) => {
          const { x, y, w, h } = elementRect(d, id, d.aspect);
          return [id, { x, y, w, h }];
        })) };
      case 'card': return { kind: 'card', card: s.card, start: teamCardRects(d, d.aspect)[s.card] };
      case 'children': return { kind: 'children', names: s.names, card: s.card, starts: startsOf(d, s.names) };
      default: return null;
    }
  };

  /** The pointer has left the click radius: decide what the drag moves, selecting a section it picks up. */
  const startDrag = (p: Press): Drag | null => {
    const intent = dragIntent(current.current, sel, p.hit, p.mods);
    if (intent.kind === 'box') return { kind: 'box' };
    if (intent.kind === 'none') return null;
    if (intent.sel !== sel) setSel(intent.sel);
    return dragFor(intent.sel, current.current);
  };

  const moveDrag = (d: Drag, p: Press, ux: number, uy: number, alt: boolean) => {
    const dux = ux - p.ux, duy = uy - p.uy;
    const cur = current.current;
    if (d.kind === 'box') {
      setMarquee({ x: Math.min(p.ux, ux), y: Math.min(p.uy, uy), w: Math.abs(ux - p.ux), h: Math.abs(uy - p.uy) });
      return;
    }
    if (d.kind === 'children') {
      // Pieces are stored unscaled in the card file's unfitted frame: the
      // pointer delta is divided by the scale, the snap is found in that
      // frame, and its guides are drawn where the pieces are drawn.
      const f = cardFrame(cur);
      const dx = dux / f.k, dy = duy / f.k;
      const start = unionBox(Object.values(d.starts));
      if (!start) return;
      const s = alt ? NO_SNAP : snapMove({ ...start, x: start.x + dx, y: start.y + dy }, pieceTargets(cur, cardState, d.names));
      const card = teamCardRects(cur, cur.aspect)[d.card];
      setGuides(s.guides.map((g) => pieceGuideToScreen(g, card, f)));
      edit((x) => moveChildren(x, d.names, d.starts, dx + s.dx, dy + s.dy), 'gesture');
      return;
    }
    const moving: Selection = d.kind === 'card' ? { kind: 'card', card: d.card } : { kind: 'elements', ids: d.ids };
    const start = d.kind === 'card' ? d.start : unionBox(Object.values(d.starts));
    if (!start) return;
    const s = alt ? NO_SNAP : snapMove({ ...start, x: start.x + dux, y: start.y + duy }, sectionTargets(cur, side, moving));
    setGuides(s.guides);
    edit((x) => (d.kind === 'card'
      ? moveCard(x, d.card, d.start, dux + s.dx, duy + s.dy)
      : moveElements(x, d.ids, d.starts, dux + s.dx, duy + s.dy)), 'gesture');
  };

  const onPointerMove = (e: PointerEvent) => {
    const { ux, uy } = pointerUnits(e);
    const p = press.current;
    if (!p) {
      setHover({ hit: hitAt(current.current, side, cardState, ux, uy), ctrl: e.ctrlKey || e.metaKey });
      return;
    }
    if (!p.moved) {
      if (Math.hypot(e.clientX - p.cx, e.clientY - p.cy) <= CLICK_PX) return;
      p.moved = true;
      drag.current = startDrag(p);
    }
    if (drag.current) moveDrag(drag.current, p, ux, uy, e.altKey);
  };

  const onPointerUp = (e: PointerEvent) => {
    const p = press.current, d = drag.current;
    // Cleared before the capture is released, so the lostpointercapture that
    // release fires is not mistaken for a drag lost mid-way.
    press.current = null;
    drag.current = null;
    const c = canvas.current;
    if (c && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    setGuides([]);
    setMarquee(null);
    if (!p) return;
    if (!p.moved) { setSel((s) => clickSelect(current.current, s, p.hit, p.mods)); return; }
    if (d?.kind === 'box') {
      const { ux, uy } = pointerUnits(e);
      setSel(boxSelect(current.current, side, cardState, { x: p.ux, y: p.uy }, { x: ux, y: uy }));
      return;
    }
    endGesture();
  };

  /** A drag that cannot finish (Escape, a lost pointer) puts the design back and records nothing. */
  const abortDrag = () => {
    if (drag.current && drag.current.kind !== 'box') cancelGesture();
    press.current = null;
    drag.current = null;
    setGuides([]);
    setMarquee(null);
  };

  // Arrows nudge (Shift by 10), Escape climbs or cancels a drag, Tab and
  // Shift+Tab cycle the side's elements: the editor works without a mouse.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (press.current) { abortDrag(); return; }
      setSel((s) => climb(current.current, s));
      return;
    }

    if (e.key === 'Tab' && e.target === canvas.current) {
      e.preventDefault();
      const list = visibleElements(side).map((el) => el.id);
      if (list.length === 0) return;
      const forward = !e.shiftKey;
      const at = sel.kind === 'elements' && sel.ids.length === 1 ? list.indexOf(sel.ids[0]) : -1;
      const next = at === -1 ? (forward ? 0 : list.length - 1) : (at + (forward ? 1 : -1) + list.length) % list.length;
      setSel({ kind: 'elements', ids: [list[next]] });
      return;
    }

    const amount = e.shiftKey ? 10 : 1;
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -amount], ArrowDown: [0, amount], ArrowLeft: [-amount, 0], ArrowRight: [amount, 0],
    };
    const delta = deltas[e.key];
    if (!delta || sel.kind === 'none') return;
    e.preventDefault();
    const s = sel;
    edit((d) => nudgeSelection(d, s, delta[0], delta[1]), { nudge: selectionKey(s) });
  };

  /** Switching preset keeps whatever moves the reader made, but they were
   *  placed for the other layout's own panel sizes, so a design with any
   *  moved elements asks first whether to drop them. Either answer switches
   *  the preset; only whether the moves survive it differs. */
  const changePreset = async (preset: Preset) => {
    if (preset === design.preset) return;
    let resetElements = false;
    if (elementsTouched(design) || Object.keys(design.children).length > 0) {
      resetElements = await confirm({
        title: 'Switching preset keeps your moves and inside edits, but they were placed for the other layout. Reset them as well?',
        confirmLabel: 'Reset', cancelLabel: 'Keep',
      });
    }
    edit((d) => ({ ...d, preset, ...(resetElements ? { elements: structuredClone(DEFAULT_DESIGN.elements), children: {} } : {}) }));
    dropPicks();
  };

  const patchStyle = (id: string, p: Partial<StyleOverride>, mode: EditMode = 'step') => edit((d) => ({
    ...d, styles: { ...d.styles, [id]: { ...(d.styles[id] ?? { kind: 'stock' }), ...p } },
  }), mode);

  const onSlotUpload = async (slot: StyleSlot, file: File) => {
    try {
      const { png } = await decodeUpload(file, slot.size.w, slot.size.h);
      setUploadErrors((u) => {
        if (!(slot.id in u)) return u;
        const n = { ...u }; delete n[slot.id]; return n;
      });
      edit((d) => ({
        ...d,
        images: { ...d.images, [slot.id]: { w: slot.size.w, h: slot.size.h, png } },
        styles: { ...d.styles, [slot.id]: { ...(d.styles[slot.id] ?? { kind: 'stock' }), kind: 'image' } },
      }));
    } catch (err) {
      setUploadErrors((u) => ({ ...u, [slot.id]: (err as Error).message }));
    }
  };

  const pickShot = (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      shot.current = img;
      setBackdrop('shot');
      setImgTick((n) => n + 1);
      setUploadErrors((u) => {
        if (!('shot' in u)) return u;
        const n2 = { ...u }; delete n2.shot; return n2;
      });
      URL.revokeObjectURL(url);
    };
    // Without this, a non-image file picked here fails silently (no status,
    // no error, the old backdrop just stays) and leaks the object URL, since
    // revocation otherwise only ever happens inside onload.
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setUploadErrors((u) => ({ ...u, shot: 'That file is not an image the browser can read.' }));
    };
    img.src = url;
  };

  const download = async () => {
    try {
      const assets = await assetsFor(design);
      // Nothing that reaches a player's game skips the validator. Every
      // control already guards its own input, but this is the one place the
      // design turns into files, so a future control that forgets cannot put
      // an out-of-range or non-finite number into a shipped .res file.
      const p = packHud(validateDesign({ ...design, name: safeName(design.name) }), assets);
      const blob = new Blob([p.bytes], { type: p.mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = p.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setStatus(`Saved ${p.filename}.`);
    } catch (err) {
      // The generator's own errors name the file and panel that broke, which
      // is exactly what is needed to file a useful bug report.
      setStatus((err as Error).message);
    }
  };

  const copyShareLink = async () => {
    const link = `${location.origin}/hud#d=${await encodeShare(design)}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      setStatus(`Could not copy automatically. Here is the link: ${link}`);
      return;
    }
    setStatus(Object.keys(design.images).length
      ? 'Copied. Uploaded images are not in a link; use Export to share those.'
      : 'Copied.');
  };

  const exportDesign = () => {
    const blob = new Blob([JSON.stringify(design)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName(design.name)}.hud.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const importDesign = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const next = validateDesign(JSON.parse(text));
      edit(() => next);
      dropPicks();
      setStatus(`Imported ${next.name}.`);
    } catch {
      setStatus('That file is not a HUD design.');
    }
  };

  const sideElements = visibleElements(side);
  const basicSlots = SLOTS.filter((s) => !s.advancedOnly);
  const advancedSlots = SLOTS.filter((s) => s.advancedOnly);
  const pickCard = (card: number | null) => setSel(card === null ? TEAMMATES : { kind: 'card', card });
  const teamPicked = sel.kind === 'card' || sel.kind === 'children' || (sel.kind === 'elements' && sel.ids.length === 1 && sel.ids[0] === 'teamColumn');
  const oneChild = sel.kind === 'children' && sel.names.length === 1 ? sel.names[0] : null;

  return (
    <div class="page page--wide">
      <PageHeader eyebrow="Tool" title="HUD Editor" />

      <div class="hud">
        <Panel class="hud__stage">
          <div class="hud__toolbar">
            <button
              type="button" class="btn btn--ghost btn--sm" aria-label="Undo" title="Undo (Ctrl+Z)"
              disabled={!hist.current.past.length} onClick={doUndo}
            >
              ↶ Undo
            </button>
            <button
              type="button" class="btn btn--ghost btn--sm" aria-label="Redo" title="Redo (Ctrl+Shift+Z)"
              disabled={!hist.current.future.length} onClick={doRedo}
            >
              ↷ Redo
            </button>

            <label>
              Preset{' '}
              <select
                value={design.preset}
                onChange={(e) => { void changePreset((e.target as HTMLSelectElement).value as Preset); }}
              >
                <option value="stock">Stock</option>
                <option value="modern">Modern</option>
              </select>
            </label>

            <Tabs
              tabs={[{ key: 'survivor', label: 'Survivor' }, { key: 'infected', label: 'Infected' }]}
              active={side}
              onSelect={(k) => { setSide(k as Side); setSel(NONE); }}
            />

            {side === 'survivor' && (
              <Tabs
                tabs={CARD_STATES.map((s) => ({ key: s.key, label: s.label }))}
                active={cardState}
                onSelect={(k) => setCardState(k as CardState)}
              />
            )}

            <label>
              Aspect{' '}
              <select
                value={design.aspect}
                onChange={(e) => edit((d) => ({ ...d, aspect: (e.target as HTMLSelectElement).value as Aspect }))}
              >
                <option value="16:9">16:9</option>
                <option value="16:10">16:10</option>
                <option value="4:3">4:3</option>
              </select>
            </label>

            <label>
              Backdrop{' '}
              <select
                value={backdrop}
                onChange={(e) => setBackdrop((e.target as HTMLSelectElement).value as Backdrop)}
              >
                {BACKDROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {backdrop === 'shot' && (
              <label class="hud__file hud__file--inline">
                <span class="btn btn--ghost btn--sm">Load screenshot</span>
                <input type="file" accept="image/*" aria-label="Load a screenshot for the backdrop" onChange={pickShot} />
              </label>
            )}
            {backdrop === 'shot' && uploadErrors.shot && <span class="error">{uploadErrors.shot}</span>}

            <label>
              Font{' '}
              <select
                value={design.font} disabled={design.preset === 'modern'}
                onChange={(e) => edit((d) => ({ ...d, font: (e.target as HTMLSelectElement).value as 'preset' | 'roboto' }))}
              >
                <option value="preset">Preset default</option>
                <option value="roboto">Roboto Condensed</option>
              </select>
            </label>
            {design.preset === 'modern' && <span class="muted hud__note">Modern already uses Roboto Condensed.</span>}
          </div>

          <div class="hud__canvaswrap">
            <canvas
              ref={canvas}
              tabIndex={0}
              class="hud__canvas"
              style={{ aspectRatio: `${screenW(design.aspect)} / ${SCREEN_H}` }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onLostPointerCapture={() => { if (press.current) abortDrag(); }}
              onPointerLeave={() => setHover(null)}
              onKeyDown={onKeyDown}
            />
            <Crumbs crumbs={breadcrumb(design, sel)} onSelect={setSel} />
          </div>

          {/* The only way to reach an element that is hidden or off screen. */}
          <div class="hud__list">
            {sideElements.map((el) => {
              const visible = elementRect(design, el.id, design.aspect).visible;
              const active = sel.kind === 'elements' && sel.ids.includes(el.id);
              return (
                <button
                  key={el.id}
                  type="button"
                  class={`hud__pill${active ? ' is-active' : ''}${visible ? '' : ' hud__pill--hidden'}`}
                  onClick={(e) => setSel((s) => pick(s, { kind: 'elements', ids: [el.id] }, e.shiftKey))}
                >
                  {el.label}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel class="hud__side">
          {oneChild
            ? <ChildControls design={design} edit={edit} end={endGesture} name={oneChild} onBack={() => setSel(TEAMMATES)} />
            : sel.kind === 'elements' && sel.ids.length === 1
              ? <ElementControls design={design} edit={edit} end={endGesture} id={sel.ids[0]} selectedCard={null} onPickCard={pickCard} />
              : sel.kind === 'card'
                ? <ElementControls design={design} edit={edit} end={endGesture} id="teamColumn" selectedCard={sel.card} onPickCard={pickCard} />
                : <p class="muted">Select an element on the canvas or in the list below it.</p>}
          {teamPicked && (
            <ChildList
              design={design} edit={edit} selectedChild={oneChild}
              onPick={(name) => setSel({ kind: 'children', names: [name], card: sel.kind === 'children' || sel.kind === 'card' ? sel.card : 0 })}
            />
          )}
        </Panel>
      </div>

      <Panel>
        <h3>Styles</h3>
        {basicSlots.map((slot) => (
          <StyleRow
            key={slot.id} slot={slot} style={design.styles[slot.id]} error={uploadErrors[slot.id]}
            onChange={(p, mode) => patchStyle(slot.id, p, mode)} onEnd={endGesture}
            onUpload={(f) => { void onSlotUpload(slot, f); }}
          />
        ))}

        <button
          type="button" class="btn btn--ghost btn--sm hud__advtoggle"
          onClick={() => edit((d) => ({ ...d, advanced: !d.advanced }))}
        >
          {design.advanced ? 'Turn off advanced mode' : 'Turn on advanced mode'}
        </button>
        <p class="muted hud__note">
          Advanced mode also restyles the incapacitated and dead panels and the weapon boxes. The game only allows
          that from a folder you add to gameinfo.txt, so the download becomes a zip with instructions.
        </p>

        {design.advanced && advancedSlots.map((slot) => (
          <StyleRow
            key={slot.id} slot={slot} style={design.styles[slot.id]} error={uploadErrors[slot.id]}
            onChange={(p, mode) => patchStyle(slot.id, p, mode)} onEnd={endGesture}
            onUpload={(f) => { void onSlotUpload(slot, f); }}
          />
        ))}
      </Panel>

      <Panel>
        <h3>Save your HUD</h3>
        <label class="hud__row">
          <span>Name</span>
          <input
            type="text" value={design.name}
            onInput={(e) => edit((d) => ({ ...d, name: (e.target as HTMLInputElement).value }), 'gesture')}
            {...endsOn(endGesture)}
          />
          <span />
        </label>

        <button type="button" class="btn btn--block" onClick={() => { void download(); }}>
          {design.advanced ? 'Download .zip' : 'Download .vpk'}
        </button>
        <p class="muted hud__note">
          {design.advanced
            ? 'Unzip it and follow README.txt. It works alongside a crosshair addon. A rebuilt HUD only shows after a game restart. Custom HUDs are allowed on the Riverside servers.'
            : <>Put the file in <code>left4dead/addons/</code> and restart the game. It works alongside a crosshair from the Crosshair page. Custom HUDs are allowed on the Riverside servers.</>}
        </p>
        {!design.advanced && (
          <p class="muted hud__note">
            Also using a crosshair addon? The game keeps only one layout file, and it is usually the
            crosshair's, so this HUD's positions would not show. Open <code>left4dead/addonlist.txt</code> and
            move this HUD's line above the crosshair's. Your crosshair keeps working.
          </p>
        )}

        <div class="hud__sharebar">
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => { void copyShareLink(); }}>Copy share link</button>
          <button type="button" class="btn btn--ghost btn--sm" onClick={exportDesign}>Export</button>
          <label class="hud__file hud__file--inline">
            <span class="btn btn--ghost btn--sm">Import</span>
            <input
              type="file" accept="application/json,.json" aria-label="Import a HUD design file"
              onChange={(e) => { void importDesign(e); }}
            />
          </label>
        </div>

        {status && <p class="muted hud__status">{status}</p>}
        {teamLayout(design, elementById('teamColumn')!).fitEmpty && (
          <p class="muted hud__status">Every part of the teammate card is hidden, so it keeps its full size instead of fitting.</p>
        )}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS, no type errors. Every Phase 1 page test not deleted in Step 1 still passes (the Layers-free pill list still selects elements and pieces).

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx web/src/styles/app.css
git commit -m "Pick the deepest piece in one click, move a section by dragging it, snap with guides, and show the selection path on the canvas"
```

---

### Task 12: Handles

**Files:**
- Modify: `web/src/routes/Hud.tsx`, `web/src/hud/mock.ts`
- Test: `web/src/routes/Hud.test.tsx`, `web/src/hud/mock.test.ts`

**Interfaces:**
- Consumes: Task 5's `selectionBox`, `handlesFor`, `handlePoint`, `handleAt`; Task 4's `snapEdges`, `Handle`; Task 6 and 7's `resizeBox`, `resizeElement`, `scaleElement`, `resizeChild`, `scaleChildren`, `cornerFactor`, `anchorOf`; `teamChild` (`children.ts`).
- Produces: the selection's box and handles are drawn; a press on a handle (5 screen pixels of slack, nearest wins) resizes: a free element by any of 8 handles, a scaled element by its corners (scale, from the opposite corner), one piece by its handles (`wh` 8, square and the item icons 4 corners), several pieces by 4 corners (scaled together). Shift keeps the ratio on a side handle; free sizes snap their dragged edges unless Alt or Shift is held. The cursor shows the resize direction over a handle. `mock.ts`'s `childCornerAt` (the Phase 1 corner hit) is removed.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, add inside `describe('Hud page', ...)`:

```ts
  it('resizes the chat box from its right handle and from its left, which moves it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    // Chat is (10, 275) to (330, 395): its right handle is at (330, 335).
    dragFrom(canvas, [330, 335], [360, 335]);
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('350');
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('10');
    dragFrom(canvas, [10, 335], [0, 335]);
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('360');
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('0');
  });

  it('scales an element from a corner handle, the opposite corner staying put', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    // Your health is (728, 389) to (853, 480); its top-left corner out by half.
    dragFrom(canvas, [728, 389], [665.5, 343.5]);
    expect((screen.getByRole('slider', { name: /^Scale/ }) as HTMLInputElement).value).toBe('1.5');
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('666');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('344');
  });

  it('resizes a piece by its side handle, and a portrait by its corner keeping it square', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    // Card 1's health bar runs (37, 457) to (133, 464): its right handle sits between two corners 3.5 away.
    clickAt(canvas, 60, 460);
    expect(screen.getByText('Health bar', { selector: 'legend' })).toBeTruthy();
    dragFrom(canvas, [133, 460.5], [143, 460.5]);
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('106');
    clickAt(canvas, 24, 454);
    dragFrom(canvas, [36, 466], [41, 471]);
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('28');
  });

  it('scales several pieces together by a corner of their box', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    // Portrait and bar together span (13, 443) to (133, 466): drag the bottom-right corner to half size.
    dragFrom(canvas, [133, 466], [73, 454.5]);
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('12');
  });
```

In `web/src/hud/mock.test.ts`, remove `childCornerAt` from the import, delete the test `finds a resizable child's corner, and never one that has no size of its own`, and in the test `searches only one card when asked, as the page does in Free` delete its last two lines (the `const head = ...` line and the `childCornerAt` expectation).

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL. A press on a handle is a plain move today: the chat box moves instead of widening, Your health moves instead of scaling, and the pieces move rather than resize.

- [ ] **Step 3: Implement**

In `web/src/hud/mock.ts`, delete `childCornerAt` and its doc comment.

In `web/src/routes/Hud.tsx`, extend the imports:

```ts
import { teamChild } from '../hud/children';
import {
  elementsTouched, hasOverrides, moveElements, moveCard, moveChildren, startsOf, nudgeSelection,
  resizeBox, resizeElement, scaleElement, resizeChild, scaleChildren, cornerFactor, anchorOf,
} from '../hud/edit';
import { snapMove, snapEdges, unionBox, type Guide, type Snap, type Handle } from '../hud/guides';
```

and add `selectionBox, handlesFor, handlePoint, handleAt` to the `../hud/selection` import.

Change `Press` and `Drag` to:

```ts
/** A press on the canvas: where it started, what was under it, and the handle it caught, until it becomes a click or a drag. */
interface Press { cx: number; cy: number; ux: number; uy: number; mods: Mods; hit: Hit; handle: Handle | null; moved: boolean }

/**
 * What a drag is doing, with where everything started: each pointer move
 * applies the whole delta to the start, so rounding and clamps never drift
 * over a long drag.
 */
type Drag =
  | { kind: 'elements'; ids: string[]; starts: Record<string, Box> }
  | { kind: 'card'; card: number; start: Box }
  | { kind: 'children'; names: string[]; card: number; starts: Record<string, CardChild> }
  | { kind: 'box' }
  | { kind: 'resizeElement'; id: string; handle: Handle; start: Box }
  | { kind: 'scaleElement'; id: string; handle: Handle; start: Box; scale: number }
  | { kind: 'resizePiece'; name: string; card: number; handle: Handle; start: CardChild }
  | { kind: 'scalePieces'; names: string[]; handle: Handle; starts: Record<string, CardChild>; box: Box };
```

Below `NO_SNAP`, add:

```ts
/** How near a handle the pointer must be, in screen pixels, whatever the canvas scale. */
const HANDLE_SLACK_PX = 5;
const RESIZE_CURSOR: Record<Handle, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};
```

In the draw effect, replace the `drawHud(...)` call with:

```ts
    const box = selectionBox(design, sel);
    drawHud(ctx, w, h, design, side, selectedIds(sel), () => setImgTick((t) => t + 1), {
      state: cardState,
      frames: selectionFrames(design, sel),
      box,
      handles: box ? handlesFor(design, sel).map((hd) => handlePoint(box, hd)) : [],
      hover: hovered.kind === 'none' ? null : { rects: selectionFrames(design, hovered), label: selectionLabel(design, hovered) },
      marquee,
      guides,
    });
```

Directly above `onPointerDown`, add:

```ts
  /** The selection's handle under the point, if any: the nearest within HANDLE_SLACK_PX screen pixels. */
  const handleUnder = (d: HudDesign, ux: number, uy: number): Handle | null => {
    const box = selectionBox(d, sel);
    const c = canvas.current;
    if (!box || !c) return null;
    const slack = (HANDLE_SLACK_PX * SCREEN_H) / c.getBoundingClientRect().height;
    return handleAt(box, handlesFor(d, sel), ux, uy, slack);
  };

  /** What a handle drag resizes, from where everything is now. */
  const handleDrag = (handle: Handle, d: HudDesign): Drag | null => {
    if (sel.kind === 'elements' && sel.ids.length === 1) {
      const id = sel.ids[0];
      const { x, y, w, h } = elementRect(d, id, d.aspect);
      return elementById(id)!.resize === 'free'
        ? { kind: 'resizeElement', id, handle, start: { x, y, w, h } }
        : { kind: 'scaleElement', id, handle, start: { x, y, w, h }, scale: d.elements[id]?.scale ?? 1 };
    }
    if (sel.kind === 'children') {
      const starts = startsOf(d, sel.names);
      if (sel.names.length === 1) {
        const start = starts[sel.names[0]];
        return start ? { kind: 'resizePiece', name: sel.names[0], card: sel.card, handle, start } : null;
      }
      const box = unionBox(Object.values(starts));
      return box ? { kind: 'scalePieces', names: sel.names, handle, starts, box } : null;
    }
    return null;
  };
```

In `onPointerDown`, change the `press.current = ...` line to:

```ts
    const d = current.current;
    press.current = { cx: e.clientX, cy: e.clientY, ux, uy, mods: modsOf(e), hit: hitAt(d, side, cardState, ux, uy), handle: handleUnder(d, ux, uy), moved: false };
```

At the top of `startDrag`, add:

```ts
    if (p.handle) return handleDrag(p.handle, current.current);
```

Change `moveDrag`'s signature to `(d: Drag, p: Press, ux: number, uy: number, alt: boolean, shift: boolean)` and, directly after its `if (d.kind === 'box') { ... }` block, add:

```ts
    if (d.kind === 'resizeElement') {
      // A free size snaps the edges the handle drags, unless Alt, or Shift's ratio lock, says not to.
      const raw = resizeBox(d.start, d.handle, dux, duy, false, 20);
      const s = alt || shift ? NO_SNAP : snapEdges(raw, d.handle, sectionTargets(cur, side, { kind: 'elements', ids: [d.id] }));
      setGuides(s.guides);
      edit((x) => resizeElement(x, d.id, d.start, d.handle, dux + s.dx, duy + s.dy, shift), 'gesture');
      return;
    }
    if (d.kind === 'scaleElement') {
      edit((x) => scaleElement(x, d.id, { rect: d.start, scale: d.scale }, d.handle, dux, duy), 'gesture');
      return;
    }
    if (d.kind === 'resizePiece') {
      const f = cardFrame(cur);
      const dx = dux / f.k, dy = duy / f.k;
      const snaps = teamChild(d.name)?.box === 'wh' && !alt && !shift;
      const s = snaps ? snapEdges(resizeBox(d.start, d.handle, dx, dy, false, 1), d.handle, pieceTargets(cur, cardState, [d.name])) : NO_SNAP;
      const card = teamCardRects(cur, cur.aspect)[d.card];
      setGuides(s.guides.map((g) => pieceGuideToScreen(g, card, f)));
      edit((x) => resizeChild(x, d.name, d.start, d.handle, dx + s.dx, dy + s.dy, shift), 'gesture');
      return;
    }
    if (d.kind === 'scalePieces') {
      const f = cardFrame(cur);
      const k = cornerFactor(d.box, d.handle, dux / f.k, duy / f.k);
      edit((x) => scaleChildren(x, d.names, d.starts, anchorOf(d.box, d.handle), k), 'gesture');
      return;
    }
```

In `onPointerMove`, replace the hover branch and the final call with:

```ts
    if (!p) {
      const d = current.current;
      setHover({ hit: hitAt(d, side, cardState, ux, uy), ctrl: e.ctrlKey || e.metaKey });
      const over = handleUnder(d, ux, uy);
      if (canvas.current) canvas.current.style.cursor = over ? RESIZE_CURSOR[over] : '';
      return;
    }
```

and

```ts
    if (drag.current) moveDrag(drag.current, p, ux, uy, e.altKey, e.shiftKey);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS, no type errors. `grep -n childCornerAt web/src -r` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx web/src/hud/mock.ts web/src/hud/mock.test.ts
git commit -m "Resize and scale from handles on every side and corner of the selection, snapping free sizes to the guides"
```

---

### Task 13: Multi-select: Shift+click, the Shift+drag box, Ctrl+A and group controls

**Files:**
- Modify: `web/src/routes/hud/ContextPanel.tsx`, `web/src/routes/Hud.tsx`, `web/src/styles/app.css`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: Task 5's `selectAll`; Task 6 and 7's `startsOf`, `placeChildren`, `alignChildren`, `alignElements`, `setChildrenVisible`, `resetChildren`, `setSelectionVisible`, `Align`; `unionBox` (`guides.ts`).
- Produces: `PiecesControls({ design, edit, end, names })` (legend `N pieces in the teammate card`: group X and Y, the six Align buttons, Visible for all, Reset all) and `ElementsControls({ design, edit, ids })` (legend `N elements`: Align, Visible for all) in `ContextPanel.tsx`; Ctrl+A (Cmd+A) on the canvas; the side panel shows the group controls for several pieces or elements. Shift+click and the Shift+drag box already work through Task 11's `clickSelect` and `boxSelect`; this task gives them their controls and tests.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, add inside `describe('Hud page', ...)`:

```ts
  it('picks several pieces with Shift+click and moves them together', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    expect(screen.getByText('2 pieces in the teammate card', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    dragFrom(canvas, [24, 454], [29, 454]);
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('18');
    // The health bar moved too: it now starts at 42.
    clickAt(canvas, 65, 460);
    expect(screen.getByText('Health bar', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('42');
  });

  it('picks the pieces a Shift+drag box touches', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    dragFrom(canvas, [60, 456], [100, 470], { shiftKey: true });
    expect(screen.getByText('2 pieces in the teammate card', { selector: 'legend' })).toBeTruthy();
  });

  it('selects every drawn piece of the card, or every visible element, with Ctrl+A', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    fireEvent.keyDown(canvas, { key: 'a', ctrlKey: true });
    expect(screen.getByText('5 pieces in the teammate card', { selector: 'legend' })).toBeTruthy();
    clickAt(canvas, 426, 100);
    fireEvent.keyDown(canvas, { key: 'a', ctrlKey: true });
    expect(screen.getByText('7 elements', { selector: 'legend' })).toBeTruthy();
  });

  it('aligns several pieces, and hides them all', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Align right' }));
    // Their box ends at 133 (the bar's right edge): the portrait moves to 110.
    fireEvent.click(screen.getByLabelText('Visible'));
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('110');
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(false);
  });

  it('aligns several elements picked with Shift+click in the list', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }), { shiftKey: true });
    expect(screen.getByText('2 elements', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Align left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('10');
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL. With several things picked the side panel shows only the hint (no group legend, no Align buttons), and Ctrl+A does nothing.

- [ ] **Step 3: Implement**

In `web/src/styles/app.css`, below `.hud__reset`, add:

```css
/* The six align buttons of a group, in one wrapping row. */
.hud__align { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-top: var(--sp-3); }
```

In `web/src/routes/hud/ContextPanel.tsx`, extend the imports:

```ts
import {
  cardOffset, withTeamDir, placeCard, patchChild, resetElement, resetChild,
  startsOf, placeChildren, alignChildren, alignElements, setChildrenVisible, resetChildren, setSelectionVisible, type Align,
} from '../../hud/edit';
import { unionBox } from '../../hud/guides';
```

and append:

```tsx
const ALIGNS: { how: Align; label: string }[] = [
  { how: 'left', label: 'Left' }, { how: 'centre', label: 'Centre' }, { how: 'right', label: 'Right' },
  { how: 'top', label: 'Top' }, { how: 'middle', label: 'Middle' }, { how: 'bottom', label: 'Bottom' },
];

/** Six buttons that line a group up against the box around it. */
function AlignRow({ onAlign }: { onAlign: (how: Align) => void }) {
  return (
    <div class="hud__align" role="group" aria-label="Align">
      {ALIGNS.map((a) => (
        <button
          key={a.how} type="button" class="btn btn--ghost btn--sm" aria-label={`Align ${a.label.toLowerCase()}`}
          onClick={() => onAlign(a.how)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Several pieces of the teammate card: the group's X and Y (the box around
 * them, in the card file's frame, moving all of them), Align, Visible for
 * all and Reset all. Every edit is the one card file, so every card follows.
 */
export function PiecesControls({ design, edit, end, names }: { design: HudDesign; edit: Edit; end: () => void; names: string[] }) {
  const box = unionBox(Object.values(startsOf(design, names)));
  if (!box) return null;
  const allVisible = names.every((n) => cardChild(design, n)?.visible);
  const place = (key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    edit((d) => {
      const b = unionBox(Object.values(startsOf(d, names)));
      return b ? placeChildren(d, names, key === 'x' ? n : b.x, key === 'y' ? n : b.y) : d;
    }, 'gesture');
  };
  return (
    <Field legend={`${names.length} pieces in the teammate card`}>
      <p class="muted hud__note">Edits inside a card apply to every teammate's card.</p>
      <div class="hud__row2">
        <label class="hud__field">
          <span>X</span>
          <input type="number" value={Math.round(box.x)} onInput={(e) => place('x', e)} {...endsOn(end)} />
        </label>
        <label class="hud__field">
          <span>Y</span>
          <input type="number" value={Math.round(box.y)} onInput={(e) => place('y', e)} {...endsOn(end)} />
        </label>
      </div>
      <AlignRow onAlign={(how) => edit((d) => alignChildren(d, names, how))} />
      <label class="hud__check">
        <input
          type="checkbox" checked={allVisible}
          onChange={(e) => { const v = (e.target as HTMLInputElement).checked; edit((d) => setChildrenVisible(d, names, v)); }}
        />
        <span>Visible</span>
      </label>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={() => edit((d) => resetChildren(d, names))}>Reset all</button>
    </Field>
  );
}

/** Several elements of the side: Align against their box, and Visible for all of those that can hide. */
export function ElementsControls({ design, edit, ids }: { design: HudDesign; edit: Edit; ids: string[] }) {
  const hideable = ids.filter((id) => elementById(id)?.props.includes('visible'));
  const allVisible = hideable.every((id) => elementRect(design, id, design.aspect).visible);
  return (
    <Field legend={`${ids.length} elements`}>
      <AlignRow onAlign={(how) => edit((d) => alignElements(d, ids, how))} />
      {hideable.length > 0 && (
        <label class="hud__check">
          <input
            type="checkbox" checked={allVisible}
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).checked;
              edit((d) => setSelectionVisible(d, { kind: 'elements', ids: hideable }, v));
            }}
          />
          <span>Visible</span>
        </label>
      )}
    </Field>
  );
}
```

In `web/src/routes/Hud.tsx`, add `selectAll` to the `../hud/selection` import, change the ContextPanel import to `import { ElementControls, ChildList, ChildControls, PiecesControls, ElementsControls } from './hud/ContextPanel';`, and in `onKeyDown`, directly above `const amount = e.shiftKey ? 10 : 1;`, add:

```ts
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel((s) => selectAll(current.current, side, cardState, s));
      return;
    }
```

In the side panel, replace the chain

```tsx
              : sel.kind === 'card'
                ? <ElementControls design={design} edit={edit} end={endGesture} id="teamColumn" selectedCard={sel.card} onPickCard={pickCard} />
                : <p class="muted">Select an element on the canvas or in the list below it.</p>}
```

with

```tsx
              : sel.kind === 'card'
                ? <ElementControls design={design} edit={edit} end={endGesture} id="teamColumn" selectedCard={sel.card} onPickCard={pickCard} />
                : sel.kind === 'children'
                  ? <PiecesControls design={design} edit={edit} end={endGesture} names={sel.names} />
                  : sel.kind === 'elements'
                    ? <ElementsControls design={design} edit={edit} ids={sel.ids} />
                    : <p class="muted">Select an element on the canvas or in the list below it.</p>}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/hud/ContextPanel.tsx web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx web/src/styles/app.css
git commit -m "Pick several pieces or elements with Shift+click, a Shift+drag box or Ctrl+A, and move, align and hide them together"
```

---

### Task 14: The Layers panel

**Files:**
- Create: `web/src/routes/hud/LayersPanel.tsx`
- Modify: `web/src/routes/hud/ContextPanel.tsx`, `web/src/routes/Hud.tsx`, `web/src/styles/app.css`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `visibleElements`, `Side` (`mock.ts`); `elementRect`, `cardChild`, `isFreeTeam` (`build.ts`); `TEAM_PANEL` (`children.ts`); `Selection`, `pick` (`selection.ts`); `setSelectionVisible`, `patchChild` (`edit.ts`).
- Produces:
  - `LayersPanel({ design, side, sel, onPick, onVisible, onAdd, onKeyDown }: { design: HudDesign; side: Side; sel: Selection; onPick: (target: Selection, shift: boolean) => void; onVisible: (target: Selection, visible: boolean) => void; onAdd: (name: string) => void; onKeyDown: (e: KeyboardEvent) => void })`: one row per element of the side in registry order (a name button and, for elements with a Visible control, an eye button named `Hide <label>` / `Show <label>`), struck through when hidden; under Teammates, `Card 1..4` rows in Free, then every registry piece (state pieces noted "shown when down", "shown when dead", "shown when talking"), and a `＋ Health number` button while the stock health number is off.
  - `ChildControls` gains the note "Edits inside a card apply to every teammate's card." and, for an added child, a "Remove the health number" button (`on: false`).
  - `ChildList` and the element pill row are removed; the `.hud` grid gains a Layers column on the left.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, replace the four tests `lists the teammate card children and adds the health number on stock`, `steps back to the teammates when the selected child stops existing`, `keeps an added health number added when its child is reset` and `offers no colour for the health number and says why, and a colour for the name` with:

```ts
  it('lists the teammate card pieces in Layers, and adds the health number on stock', () => {
    render(<Hud />);
    for (const label of ['Portrait', 'Health bar', 'Name', 'Item icons', 'Status text', 'Damage splatter', 'Down picture', 'Dead picture', 'Voice icon']) {
      expect(screen.getByRole('button', { name: label }), label).toBeTruthy();
    }
    expect(screen.getByText('shown when down')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Health number' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    expect(screen.getByRole('button', { name: 'Health number' })).toBeTruthy();
    expect(screen.getByText('Health number', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByText("Edits inside a card apply to every teammate's card.")).toBeTruthy();
  });

  it('steps back to the teammates when the selected piece is removed', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    expect(screen.getByText('Reset this child')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the health number' }));
    expect(screen.getByText('Reset this element')).toBeTruthy();
    expect(screen.getByRole('button', { name: '＋ Health number' })).toBeTruthy();
  });

  it('keeps an added health number added when its child is reset', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '90' } });
    fireEvent.click(screen.getByText('Reset this child'));
    // The move is gone and the number is still there: back at the template's x 103.
    expect(screen.getByRole('button', { name: 'Health number' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('103');
  });

  it('offers no colour for the health number and says why, and a colour for the name', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    expect(screen.getByText('The game colours this by health.')).toBeTruthy();
    expect(screen.queryByLabelText('Health number colour')).toBeNull();
    expect(screen.getByLabelText('Text size')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(screen.getByLabelText('Name colour')).toBeTruthy();
  });

  it('hides and shows from the eye in Layers, struck through while hidden', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Chat' }));
    const row = () => screen.getByRole('button', { name: 'Chat' }).closest('.hud__layer')!;
    expect(row().classList.contains('hud__layer--hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show Chat' }));
    expect(row().classList.contains('hud__layer--hidden')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Portrait' }));
    expect(screen.getByRole('button', { name: 'Portrait' }).closest('.hud__layer')!.classList.contains('hud__layer--hidden')).toBe(true);
  });

  it('selects from Layers, Shift+click adding, and lists the Free cards', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }), { shiftKey: true });
    expect(screen.getByText('2 elements', { selector: 'legend' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Card 2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    fireEvent.click(screen.getByRole('button', { name: 'Card 2' }));
    expect(screen.getByText('Teammate card 2')).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL. There is no Layers list: the pieces are listed only once the Teammates are selected, there is no `＋ Health number` button, no eye buttons, no Card rows.

- [ ] **Step 3: Implement**

Create `web/src/routes/hud/LayersPanel.tsx`:

```tsx
/**
 * The Layers list, left of the canvas: every element of the current side in
 * registry order, with an eye that shows or hides it, struck through while
 * hidden. The Teammates expand to their cards (in Free) and to every piece
 * of the teammate card from the child registry, splatter included, which
 * makes this the one way to reach a hidden, tiny or state-only piece. Click
 * selects and Shift+click adds, by the same rule as the canvas
 * (selection.ts's pick), and it takes the canvas's keys (arrows, Delete,
 * Escape, Ctrl+A) while a row has focus.
 */
import type { HudDesign } from '../../hud/design';
import { elementRect, cardChild, isFreeTeam } from '../../hud/build';
import { TEAM_PANEL } from '../../hud/children';
import { visibleElements, type Side } from '../../hud/mock';
import type { Selection } from '../../hud/selection';

/** State pieces the game shows only sometimes, and when. */
const WHEN: Record<string, string> = { Incapacitated: 'shown when down', Dead: 'shown when dead', Voice: 'shown when talking' };

/** Whether one row's target is part of the selection. */
function isIn(sel: Selection, target: Selection): boolean {
  if (sel.kind === 'elements' && target.kind === 'elements') return sel.ids.includes(target.ids[0]);
  if (sel.kind === 'card' && target.kind === 'card') return sel.card === target.card;
  if (sel.kind === 'children' && target.kind === 'children') return sel.names.includes(target.names[0]);
  return false;
}

function Eye({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.3" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      {hidden && <path d="M2 14L14 2" stroke="currentColor" stroke-width="1.5" />}
    </svg>
  );
}

function Row(
  { label, depth, active, hidden, note, onPick, onEye }: {
    label: string; depth: 0 | 1; active: boolean; hidden: boolean; note?: string;
    onPick: (shift: boolean) => void; onEye?: (visible: boolean) => void;
  },
) {
  return (
    <div class={`hud__layer hud__layer--d${depth}${active ? ' is-active' : ''}${hidden ? ' hud__layer--hidden' : ''}`}>
      <button type="button" class="hud__layername" onClick={(e) => onPick(e.shiftKey)}>{label}</button>
      {note && <span class="hud__layernote">{note}</span>}
      {onEye && (
        <button type="button" class="hud__eye" aria-label={`${hidden ? 'Show' : 'Hide'} ${label}`} onClick={() => onEye(hidden)}>
          <Eye hidden={hidden} />
        </button>
      )}
    </div>
  );
}

export function LayersPanel(
  { design, side, sel, onPick, onVisible, onAdd, onKeyDown }: {
    design: HudDesign; side: Side; sel: Selection;
    onPick: (target: Selection, shift: boolean) => void;
    onVisible: (target: Selection, visible: boolean) => void;
    onAdd: (name: string) => void;
    onKeyDown: (e: KeyboardEvent) => void;
  },
) {
  // A piece picked here keeps the card the selection was in, for the handles and the breadcrumb.
  const card = sel.kind === 'children' || sel.kind === 'card' ? sel.card : 0;
  const free = isFreeTeam(design);
  return (
    <nav class="hud__layers" aria-label="Layers" onKeyDown={onKeyDown}>
      <p class="eyebrow">{side === 'survivor' ? 'Survivor HUD' : 'Infected HUD'}</p>
      {visibleElements(side).map((el) => {
        const target: Selection = { kind: 'elements', ids: [el.id] };
        return (
          <div key={el.id}>
            <Row
              label={el.label} depth={0} active={isIn(sel, target)} hidden={!elementRect(design, el.id, design.aspect).visible}
              onPick={(shift) => onPick(target, shift)}
              onEye={el.props.includes('visible') ? (v) => onVisible(target, v) : undefined}
            />
            {el.id === 'teamColumn' && free && [0, 1, 2, 3].map((i) => {
              const t: Selection = { kind: 'card', card: i };
              return <Row key={`card${i}`} label={`Card ${i + 1}`} depth={1} active={isIn(sel, t)} hidden={false} onPick={(shift) => onPick(t, shift)} />;
            })}
            {el.id === 'teamColumn' && TEAM_PANEL.children.map((def) => {
              const info = cardChild(design, def.name);
              if (!info) {
                return def.addable ? (
                  <div key={def.name} class="hud__layer hud__layer--d1">
                    <button type="button" class="hud__layername hud__layeradd" onClick={() => onAdd(def.name)}>{`＋ ${def.label}`}</button>
                  </div>
                ) : null;
              }
              const t: Selection = { kind: 'children', names: [def.name], card };
              return (
                <Row
                  key={def.name} label={def.label} depth={1} active={isIn(sel, t)} hidden={!info.visible} note={WHEN[def.name]}
                  onPick={(shift) => onPick(t, shift)} onEye={(v) => onVisible(t, v)}
                />
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
```

In `web/src/styles/app.css`, change `.hud { display: grid; grid-template-columns: 1fr 320px; ... }` to

```css
.hud { display: grid; grid-template-columns: 190px minmax(0, 1fr) 320px; gap: var(--sp-4); align-items: start; }
```

and below the `.hud__pill--hidden` rule add:

```css
/* The Layers list: one row per element, pieces indented under the
 * Teammates. The name is a button (click selects, Shift+click adds), the eye
 * another; a hidden row is struck through, as the old pills were. */
.hud__layers .eyebrow { margin-bottom: var(--sp-2); }
.hud__layer { display: flex; align-items: center; gap: var(--sp-1); padding: 1px var(--sp-1); }
.hud__layer--d1 { padding-left: var(--sp-4); }
.hud__layer.is-active { background: var(--accent); }
.hud__layername {
  flex: 1; min-width: 0; text-align: left; background: none; border: 0; padding: 2px 0;
  color: var(--text); font: inherit; font-size: var(--fs-dense); cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hud__layer.is-active .hud__layername { color: #fff; }
.hud__layer--hidden .hud__layername { text-decoration: line-through; color: var(--text-muted); }
.hud__layernote { font-size: var(--fs-label); color: var(--text-muted); white-space: nowrap; }
.hud__layeradd { color: var(--text-muted); }
.hud__eye { background: none; border: 0; padding: 2px; color: var(--text-muted); cursor: pointer; line-height: 0; }
.hud__eye:hover { color: var(--text-bright); }
```

and in `@media (max-width: 900px)` nothing changes (`.hud { grid-template-columns: 1fr; }` already stacks the three columns). Add above it:

```css
@media (max-width: 1200px) {
  .hud { grid-template-columns: minmax(0, 1fr) 320px; }
  .hud__layerpanel { grid-column: 1 / -1; }
}
```

In `web/src/routes/hud/ContextPanel.tsx`, delete `ChildList` and its doc comment. In `ChildControls`, directly above `{def.note && ...}`, add:

```tsx
      <p class="muted hud__note">Edits inside a card apply to every teammate's card.</p>
```

and directly above the `Reset this child` button add:

```tsx
      {def.addable && !baseHasChild(design.preset, name) && (
        <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={() => edit((d) => patchChild(d, name, { on: false }))}>
          {`Remove the ${def.label.toLowerCase()}`}
        </button>
      )}
```

In `web/src/routes/Hud.tsx`:

- Import `import { LayersPanel } from './hud/LayersPanel';`, add `setSelectionVisible, patchChild` to the `../hud/edit` import, and drop `ChildList` from the ContextPanel import.
- Delete the `{/* The only way to reach an element that is hidden or off screen. */}` comment and the `<div class="hud__list">...</div>` block after the canvas wrapper, the `const sideElements = visibleElements(side);` line, and the `{teamPicked && (<ChildList ... />)}` block with the `teamPicked` constant.
- As the first child of `<div class="hud">`, add:

```tsx
        <Panel class="hud__layerpanel">
          <LayersPanel
            design={design} side={side} sel={sel}
            onPick={(t, shift) => setSel((s) => pick(s, t, shift))}
            onVisible={(t, v) => edit((d) => setSelectionVisible(d, t, v))}
            onAdd={(name) => { edit((d) => patchChild(d, name, { on: true })); setSel({ kind: 'children', names: [name], card: 0 }); }}
            onKeyDown={onKeyDown}
          />
        </Panel>
```

- Change the hint `<p class="muted">Select an element on the canvas or in the list below it.</p>` to `<p class="muted">Select an element on the canvas or in Layers.</p>`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS, no type errors. The Phase 1 tests that clicked `Teammates` and then a piece now click the Layers rows (same accessible names) and pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/hud/LayersPanel.tsx web/src/routes/hud/ContextPanel.tsx web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx web/src/styles/app.css
git commit -m "Replace the pill rows with a Layers list: every element and card piece with an eye, the Free cards, and the health number to add"
```

---

### Task 15: One toolbar and a context panel that shows only what the selection can do

**Files:**
- Create: `web/src/routes/hud/Toolbar.tsx`
- Modify: `web/src/routes/hud/ContextPanel.tsx`, `web/src/routes/Hud.tsx`, `web/src/styles/app.css`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `Tabs` (`components/bits`); `Backdrop` (`crosshair/draw`); `teamCardRects` (`build.ts`); `placeCard` (`edit.ts`); `TEAMMATES`, `Selection` (`selection.ts`).
- Produces:
  - `Toolbar(p: ToolbarProps)` with `interface ToolbarProps { design: HudDesign; side: Side; cardState: CardState; backdrop: Backdrop; shotError?: string; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onSide: (s: Side) => void; onState: (s: CardState) => void; onPreset: (p: Preset) => void; onAspect: (a: Aspect) => void; onBackdrop: (b: Backdrop) => void; onShot: (e: Event) => void; onFont: (f: 'preset' | 'roboto') => void; onDownload: () => void }`: Undo, Redo; Survivor / Infected; Healthy / Down / Dead (survivor only); Preset, Aspect, Backdrop (and the screenshot loader), Font; Download on the right.
  - `CardControls({ design, edit, end, card })`: legend `Teammate card N`, X and Y of where the card is drawn.
  - `ContextPanel({ design, sel, edit, end, onSelect })`: nothing, one element, one card, one piece, several pieces, several elements.
  - The Save panel keeps the name, the install notes, share, export and import; its Download button moves to the toolbar.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, add `within` to the `@testing-library/preact` import:

```ts
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
```

In `makes one canvas drag one step`, replace everything from `expect((screen.getByLabelText('Card 1 X') ...` to the end of the test with:

```ts
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('113');
    undoKey();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    // The Layout change before it is its own step; leaving Free climbs the card to the Teammates.
    undoKey();
    expect((screen.getByRole('combobox', { name: /^Layout/ }) as HTMLSelectElement).value).toBe('row');
```

In `in Free, picks a piece of any card in one click, and a drag on another card moves that card`, replace its last three expectations with:

```ts
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('113');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('241');
```

In `selects from Layers, Shift+click adding, and lists the Free cards`, replace `expect(screen.getByText('Teammate card 2')).toBeTruthy();` with `expect(screen.getByText('Teammate card 2', { selector: 'legend' })).toBeTruthy();`.

Add inside `describe('Hud page', ...)`:

```ts
  it('puts every page control in one toolbar, Download on it', () => {
    const { container } = render(<Hud />);
    const bar = within(container.querySelector('.hud__toolbar') as HTMLElement);
    for (const name of ['Undo', 'Redo']) expect(bar.getByRole('button', { name }), name).toBeTruthy();
    for (const name of ['Survivor', 'Infected', 'Healthy', 'Down', 'Dead']) expect(bar.getByRole('tab', { name }), name).toBeTruthy();
    for (const name of [/preset/i, /aspect/i, /backdrop/i, /font/i]) expect(bar.getByRole('combobox', { name }), String(name)).toBeTruthy();
    const download = bar.getByRole('button', { name: /download/i });
    expect(download.classList.contains('hud__download')).toBe(true);
    expect(download.textContent).toBe('Download .vpk');
    expect(screen.getAllByRole('button', { name: /download/i })).toHaveLength(1);
  });

  it('shows a Free card its own X and Y, placing the card where it is drawn', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    fireEvent.click(screen.getByRole('button', { name: 'Card 3' }));
    expect(screen.getByText('Teammate card 3', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('293');
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '500' } });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('500');
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByLabelText('Card 3 X') as HTMLInputElement).value).toBe('500');
  });

  it('shows a hint, then Styles and Save, with nothing selected', () => {
    render(<Hud />);
    expect(screen.getByText(/a drag moves its whole section/)).toBeTruthy();
    expect(screen.getByText('Styles')).toBeTruthy();
    expect(screen.getByText('Save your HUD')).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL. Download is still in the Save panel, a Free card still shows the whole Teammates panel, and the hint does not mention dragging.

- [ ] **Step 3: Implement**

Create `web/src/routes/hud/Toolbar.tsx`:

```tsx
/**
 * The one toolbar above the canvas: history, what is previewed (side, card
 * state, backdrop), what the design is built on (preset, aspect, font), and
 * Download on the right. The existing controls, gathered in one place.
 */
import { Tabs } from '../../components/bits';
import type { Backdrop } from '../../crosshair/draw';
import type { HudDesign } from '../../hud/design';
import type { Aspect } from '../../hud/units';
import type { Side } from '../../hud/mock';
import type { CardState } from '../../hud/render';
import type { Preset } from '../../hud/base';

const BACKDROPS: [Backdrop, string][] = [
  ['scene', 'Saferoom'], ['dark', 'Dark'], ['bright', 'Bright'], ['grey', 'Grey'], ['shot', 'My screenshot'],
];

const CARD_STATES: { key: CardState; label: string }[] = [
  { key: 'healthy', label: 'Healthy' }, { key: 'down', label: 'Down' }, { key: 'dead', label: 'Dead' },
];

export interface ToolbarProps {
  design: HudDesign; side: Side; cardState: CardState; backdrop: Backdrop; shotError?: string;
  canUndo: boolean; canRedo: boolean;
  onUndo: () => void; onRedo: () => void;
  onSide: (s: Side) => void; onState: (s: CardState) => void;
  onPreset: (p: Preset) => void; onAspect: (a: Aspect) => void; onBackdrop: (b: Backdrop) => void;
  onShot: (e: Event) => void; onFont: (f: 'preset' | 'roboto') => void; onDownload: () => void;
}

export function Toolbar(p: ToolbarProps) {
  const { design } = p;
  return (
    <div class="hud__toolbar">
      <button type="button" class="btn btn--ghost btn--sm" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!p.canUndo} onClick={p.onUndo}>
        ↶ Undo
      </button>
      <button type="button" class="btn btn--ghost btn--sm" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!p.canRedo} onClick={p.onRedo}>
        ↷ Redo
      </button>
      <span class="hud__tbsep" aria-hidden="true" />

      <Tabs
        tabs={[{ key: 'survivor', label: 'Survivor' }, { key: 'infected', label: 'Infected' }]}
        active={p.side} onSelect={(k) => p.onSide(k as Side)}
      />
      {p.side === 'survivor' && (
        <Tabs tabs={CARD_STATES.map((s) => ({ key: s.key, label: s.label }))} active={p.cardState} onSelect={(k) => p.onState(k as CardState)} />
      )}
      <span class="hud__tbsep" aria-hidden="true" />

      <label>
        Preset{' '}
        <select value={design.preset} onChange={(e) => p.onPreset((e.target as HTMLSelectElement).value as Preset)}>
          <option value="stock">Stock</option>
          <option value="modern">Modern</option>
        </select>
      </label>
      <label>
        Aspect{' '}
        <select value={design.aspect} onChange={(e) => p.onAspect((e.target as HTMLSelectElement).value as Aspect)}>
          <option value="16:9">16:9</option>
          <option value="16:10">16:10</option>
          <option value="4:3">4:3</option>
        </select>
      </label>
      <label>
        Backdrop{' '}
        <select value={p.backdrop} onChange={(e) => p.onBackdrop((e.target as HTMLSelectElement).value as Backdrop)}>
          {BACKDROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {p.backdrop === 'shot' && (
        <label class="hud__file hud__file--inline">
          <span class="btn btn--ghost btn--sm">Load screenshot</span>
          <input type="file" accept="image/*" aria-label="Load a screenshot for the backdrop" onChange={p.onShot} />
        </label>
      )}
      {p.backdrop === 'shot' && p.shotError && <span class="error">{p.shotError}</span>}
      <label>
        Font{' '}
        <select
          value={design.font} disabled={design.preset === 'modern'}
          onChange={(e) => p.onFont((e.target as HTMLSelectElement).value as 'preset' | 'roboto')}
        >
          <option value="preset">Preset default</option>
          <option value="roboto">Roboto Condensed</option>
        </select>
      </label>
      {design.preset === 'modern' && <span class="muted hud__note">Modern already uses Roboto Condensed.</span>}

      <button type="button" class="btn btn--sm hud__download" onClick={p.onDownload}>
        {design.advanced ? 'Download .zip' : 'Download .vpk'}
      </button>
    </div>
  );
}
```

In `web/src/styles/app.css`, below `.hud__toolbar select { ... }`, add:

```css
.hud__tbsep { width: 1px; align-self: stretch; background: var(--border); }
/* Download sits at the right end of the toolbar, whatever wraps before it. */
.hud__download { margin-left: auto; }
```

In `web/src/routes/hud/ContextPanel.tsx`, extend the imports:

```ts
import { elementRect, teamLayout, cardChild, baseHasChild, teamCardRects } from '../../hud/build';
import { TEAMMATES, type Selection } from '../../hud/selection';
```

and append:

```tsx
/**
 * One Free teammate card: where it is drawn, as X and Y. placeCard stores
 * the slot less the fit offset, so the boxes take and show the drawn place.
 * The cards share one size (the Teammates' Scale), so there is no size here.
 */
export function CardControls({ design, edit, end, card }: { design: HudDesign; edit: Edit; end: () => void; card: number }) {
  const r = teamCardRects(design, design.aspect)[card];
  const place = (key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    edit((d) => {
      const c = teamCardRects(d, d.aspect)[card];
      return placeCard(d, card, key === 'x' ? n : c.x, key === 'y' ? n : c.y);
    }, 'gesture');
  };
  return (
    <Field legend={`Teammate card ${card + 1}`}>
      {card === 3 && <p class="muted hud__note">Card 4 shows only while you spectate a full team.</p>}
      <div class="hud__row2">
        <label class="hud__field">
          <span>X</span>
          <input type="number" value={Math.round(r.x)} onInput={(e) => place('x', e)} {...endsOn(end)} />
        </label>
        <label class="hud__field">
          <span>Y</span>
          <input type="number" value={Math.round(r.y)} onInput={(e) => place('y', e)} {...endsOn(end)} />
        </label>
      </div>
      <p class="muted hud__note">The cards share one size: scale them from the Teammates.</p>
    </Field>
  );
}

/** The right-hand panel: only what the selection can do. */
export function ContextPanel(
  { design, sel, edit, end, onSelect }: {
    design: HudDesign; sel: Selection; edit: Edit; end: () => void; onSelect: (s: Selection) => void;
  },
) {
  const pickCard = (card: number | null) => onSelect(card === null ? TEAMMATES : { kind: 'card', card });
  switch (sel.kind) {
    case 'none':
      return <p class="muted">Select an element on the canvas or in Layers. A click picks the piece under the pointer; a drag moves its whole section.</p>;
    case 'elements':
      return sel.ids.length === 1
        ? <ElementControls design={design} edit={edit} end={end} id={sel.ids[0]} selectedCard={null} onPickCard={pickCard} />
        : <ElementsControls design={design} edit={edit} ids={sel.ids} />;
    case 'card':
      return <CardControls design={design} edit={edit} end={end} card={sel.card} />;
    case 'children':
      return sel.names.length === 1
        ? <ChildControls design={design} edit={edit} end={end} name={sel.names[0]} onBack={() => onSelect(TEAMMATES)} />
        : <PiecesControls design={design} edit={edit} end={end} names={sel.names} />;
  }
}
```

In `web/src/routes/Hud.tsx`:

- Imports: add `import { Toolbar } from './hud/Toolbar';`, change the ContextPanel import to `import { ContextPanel } from './hud/ContextPanel';`, remove `Tabs` from the `../components/bits` import, and delete the `BACKDROPS` and `CARD_STATES` constants (they live in `Toolbar.tsx`).
- Replace the whole `<div class="hud__toolbar">...</div>` block with:

```tsx
          <Toolbar
            design={design} side={side} cardState={cardState} backdrop={backdrop} shotError={uploadErrors.shot}
            canUndo={hist.current.past.length > 0} canRedo={hist.current.future.length > 0}
            onUndo={doUndo} onRedo={doRedo}
            onSide={(s) => { setSide(s); setSel(NONE); }}
            onState={setCardState}
            onPreset={(p) => { void changePreset(p); }}
            onAspect={(a) => edit((d) => ({ ...d, aspect: a }))}
            onBackdrop={setBackdrop}
            onShot={pickShot}
            onFont={(f) => edit((d) => ({ ...d, font: f }))}
            onDownload={() => { void download(); }}
          />
```

- Replace the whole content of `<Panel class="hud__side">...</Panel>` with:

```tsx
          <ContextPanel design={design} sel={sel} edit={edit} end={endGesture} onSelect={setSel} />
```

and delete the now unused `pickCard` and `oneChild` constants.
- In the Save panel, delete the `<button type="button" class="btn btn--block" ...>{design.advanced ? 'Download .zip' : 'Download .vpk'}</button>` block; the install notes after it stay.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck && npm run build`
Expected: PASS, no type errors, the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/hud/Toolbar.tsx web/src/routes/hud/ContextPanel.tsx web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx web/src/styles/app.css
git commit -m "Gather the HUD editor's controls into one toolbar and show only what the selection can do in the side panel"
```

---

### Task 16: The right-click menu, and Delete hides

**Files:**
- Create: `web/src/routes/hud/ContextMenu.tsx`
- Modify: `web/src/routes/Hud.tsx`, `web/src/styles/app.css`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: Task 5's `isPicked`, `targetOf`, `hitAt`, `menuActions`, `MenuAction`, `TEAMMATES`; Task 7's `hideSelection`, `resetSelection`.
- Produces:
  - `interface MenuItem { label: string; run: () => void }`, `ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void })`: a `role="menu"` list at (x, y) in the canvas wrapper, `role="menuitem"` buttons, closed by a press outside it, Escape, or running an item. Focus moves to its first item when it opens.
  - Right-click on the canvas opens it for the thing under the pointer (the whole selection when that thing is part of it), selecting what it acts on: Hide, Reset, Select whole card (a piece in Free), Select Teammates (a piece or a card).
  - Delete and Backspace hide the selection (one undo step), from the canvas or the Layers list.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, add inside `describe('Hud page', ...)`:

```ts
  const hiddenRow = (label: string) => screen.getByRole('button', { name: label }).closest('.hud__layer')!.classList.contains('hud__layer--hidden');

  it('opens a menu on right-click for the piece under the pointer, and Hide hides it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Select Teammates']);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(hiddenRow('Portrait')).toBe(true);
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(false);
  });

  it('acts on the whole selection when the right-click is on part of it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    fireEvent.contextMenu(canvas, { clientX: 60, clientY: 460 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(hiddenRow('Portrait')).toBe(true);
    expect(hiddenRow('Health bar')).toBe(true);
  });

  it('offers Select whole card for a piece in Free', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Select whole card', 'Select Teammates']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select whole card' }));
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
  });

  it('closes the menu with Escape or a press elsewhere, and opens none over empty screen', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Hide' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(canvas, { clientX: 426, clientY: 100 });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hides the selection with Delete or Backspace, one undo step each', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.keyDown(canvas, { key: 'Delete' });
    expect(hiddenRow('Chat')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Your health' }), { key: 'Backspace' });
    expect(hiddenRow('Your health')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(hiddenRow('Your health')).toBe(false);
    expect(hiddenRow('Chat')).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL. A right-click opens no menu and Delete does nothing.

- [ ] **Step 3: Implement**

Create `web/src/routes/hud/ContextMenu.tsx`:

```tsx
/**
 * The canvas's right-click menu: a short list of what can be done to the
 * thing under the pointer. It closes on a press anywhere outside it, on
 * Escape, and once an item has run; focus moves into it when it opens so
 * the keyboard can reach it.
 */
import { useEffect, useRef } from 'preact/hooks';

export interface MenuItem { label: string; run: () => void }

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLUListElement>(null);
  // The latest onClose, so the window listeners (added once) never call a stale one.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close.current(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    ref.current?.querySelector('button')?.focus();
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, []);

  return (
    <ul ref={ref} class="hud__menu" role="menu" style={{ left: `${x}px`, top: `${y}px` }}>
      {items.map((it) => (
        <li key={it.label} role="none">
          <button type="button" role="menuitem" onClick={() => { it.run(); close.current(); }}>{it.label}</button>
        </li>
      ))}
    </ul>
  );
}
```

In `web/src/styles/app.css`, below the `.hud__crumbs` rules, add:

```css
.hud__menu {
  position: absolute; z-index: 5; list-style: none; margin: 0; padding: var(--sp-1) 0; min-width: 11rem;
  background: var(--surface-2); border: 1px solid var(--border-strong); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}
.hud__menu button {
  display: block; width: 100%; text-align: left; background: none; border: 0;
  padding: var(--sp-1) var(--sp-3); color: var(--text); font: inherit; font-size: var(--fs-dense); cursor: pointer;
}
.hud__menu button:hover, .hud__menu button:focus-visible { background: var(--surface); color: var(--text-bright); }
```

In `web/src/routes/Hud.tsx`:

- Imports: `import { ContextMenu } from './hud/ContextMenu';`; add `hideSelection, resetSelection` to the `../hud/edit` import; add `isPicked, menuActions, type MenuAction` to the `../hud/selection` import.
- Below `RESIZE_CURSOR`, add:

```ts
const MENU_LABELS: Record<MenuAction, string> = {
  hide: 'Hide', reset: 'Reset', selectCard: 'Select whole card', selectTeam: 'Select Teammates',
};
```

- Below `const [marquee, setMarquee] = ...`, add:

```ts
  // The right-click menu, where it opened (in the canvas wrapper's pixels) and what it acts on.
  const [menu, setMenu] = useState<{ x: number; y: number; sel: Selection } | null>(null);
```

- Above `onKeyDown`, add:

```ts
  /**
   * Right-click: a menu for the thing under the pointer. When that thing is
   * part of the selection the menu acts on the whole selection; otherwise it
   * selects the thing (the deepest level, as a click would) and acts on it.
   */
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const d = current.current;
    const { ux, uy } = pointerUnits(e);
    const hit = hitAt(d, side, cardState, ux, uy);
    const target = targetOf(d, hit);
    if (target.kind === 'none') { setMenu(null); return; }
    const acting = isPicked(d, sel, hit) ? sel : target;
    setSel(acting);
    const r = canvas.current!.getBoundingClientRect();
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, sel: acting });
  };

  const runMenu = (a: MenuAction, s: Selection) => {
    if (a === 'hide') edit((d) => hideSelection(d, s));
    else if (a === 'reset') edit((d) => resetSelection(d, s));
    else if (a === 'selectCard' && s.kind === 'children') setSel({ kind: 'card', card: s.card });
    else if (a === 'selectTeam') setSel(TEAMMATES);
  };
```

- In `onKeyDown`, directly below the Tab block, add:

```ts
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel.kind === 'none') return;
      e.preventDefault();
      const s = sel;
      edit((d) => hideSelection(d, s));
      return;
    }
```

- On the `<canvas>`, add `onContextMenu={onContextMenu}`; directly after `<Crumbs ... />` inside `hud__canvaswrap`, add:

```tsx
            {menu && (
              <ContextMenu
                x={menu.x} y={menu.y} onClose={() => setMenu(null)}
                items={menuActions(design, menu.sel).map((a) => ({ label: MENU_LABELS[a], run: () => runMenu(a, menu.sel) }))}
              />
            )}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/hud/ContextMenu.tsx web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx web/src/styles/app.css
git commit -m "Add a right-click menu on the HUD editor canvas (Hide, Reset, Select whole card, Select Teammates) and hide the selection with Delete"
```

---

### Task 17: Full verification and hand-off

**Files:**
- None changed, unless a check below fails.

**Interfaces:**
- Consumes: everything above; `scripts/check-hud-vpk.sh` (unchanged).
- Produces: the controller's browser checklist, in the final report.

- [ ] **Step 1: Full suite, types, build, the VPK checks**

Run: `npm test && npm run typecheck && npm run build && bash scripts/check-hud-vpk.sh && HUD_SAMPLE=b bash scripts/check-hud-vpk.sh`
Expected: every suite passes (the known pre-existing ECONNREFUSED noise on port 3000 from the replay viewer tests is not this plan's), typecheck and build are clean, and both VPK checks print `N files ok`. Report the real output, including the `Hud-*.js` chunk size from the build. Sample (a) is a fitted Column at scale 1.25 that grows back to `r240`; the on-screen clamp leaves it where it was, so its files are unchanged.

- [ ] **Step 2: No em dashes**

Run: `git diff master --name-only | xargs grep -lP '\x{2014}' || echo none`
Expected: `none` for this branch's files (one pre-existing hit in `tests/discordPresenter.test.ts` is a required test literal and is not this branch's).

- [ ] **Step 3: Nothing left of the old model**

Run: `grep -rn "selectedChild\|childCornerAt\|hud__pill\|hud__list\|snap(" web/src/routes web/src/hud | grep -v "\.test\." || echo none`
Expected: `none`. (`TeamControls` keeps its own `selectedCard` prop, which `ContextPanel` always passes as `null`; leave it.)

Run: `grep -n "hud__pill\|hud__list" web/src/styles/app.css || echo none`
Expected: the `.hud__list` rule and the four `.hud__pill*` rules, which nothing uses any more. Delete them and commit that alone:

```bash
git add web/src/styles/app.css
git commit -m "Drop the HUD editor's unused pill styles"
```

- [ ] **Step 4: Write the controller's browser checklist into the report, then stop**

Do not start a dev server; the controller drives the browser. List exactly this for the controller to check on `/hud` (clear the `hud` localStorage key first):

1. Layout: Layers on the left (Survivor HUD, Teammates expanded with its pieces, `＋ Health number`), the canvas with one toolbar above it (Undo, Redo, Survivor / Infected, Healthy / Down / Dead, Preset, Aspect, Backdrop, Font, Download at the right end), the context panel on the right with the hint, Styles and Save below.
2. Hover: moving over a teammate portrait outlines it (dashed) in all three cards with the label "Portrait"; holding Ctrl the outline becomes the whole Teammates.
3. One click on a card's health bar picks it: solid outline in all three cards, eight handles on the clicked card's bar, breadcrumb `Teammates › Health bar`. Dragging the bar moves only the bar; a pink guide appears when its edge lines up with the portrait or the card edge; Alt drag has no guides.
4. A drag started on an unpicked portrait moves the whole team; Undo (Ctrl+Z) puts it back in one step; Ctrl+Shift+Z and Ctrl+Y redo.
5. Handles: the bar's right handle widens it; Shift on a side handle keeps the ratio; the portrait's corner keeps it square; Your health's corner scales it from the opposite corner and the Scale slider follows; the chat box resizes from all eight handles.
6. Shift+click the portrait and the bar: one frame with four corner handles, "2 pieces in the teammate card"; drag either and both move; drag a corner to scale both; Align right, Visible off, Reset all. Shift+drag a box inside a card picks the pieces it touches; Ctrl+A picks every drawn piece; on empty screen Ctrl+A picks every visible element.
7. Layers: the eye hides and shows (struck through); Shift+click adds; in Free, Card 1..4 rows appear and a card shows its own X and Y.
8. Right-click a piece: Hide, Reset, Select Teammates (and Select whole card in Free); Delete and Backspace hide the selection.
9. Escape during a drag restores it; Escape otherwise climbs piece, card, Teammates, nothing.
10. Typing in a number box, Ctrl+Z undoes the typing, not the design. A slider drag and a typed number are one undo step each; held arrow keys are one step.
11. The known issue: Teammates at Scale 2 in a Row stay on screen (the row lifts off the bottom); a Teammates moved to the right and switched to Column stays on screen.
12. The Infected side: Layers lists its elements; the Infected teammates and siHealth scale from their corners.

Then the in-game check the owner runs: a scaled Row (the clamp) compared with the preview; nothing else in this phase changes a downloaded file.

Stop here. Do not merge, push or deploy.
