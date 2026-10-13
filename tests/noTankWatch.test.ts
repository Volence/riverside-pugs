import { describe, expect, it } from 'vitest';
import { NoTankWatch, NO_TANK_HOLD_MS, noTankText } from '../src/noTankWatch.js';

const T = 'a'.repeat(32);

describe('NoTankWatch', () => {
  it('flags match 673: prog 43 against a 30% tank, no tank_spawn', () => {
    const w = new NoTankWatch();
    w.roundStart(T, 'l4d_vs_smalltown04_mainstreet', 1);
    expect(w.hud(T, 29, 30, 0)).toBeNull();
    expect(w.hud(T, 35, 30, 2_000)).toBeNull(); // past the margin, hold starts
    expect(w.hud(T, 38, 30, 2_000 + NO_TANK_HOLD_MS - 1)).toBeNull();
    const a = w.hud(T, 43, 30, 2_000 + NO_TANK_HOLD_MS);
    expect(a).toEqual({ map: 'l4d_vs_smalltown04_mainstreet', half: 1, tank: 30, prog: 43 });
    expect(noTankText(673, a!)).toContain('Match 673: no tank on l4d_vs_smalltown04_mainstreet half 1');
    // Once per half.
    expect(w.hud(T, 50, 30, 60_000)).toBeNull();
  });

  it('stays quiet when the tank spawned, even if the event lags the spawn', () => {
    const w = new NoTankWatch();
    w.roundStart(T, 'm', 1);
    w.hud(T, 36, 30, 0);
    w.event(T, 'tank_spawn');
    expect(w.hud(T, 40, 30, NO_TANK_HOLD_MS * 2)).toBeNull();
  });

  it('ignores halves with no tank and progress inside the margin', () => {
    const w = new NoTankWatch();
    w.roundStart(T, 'm', 2);
    expect(w.hud(T, 90, 0, 0)).toBeNull();
    expect(w.hud(T, 90, 0, NO_TANK_HOLD_MS * 2)).toBeNull();
    w.roundStart(T, 'm', 2);
    w.hud(T, 34, 30, 0);
    expect(w.hud(T, 34, 30, NO_TANK_HOLD_MS * 2)).toBeNull();
  });

  it('restarts the hold when progress drops back, and a replayed half starts clean', () => {
    const w = new NoTankWatch();
    w.roundStart(T, 'm', 1);
    w.hud(T, 36, 30, 0);
    w.hud(T, 33, 30, 5_000); // back inside the margin
    expect(w.hud(T, 36, 30, NO_TANK_HOLD_MS + 1)).toBeNull();
    w.event(T, 'tank_spawn');
    w.roundStart(T, 'm', 1); // map restarted: the old spawn does not count
    w.hud(T, 36, 30, 100_000);
    expect(w.hud(T, 36, 30, 100_000 + NO_TANK_HOLD_MS)).not.toBeNull();
  });

  it('knows nothing about a token without a ROUND_START', () => {
    const w = new NoTankWatch();
    expect(w.hud(T, 90, 30, 0)).toBeNull();
    expect(w.hud(T, 90, 30, NO_TANK_HOLD_MS * 2)).toBeNull();
  });
});
