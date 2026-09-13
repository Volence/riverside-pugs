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
