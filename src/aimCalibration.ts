import type { DB } from './db.js';
import { HS_GROUPS, HS_MIN_KILLS, binomialTail, groupOf, isFlickReturn, pooledRate } from './aimRules.js';

/**
 * What a week of l4d_inputstats 0.4.0 data says about the aim rules, for the
 * owner to set the thresholds from before aim_rules goes on (spec,
 * "Calibration after one week of log"). The plugin measures at 100 Hz, which
 * is sharper than the 10 Hz replays the rules were found on, so the honest
 * distributions here, not the study's, are what the thresholds should sit
 * above. Read-only.
 */

/** Upper edges of the p-value buckets. */
const P_EDGES = [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1.000001];
const LOWEST_SHOWN = 10;

export interface AimCalibration {
  since: string;
  playerMatches: number;
  /** Every group, enabled or not: the rifle's rate is what enables it. */
  pools: { group: string; kills: number; headshots: number; rate: number | null }[];
  hs: {
    group: string;
    /** Player-matches with at least HS_MIN_KILLS kills in the group. */
    scored: number;
    buckets: { below: number; count: number }[];
    lowest: { steamid: string; matchId: number; kills: number; headshots: number; p: number }[];
  }[];
  flicks: {
    counts: { flicks: number; playerMatches: number }[];
    top: { steamid: string; matchId: number; flicks: number; kills: number }[];
  };
}

interface Row { matchId: number; steamid: string; weapon: string; headshot: number; pre: number; back: number }

export function aimCalibration(db: DB, now = new Date(), days = 7): AimCalibration {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = db.prepare(
    `SELECT match_id AS matchId, steamid, weapon, headshot, pre, back FROM si_kills
     WHERE match_id IS NOT NULL AND at >= ? AND at <= ? ORDER BY id`,
  ).all(since, now.toISOString()) as Row[];

  const byPm = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.matchId}|${r.steamid}`;
    const list = byPm.get(key) ?? [];
    list.push(r);
    byPm.set(key, list);
  }

  const pools = HS_GROUPS.map((g) => {
    const mine = rows.filter((r) => groupOf(r.weapon) === g);
    const headshots = mine.filter((r) => r.headshot).length;
    return { group: g.name, kills: mine.length, headshots, rate: mine.length ? headshots / mine.length : null };
  });

  const hs = HS_GROUPS.map((g) => {
    const scoredRows: AimCalibration['hs'][number]['lowest'] = [];
    for (const kills of byPm.values()) {
      const mine = kills.filter((k) => groupOf(k.weapon) === g);
      if (mine.length < HS_MIN_KILLS) continue;
      // Judged the way the rule judges: against the pool without this match,
      // or, for a group with no fallback, against this window's own rate.
      const rate = pooledRate(db, g, mine[0].matchId, now)?.rate ?? pools.find((p) => p.group === g.name)!.rate;
      if (rate === null) continue;
      const headshots = mine.filter((k) => k.headshot).length;
      scoredRows.push({ steamid: mine[0].steamid, matchId: mine[0].matchId, kills: mine.length, headshots, p: binomialTail(headshots, mine.length, rate) });
    }
    scoredRows.sort((a, b) => a.p - b.p);
    const buckets = P_EDGES.map((below, i) => ({
      below,
      count: scoredRows.filter((s) => s.p < below && (i === 0 || s.p >= P_EDGES[i - 1])).length,
    }));
    return { group: g.name, scored: scoredRows.length, buckets, lowest: scoredRows.slice(0, LOWEST_SHOWN) };
  });

  const perPm = [...byPm.values()].map((kills) => ({
    steamid: kills[0].steamid, matchId: kills[0].matchId, kills: kills.length, flicks: kills.filter(isFlickReturn).length,
  }));
  const countMap = new Map<number, number>();
  for (const p of perPm) countMap.set(p.flicks, (countMap.get(p.flicks) ?? 0) + 1);
  const counts = [...countMap].sort((a, b) => a[0] - b[0]).map(([flicks, playerMatches]) => ({ flicks, playerMatches }));
  const top = perPm.filter((p) => p.flicks > 0).sort((a, b) => b.flicks - a.flicks || b.kills - a.kills).slice(0, LOWEST_SHOWN);

  return { since, playerMatches: byPm.size, pools, hs, flicks: { counts, top } };
}
