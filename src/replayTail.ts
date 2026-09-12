import type { Frame } from './replayFormat.js';

/** How far behind live a viewer is held. This is an anti-ghosting control,
 *  not a buffering convenience: the live page is public, the frames carry
 *  every infected player's position, and the GHOST state bit shows where one
 *  is about to spawn from. Ten seconds is long enough that the information is
 *  spent by the time it is visible. */
export const DEFAULT_DELAY_MS = 10_000;

/**
 * Which of these frames may be sent to a viewer right now.
 *
 * Frames carry `tMs` relative to the round going live, and the round's
 * wall-clock start comes from `match_rounds.started_at`, so a frame's real
 * time is arithmetic with no clock synchronisation between the game server
 * and this process.
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
): Frame[] {
  if (delayMs <= 0) return [];
  if (!roundStartedUnixMs || roundStartedUnixMs <= 0) return [];
  const cutoffTMs = nowMs - delayMs - roundStartedUnixMs;
  if (cutoffTMs < 0) return [];
  return frames.filter((f) => f.tMs <= cutoffTMs);
}
