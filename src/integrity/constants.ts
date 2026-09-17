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
   *  NOT filtered by kind. Every kind the recorder writes is a VISIBLE object:
   *  `RplWorldKind` in plugin/pug-match.sp admits only `infected`, `witch` and
   *  `tank_rock`, plus survivor bots from the player block. Ghost infected are
   *  players and are already excluded by `visibleOthers`, so no invisible thing
   *  ever reaches this list. Dropping a kind would therefore be discarding a
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
  /** "On target" for the occupancy metric, in degrees. */
  E_DWELL: 5,
  /** Windows above this fidelity become reviewable clips. */
  CLIP_MIN: 0.7,
  /** Most clips kept per player-round. */
  CLIPS_PER_ROUND: 5,
} as const;
