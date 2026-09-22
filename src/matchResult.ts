import type { DB } from './db.js';
import type { Dump } from './dumpParse.js';
import { applyMatchRatings, MIN_RATED_PER_TEAM, type RatingOutcome } from './rating.js';
import { statDef } from './statKeys.js';
import { canonicaliseDump } from './aliases.js';
import { publishAdminEvent } from './adminFeed.js';

/** Persist a finished match (result, per-map scores, per-player stats) and
 *  apply ratings, atomically. Returns false when the match is missing or
 *  already completed/aborted. This is the single write-path for match completion:
 *  used by the real orchestrator and by dev-mode simulation.
 *
 *  The dump decides WHO is rated, not only what they scored. It arrives over
 *  TCP RCON from a server we dialled; the roster rows for a match started in
 *  game, and for every late joiner on any match, were built from UDP
 *  MATCH_ROSTER lines, and a forged one (it needs the match token, which
 *  crosses the same cleartext stream) used to add a fifth player who was then
 *  rated on a match the dump never put them in. So, before ratings:
 *
 *   - every steamid in the dump is rewritten to its canonical account, as the
 *     log listener already does for the UDP side;
 *   - a row that came over UDP and has no STAT line is kept, marked rated = 0,
 *     and reported. A row the website rostered is never second-guessed: the
 *     site chose those eight itself and pushed them over RCON;
 *   - a STAT line with no roster row is reported and otherwise ignored, as
 *     before. It is NOT added: addLateJoiner refuses some accounts on purpose
 *     (an unknown account onto a full team), and the plugin rosters those all
 *     the same, so this is exactly where a refused alt shows up.
 *
 *  Problems are published after the transaction commits, so a subscriber that
 *  throws cannot cost the match its result. */
export function completeMatch(db: DB, matchId: number, rawDump: Dump): boolean {
  const row = db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as { state: string } | undefined;
  if (!row || row.state === 'completed' || row.state === 'aborted') return false;
  const d = canonicaliseDump(db, rawDump);
  const problems: string[] = [];
  let outcome: RatingOutcome | null = null;
  db.transaction(() => {
    db.prepare(
      "UPDATE matches SET state = 'completed', team_a_score = ?, team_b_score = ?, winner = ?, ended_at = datetime('now') WHERE id = ?",
    ).run(d.totalA, d.totalB, d.winner, matchId);
    const insMap = db.prepare(
      'INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)',
    );
    d.maps.forEach((m, i) => insMap.run(matchId, i, m.map, m.a, m.b));
    const upd = db.prepare(
      `UPDATE match_players SET si_damage = ?, si_kills = ?, common_kills = ?, ff_dealt = ?, revives = ?, stats_json = ?, joined_map = ?
       WHERE match_id = ? AND player_id = ?`,
    );
    for (const p of d.players) {
      const result = upd.run(p.sidmg, p.sikill, p.ck, p.ff, p.rev,
        JSON.stringify({ sidmg: String(p.sidmg), sikill: String(p.sikill), ck: String(p.ck), ff: String(p.ff), rev: String(p.rev) }),
        p.joinedMap ?? 0, matchId, p.steamid);
      if (result.changes === 0) {
        console.warn(`[matchResult] dump stat for ${p.steamid} matched no roster row in match ${matchId}`);
        problems.push(
          `Match #${matchId}: the server's result lists ${p.steamid} on team ${p.team.toUpperCase()}, who is not on the site's roster, so they get no stats and no rating. Either their roster line was lost or refused (a second account onto a full team is refused on purpose), or they are an alias nobody has recorded.`,
        );
      }
    }
    reconcileRoster(db, matchId, d, problems);

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

    outcome = applyMatchRatings(db, matchId);
  })();
  const o = outcome as RatingOutcome | null;
  if (o && !o.applied && o.reason === 'too_few') {
    problems.push(
      `Match #${matchId} completed UNRATED: it needs at least ${MIN_RATED_PER_TEAM} rated players on each team and had ${o.ratedA} on A and ${o.ratedB} on B. The result and stats are recorded; no rating moved.`,
    );
  }
  for (const text of problems) publishAdminEvent({ kind: 'problem', matchId, text });
  return true;
}

/** Hold every roster row that arrived over UDP to the dump. Runs inside the
 *  completion transaction, after the STAT lines have been applied. */
function reconcileRoster(db: DB, matchId: number, d: Dump, problems: string[]): void {
  const inDump = new Map(d.players.map((p) => [p.steamid, p]));
  const rows = db.prepare(
    `SELECT mp.player_id AS id, mp.team AS team, p.name AS name
     FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id = ? AND mp.source = 'udp'`,
  ).all(matchId) as { id: string; team: 'a' | 'b'; name: string }[];
  const unrate = db.prepare(
    "UPDATE match_players SET rated = 0, unrated_reason = 'not_in_dump' WHERE match_id = ? AND player_id = ?",
  );
  const setTeam = db.prepare('UPDATE match_players SET team = ? WHERE match_id = ? AND player_id = ?');
  for (const r of rows) {
    const stat = inDump.get(r.id);
    if (!stat) {
      unrate.run(matchId, r.id);
      problems.push(
        `Match #${matchId}: ${r.name} (${r.id}) was rostered onto team ${r.team.toUpperCase()} by a log line, but the server's own result does not list them. Kept on the match page, NOT rated. A forged roster line looks exactly like this.`,
      );
      continue;
    }
    if (stat.team !== r.team) {
      setTeam.run(stat.team, matchId, r.id);
      problems.push(
        `Match #${matchId}: ${r.name} (${r.id}) was rostered onto team ${r.team.toUpperCase()} by a log line, but the server's own result has them on team ${stat.team.toUpperCase()}. The server's answer was used.`,
      );
    }
  }
}
