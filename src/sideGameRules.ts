/**
 * The rules of a queue side game, with no I/O: how many play, who sits out,
 * who subs in. src/sideGames.ts applies them. See the spec,
 * docs/superpowers/specs/2026-09-28-queue-side-games-design.md.
 */
export type SideSize = 2 | 3;

/** 4-5 players play 2v2, 6-7 play 3v3. Under 4 is no game; 8 means the queue popped. */
export function sizeFor(n: number): SideSize | null {
  if (n === 4 || n === 5) return 2;
  if (n === 6 || n === 7) return 3;
  return null;
}

export interface SideCandidate {
  steamid: string;
  connected: boolean;
  /** Position in the PUG queue, 0 = front. */
  queuePos: number;
  /** Consecutive maps sat out. */
  satOut: number;
  /** Consecutive maps played. */
  playedStreak: number;
}

/** Who plays first: connected, then longest sitter, then shortest streak,
 *  then earliest in the queue. */
function playOrder(a: SideCandidate, b: SideCandidate): number {
  if (a.connected !== b.connected) return a.connected ? -1 : 1;
  if (a.satOut !== b.satOut) return b.satOut - a.satOut;
  if (a.playedStreak !== b.playedStreak) return a.playedStreak - b.playedStreak;
  return a.queuePos - b.queuePos;
}

export function choosePlaying(cands: SideCandidate[], size: SideSize): { playing: string[]; bench: string[] } {
  const sorted = [...cands].sort(playOrder);
  return {
    playing: sorted.slice(0, size * 2).map((x) => x.steamid),
    bench: sorted.slice(size * 2).map((x) => x.steamid),
  };
}

/** The connected player who has sat out longest, or null. */
export function pickSub(bench: SideCandidate[]): string | null {
  const ready = bench.filter((b) => b.connected).sort(playOrder);
  return ready[0]?.steamid ?? null;
}

export type LeaveAction =
  | { kind: 'sub'; steamid: string }
  | { kind: 'rebuild'; size: SideSize }
  | { kind: 'close' };

/**
 * A player has gone for good. `remaining` is everyone still in the game
 * (playing and sitting out); `bench` is the sitting-out part of it.
 * Shrinking is handled at once: a sub keeps the size, otherwise the game is
 * rebuilt at the size the remaining count supports, or closed under 4.
 */
export function onLeave(remaining: SideCandidate[], bench: SideCandidate[]): LeaveAction {
  const sub = pickSub(bench);
  if (sub) return { kind: 'sub', steamid: sub };
  const size = sizeFor(remaining.length);
  return size ? { kind: 'rebuild', size } : { kind: 'close' };
}
