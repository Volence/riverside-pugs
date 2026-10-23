import type { DB } from '../src/db.js';
import { encodeIntervals } from '../src/inputStats.js';
import { addHolds, type Fingerprint } from '../src/fingerprint.js';
import { upsertPlayer } from '../src/players.js';
import { rng } from './inputSim.js';

/** Synthetic hold data for the fingerprint tests. Nothing here is a real
 *  player's numbers: the real ones live only in the production database. */

export const HUNTER = 'fire:weapon_hunter_claw';
export const POUNCE = 'pounce:weapon_hunter_claw';
export const SMOKER = 'fire:weapon_smoker_claw';

/** n holds spread over peak-1, peak, peak, peak+1: a hand that "holds about
 *  `peak` ticks". Two spreads more than 2 apart share no bin at all. */
export function spread(peak: number, n: number): number[] {
  const pattern = [peak - 1, peak, peak, peak + 1];
  return Array.from({ length: n }, (_, i) => pattern[i % 4]);
}

/**
 * A hand, read by a server at `rate`: n holds whose true lengths are
 * log-normal around `medianMs` (a spread of 0.3 is about 30%, what a finger
 * does), each pressed at a random point in a tick and read as the usercmds
 * that saw it down. Deterministic for a seed. The same hand at 100 and 128
 * tick is the same medianMs and spread with a different seed.
 */
export function handHolds(seed: number, rate: number, n: number, medianMs: number, spreadLog = 0.3): number[] {
  const r = rng(seed);
  const tickMs = 1000 / rate;
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  return Array.from({ length: n }, () => {
    const ms = medianMs * Math.exp(spreadLog * gauss());
    const press = r() * tickMs;
    return Math.max(1, Math.ceil((press + ms) / tickMs) - Math.ceil(press / tickMs));
  });
}

export function fpOf(classes: Record<string, number[]>): Fingerprint {
  const out: Fingerprint = {};
  for (const [cls, holds] of Object.entries(classes)) addHolds(out, cls, holds);
  return out;
}

export function player(db: DB, steamid: string, name = `p${steamid.slice(-3)}`): void {
  upsertPlayer(db, { steamid, name, avatar: null }, []);
}

/** A completed match. ended_at is in the column's own format (SQLite
 *  datetime, a space and no zone), as the app writes it. */
export function endedMatch(db: DB, id: number, endedAt = '2026-10-17 20:00:00'): void {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (?, 1, 'completed', 'death_toll', ?)")
    .run(id, endedAt);
}

/** One hunter claw burst and one hunter pounce burst in `matchId`, n holds
 *  each around `peak`, so 2n base-class holds in all. */
export function playMatch(
  db: DB, steamid: string, matchId: number | null, peak: number, n: number, at = '2026-10-17T19:00:00.000Z',
): void {
  const ins = db.prepare(
    `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks, air_presses,
       server_tick, client_tick, intervals, at, wire, holds)
     VALUES (?, 1, ?, ?, 'weapon_hunter_claw', ?, 0, 0, 1, 1, ?, ?, 2, ?)`,
  );
  for (const kind of ['fire', 'pounce']) {
    ins.run(matchId, steamid, kind, n - 1, encodeIntervals(Array(n - 1).fill(8)), at, encodeIntervals(spread(peak, n)));
  }
}
