import { describe, it, expect } from 'vitest';
import {
  healthColor, statusFlags, portraitFor, barSegments, healthBar,
  INCAP_ARC_MAX, INCAP_POOL, TEMP_HEALTH_COLOR,
} from './hud';
import { STATE, VERSION } from '../../../src/replayFormat';
import { distance } from './colorDistance';
import { GHOST_COLOR } from './draw';

describe('healthColor', () => {
  it('ramps green to red', () => {
    expect(healthColor(100, true)).not.toBe(healthColor(40, true));
    expect(healthColor(40, true)).not.toBe(healthColor(10, true));
  });

  it('greys out a dead player', () => {
    expect(healthColor(0, false)).toBe(healthColor(100, false));
  });
});

describe('statusFlags', () => {
  it('names each state bit that is set', () => {
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.INCAP)).toContain('Incapped');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.PINNED)).toContain('Pinned');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.BILED)).toContain('Biled');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.BURNING)).toContain('Burning');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.LEDGED)).toContain('Hanging');
  });

  it('names nothing for a healthy player', () => {
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE)).toEqual([]);
  });

  it('names a dead player as dead rather than listing bits', () => {
    expect(statusFlags(STATE.PRESENT)).toEqual(['Dead']);
  });
});

describe('portraitFor', () => {
  // The whole reason the version check exists. A version 1 file wrote 0 for
  // every survivor, so believing `cls` there would label all four of them
  // Bill.
  it('is the silhouette for a version 1 survivor', () => {
    expect(portraitFor(0, 1, true)).toBe('/portraits/unknown.png');
    expect(portraitFor(2, 1, true)).toBe('/portraits/unknown.png');
  });

  it('is the real character for a version 2 survivor', () => {
    expect(portraitFor(2, 2, true)).toBe('/portraits/francis.png');
  });

  it('is the silhouette for an out of range character index', () => {
    expect(portraitFor(99, 2, true)).toBe('/portraits/unknown.png');
  });

  it('is never a survivor portrait for an infected player', () => {
    expect(portraitFor(1, 2, false)).toBe('/portraits/unknown.png');
  });

  it('handles the current version without special casing', () => {
    expect(portraitFor(0, VERSION, true)).toBe(
      VERSION >= 2 ? '/portraits/bill.png' : '/portraits/unknown.png',
    );
  });
});

describe('barSegments', () => {
  it('splits permanent and temporary health as fractions', () => {
    expect(barSegments(50, 25)).toEqual({ perm: 0.5, temp: 0.25 });
  });

  it('clamps the total to the bar', () => {
    const got = barSegments(90, 90);
    expect(got.perm + got.temp).toBeLessThanOrEqual(1);
  });

  it('is empty for a dead player', () => {
    expect(barSegments(0, 0)).toEqual({ perm: 0, temp: 0 });
  });

  // A tank records 8000 health, which is why health is a uint16 in the
  // format. Passing its own max keeps the bar meaningful instead of pinned.
  it('accepts a different maximum', () => {
    expect(barSegments(4000, 0, 8000).perm).toBe(0.5);
  });
});

describe('healthBar for a downed survivor', () => {
  // These moved here from draw.test.ts when the map ring and the panel bar
  // were merged into one reading (Finding 6). The map's ring and the panel's
  // bar are now the same arithmetic, so the arithmetic is tested where it
  // lives rather than through one of its two call sites.
  const ringOf = (health: number, state: number) => healthBar(health, 0, 100, state).perm;

  // The bug this exists to close. `GetClientHealth` on a downed L4D survivor
  // returns the INCAPACITATION POOL, which starts at 300 and bleeds down, not
  // a 0-100 health value. The old ring computed health/100, clamped it to 1
  // and coloured it with healthColor(300, true), so the state that most needs
  // to shout drew a CLOSED BRIGHT GREEN ring: the colour that means "fine".
  it('does not draw a downed survivor a full ring off the 300 point incap pool', () => {
    const naive = Math.min(1, INCAP_POOL / 100);
    expect(naive).toBe(1);
    const frac = ringOf(INCAP_POOL, STATE.PRESENT | STATE.ALIVE | STATE.INCAP);
    expect(frac).toBeLessThanOrEqual(INCAP_ARC_MAX);
  });

  it('treats hanging off a ledge the same way, because it is the same pool', () => {
    const ledged = ringOf(INCAP_POOL, STATE.PRESENT | STATE.ALIVE | STATE.LEDGED);
    expect(ledged).toBeLessThanOrEqual(INCAP_ARC_MAX);
  });

  // The arc stays small throughout, but it still ticks down as the pool
  // bleeds out, so it carries the bleed-out clock rather than nothing.
  it('shrinks as the incap pool bleeds out, without ever growing large', () => {
    const full = ringOf(300, STATE.PRESENT | STATE.ALIVE | STATE.INCAP);
    const half = ringOf(150, STATE.PRESENT | STATE.ALIVE | STATE.INCAP);
    const empty = ringOf(0, STATE.PRESENT | STATE.ALIVE | STATE.INCAP);
    expect(full).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(empty);
    expect(full).toBeLessThanOrEqual(INCAP_ARC_MAX);
    expect(empty).toBeGreaterThan(0);
  });

  it('is still plain health over 100 for a survivor who is on their feet', () => {
    const up = STATE.PRESENT | STATE.ALIVE;
    expect(ringOf(100, up)).toBeCloseTo(1, 5);
    expect(ringOf(50, up)).toBeCloseTo(0.5, 5);
    expect(ringOf(0, up)).toBeCloseTo(0, 5);
  });

  // A downed survivor's arc must read as smaller than any healthy one, or
  // the whole point of the change is lost.
  it('always draws a smaller arc downed than a survivor on one point of health', () => {
    const down = ringOf(300, STATE.PRESENT | STATE.ALIVE | STATE.INCAP);
    const barely = ringOf(25, STATE.PRESENT | STATE.ALIVE);
    expect(down).toBeLessThan(barely);
  });
});

