import type { DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';

/** Seventeen-digit fake SteamID64s: PID(0) .. PID(n). */
export const PID = (n: number): string => `765611990000${String(n).padStart(5, '0')}`;

export function seedPlayers(db: DB, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    upsertPlayer(db, { steamid: PID(i), name: `p${i}`, avatar: null }, []);
    ids.push(PID(i));
  }
  return ids;
}

type Fixed = 'si_damage' | 'si_kills' | 'common_kills' | 'revives' | 'ff_dealt';
export interface SeedLine {
  id: string;
  team: 'a' | 'b';
  fixed?: Partial<Record<Fixed, number>>;
  stats?: Record<string, number>;
}

export interface SeedMatch {
  endedAt: string;              // 'YYYY-MM-DD HH:MM:SS'
  wentLiveAt?: string;
  winner?: 'a' | 'b' | 'draw';
  a?: number;
  b?: number;
  campaign?: string;
  state?: 'completed' | 'aborted' | 'live';
  voided?: boolean;
  lines: SeedLine[];
}

export function seedMatch(db: DB, o: SeedMatch): number {
  const id = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, winner, team_a_score, team_b_score, ended_at, went_live_at, voided_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.state ?? 'completed', o.campaign ?? 'no_mercy', o.winner ?? 'a', o.a ?? 500, o.b ?? 400,
    o.endedAt, o.wentLiveAt ?? null, o.voided ? o.endedAt : null,
  ).lastInsertRowid);
  const mp = db.prepare(
    'INSERT INTO match_players (match_id, player_id, team, si_damage, si_kills, common_kills, revives, ff_dealt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const st = db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)');
  for (const l of o.lines) {
    mp.run(id, l.id, l.team, l.fixed?.si_damage ?? 0, l.fixed?.si_kills ?? 0, l.fixed?.common_kills ?? 0, l.fixed?.revives ?? 0, l.fixed?.ff_dealt ?? 0);
    for (const [k, v] of Object.entries(l.stats ?? {})) st.run(id, l.id, k, v);
  }
  return id;
}

/** One rating_history row. mu/sigma chosen so displaySr = round((mu - 2*sigma)*100). */
export function seedRating(db: DB, matchId: number, steamid: string, before: [mu: number, sigma: number], after: [mu: number, sigma: number]): void {
  db.prepare(
    `INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
  ).run(steamid, matchId, before[0], before[1], after[0], after[1]);
}

/** One ready-up in a match with per-player not-ready seconds. */
export function seedReadyup(db: DB, matchId: number, seconds: Record<string, number>): void {
  const rid = Number(db.prepare(
    "INSERT INTO match_readyups (match_id, map_ordinal, half, started_at) VALUES (?, 1, 1, '2026-09-21 12:00:00')",
  ).run(matchId).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_readyup_players (readyup_id, match_id, player_id, seconds) VALUES (?, ?, ?, ?)');
  for (const [p, s] of Object.entries(seconds)) ins.run(rid, matchId, p, s);
}
