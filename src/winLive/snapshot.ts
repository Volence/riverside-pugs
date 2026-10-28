import type { DB } from '../db.js';
import { ENTITY_KIND, STATE, type Frame } from '../replayFormat.js';
import type { RoundKey, RoundReplay } from '../metrics/types.js';
import { FRAME_DT_CAP_MS } from '../metrics/replayRound.js';

/**
 * Half snapshots: one recorded half turned into 5-second pictures of the game
 * state, the rows the live win model trains on.
 *
 * Replay frame times and the data feeds' `t_ms` / `spawn_ms` are the same
 * clock, the plugin's RoundMs() (ms since the half went live), and the
 * replay's paused frames are already dropped by `unpausedFrames` without
 * renumbering the clock. So a feed sample and a frame are paired by `tMs`,
 * never by frame index.
 */

/** Where the tank is: not yet spawned, on the field, or gone after being seen. */
export type TankState = 'pending' | 'alive' | 'dead';

export interface Snapshot {
  tMs: number;
  /** Furthest route progress so far, 0..100, or null before any sample. */
  prog: number | null;
  /** Survivors alive (incapped and ledged ones included). */
  alive: number;
  /** Survivors incapped or hanging from a ledge. */
  down: number;
  /** Sum of health + temp over alive, standing survivors, capped at 100 each. */
  health: number;
  tank: TankState;
  /** Tank health over the most it was seen with; null unless alive and known. */
  tankHealthFrac: number | null;
  /** Tank flow % minus `prog` while the tank is pending; else null. */
  tankFlowGap: number | null;
}

const TANK_CLS = 5;
const SURVIVOR_HEALTH_CAP = 100;
export const SNAPSHOT_EVERY_MS = 5000;
/** No tank in the frames for longer than this means the tank is dead. */
export const TANK_GONE_MS = 2000;

/** Progress as a function of half time: furthest so far (monotone max),
 *  linear between samples, null before the first sample. Samples outside
 *  0..100 are dropped as bad data. */
export function progressTimeline(points: { tMs: number; prog: number }[]): (tMs: number) => number | null {
  const sorted = points
    .filter((p) => Number.isFinite(p.prog) && p.prog >= 0 && p.prog <= 100)
    .sort((a, b) => a.tMs - b.tMs);
  const ts: number[] = [];
  const ps: number[] = [];
  let best = -Infinity;
  for (const p of sorted) {
    best = Math.max(best, p.prog);
    // A repeated time keeps the larger running max rather than a vertical step.
    if (ts.length > 0 && ts[ts.length - 1] === p.tMs) ps[ps.length - 1] = best;
    else { ts.push(p.tMs); ps.push(best); }
  }
  return (tMs: number): number | null => {
    if (ts.length === 0 || tMs < ts[0]) return null;
    if (tMs >= ts[ts.length - 1]) return ps[ps.length - 1];
    // Last sample at or before tMs.
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= tMs) lo = mid; else hi = mid - 1;
    }
    const f = (tMs - ts[lo]) / (ts[lo + 1] - ts[lo]);
    return ps[lo] + (ps[lo + 1] - ps[lo]) * f;
  };
}

/** The tank on the field in this frame, with a key stable across frames, or null. */
function liveTank(frame: Frame): { key: string; health: number } | null {
  for (const p of frame.players) {
    if (p.infected === true && p.cls === TANK_CLS
      && (p.state & STATE.ALIVE) !== 0 && (p.state & STATE.GHOST) === 0) {
      return { key: `p${p.slot}`, health: p.health };
    }
  }
  for (const e of frame.entities) {
    if (e.kind === ENTITY_KIND.TANK_AI && (e.state & STATE.ALIVE) !== 0) {
      return { key: `e${e.ref}`, health: e.health };
    }
  }
  return null;
}

/** One frame as a snapshot. Pure: whether a tank that is not on the field has
 *  died or not yet spawned needs the frames before this one, so this returns
 *  'pending' for it and `halfSnapshots` upgrades it to 'dead'. */
