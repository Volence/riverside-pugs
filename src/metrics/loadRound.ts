import type { DB } from '../db.js';
import type { RoundEvent, RoundInput, RoundKey } from './types.js';

/** Everything a metric needs about one round except the replay. Null when the
 *  round row does not exist. */
export function loadRoundInput(db: DB, key: RoundKey): Omit<RoundInput, 'replay'> | null {
  const row = db.prepare(`SELECT surv_team, score, reliable, started_at, ended_at, survivors_alive, skill_detect
                          FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?`)
    .get(key.matchId, key.ordinal, key.half) as {
      surv_team: 'a' | 'b'; score: number; reliable: number; started_at: string | null; ended_at: string | null;
      survivors_alive: number | null; skill_detect: number | null } | undefined;
  if (!row) return null;

  const events = db.prepare(`SELECT kind, actor, target, value, t_ms AS tMs FROM match_live_events
                             WHERE match_id = ? AND map_ordinal = ? AND half = ?
                             ORDER BY t_ms, seq`)
    .all(key.matchId, key.ordinal, key.half) as RoundEvent[];

  const stats = new Map<string, Map<string, number>>();
  for (const s of db.prepare(`SELECT player_id, stat, value FROM match_round_stats
                              WHERE match_id = ? AND ordinal = ? AND half = ?`)
    .all(key.matchId, key.ordinal, key.half) as { player_id: string; stat: string; value: number }[]) {
    let m = stats.get(s.player_id);
    if (!m) { m = new Map(); stats.set(s.player_id, m); }
    m.set(s.stat, s.value);
  }

  const marks = db.prepare(`SELECT kind, t_ms AS tMs FROM match_round_marks
                            WHERE match_id = ? AND ordinal = ? AND half = ? ORDER BY t_ms`)
    .all(key.matchId, key.ordinal, key.half) as { kind: string; tMs: number }[];

  const teamOf = new Map((db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
    .all(key.matchId) as { player_id: string; team: 'a' | 'b' }[]).map((r) => [r.player_id, r.team] as const));

  return {
    key,
    survTeam: row.surv_team,
    reliable: row.reliable === 1,
    ended: row.ended_at !== null && row.started_at !== null,
    score: row.score,
    survivorsAlive: row.survivors_alive,
    events,
    marks,
    stats,
    hasStats: row.skill_detect !== null,
    skillDetect: row.skill_detect === 1,
    teamOf,
  };
}
