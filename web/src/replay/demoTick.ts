/** Where a round sits in its map's SourceTV demo, as the timeline route
 *  serves it: `tick` is the demo tick at which the half went live (t_ms 0)
 *  and `hz` the server tickrate. Null for rounds from before pug-match
 *  0.3.12 or with no match demo, and then nothing about demos is shown. */
export interface DemoSync { tick: number; hz: number }

/** The demo tick for a moment `tMs` into the round, the number to give
 *  demoui's Goto or `demo_gototick`. */
export function demoTickAt(sync: DemoSync, tMs: number): number {
  return sync.tick + Math.round((Math.max(0, tMs) * sync.hz) / 1000);
}

/** Hover text for anything showing a demo tick. */
export function demoTickTitle(tick: number): string {
  return `SourceTV demo tick. In the match demo, type demo_gototick ${tick} in the console or enter it in demoui's Goto.`;
}
