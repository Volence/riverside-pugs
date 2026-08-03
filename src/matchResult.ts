import type { DB } from './db.js';
import type { Dump } from './dumpParse.js';
import { applyMatchRatings } from './rating.js';

/** Persist a finished match (result, per-map scores, per-player stats) and
 *  apply ratings, atomically. Returns false when the match is missing or
 *  already completed/aborted. The single write-path for match completion —
 *  used by the real orchestrator and by dev-mode simulation. */
export function completeMatch(db: DB, matchId: number, d: Dump): boolean {
  const row = db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as { state: string } | undefined;
  if (!row || row.state === 'completed' || row.state === 'aborted') return false;
  db.transaction(() => {
    db.prepare(
      "UPDATE matches SET state = 'completed', team_a_score = ?, team_b_score = ?, winner = ?, ended_at = datetime('now') WHERE id = ?",
    ).run(d.totalA, d.totalB, d.winner, matchId);
    const insMap = db.prepare(
      'INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)',
    );
    d.maps.forEach((m, i) => insMap.run(matchId, i, m.map, m.a, m.b));
    const upd = db.prepare(
      `UPDATE match_players SET si_damage = ?, si_kills = ?, common_kills = ?, ff_dealt = ?, revives = ?, stats_json = ?
       WHERE match_id = ? AND player_id = ?`,
    );
    for (const p of d.players) {
      upd.run(p.sidmg, p.sikill, p.ck, p.ff, p.rev,
        JSON.stringify({ sidmg: String(p.sidmg), sikill: String(p.sikill), ck: String(p.ck), ff: String(p.ff), rev: String(p.rev) }),
        matchId, p.steamid);
    }
    applyMatchRatings(db, matchId);
  })();
  return true;
}
