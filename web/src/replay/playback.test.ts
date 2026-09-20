import { describe, it, expect } from 'vitest';
import { advance, CLOSED_CATCHUP_MS, MAX_STEP_MS, SPEEDS, LIVE_BUFFER_MS, LIVE_SNAP_MS } from './playback';

describe('SPEEDS', () => {
  it('offers the four rates the toolbar shows', () => {
    expect([...SPEEDS]).toEqual([0.5, 1, 2, 4]);
  });
});

describe('advance', () => {
  it('moves forward by elapsed time at 1x', () => {
    expect(advance(1000, 16, 1, 10_000, false)).toBe(1016);
  });

  it('scales by speed', () => {
    expect(advance(1000, 100, 4, 10_000, false)).toBe(1400);
  });

  it('stops at the end when not following', () => {
    expect(advance(9950, 100, 1, 10_000, false)).toBe(10_000);
  });

  // Following is the live case. The end keeps moving as frames arrive, and
  // the viewer should ride it rather than repeatedly hitting a wall that
  // moves a moment later.
  // Live frames arrive in one second batches from the poll. Pinning to the
  // newest frame snapped everyone forward once a second with nothing played
  // in between; the clock now runs at real time a buffer behind the end.
  it('runs at real time while following, ignoring speed', () => {
    expect(advance(8000, 16, 4, 10_000, true)).toBe(8016);
  });

  it('never passes the newest frame while following', () => {
    expect(advance(9990, 16, 1, 10_000, true)).toBe(10_000);
  });

  it('jumps to the buffer point when it has fallen far behind', () => {
    expect(advance(0, 16, 1, 10_000, true)).toBe(10_000 - LIVE_BUFFER_MS);
    // A round only half a second old has no buffer to sit behind: the clock
    // simply runs at real time from wherever it is.
    expect(advance(0, 16, 1, 500, true)).toBe(16);
  });

  // When a round ends the server releases the ten seconds it was holding
  // back in one batch. The snap rule saw a clock nine seconds behind and
  // jumped to the end, skipping the finish of every round. A closed file's
  // end never moves again, so there is nothing to catch up to: play it out.
  it('plays a closed round out at real time while following instead of jumping', () => {
    expect(advance(0, 16, 1, 10_000, true, true)).toBe(16);
  });

  it('still holds at the last frame of a closed round while following', () => {
    expect(advance(9990, 16, 1, 10_000, true, true)).toBe(10_000);
  });

  // The other end of the same rule. Playing a closed file out at real time is
  // right for the ten seconds a round release leaves on the clock, and wrong
  // for a viewer who lands on a whole finished round: the live page opened in
  // the ten second window after a round ends resolves to that round's closed
  // file at t=0, and used to crawl the entire four minutes of it under a
  // "Round over, catching up" flag while the next round was actually being
  // played (2026-09-20).
  it('snaps to the end of a closed round it is nowhere near, while following', () => {
    expect(advance(0, 16, 1, 244_000, true, true)).toBe(244_000);
  });

  it('snaps only past the catch-up distance, so a round release still plays out', () => {
    const justInside = 10_000 - CLOSED_CATCHUP_MS + 10;
    expect(advance(justInside, 16, 1, 10_000, true, true)).toBe(justInside + 16);
    const justOutside = 10_000 - CLOSED_CATCHUP_MS - 10;
    expect(advance(justOutside, 16, 1, 10_000, true, true)).toBe(10_000);
  });

  // A paused viewer is not following, so nothing here applies to it: someone
  // who scrubbed back into a finished round is there on purpose.
  it('never snaps a closed round when not following', () => {
    expect(advance(0, 16, 1, 244_000, false, true)).toBe(16);
  });

  it('plays through a gap smaller than the snap distance rather than jumping', () => {
    const behind = 10_000 - LIVE_SNAP_MS + 10;
    expect(advance(behind, 16, 1, 10_000, true)).toBe(behind + 16);
  });

  it('never goes backwards past zero', () => {
    expect(advance(0, 16, 1, 0, false)).toBe(0);
  });

  // requestAnimationFrame stops while a tab is backgrounded, so the first
  // frame back reports the whole stall as elapsed. Without a cap, forty
  // seconds away moved a saved replay forty seconds on in one step.
  it('caps one step so a backgrounded tab does not jump the clock', () => {
    expect(advance(1000, 40_000, 1, 600_000, false)).toBe(1000 + MAX_STEP_MS);
  });

  it('caps before applying speed, so 4x cannot multiply a stall back in', () => {
    expect(advance(1000, 40_000, 4, 600_000, false)).toBe(1000 + MAX_STEP_MS * 4);
  });

  it('leaves a normal frame time alone', () => {
    expect(advance(1000, MAX_STEP_MS, 1, 600_000, false)).toBe(1000 + MAX_STEP_MS);
    expect(advance(1000, 16, 1, 600_000, false)).toBe(1016);
  });
});
