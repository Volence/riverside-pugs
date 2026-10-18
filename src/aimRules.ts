import type { DB } from './db.js';
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

export interface SiKillInput {
  matchId: number | null;
  serverId: number | null;
  steamid: string;
  weapon: string;
  headshot: boolean;
  dist: number;
  pre: number;
  back: number;
  victimClass: string;
}

/** Store one SI kill. Rules A and C read these once the match is over
 *  (scanAimMatches), never per kill: a mid-match prefix is not what they
 *  were calibrated on. */
export function recordSiKill(db: DB, k: SiKillInput, now = new Date()): number {
  const info = db.prepare(
    `INSERT INTO si_kills (match_id, server_id, steamid, weapon, headshot, dist, pre, back, victim_class, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(k.matchId, k.serverId, k.steamid, k.weapon, k.headshot ? 1 : 0, k.dist, k.pre, k.back, k.victimClass, now.toISOString());
  return Number(info.lastInsertRowid);
}

// --- Rule A: headshot share ---------------------------------------------

export const HS_MIN_KILLS = 10;
export const HS_MAX_P = 1e-3;
export const HS_POOL_DAYS = 30;
/** Kills a group needs in the pool before its own rate replaces the fixed one. */
export const HS_POOL_MIN = 500;

export interface HsGroup {
  name: 'auto' | 'rifle';
  weapons: readonly string[];
  /** The rate used until HS_POOL_MIN kills exist, or null for none. */
  fallback: number | null;
  enabled: boolean;
}

/**
 * Survivor kills of human SI, per weapon group. `auto` is the nepmir case,
 * and 0.367 is its pooled share in the log study. Honest snipers headshot a
 * lot, so the hunting rifle is its own pool, off until its rate is measured
 * (the calibration report, src/aimCalibration.ts, prints it). Shotguns are in
 * no group: pump kills never report a headshot. Nor is the M16, whose game
 * name is `rifle` (not this group, which is the hunting rifle).
 */
export const HS_GROUPS: readonly HsGroup[] = [
  { name: 'auto', weapons: ['smg', 'pistol', 'dual_pistols'], fallback: 0.367, enabled: true },
  { name: 'rifle', weapons: ['hunting_rifle'], fallback: null, enabled: false },
];

export function groupOf(weapon: string): HsGroup | null {
  const w = weapon.startsWith('weapon_') ? weapon.slice('weapon_'.length) : weapon;
  return HS_GROUPS.find((g) => g.weapons.includes(w)) ?? null;
}

/** P(X >= k) for X ~ Binomial(n, p), each term built in log space so a long
 *  match cannot underflow or overflow the binomial coefficient. */
export function binomialTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let logC = 0; // log C(n, i), from i = 0
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) sum += Math.exp(logC + i * lp + (n - i) * lq);
  }
  return Math.min(1, sum);
}

export interface PooledRate { rate: number; poolKills: number; pooled: boolean }

/** The headshot share a group's kills are judged against: every kill in the
 *  trailing HS_POOL_DAYS except the judged match's own (a cheater's kills
 *  would drag the pool toward them), or the fixed rate until the pool has
 *  HS_POOL_MIN kills. Grouped in code, not SQL, so a weapon_ prefixed name
 *  pools with its bare one. */
export function pooledRate(db: DB, group: HsGroup, excludeMatch: number, now = new Date()): PooledRate | null {
  const since = new Date(now.getTime() - HS_POOL_DAYS * 86_400_000).toISOString();
  const rows = db.prepare(
    `SELECT weapon, COUNT(*) AS n, SUM(headshot) AS hs FROM si_kills
     WHERE match_id IS NOT NULL AND match_id <> ? AND at >= ? AND at <= ?
     GROUP BY weapon`,
  ).all(excludeMatch, since, now.toISOString()) as { weapon: string; n: number; hs: number }[];
  let n = 0;
  let hs = 0;
  for (const r of rows) {
    if (groupOf(r.weapon) !== group) continue;
    n += r.n;
    hs += r.hs;
  }
  if (n >= HS_POOL_MIN) return { rate: hs / n, poolKills: n, pooled: true };
  return group.fallback === null ? null : { rate: group.fallback, poolKills: n, pooled: false };
}

/** One si_kills row as the rules read it. */
export interface KillRow { id: number; weapon: string; headshot: number; pre: number; back: number; victimClass: string; at: string }

export interface HsResult extends PooledRate { group: string; kills: number; headshots: number; p: number }

/** Rule A over one player's kills in one match: the groups that fire. */
export function hsShare(
  kills: readonly Pick<KillRow, 'weapon' | 'headshot'>[], rateOf: (g: HsGroup) => PooledRate | null,
): HsResult[] {
  const out: HsResult[] = [];
  for (const g of HS_GROUPS) {
    if (!g.enabled) continue;
    const mine = kills.filter((k) => groupOf(k.weapon) === g);
    if (mine.length < HS_MIN_KILLS) continue;
    const rate = rateOf(g);
    if (!rate) continue;
    const headshots = mine.filter((k) => k.headshot).length;
    const p = binomialTail(headshots, mine.length, rate.rate);
    if (p < HS_MAX_P) out.push({ group: g.name, kills: mine.length, headshots, p, ...rate });
  }
  return out;
}

export function hsNote(r: HsResult): string {
  const pool = r.pooled
    ? `${r.rate.toFixed(3)} pooled from ${r.poolKills} kills over ${HS_POOL_DAYS} days`
    : `${r.rate.toFixed(3)} (fixed until ${HS_POOL_MIN} kills are on record, ${r.poolKills} so far)`;
  return `${r.group} weapons: ${r.headshots} of ${r.kills} SI kills were headshots, p = ${r.p.toExponential(1)} against ${pool}`;
}

// --- Rule C: flick and return ---------------------------------------------

export const FLICK_PRE_DEG = 90;
export const FLICK_BACK_DEG = 45;
export const FLICK_MIN_KILLS = 2;

/** A kill whose view swung FLICK_PRE_DEG+ in the 300 ms before and came back
 *  within FLICK_BACK_DEG of where it started in the second after. back -1
 *  (the killer left or died first) is unknown and never a return. */
export function isFlickReturn(k: Pick<KillRow, 'pre' | 'back'>): boolean {
  return k.back >= 0 && k.pre >= FLICK_PRE_DEG && k.back <= FLICK_BACK_DEG;
}

export interface FlickResult { kills: number; flicks: KillRow[] }

/** Rule C over one player's kills in one match. nepmir had 2; no honest
 *  player of 520 had more than 1. */
export function flickReturns(kills: readonly KillRow[]): FlickResult | null {
  const flicks = kills.filter(isFlickReturn);
  return flicks.length >= FLICK_MIN_KILLS ? { kills: kills.length, flicks } : null;
}

/** The kills, their degrees and when the site heard of them (UTC; the line
 *  carries no game clock, so this is about a second after the kill). */
export function flickNote(r: FlickResult): string {
  const each = r.flicks.map((k) => `${k.at.slice(11, 19)} ${k.victimClass} (pre ${k.pre.toFixed(1)}, back ${k.back.toFixed(1)})`);
  return `${r.flicks.length} of ${r.kills} SI kills were a ${FLICK_PRE_DEG}+ degree flick and back within ${FLICK_BACK_DEG}: ${each.join(', ')} UTC`;
}
