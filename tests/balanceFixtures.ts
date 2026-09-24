import type { openDb } from '../src/db.js';
import { recordBalanceSighting } from '../src/balancePatches.js';
import type { BalanceKnobs } from '../src/balanceKnobs.js';

type DB = ReturnType<typeof openDb>;

export const KNOBS: BalanceKnobs = {
  cvars: [
    { cvar: 'z_tank_health', label: 'Tank health', group: 'tank', type: 'int', min: 6000, max: 10000, step: 250, baseline: '8000' },
    { cvar: 'versus_boss_flow_min', label: 'Flow min', group: 'bosses', type: 'float', min: 0.1, max: 0.3, step: 0.05, baseline: '0.10', pairMax: 'versus_boss_flow_max' },
    { cvar: 'versus_boss_flow_max', label: 'Flow max', group: 'bosses', type: 'float', min: 0.1, max: 0.9, step: 0.05, baseline: '0.90' },
    { cvar: 'z_witch_health', label: 'Witch health', group: 'witch' },
  ],
  files: [], dirs: [], versionless: ['pug-match.smx'], ignored: ['l4d_tvwatch.smx'],
};

export const LIVE = {
  'c:z_tank_health': '8000', 'c:versus_boss_flow_min': '0.10', 'c:versus_boss_flow_max': '0.90',
  'c:z_witch_health': '1000', 'p:pug-match.smx': '1.aaaa', 'p:l4d_skypounce.smx': '2.bbbb',
};

/** One queue match on server `serverId` whose round saw `inv`. */
export function sight(db: DB, matchId: number, serverId: number, inv: Record<string, string>, origin = 'queue', at = '2026-09-24 01:00:00') {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token, origin) VALUES (?, 1, 'completed', 'x', ?, ?, ?)")
    .run(matchId, serverId, String(matchId).padStart(32, '0'), origin);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (?, 0, 1, 'a', ?)").run(matchId, at);
  return recordBalanceSighting(db, { matchId, serverId, half: 1, inventory: inv, versionless: KNOBS.versionless, ignored: KNOBS.ignored, now: at });
}
