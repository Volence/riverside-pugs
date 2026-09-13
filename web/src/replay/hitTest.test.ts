import { describe, it, expect } from 'vitest';
import { hitTest, sameHit, stageHit, type HitItem } from './hitTest';

const items: HitItem[] = [
  { kind: 'marker', px: 100, py: 100, r: 8, seq: 5 },
  { kind: 'entity', px: 104, py: 100, r: 9, entityKind: 8, health: 250, state: 0 },
  { kind: 'player', px: 108, py: 100, r: 17, slot: 2 },
];

describe('hitTest', () => {
  it('is null on an empty scene or a miss', () => {
    expect(hitTest([], 100, 100)).toBeNull();
    expect(hitTest(items, 300, 300)).toBeNull();
  });

  it('returns the topmost (last drawn) item under the pointer', () => {
    expect(hitTest(items, 100, 100)).toMatchObject({ kind: 'player', slot: 2 });
  });

  it('respects each item radius', () => {
    expect(hitTest(items, 92, 100)).toMatchObject({ kind: 'player' });   // 16 from the player centre, inside 17
    expect(hitTest(items, 90, 100)).toBeNull();                          // 10 from the marker (outside 8), 14 from
    // the entity (outside 9), 18 from the player (outside 17): miss all three.
  });

  // The player's hit circle (centre 108, r 17) fully encloses the marker's
  // (centre 100, r 8: the centres are 8 apart and 8 + 8 = 16 <= 17), so no
  // point on this line can ever reach the marker without also reaching the
  // player, and the player is topmost. 94 is 6 from the marker (inside 8)
  // and, unavoidably, 14 from the player (inside 17 too) so the topmost item
  // wins, exactly as it does at 100 above.
  it('gives the topmost item the win even where a lower item is also in range', () => {
    expect(hitTest(items, 94, 100)).toMatchObject({ kind: 'player' });
  });

  it('finds the marker on its own, once nothing bigger is drawn over it', () => {
    expect(hitTest(items.slice(0, 2), 94, 100)).toMatchObject({ kind: 'marker' });
  });

  // The marker (centre 100, r 8) also covers x 104 (4 away), but the entity
  // (centre 104, r 9) is drawn later, so with the player out of the way the
  // entity is the topmost hit here, not the marker underneath it.
  it('gives the entity the win over a marker it was drawn over', () => {
    expect(hitTest(items.slice(0, 2), 104, 100)).toMatchObject({ kind: 'entity' });
  });
});

describe('sameHit', () => {
  it('is true for two nulls and false for one null one hit', () => {
    expect(sameHit(null, null)).toBe(true);
    expect(sameHit(null, items[2])).toBe(false);
    expect(sameHit(items[2], null)).toBe(false);
  });

  it('is true for the identical object', () => {
    expect(sameHit(items[0], items[0])).toBe(true);
  });

  it('compares players by slot, not object identity', () => {
    const a: HitItem = { kind: 'player', px: 1, py: 1, r: 1, slot: 3 };
    const b: HitItem = { kind: 'player', px: 999, py: 999, r: 99, slot: 3 };
    const c: HitItem = { kind: 'player', px: 1, py: 1, r: 1, slot: 4 };
    expect(sameHit(a, b)).toBe(true);
    expect(sameHit(a, c)).toBe(false);
  });

  it('compares markers by seq', () => {
    const a: HitItem = { kind: 'marker', px: 1, py: 1, r: 1, seq: 7 };
    const b: HitItem = { kind: 'marker', px: 2, py: 2, r: 2, seq: 7 };
    const c: HitItem = { kind: 'marker', px: 1, py: 1, r: 1, seq: 8 };
    expect(sameHit(a, b)).toBe(true);
    expect(sameHit(a, c)).toBe(false);
  });

  it('compares entities by position and entityKind, since they carry no id', () => {
    const a: HitItem = { kind: 'entity', px: 10, py: 20, r: 9, entityKind: 4, health: 1000, state: 0 };
    const b: HitItem = { kind: 'entity', px: 10, py: 20, r: 9, entityKind: 4, health: 800, state: 1 };
    const c: HitItem = { kind: 'entity', px: 11, py: 20, r: 9, entityKind: 4, health: 1000, state: 0 };
    const d: HitItem = { kind: 'entity', px: 10, py: 20, r: 9, entityKind: 5, health: 1000, state: 0 };
    expect(sameHit(a, b)).toBe(true);
    expect(sameHit(a, c)).toBe(false);
    expect(sameHit(a, d)).toBe(false);
  });

  it('is false across different kinds even at the same point', () => {
    const a: HitItem = { kind: 'marker', px: 1, py: 1, r: 1, seq: 1 };
    const b: HitItem = { kind: 'entity', px: 1, py: 1, r: 1, entityKind: 1, health: 0, state: 0 };
    expect(sameHit(a, b)).toBe(false);
  });
});

describe('stageHit', () => {
  it('subtracts the follow shift before testing', () => {
    const hits: HitItem[] = [{ kind: 'player', px: 50, py: 60, r: 17, slot: 0 }];
    // The pointer is at (70, 75) on screen; the scene was shifted by (20, 15)
    // when it was drawn, so the hit's own recorded position is (50, 60).
    expect(stageHit(hits, 70, 75, { x: 20, y: 15 }, false)).toMatchObject({ slot: 0 });
    // Without subtracting the shift this would miss (70,75) vs (50,60), 25px away.
    expect(hitTest(hits, 70, 75)).toBeNull();
  });

  it('is null while dragging, regardless of what is under the pointer', () => {
    const hits: HitItem[] = [{ kind: 'player', px: 50, py: 60, r: 17, slot: 0 }];
    expect(stageHit(hits, 50, 60, { x: 0, y: 0 }, true)).toBeNull();
  });
});
