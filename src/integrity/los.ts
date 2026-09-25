import { PLAYER_SLOTS, STATE, sideRanks, type Frame, type PlayerSample, type ReplayHeader } from '../replayFormat.js';

/**
 * Line of sight as the analyzer reads it.
 *
 * `canSee` in replayFormat.ts answers the same question, but recomputes the
 * side ranks on every call, and the analyzer asks it for every survivor, every
 * infected and every frame of every round in history. This computes the ranks
 * once per round. The answers are identical, which a test holds it to.
 *
 * Unknown is never "could not see". A file written before plan 1 has no bits
 * at all, so every question about it answers null and the hidden metrics do
 * not run on it.
 */

/** The special infected the hidden metrics score. A witch cannot move and a
 *  tank is loud and enormous, so knowing where either is gives nothing a
 *  survivor could not have heard. */
export type InfectedClass = 'smoker' | 'boomer' | 'hunter';
export const TRACKED_CLASSES: readonly InfectedClass[] = ['smoker', 'boomer', 'hunter'];

/** `m_zombieClass` (ZOMBIE_CLASSES in replayFormat.ts) to a scored class. */
export function classOf(cls: number): InfectedClass | null {
  if (cls === 1) return 'smoker';
  if (cls === 2) return 'boomer';
  if (cls === 3) return 'hunter';
  return null;
}

/** An infected the hidden metrics can be about: on the infected side,
 *  present, alive, spawned, and of a scored class. A ghost is metric A's
 *  business, not these.
 *
 *  The side check comes first because `cls` means something else on the
 *  survivor side: it holds the survivor's character number, and characters 1
 *  to 3 are the same numbers as smoker, boomer and hunter. Without it every
 *  survivor teammate was paired as a target and fell into `losUnknown` (the
 *  scores never saw them, but the gate tallies did). `infected` is always set
 *  by `decodeFrames`; a hand-built sample without it is taken at its class. */
export function isSpawnedTarget(p: PlayerSample): boolean {
  if (p.infected === false) return false;
  if ((p.state & STATE.PRESENT) === 0) return false;
  if ((p.state & STATE.ALIVE) === 0) return false;
  if ((p.state & STATE.GHOST) !== 0) return false;
  return classOf(p.cls) !== null;
}

export interface LosView {
  /** Whether the file records line of sight at all (header byte 158). */
  known: boolean;
  /** Could this survivor see this infected in this frame. Null when unknown. */
  sees(f: Frame, survivorSlot: number, infectedSlot: number): boolean | null;
  /** Could any survivor OTHER than `exceptSurvivorSlot` see this infected. A
   *  teammate who can see it may have called it out, so this is the voice
   *  confound the "hidden from the whole team" gate removes. Null when
   *  unknown. */
  othersSee(f: Frame, infectedSlot: number, exceptSurvivorSlot: number): boolean | null;
}

export const NO_LOS: LosView = { known: false, sees: () => null, othersSee: () => null };

export function losView(h: ReplayHeader): LosView {
  if (!h.losKnown) return NO_LOS;
  const { survivor, infected } = sideRanks(h);
  const bit = (f: Frame, sr: number, ir: number): boolean => (((f.los ?? 0) >> (sr * 4 + ir)) & 1) === 1;
  return {
    known: true,
    sees(f, survivorSlot, infectedSlot) {
      const sr = survivor[survivorSlot] ?? -1, ir = infected[infectedSlot] ?? -1;
      if (sr < 0 || ir < 0) return null;
      return bit(f, sr, ir);
    },
    othersSee(f, infectedSlot, exceptSurvivorSlot) {
      const ir = infected[infectedSlot] ?? -1;
      if (ir < 0) return null;
      for (let s = 0; s < PLAYER_SLOTS; s++) {
        if (s === exceptSurvivorSlot) continue;
        const sr = survivor[s];
        if (sr >= 0 && bit(f, sr, ir)) return true;
      }
      return false;
    },
  };
}
