import type { DB } from './db.js';
import type { ServerRow } from './serverPool.js';
import { getSetting, settingNumber } from './settings.js';

/**
 * Choosing a match's server by the players' ping.
 *
 * pug-match logs each rostered player's average ping once per round (PING
 * lines, recorded into player_pings by recordPing). When server_pick_by_ping
 * is on, claimIdle hands the idle boxes to choosePingServer instead of taking
 * the first in pick order.
 *
 * Pings are looked up by HOST, not server id: two srcds on one box share a
 * route, so a round played on one counts for its neighbour.
 *
 * The rule, kept simple enough to explain from the admin feed:
 *  - only players with a known ping to EVERY candidate host are compared, so
 *    a box is never favoured just because nobody has played on it yet;
 *  - fewer than server_pick_ping_min_players such players and nothing
 *    changes: the first box in pick order;
 *  - a box's cost is its WORST compared player's ping, then the average as
 *    the tie break (one player on 140 ms hurts a match more than everyone a
 *    few ms higher);
 *  - the cheapest box wins only if it beats the pick-order box by at least
 *    server_pick_ping_margin_ms, so a 3 ms difference never moves a match.
 */

/** Samples older than this stop counting: a player moves, an ISP reroutes. */
const PING_MAX_AGE_DAYS = 60;
/** The most recent rounds a player's ping to a host is the median of. */
const PING_RECENT_ROUNDS = 20;

export interface PingLine { half: 1 | 2; steamid: string; ms: number; loss: number; samples: number }

/** One round's average ping for one player. Upsert: UDP can duplicate a
 *  datagram, and the plugin sends each round's value once. */
export function recordPing(db: DB, matchId: number, ordinal: number, server: { id: number; host: string }, ev: PingLine, at: string = new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO player_pings (match_id, ordinal, half, steamid, server_id, host, ms, loss, samples, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, ordinal, half, steamid) DO UPDATE SET
       ms = excluded.ms, loss = excluded.loss, samples = excluded.samples, at = excluded.at`,
  ).run(matchId, ordinal, ev.half, ev.steamid, server.id, server.host, ev.ms, ev.loss, ev.samples, at);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A player's typical ping to a host: the median of their most recent rounds
 *  there, or null with no recent rounds. */
export function pingTo(db: DB, steamid: string, host: string, nowMs: number = Date.now()): number | null {
  const since = new Date(nowMs - PING_MAX_AGE_DAYS * 86_400_000).toISOString();
  const rows = db.prepare(
    `SELECT ms FROM player_pings WHERE steamid = ? AND host = ? AND at >= ? ORDER BY at DESC LIMIT ?`,
  ).all(steamid, host, since, PING_RECENT_ROUNDS) as { ms: number }[];
  return rows.length ? median(rows.map((r) => r.ms)) : null;
}

export interface PingChoice {
  server: ServerRow;
  /** Why, in one line for the admin feed and the console. */
  reason: string;
  /** True when ping moved the match off the first box in pick order. */
  moved: boolean;
}

/** Pure: pick from `free` (already in pick order) given each player's ping
 *  per host. Exported for the tests. */
export function choosePing(
  free: ServerRow[],
  pings: Map<string, Map<string, number | null>>,
  opts: { marginMs: number; minPlayers: number },
): PingChoice {
  const first = free[0];
  if (free.length < 2) return { server: first, reason: 'only one server free', moved: false };
  const hosts = [...new Set(free.map((s) => s.host))];
  if (hosts.length < 2) return { server: first, reason: 'every free server is on one host', moved: false };
  const compared = [...pings.entries()].filter(([, byHost]) => hosts.every((h) => typeof byHost.get(h) === 'number'));
  if (compared.length < opts.minPlayers) {
    return { server: first, reason: `ping known to every free host for ${compared.length} player(s), need ${opts.minPlayers}`, moved: false };
  }
  const cost = (s: ServerRow) => {
    const ms = compared.map(([, byHost]) => byHost.get(s.host) as number);
    return { worst: Math.max(...ms), avg: ms.reduce((a, b) => a + b, 0) / ms.length };
  };
  const costs = free.map((s) => ({ s, ...cost(s) }));
  const best = costs.reduce((a, b) => (b.worst < a.worst || (b.worst === a.worst && b.avg < a.avg) ? b : a));
  const base = costs[0];
  const fmt = (c: { s: ServerRow; worst: number; avg: number }) => `${c.s.name} worst ${Math.round(c.worst)} ms, avg ${Math.round(c.avg)} ms`;
  if (best.s.host === base.s.host || base.worst - best.worst < opts.marginMs) {
    return { server: first, reason: `kept ${fmt(base)} (best other: ${fmt(best)}, margin ${opts.marginMs} ms, ${compared.length} players)`, moved: false };
  }
  // The first box on the winning host in pick order, so the admin's order
  // still decides between two srcds on one machine.
  const server = free.find((s) => s.host === best.s.host) as ServerRow;
  return { server, reason: `picked ${fmt(best)} over ${fmt(base)} (${compared.length} players)`, moved: true };
}

export function pingPickEnabled(db: DB): boolean {
  return getSetting(db, 'server_pick_by_ping') === '1';
}

/** The chooser claimIdle runs for a match, reading the settings and the
 *  players' pings. `onChoice` hears every decision, kept or moved. */
export function pingChooser(
  db: DB,
  steamids: string[],
  onChoice?: (c: PingChoice) => void,
  nowMs: number = Date.now(),
): (free: ServerRow[]) => ServerRow {
  return (free) => {
    if (free.length === 0) return free[0];
    const hosts = [...new Set(free.map((s) => s.host))];
    const pings = new Map(steamids.map((id) => [id, new Map(hosts.map((h) => [h, pingTo(db, id, h, nowMs)]))]));
    const choice = choosePing(free, pings, {
      marginMs: settingNumber(db, 'server_pick_ping_margin_ms', 15, { integer: true, min: 0, max: 200 }),
      minPlayers: settingNumber(db, 'server_pick_ping_min_players', 4, { integer: true, min: 1, max: 8 }),
    });
    onChoice?.(choice);
    return choice.server;
  };
}
