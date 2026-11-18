// Health-run scoring, rule hr1 (shadow mode). Pure functions only; see
// docs/superpowers/specs/2026-11-18-health-run-scoring-design.md.
//
// A survivor's points are solid health plus a weighted temp term:
//   solid + pills x (temp + pillStore if holding pills) + revives x (unused revive health)
// With pills and revives weighted equally, eaten-pill temp and revive temp need no telling apart, so the
// caller passes the survivor's current temp health once. A fresh survivor is fullPoints() (127.5 under hr1).
//
// A half's raw components are sums over the team, unweighted and unmultiplied:
//   ws/wt/wr walking (solid, temp+pills, revive), ts/tt/tr tank, ds/dt/dr door.

export const ALT_RULE = 'hr1';

export interface AltWeights {
  pills: number;
  revives: number;
  walkPool: number;
  tankPool: number;
  doorPool: number;
  pillStore: number;
  reviveStore: number;
  teamSize: number;
}

export const HR1: AltWeights = {
  pills: 0.25,
  revives: 0.25,
  walkPool: 700,
  tankPool: 300,
  doorPool: 500,
  pillStore: 50,
  reviveStore: 60,
  teamSize: 4,
};

const SOLID_MAX = 100;

export interface AltRaw {
  ws: number;
  wt: number;
  wr: number;
  ts: number;
  tt: number;
  tr: number;
  ds: number;
  dt: number;
  dr: number;
}

export interface SurvivorState {
  state: 'up' | 'down' | 'hanging' | 'dead';
  solid: number;
  temp: number;
  pillsHeld: boolean;
  reviveStore: number;
}

/** Points of a fresh survivor: full solid, a held bottle, and a full revive store. */
export function fullPoints(w: AltWeights = HR1): number {
  return SOLID_MAX + w.pillStore * w.pills + w.reviveStore * w.revives;
}

/** One survivor's points now. Dead is 0; a downed survivor's solid health counts 0. */
export function survivorPoints(s: SurvivorState, w: AltWeights = HR1): number {
  if (s.state === 'dead') return 0;
  const solid = s.state === 'down' ? 0 : s.solid;
  const pills = s.temp + (s.pillsHeld ? w.pillStore : 0);
  return solid + w.pills * pills + w.revives * s.reviveStore;
}

export interface AltParts {
  walk: number;
  tank: number;
  door: number;
  total: number;
}

/** A half's walk, tank and door points; each is rounded after its multiplier, total is their sum. */
export function halfParts(raw: AltRaw, walkMult: number, doorMult: number, w: AltWeights = HR1): AltParts {
  const full = fullPoints(w);
  const walk = Math.round(
    (walkMult * (w.walkPool / w.teamSize) * (raw.ws + w.pills * raw.wt + w.revives * raw.wr)) / full,
  );
  const tank = Math.round((w.tankPool * (raw.ts + w.pills * raw.tt + w.revives * raw.tr)) / (w.teamSize * full));
  const door = Math.round(
    (doorMult * (w.doorPool / w.teamSize) * (raw.ds + w.pills * raw.dt + w.revives * raw.dr)) / full,
  );
  return { walk, tank, door, total: walk + tank + door };
}

export interface AltHalf {
  ordinal: number;
  half: number;
  survTeam: 'a' | 'b';
  raw: AltRaw;
  walkMult: number;
  doorMult: number;
}

export interface AltMatch {
  altA: number;
  altB: number;
  altWinner: 'a' | 'b' | 'draw';
  complete: boolean;
  differs: boolean | null;
}

/**
 * Totals each team's halves under the rule and compares the alt winner with the real one.
 * `differs` is null unless every real half has an alt half and the real winner is known.
 */
export function compareMatch(
  halves: AltHalf[],
  realHalfCount: number,
  realWinner: 'a' | 'b' | 'draw' | null,
  w: AltWeights = HR1,
): AltMatch {
  let altA = 0;
  let altB = 0;
  for (const h of halves) {
    const { total } = halfParts(h.raw, h.walkMult, h.doorMult, w);
    if (h.survTeam === 'a') altA += total;
    else altB += total;
  }
  const altWinner = altA > altB ? 'a' : altB > altA ? 'b' : 'draw';
  const complete = halves.length === realHalfCount && realHalfCount > 0;
  const differs = complete && realWinner !== null ? altWinner !== realWinner : null;
  return { altA, altB, altWinner, complete, differs };
}
