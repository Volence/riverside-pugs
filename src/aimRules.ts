import type { LilacReason } from './logParse.js';
import type { FlagSeverity } from './integrityFlags.js';

/**
 * Aimbot rules from the nepmir ground truth.
 *
 * Design: docs/superpowers/specs/2026-10-17-aimbot-rules-design.md
 *
 * nepmir (dethisa's 5th account) hard-aimbotted match 722 and was banned on
 * 2026-10-17: the first confirmed aimbot. Their moment-to-moment aim looked
 * ordinary at 10 Hz, which fits a "legit" aimbot: it shows in where the
 * bullets land and in rare huge snaps, not in reaction time. Three separators
 * came out of 3,167 player-matches of game logs and 520 of replays:
 *
 *   A. headshot share on SI kills, per weapon group (14 of 16, p = 4e-5);
 *   B. LilAC's aim-snap ldelta (143.5 degrees, every other aimbot flag < 45);
 *   C. a 90+ degree flick onto an SI kill and back within a second (2 in
 *      the match, nobody else more than 1).
 *
 * Evidence for staff, never a verdict: nothing here bans, holds or kicks.
 */

/** Rule B. LilAC's aim-snap `ldelta` at or above this is a big snap. nepmir's
 *  was 143.5; every one of the 42 other aimbot flags on record was under 45. */
export const BIG_SNAP_DEG = 60;

/** The LilAC kind (LILAC_CHEATS in src/integrityFlags.ts) that measures an
 *  aim-snap. aimlock and bhop carry no ldelta of their own. */
const AIMBOT = 'aimbot';

export function isBigSnap(kind: string, reason: LilacReason | undefined): boolean {
  return kind === AIMBOT && reason?.ldelta !== undefined && reason.ldelta >= BIG_SNAP_DEG;
}

/** Rule B, always on (not governed by aim_rules): the severity a LilAC flag
 *  is stored with. A ban LilAC issued itself stays 'banned'. -1 is LilAC's
 *  "unknown" ldelta and is under the line like any small value. */
export function lilacSeverity(kind: string, banned: boolean, reason?: LilacReason): FlagSeverity {
  if (banned) return 'banned';
  return isBigSnap(kind, reason) ? 'high' : 'suspected';
}