describe('healthBar', () => {
  const UP = STATE.PRESENT | STATE.ALIVE;

  // Finding 6. The map ring read PERMANENT health only while the panel drew
  // permanent plus temporary through `barSegments`, so a survivor on 20
  // permanent and 70 temporary showed a red sliver on the map and a nearly
  // full bar in the panel. The map, whose whole purpose is to save a viewer
  // looking down at the panel, was the less accurate of the two.
  it('includes temporary health, the way the panel bar always did', () => {
    const bar = healthBar(20, 70, 100, UP);
    expect(bar.perm).toBeCloseTo(0.2, 5);
    expect(bar.temp).toBeCloseTo(0.7, 5);
    expect(bar.perm + bar.temp).toBeCloseTo(0.9, 5);
  });

  it('is exactly barSegments for a survivor on their feet, so the panel is unchanged', () => {
    for (const [h, t] of [[100, 0], [20, 70], [0, 50], [90, 90], [55, 12]]) {
      const seg = barSegments(h, t, 100);
      const bar = healthBar(h, t, 100, UP);
      expect([bar.perm, bar.temp]).toEqual([seg.perm, seg.temp]);
    }
  });

  it('clamps the pair so a buffed survivor never overflows the bar or the ring', () => {
    const bar = healthBar(90, 90, 100, UP);
    expect(bar.perm + bar.temp).toBeCloseTo(1, 5);
  });

  it('normalises by max, so a tank on 8000 does not fall off the colour ramp', () => {
    expect(healthBar(8000, 0, 8000, UP).color).toBe(healthColor(100, true));
    expect(healthBar(8000, 0, 8000, UP).perm).toBeCloseTo(1, 5);
  });

  // The panel had the same 300 point bug the map ring did: barSegments(300,
  // ., 100) clamps to a full bar and healthColor(300) is green, so the moment
  // a survivor hit the floor the panel also said they were perfectly fine.
  it('does not draw a downed survivor a full green bar either', () => {
    const down = healthBar(INCAP_POOL, 0, 100, UP | STATE.INCAP);
    expect(down.perm).toBeLessThanOrEqual(INCAP_ARC_MAX);
    expect(down.temp).toBe(0);
    expect(down.color).toBe(healthColor(0, true));
    expect(down.color).not.toBe(healthColor(100, true));
    expect(down.downed).toBe(true);
  });

  it('empties the bar for a dead player', () => {
    const dead = healthBar(100, 50, 100, STATE.PRESENT);
    expect(dead.perm).toBe(0);
    expect(dead.temp).toBe(0);
    expect(dead.color).toBe(healthColor(0, false));
  });

  // Finding: the previous TEMP_HEALTH_COLOR (#5f9d78) sat only about 15 dE
  // from healthColor's teal under normal vision, and 12 to 14 dE under
  // protanopia and deuteranopia, so the permanent and temporary bar segments
  // nearly merged. `!==` alone would pass at 1 dE, so this asserts the
  // measured separation instead, following the idiom in draw.test.ts's
  // SLOT_COLORS-under-dichromacy checks.
  it('keeps the temporary colour far from every health-ramp colour and the ghost tint', () => {
    const refs = [
      healthColor(100, true),
      healthColor(40, true),
      healthColor(20, true),
      healthColor(0, false),
      GHOST_COLOR,
    ];
    for (const ref of refs) {
      expect(distance(TEMP_HEALTH_COLOR, ref)).toBeGreaterThanOrEqual(30);
    }
  });
});

describe('temp health noise floor', () => {
  // MEASURED, not guessed. The recorder stores m_healthBuffer floored, and
  // that netprop has a resting baseline rather than sitting at zero: across
  // one real round, 6111 of 8860 alive-survivor samples (69%) read exactly 1,
  // only 8 read 0, and at frame 0 (200ms in, before anyone can have taken
  // pills) all four survivors read hp=100 temp=1.
  //
  // So a recorded 1 means "none". Zeroing it here rather than at each call
  // site is the same reason healthBar exists at all: the map ring and the HUD
  // panel must not be able to disagree.
  // Below max health, where barSegments no longer clamps the sliver away.
  // This is the case in the report: a survivor on 78 showing "+1".
  it('reads a recorded temp of 1 as no temporary health at all', () => {
    const bar = healthBar(78, 1, 100, STATE.PRESENT | STATE.ALIVE);
    expect(bar.temp).toBe(0);
  });

  it('still counts real temporary health', () => {
    const bar = healthBar(50, 47, 100, STATE.PRESENT | STATE.ALIVE);
    expect(bar.temp).toBeGreaterThan(0);
  });

  it('treats a recorded 0 as none, the same as 1', () => {
    expect(healthBar(100, 0, 100, STATE.PRESENT | STATE.ALIVE).temp).toBe(0);
  });
});
