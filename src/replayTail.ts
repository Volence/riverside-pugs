import { frameBytes, type Frame } from './replayFormat.js';

/** How far behind live a viewer is held. This is an anti-ghosting control,
 *  not a buffering convenience: the live page is public, the frames carry
 *  every infected player's position, and the GHOST state bit shows where one
 *  is about to spawn from. Ten seconds is long enough that the information is
 *  spent by the time it is visible. */
export const DEFAULT_DELAY_MS = 10_000;

/**
 * Which of these frames may be sent to a viewer right now.
 *
 * Two independent rules, and a frame must satisfy both. Keeping them together
 * in one function is deliberate: the delay is meant to be defined in exactly
 * one place, and a second condition living anywhere else could drift from
 * this one.
 *
 * The wall-clock rule. Frames carry `tMs` relative to the round going live,
 * and the round's wall-clock start comes from the header's `startedUnix`, so
 * a frame's age is arithmetic with no clock synchronisation between the game
 * server and this process.
 *
 * The game-clock rule, applied when the file's mtime is supplied. `tMs` is
 * GAME time and `startedUnix` is WALL time, and those two agree only at the
 * moment the round goes live. An engine pause stops `GetGameTime()` while the
 * wall clock keeps running, and tech pauses are routine in ranked play, so
 * after a pause of P every later frame's `tMs` understates its true age by P
 * forever. At P of ten seconds the wall-clock rule alone would release the
 * frame being written this instant. The file's mtime is a fresh wall-clock
 * stamp for its newest frame, so
 *
 *   age(f) >= (newest.tMs - f.tMs) + (nowMs - mtimeMs)
 *
 * where the first term is a difference of two game times, which a pause
 * cancels out of, and the second is pure wall time. Every pause between `f`
 * and the newest frame only makes the real gap larger than the game-time
 * gap, so this errs towards holding a frame back rather than releasing it
 * early. Rearranged, `f` is old enough when
 * `f.tMs <= newest.tMs - (delayMs - idleMs)`.
 *
 * Every failure mode returns fewer frames, never more. An unknown round start
 * or a nonsensical delay releases nothing at all, because the cost of holding
 * back a frame is a viewer waiting and the cost of releasing one early is a
 * player reading live infected positions.
 */
export function releasableFrames(
  frames: Frame[],
  roundStartedUnixMs: number,
  nowMs: number,
  delayMs: number = DEFAULT_DELAY_MS,
  mtimeMs?: number,
): Frame[] {
  if (delayMs <= 0) return [];
  if (!roundStartedUnixMs || roundStartedUnixMs <= 0) return [];
  const cutoffTMs = nowMs - delayMs - roundStartedUnixMs;
  if (cutoffTMs < 0) return [];

  let limitTMs = cutoffTMs;
  if (mtimeMs !== undefined && mtimeMs > 0) {
    if (frames.length === 0) return [];
    // A future mtime is clock skew, not idleness, so clamp rather than let it
    // widen the window. Clamping the subtraction too is what lets a crashed
    // recording, idle for longer than the delay, release its whole file.
    const idleMs = Math.max(0, nowMs - mtimeMs);
    const newest = frames[frames.length - 1].tMs;
    const gameCutoffTMs = newest - Math.max(0, delayMs - idleMs);
    limitTMs = Math.min(limitTMs, gameCutoffTMs);
  }

  return frames.filter((f) => f.tMs <= limitTMs);
}

/**
 * The same decision as `releasableFrames`, expressed in bytes.
 *
 * The HTTP layer serves a prefix of the file rather than re-encoding frames,
 * so it needs the cutoff as an offset. Deriving it here from the frames
 * `releasableFrames` already approved is what keeps the delay rule in one
 * place: there is no second condition that could drift from the first.
 *
 * Returns 0, not the header size, when nothing is releasable. The caller
 * knows what floor it scanned from and 0 lets it say so; returning
 * HEADER_BYTES would be wrong for a caller that started mid-file.
 */
export function releasableBytes(
  frames: Frame[],
  roundStartedUnixMs: number,
  nowMs: number,
  delayMs: number = DEFAULT_DELAY_MS,
  mtimeMs?: number,
): number {
  const ok = releasableFrames(frames, roundStartedUnixMs, nowMs, delayMs, mtimeMs);
  if (ok.length === 0) return 0;
  const last = ok[ok.length - 1];
  return last.offset + frameBytes(last.entities.length);
}
