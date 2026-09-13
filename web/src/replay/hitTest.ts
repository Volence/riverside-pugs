export type HitItem =
  | { kind: 'player'; px: number; py: number; r: number; slot: number }
  | { kind: 'entity'; px: number; py: number; r: number; entityKind: number; health: number; state: number }
  | { kind: 'marker'; px: number; py: number; r: number; seq: number };

/** Hit radius for a marker tag: the tag is 12px square, and a finger or a
 *  quick mouse wants a little more than that. */
export const MARKER_HIT_R = 8;

/** The topmost item under the pointer: items are recorded in draw order, so
 *  the last one within its radius is the one painted on top. */
export function hitTest(items: readonly HitItem[], px: number, py: number): HitItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const dx = it.px - px; const dy = it.py - py;
    if (dx * dx + dy * dy <= it.r * it.r) return it;
  }
  return null;
}

/** Whether two hits are the same item, not merely equal-looking objects: each
 *  paint records a fresh `HitItem[]`, so `a === b` is never true across two
 *  paints even when the pointer never left the same medallion. Compared by
 *  the field that actually identifies one instance of that kind (`slot` for
 *  a player, `seq` for a marker, position plus `entityKind` for a world
 *  entity, since entities carry no id of their own). Used to decide whether
 *  a hover state update is needed at all: see `stageHit` and Viewer's
 *  `onPointerMove`. */
export function sameHit(a: HitItem | null, b: HitItem | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'player' && b.kind === 'player') return a.slot === b.slot;
  if (a.kind === 'marker' && b.kind === 'marker') return a.seq === b.seq;
  return a.kind === 'entity' && b.kind === 'entity'
    && a.entityKind === b.entityKind && a.px === b.px && a.py === b.py;
}

/**
 * The item under the pointer at stage-relative coordinates `(x, y)`.
 *
 * `hits` are recorded in the canvas's own pre-shift space (see
 * `ReplayCanvasProps.hitsRef`): the follow camera translates the drawing by
 * `shift` after the hits are pushed, so the pointer position has to be moved
 * back by that same `shift` before it lines up with them. A drag in progress
 * suppresses hit testing outright, camera or not: a pointer dragging the map
 * around must never land a tooltip, or arm a click-to-seek, on whatever used
 * to be under it before the drag started.
 */
export function stageHit(
  hits: readonly HitItem[], x: number, y: number, shift: { x: number; y: number }, dragging: boolean,
): HitItem | null {
  if (dragging) return null;
  return hitTest(hits, x - shift.x, y - shift.y);
}
