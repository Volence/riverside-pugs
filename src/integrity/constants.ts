/**
 * Every tuning number the analyzer has, in one place.
 *
 * These WILL be wrong on the first run. That is why nothing derived from them
 * is ever stored: `integrity_rounds` holds measurements, and `score.ts` turns
 * them into rankings at read time. Changing a number here and re-running the
 * backfill re-scores the entire history.
 */
export const TUNING = {
  /** Ghosts closer than this are dropped. Close coincidences are common and
   *  prove nothing. World units. */
  D_MIN: 300,
  /** Nothing in the first stretch of a round counts: everyone is looking
   *  around and the first spawns are scripted by position. */
  SPAWN_GRACE_MS: 5000,
  /** If a non-ghost target is within this many degrees of the ghost's bearing,
   *  the frame is dropped. The analyzer has no line of sight, so it cannot
   *  tell an invisible ghost from the visible thing next to it. */
  OCCLUDE_WINDOW: 15,
  /** How far an occluder may be from the survivor and still veto a frame.
   *
   *  Two decisions live here, and both were defaults rather than choices until
   *  2026-09-17.
   *
   *  BOUNDED, at the same reach the aim prior uses. `wedgeCells` stops
   *  rasterising at R_MAX, so the analyzer's own working definition of "the
   *  player is looking at that" already ends there. An unbounded list let a
   *  common infected on the far side of the map veto a frame it has nothing to
   *  do with, and commons swarm: a veto is any occluder inside 1/12 of the
   *  circle, a window needs 20 consecutive surviving frames, so with k
   *  occluders the survival odds run about (11/12)^(20k). Eight of them is
   *  about one in a million. That is structural blindness, not strictness.
   *
   *  NOT filtered by kind, but filtered on STATE. An occluder has to be a thing
   *  the survivor could actually have been looking at, and visibility is a
   *  property of state rather than of kind: an AI hunter is a perfectly good
   *  alternative explanation for a crosshair once it has spawned, and no
   *  explanation at all while it is still a ghost.
   *
   *  Entities really can carry the ghost bit. The frame writer has two loops
   *  feeding one entity array. `RplWorldKind` (plugin/pug-match.sp:852) supplies
   *  `infected`, `witch` and `tank_rock`, which are always visible. The second
   *  loop (plugin/pug-match.sp:1341) writes non-rostered CLIENTS through
   *  `RplBotKind` (survivor bots, AI specials, the AI tank) and stamps them with
   *  `RplClientState(c, RplIsGhost(c))`, the same GHOST bit a human infected
   *  carries. A bot filling a disconnected SI's slot mid-round is the ordinary
   *  way an invisible entity appears. `visibleOthers` therefore drops any entity
   *  with `STATE.GHOST`, mirroring what the players loop already does.
   *
   *  Dropping a whole KIND would be different, and wrong: it would discard a
   *  real alternative explanation for the crosshair, which is exactly what the
   *  guard exists to honour.
   *
   *  The gate tally in RoundMetrics counts how often this fires, so the number
   *  can be revisited against evidence rather than against reasoning. */
  OCCLUDE_MAX_DIST: 2000,
  /** Aim prior grid cell size, world units. */
  CELL: 256,
  /** How far out the aim wedge is rasterised when building the prior. */
  R_MAX: 2000,
  /** A map with fewer player-rounds than this gets no occupancy score at all.
   *  Scoring against a thin prior is worse than not scoring. */
  MIN_PRIOR_ROUNDS: 20,
  /** Fidelity window length in frames. 20 frames is 2 seconds at 10 Hz. */
  W: 20,
  /** A fidelity window requires the aim to stay inside this many degrees of
   *  the ghost for its whole length. */
  E_TRACK: 12,
  /** Heights above an entity's origin, world units: the survivor's eye, and the
   *  point on a ghost a crosshair would rest on. Positions in the file are
   *  origins, which is the feet.
   *
   *  Used only to turn a height difference into the pitch that would look at
   *  it, for the PITCH_TOL gate. Both are rough (the file has no crouch state,
   *  and a hunter is not a smoker), which is why the gate is loose.
   *
   *  The SIGN was verified, not assumed. Over the 189 replays in hand on
   *  2026-09-21, 13261 frames where a survivor's clip dropped while their yaw
   *  was inside 3 degrees of a spawned special infected 300 or more units away:
   *  pitch against elevation has slope -0.87, r = -0.84, and targets 15 degrees
   *  or more BELOW the survivor read a median pitch of +23. Negative is up. With
   *  these two heights the median residual is -0.8 degrees. */
  EYE_Z: 62,
  TARGET_Z: 36,
  /** On target means the pitch is within this many degrees of the ghost as well
   *  as the yaw. Loose on purpose: at D_MIN a crouch is worth 3 degrees, the
   *  choice of aim point on the body another 7, and pitch is stored in whole
   *  degrees. In the same 13261 firing frames the residual is inside 8.0 at
   *  p90 and 16.2 at p95, and the tail beyond that is mostly shots at something
   *  else that happened to share the yaw. What this removes is a ghost on
   *  another floor: 9% of version 3's windows (121 of 1325) held a frame with
   *  the pitch more than 20 degrees off the ghost supposedly being followed. */
  PITCH_TOL: 20,
  /** A fidelity window scores only when the motion it required, summed frame to
   *  frame, comes to at least this many degrees. "Required" is the series
   *  `trackFidelity` normalises by, so it is already net of the survivor's own
   *  movement.
   *
   *  Positions are int16. One unit of rounding is 0.19 degrees at D_MIN, so a
   *  ghost that barely moves produces a required motion made of rounding and
   *  nothing else, and a ratio of two rounding errors is not a measurement.
   *  Version 3 scored windows whose bearing moved 0.09 degrees a frame.
   *
   *  Measured over the 189 replays in hand on 2026-09-21, 1325 windows:
   *    ghost still, or moved under 20 units in the 2 s (524 windows, 40% of
   *      them all): travel 0 at the median, 1.96 at the most. Expected from
   *      rounding alone at D_MIN is about 1.2.
   *    ghost moved 300 units or more (437 windows), which is a ghost actually
   *      going somewhere: 3.2 at p10, 5.6 at p25, 8.3 median, 10.7 at p75.
   *  4 is twice the worst rounding-only window and keeps 86% of the real
   *  movement. The 10 to 15 first suggested for this would have kept 29% and
   *  15% of it, which is a detector that mostly does not run. No window at or
   *  above 4 scored over 0.21, so nothing is being let in by the low bar. */
  MIN_TRAVEL: 4,
  /** "On target" for the occupancy metric, in degrees. */
  E_DWELL: 5,
  /** Metric B counts in blocks of this many milliseconds per ghost, not in
   *  frames, because frames are nowhere near independent. Over the 189 replays
   *  in hand on 2026-09-21 (232826 eligible pair-frames) the on-target
   *  indicator correlates with itself 0.70 one frame later, 0.29 at 1 s, 0.25
   *  at 2 s, 0.16 at 5 s and 0.04 at 10 s.
   *
   *  The length is chosen by what it does to the per-round score, which has to
   *  have a spread near 1 before anyone may call it a z-score. Same data, 708
   *  player-rounds, calibrated per map as in score.ts:
   *    frames  sd 3.42, 35.6% beyond 2 either way, max 38.0
   *    1 s     sd 1.19,  5.1%, max 10.2
   *    2 s     sd 0.95,  3.7%, max 6.4, p95 1.68
   *    3 s     sd 0.87,  3.8%, max 4.7
   *    5 s     sd 0.79,  3.0%, max 3.7
   *  A normal gives 4.6% and a p95 of 1.64. 2 s is the shortest block under 1,
   *  so what error is left is on the conservative side, and longer blocks only
   *  give sensitivity away. The mean is -0.01 at every length; the median sits
   *  at -0.27 because a count that cannot go below zero is skewed, which is
   *  also why the low tail is short (p05 -1.03). */
  OCC_BLOCK_MS: 2000,
  /** A map calibrates its own occupancy level (see `calibrate` in score.ts)
   *  once the rows on the board add up to this many EXPECTED on-target blocks
   *  there. Under it the ratio is a handful of events over a handful, and the
   *  whole board's ratio is used instead. A player-round expects about 2.5,
   *  so this is roughly four of them. */
  MIN_CAL_EXPECTED: 10,
  /** Windows above this fidelity become reviewable clips. */
  CLIP_MIN: 0.7,
  /** Most clips kept per player-round. */
  CLIPS_PER_ROUND: 5,
} as const;