export function snapshotAt(
  frame: Frame,
  prog: number | null,
  tankFlow: number | null,
  tankSpawnHealth: number | null = null,
): Snapshot {
  let alive = 0, down = 0, health = 0;
  for (const p of frame.players) {
    if (p.infected !== false) continue;
    if ((p.state & STATE.ALIVE) === 0) continue;
    alive++;
    if ((p.state & (STATE.INCAP | STATE.LEDGED)) !== 0) { down++; continue; }
    health += Math.min(p.health + p.temp, SURVIVOR_HEALTH_CAP);
  }
  const tank = liveTank(frame);
  let tankHealthFrac: number | null = null;
  if (tank && tankSpawnHealth !== null && tankSpawnHealth > 0) {
    tankHealthFrac = Math.min(Math.max(tank.health / tankSpawnHealth, 0), 1);
  }
  const state: TankState = tank ? 'alive' : 'pending';
  const tankFlowGap = state === 'pending' && tankFlow !== null && prog !== null ? tankFlow - prog : null;
  return { tMs: frame.tMs, prog, alive, down, health, tank: state, tankHealthFrac, tankFlowGap };
}

/** A snapshot every `everyMs` of half time, each from the latest frame at or
 *  before that time (its `tMs` is that frame's).
 *
 *  Walks every frame, but only ever looks backwards: the tank's spawn health is
 *  the most health seen so far in the current tank life, never a later peak, so
 *  a training row holds only what a live reader would have known. A tank life
 *  survives a pass (AI to player, player to player) and a short gap in the
 *  frames; it ends when no tank has been seen for more than TANK_GONE_MS, and
 *  a tank after that starts a new life with fresh spawn health. */
export function halfSnapshots(
  rr: RoundReplay,
  prog: (tMs: number) => number | null,
  tankFlow: number | null,
  everyMs = SNAPSHOT_EVERY_MS,
): Snapshot[] {
  const frames = rr.frames;
  if (frames.length === 0) return [];
  const out: Snapshot[] = [];
  let lifeMax = 0;
  let lastSeenMs: number | null = null;
  let gone = false;
  let next = frames[0].tMs;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const tank = liveTank(f);
    // Death is judged on frames that lack a tank, so a coarse frame spacing
    // never reads as an absence.
    if (!tank && lastSeenMs !== null && f.tMs - lastSeenMs > TANK_GONE_MS) gone = true;
    if (tank) {
      if (gone) { lifeMax = 0; gone = false; }
      lifeMax = Math.max(lifeMax, tank.health);
      lastSeenMs = f.tMs;
    }
    // The frame stands for every sample time up to the next frame's time; the
    // last one stands only for its own time. A sample time that falls in a
    // hole (a pause, or a gap in the file) is skipped rather than answered
    // with a stale frame.
    const until = i + 1 < frames.length ? frames[i + 1].tMs : f.tMs + 1;
    for (; next < until; next += everyMs) {
      if (next - f.tMs > FRAME_DT_CAP_MS) continue;
      const s = snapshotAt(f, prog(f.tMs), tankFlow, tank && lifeMax > 0 ? lifeMax : null);
      if (!tank && lastSeenMs !== null) {
        // A brief absence is still the same tank; a long one is its death.
        s.tank = gone ? 'dead' : 'alive';
        s.tankFlowGap = null;
      }
      out.push(s);
    }
  }
  return out;
}

/** Route progress samples the data feeds recorded for one half: SI spawns,
 *  survivor downs and, when `endTMs` is given, the round-end stamp. Feed times
 *  are RoundMs() like replay frames, so they line up with `tMs` directly. */
export function feedProgressPoints(db: DB, key: RoundKey, endTMs?: number): { tMs: number; prog: number }[] {
  const pts: { tMs: number; prog: number }[] = [];
  const spawns = db.prepare(
    `SELECT spawn_ms AS t, spawn_prog AS p FROM match_si_lives
     WHERE match_id = ? AND ordinal = ? AND half = ? AND spawn_ms IS NOT NULL AND spawn_prog IS NOT NULL`,
  ).all(key.matchId, key.ordinal, key.half) as { t: number; p: number }[];
  const downs = db.prepare(
    `SELECT t_ms AS t, prog AS p FROM match_survivor_downs
     WHERE match_id = ? AND ordinal = ? AND half = ? AND prog IS NOT NULL`,
  ).all(key.matchId, key.ordinal, key.half) as { t: number; p: number }[];
  for (const r of [...spawns, ...downs]) pts.push({ tMs: r.t, prog: r.p });
  if (endTMs !== undefined) {
    const end = db.prepare(
      'SELECT end_prog AS p FROM match_round_feeds WHERE match_id = ? AND ordinal = ? AND half = ? AND end_prog IS NOT NULL',
    ).get(key.matchId, key.ordinal, key.half) as { p: number } | undefined;
    if (end) pts.push({ tMs: endTMs, prog: end.p });
  }
  return pts.sort((a, b) => a.tMs - b.tMs);
}
