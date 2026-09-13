import { describe, it, expect } from 'vitest';
import { hitTest, type HitItem } from './hitTest';

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
});
