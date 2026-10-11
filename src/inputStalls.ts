import type { DB } from './db.js';

/**
 * Stalls and the `fakelag` signature.
 *
 * A stall is a stretch of server ticks in which a live player's usercmds
 * stopped arriving, then all arrived at once (l4d_inputstats 0.3.0). The
 * server does not move a player it has no commands for, so they hang in place,
 * mid-air included, and the backlog runs in one tick: a warp nobody can shoot.
 *
 * A bad connection does that now and then, on either team. Fakelag does it on
 * purpose. Calibrated on the first confirmed cheater (yes / Bella<3, match 631,
 * Aimware, confessed 2026-10-10) against l4d_cmd_budget's logs from all five
 * servers (50 player-days): every one of their stalls was as infected, the
 * hold was a fixed 11 ticks, and 29 were MID-POUNCE (a hunter hung in the air
 * so it cannot be skeeted). Nobody else had more than 4 mid-pounce stalls, and
 * the worst connection on record (ping 153, 262 stalls) had 4 of 30 hunter
 * stalls mid-pounce.
 *
 * So the signature counts a hunter's held-back (nothing lost) stalls of
 * FAKELAG_MIN_GAP to FAKELAG_MAX_GAP ticks that caught them mid-pounce, and
 * wants both a count and a share: a bad line stalls at random moments, a
 * pounce is a small part of a hunter's life, and fakelag on the pounce key
 * puts a large share of the stalls exactly there.
 *
 * Evidence for review, never a verdict, like every input signature.
 */

export const FAKELAG_MIN_GAP = 8;
export const FAKELAG_MAX_GAP = 20;
export const FAKELAG_MIN_LUNGING = 10;
export const FAKELAG_MIN_SHARE = 0.25;
const SIGNATURE = 'fakelag';
const HUNTER = 3;
const INFECTED = 3;

export interface StallInput {
  matchId: number | null;
  serverId: number | null;
  steamid: string;
  serverTick: number;
  gap: number;
  missed: number;
  cmds: number;
  team: number;
  cls: number;
  lunging: number;
}

interface StallRow { id: number; gap: number; missed: number; team: number; cls: number; lunging: number; at: string }

export interface FakelagResult { hunterStalls: number; lunging: number; completing: StallRow }

/** Pure over one player's stalls in one match, in order. */
export function fakelag(stalls: readonly StallRow[]): FakelagResult | null {
  let hunterStalls = 0, lunging = 0;
  let completing: StallRow | null = null;
  for (const s of stalls) {
    if (s.team !== INFECTED || s.cls !== HUNTER || s.missed !== 0) continue;
    if (s.gap < FAKELAG_MIN_GAP || s.gap > FAKELAG_MAX_GAP) continue;
    hunterStalls++;
    if (s.lunging === 1) lunging++;
    if (!completing && lunging >= FAKELAG_MIN_LUNGING && lunging >= FAKELAG_MIN_SHARE * hunterStalls) completing = s;
  }
  if (lunging < FAKELAG_MIN_LUNGING || lunging < FAKELAG_MIN_SHARE * hunterStalls) return null;
  return { hunterStalls, lunging, completing: completing ?? stalls[stalls.length - 1] };
}

export function fakelagNote(r: Pick<FakelagResult, 'hunterStalls' | 'lunging'>): string {
  return `${r.lunging} of ${r.hunterStalls} hunter input stalls hung mid-pounce`;
}

/** Store one stall; returns the note when this stall CREATED the detection. */
export function recordInputStall(db: DB, s: StallInput, now = new Date()): { id: number; created: string | null } {
  const info = db.prepare(
    `INSERT INTO input_stalls (match_id, server_id, steamid, server_tick, gap, missed, cmds, team, cls, lunging, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.matchId, s.serverId, s.steamid, s.serverTick, s.gap, s.missed, s.cmds, s.team, s.cls, s.lunging, now.toISOString());
  const id = Number(info.lastInsertRowid);
  // Only a hunter's stall moves the count or the share.
  if (s.matchId === null || s.team !== INFECTED || s.cls !== HUNTER) return { id, created: null };
  return { id, created: evaluateStalls(db, s.matchId, s.steamid) };
}

/** Bring one player's fakelag row in one match in line with their stalls.
 *  Returns the note when the row was created by this call. */
export function evaluateStalls(db: DB, matchId: number, steamid: string): string | null {
  const rows = db.prepare(
    'SELECT id, gap, missed, team, cls, lunging, at FROM input_stalls WHERE match_id = ? AND steamid = ? ORDER BY id',
  ).all(matchId, steamid) as StallRow[];
  const r = fakelag(rows);
  if (!r) return null;
  const note = fakelagNote(r);
  const existing = db.prepare(
    'SELECT id FROM input_detections WHERE match_id = ? AND steamid = ? AND signature = ?',
  ).get(matchId, steamid, SIGNATURE) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE input_detections SET hits = ?, note = ? WHERE id = ?').run(r.lunging, note, existing.id);
    return null;
  }
  // burst_id names the completing STALL (input_stalls.id); evidence stays an
  // empty list because evidence ids are input_bursts ids everywhere else.
  db.prepare(
    `INSERT INTO input_detections (burst_id, match_id, steamid, kind, signature, severity, at, hits, evidence, note)
     VALUES (?, ?, ?, 'stall', ?, 'low', ?, ?, '[]', ?)`,
  ).run(r.completing.id, matchId, steamid, SIGNATURE, r.completing.at, r.lunging, note);
  return note;
}

/** Every player-match that has stalls, for rerunSignatures. */
export function rerunStalls(db: DB): void {
  const groups = db.prepare(
    'SELECT DISTINCT match_id AS matchId, steamid FROM input_stalls WHERE match_id IS NOT NULL',
  ).all() as { matchId: number; steamid: string }[];
  for (const g of groups) evaluateStalls(db, g.matchId, g.steamid);
}
