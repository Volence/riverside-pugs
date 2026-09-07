import type { DB } from './db.js';
import type { Dump } from './dumpParse.js';
import { applyMatchRatings } from './rating.js';
import { statDef } from './statKeys.js';

/** Persist a finished match (result, per-map scores, per-player stats) and
 *  apply ratings, atomically. Returns false when the match is missing or
 *  already completed/aborted. This is the single write-path for match completion:
 *  used by the real orchestrator and by dev-mode simulation. Dump stats for
 *  a steamid not on the match's roster match no row and are ignored, with a
 *  warning logged. */
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
      const result = upd.run(p.sidmg, p.sikill, p.ck, p.ff, p.rev,
        JSON.stringify({ sidmg: String(p.sidmg), sikill: String(p.sikill), ck: String(p.ck), ff: String(p.ff), rev: String(p.rev) }),
        matchId, p.steamid);
      if (result.changes === 0) {
        console.warn(`[matchResult] dump stat for ${p.steamid} matched no roster row in match ${matchId}`);
      }
    }

    // Skill stats. sm_pug_dump may be called more than once, so upsert rather
    // than insert. Stats that need skill_detect are skipped entirely when the
    // plugin reported skilldetect=0, so "not measured" never lands as a zero.
    const insStat = db.prepare(
      `INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (match_id, player_id, stat) DO UPDATE SET value = excluded.value`,
    );
    // src/db.ts:103 sets `foreign_keys = ON`, so a steamid that is not a known
    // player would not warn, it would THROW and roll back this whole transaction,
    // losing the match result over a stray stat row. Skip and warn instead, which
    // is also how the match_players update above treats an unmatched steamid.
    const onRoster = new Set(
      (db.prepare('SELECT player_id FROM match_players WHERE match_id = ?')
        .all(matchId) as { player_id: string }[]).map((r) => r.player_id),
    );
    for (const s of d.skills) {
      if (!onRoster.has(s.steamid)) {
        console.warn(`[matchResult] skill stats for ${s.steamid} matched no roster row in match ${matchId}`);
        continue;
      }
      for (const [key, value] of Object.entries(s.stats)) {
        const def = statDef(key);
        if (!def) continue;
        if (def.needsSkillDetect && !d.skillDetect) continue;
        insStat.run(matchId, s.steamid, key, value);
      }
    }

    applyMatchRatings(db, matchId);
  })();
  return true;
}
