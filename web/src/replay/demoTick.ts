/** A pause inside a round (pug-match 0.3.15 on). The replay clock is game
 *  time, which stands still while the server is paused, but the SourceTV demo
 *  keeps recording ticks, so from round time `tMs` on (the frozen moment the
 *  pause began) the demo is `ticks` further along than the round clock says. */
export interface DemoShift { tMs: number; ticks: number }

/** Where a round sits in its map's SourceTV demo, as the timeline route
 *  serves it: `tick` is the demo tick at which the half went live (t_ms 0)
 *  and `hz` the server tickrate. `shifts` lists the round's pauses, absent
 *  for none and for plugins before 0.3.15. Null for rounds from before
 *  pug-match 0.3.12 or with no match demo, and then nothing about demos is
 *  shown. */
export interface DemoSync { tick: number; hz: number; shifts?: DemoShift[] }

/** The demo tick for a moment `tMs` into the round, the number to give
 *  demoui's Goto or `demo_gototick`. A shift counts only for moments after
 *  its own: the frozen moment is the last tick simulated before the pause. */
export function demoTickAt(sync: DemoSync, tMs: number): number {
  let paused = 0;
  for (const s of sync.shifts ?? []) if (s.tMs < tMs) paused += s.ticks;
  return sync.tick + Math.round((Math.max(0, tMs) * sync.hz) / 1000) + paused;
}

/** Hover text for anything showing a demo tick. */
export function demoTickTitle(tick: number): string {
  return `SourceTV demo tick. In the match demo, type demo_gototick ${tick} in the console or enter it in demoui's Goto.`;
}
