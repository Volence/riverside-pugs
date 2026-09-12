import { STATE, type EntitySample, type Frame, type PlayerSample } from '../../../src/replayFormat';

/** How far an entity may move between two samples and still be believed to be
 *  the same entity. At 10Hz a sprinting common covers roughly 25 units, and a
 *  tank throwing itself around covers more, so this is generous. It exists to
 *  catch a recycled index, which teleports across the map, not to catch fast
 *  movement. */
export const MAX_ENTITY_JUMP = 600;

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Interpolate a yaw the short way around.
 *
 *  Yaw is stored in +/- 180, so a player turning through south goes from 170
 *  to -170. Treated as plain numbers that is a 340 degree spin in the wrong
 *  direction, once per turn, and it is extremely visible. */
export function lerpAngle(a: number, b: number, f: number): number {
  const delta = ((b - a + 540) % 360) - 180;
  return a + delta * f;
}

/**
 * The two frames a time falls between, and how far between them it is.
 *
 * Binary search rather than a scan: a round holds several thousand frames and
 * this runs on every animation frame.
 */
export function bracket(
  frames: Frame[], tMs: number,
): { a: Frame; b: Frame; f: number } | null {
  if (frames.length === 0) return null;
  if (tMs <= frames[0].tMs) return { a: frames[0], b: frames[0], f: 0 };
  const last = frames[frames.length - 1];
  if (tMs >= last.tMs) return { a: last, b: last, f: 0 };

  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].tMs <= tMs) lo = mid;
    else hi = mid;
  }

  const a = frames[lo];
  const b = frames[hi];
  const span = b.tMs - a.tMs;
  return { a, b, f: span > 0 ? (tMs - a.tMs) / span : 0 };
}

/**
 * Positions and angles interpolate. Everything else does not.
 *
 * State is a bitfield, health is a number that means something exact, and the
 * weapon is an id. Half of "incapacitated" is meaningless, and a health bar
 * that slides from 100 to 0 over a tenth of a second reads as a slow death
 * rather than an instant one. Discrete fields come from the earlier frame,
 * so they change exactly when the recording says they changed.
 *
 * An empty slot in the later frame is the one case where taking position from
 * both would be wrong. A disconnect or a substitution writes an all-zero
 * record, and because the state byte comes from the earlier frame the avatar
 * keeps its PRESENT bit for the interval: lerping towards zero would streak
 * it across the map to the world origin before it vanished. It holds still
 * instead.
 */
export function interpolatePlayers(a: Frame, b: Frame, f: number): PlayerSample[] {
  return a.players.map((pa, i) => {
    const pb = b.players[i] ?? pa;
    const to = (pb.state & STATE.PRESENT) !== 0 ? pb : pa;
    return {
      ...pa,
      x: lerp(pa.x, to.x, f),
      y: lerp(pa.y, to.y, f),
      z: lerp(pa.z, to.z, f),
      yaw: lerpAngle(pa.yaw, to.yaw, f),
    };
  });
}

/**
 * Entities are matched by index, which the format warns is recycled.
 *
 * An entity only interpolates when the later frame has the same ref, the same
 * kind, and a plausible distance. Anything else is drawn where the later
 * frame says it is, which pops for one frame and is correct, rather than
 * sliding smoothly between two different zombies, which looks smooth and is
 * nonsense.
 */
export function interpolateEntities(
  a: Frame, b: Frame, f: number, maxJump: number = MAX_ENTITY_JUMP,
): EntitySample[] {
  const prev = new Map<number, EntitySample>();
  for (const e of a.entities) prev.set(e.ref, e);

  return b.entities.map((eb) => {
    const ea = prev.get(eb.ref);
    if (!ea || ea.kind !== eb.kind) return eb;
    const dx = eb.x - ea.x;
    const dy = eb.y - ea.y;
    const dz = eb.z - ea.z;
    if (dx * dx + dy * dy + dz * dz > maxJump * maxJump) return eb;
    return {
      ...eb,
      x: lerp(ea.x, eb.x, f),
      y: lerp(ea.y, eb.y, f),
      z: lerp(ea.z, eb.z, f),
    };
  });
}
