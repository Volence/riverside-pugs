import type { DB } from '../db.js';
import type { MetricRow } from './registry.js';
import type { RoundKey } from './types.js';

export interface RoundContext {
  map: string | null; origin: string | null; serverId: number | null; patchId: number | null;
  survMu: number | null; infMu: number | null;
}

export function roundContext(db: DB, key: RoundKey): RoundContext {
  const m = db.prepare('SELECT origin, server_id FROM matches WHERE id = ?').get(key.matchId) as
    { origin: string | null; server_id: number | null } | undefined;
  const map = (db.prepare('SELECT map FROM match_maps WHERE match_id = ? AND ordinal = ?')
    .get(key.matchId, key.ordinal) as { map: string } | undefined)?.map ?? null;
  const r = db.prepare('SELECT surv_team, patch_id FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?')
    .get(key.matchId, key.ordinal, key.half) as { surv_team: 'a' | 'b'; patch_id: number | null } | undefined;
  const mu = db.prepare(`SELECT mp.team AS team, AVG(rh.mu_before) AS mu FROM rating_history rh
    JOIN match_players mp ON mp.match_id = rh.match_id AND mp.player_id = rh.player_id
    WHERE rh.match_id = ? GROUP BY mp.team`).all(key.matchId) as { team: 'a' | 'b'; mu: number }[];
  const muOf = (t: 'a' | 'b') => mu.find((x) => x.team === t)?.mu ?? null;
  const surv = r?.surv_team ?? null;
  return {
    map, origin: m?.origin ?? null, serverId: m?.server_id ?? null, patchId: r?.patch_id ?? null,
    survMu: surv ? muOf(surv) : null, infMu: surv ? muOf(surv === 'a' ? 'b' : 'a') : null,
  };
}

let generation = 0;
/** Bumped after every metrics write so cached comparisons know to recompute. */
export function metricsGeneration(): number { return generation; }

export function writeRoundMetrics(db: DB, key: RoundKey, rows: MetricRow[],
  meta: { hasReplay: boolean; hasStats: boolean; replaySeen: boolean; engine: string; now?: string }): void {
  const now = meta.now ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const ctx = roundContext(db, key);
  db.transaction(() => {
    db.prepare('DELETE FROM round_metrics WHERE match_id = ? AND ordinal = ? AND half = ?').run(key.matchId, key.ordinal, key.half);
    const ins = db.prepare('INSERT INTO round_metrics (match_id, ordinal, half, metric, phase, num, den) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(key.matchId, key.ordinal, key.half, r.metric, r.phase, r.num, r.den);
    db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, server_id, patch_id, surv_mu, inf_mu,
                  has_replay, has_stats, replay_seen, engine, computed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (match_id, ordinal, half) DO UPDATE SET map = excluded.map, origin = excluded.origin,
                  server_id = excluded.server_id, patch_id = excluded.patch_id, surv_mu = excluded.surv_mu, inf_mu = excluded.inf_mu,
                  has_replay = excluded.has_replay, has_stats = excluded.has_stats, replay_seen = excluded.replay_seen,
                  engine = excluded.engine, computed_at = excluded.computed_at`)
      .run(key.matchId, key.ordinal, key.half, ctx.map, ctx.origin, ctx.serverId, ctx.patchId, ctx.survMu, ctx.infMu,
        meta.hasReplay ? 1 : 0, meta.hasStats ? 1 : 0, meta.replaySeen ? 1 : 0, meta.engine, now);
  })();
  generation++;
}
