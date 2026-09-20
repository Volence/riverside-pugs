import type { DB } from './db.js';
import { statDef } from './statKeys.js';

/**
 * Drop the volatile rows once a match is no longer live.
 *
 * Deliberately KEEPS `match_live_map_stats` and `match_live_events`. They were
 * originally cleared with everything else, which meant completing a match
 * destroyed the only per-map player breakdown and the whole event feed that
 * had just been collected: the match page could never show them. They are the
 * historical record, not scratch.
 *
 * What does go is genuinely transient: `match_live` is heartbeat and
 * current-map bookkeeping, `match_live_players` is a running cumulative total
 * superseded by the authoritative `match_players` rows, and `match_live_maps`
 * is superseded by `match_maps` from the dump.
 *
 * Nothing here is keyed on by the live page, which only ever looks at matches
 * in state 'live', so retained rows cost nothing but a little disk.
 */
export function clearLive(db: DB, matchId: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM match_live_players WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM match_live_maps WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM match_live WHERE match_id = ?').run(matchId);
  })();
}


/**
 * Freeze what a cancelled match managed to record, then drop its scratch.
 *
 * A completed match is written once from the rcon dump by completeMatch, and
 * `clearLive` then throws away the live-feed scratch that the dump supersedes.
 * An aborted match never gets a dump, so calling `clearLive` on it destroyed
 * the only record of what happened: the map list, the running scores and every
 * per-player total went, `match_maps` stayed empty, and `/api/matches/:id`
 * (completed only) answered 404 for the link the Discord card was still
 * offering. Three abandons in a row on 2026-09-20 left nothing an admin could
 * look at.
 *
 * So the abort paths call this instead. It promotes the scratch into the same
 * permanent tables a completed match uses, which is what lets the whole read
 * path (the match page, per-map stats, round attribution, the demo join) serve
 * an aborted match with no special cases of its own. `winner` is deliberately
 * left NULL: that, not the presence of rows, is what says no result was
 * reached, and every aggregate query in the codebase already filters on
 * `state = 'completed'`, so these rows never reach a rating, a leaderboard or
 * a map page. Voided matches (completed, then flipped to 'aborted') already
 * carry exactly this shape, so nothing downstream is seeing it for the first
 * time.
 *
 * Re-runnable, and deliberately tolerant of a match whose scratch is already
 * gone: it falls back to `match_rounds`, `match_live_map_stats` and
 * `match_demos`, all of which survive `clearLive`, so the same function
 * backfills matches aborted before it existed. Nothing here overwrites a row
 * that already exists.
 */
export function archiveAborted(db: DB, matchId: number): void {
  db.transaction(() => {
    const maps = archiveMaps(db, matchId);
    archivePlayers(db, matchId);
    archiveScore(db, matchId, maps);
  })();
  clearLive(db, matchId);
}

interface ArchivedMap { ordinal: number; map: string; a: number; b: number }

/** Per-map scores as the ended halves recorded them. A half with no ended_at
 *  contributes nothing: `score` is NOT NULL DEFAULT 0, so counting it would
 *  turn "we never heard" into "they scored nothing". */
function scoresByOrdinal(db: DB, matchId: number): Map<number, { a: number; b: number }> {
  const rows = db.prepare(
    'SELECT ordinal, surv_team AS surv, score, ended_at AS endedAt FROM match_rounds WHERE match_id = ?',
  ).all(matchId) as { ordinal: number; surv: 'a' | 'b'; score: number; endedAt: string | null }[];
  const out = new Map<number, { a: number; b: number }>();
  for (const r of rows) {
    const cur = out.get(r.ordinal) ?? { a: 0, b: 0 };
    if (r.endedAt !== null) cur[r.surv] += r.score;
    out.set(r.ordinal, cur);
  }
  return out;
}

/**
 * The map list, into `match_maps`.
 *
 * Names come from three places because no single one covers every case.
 * `match_live_maps` has the maps that finished, and is also the MAP_RESULT
 * score straight off the wire, so it wins where it exists.
 * `match_live.current_map` is the map the abort interrupted, which is the one
 * an admin most wants to reach (its demo and its replay hang off that
 * ordinal). `match_demos` is neither, but it survives `clearLive` and carries
 * ordinal and map together, which is what makes a backfill possible at all.
 */
function archiveMaps(db: DB, matchId: number): ArchivedMap[] {
  const already = db.prepare('SELECT ordinal FROM match_maps WHERE match_id = ?')
    .all(matchId) as { ordinal: number }[];
  if (already.length > 0) {
    return (db.prepare(
      'SELECT ordinal, map, team_a_score AS a, team_b_score AS b FROM match_maps WHERE match_id = ? ORDER BY ordinal',
    ).all(matchId) as ArchivedMap[]);
  }

  const scores = scoresByOrdinal(db, matchId);
  const byOrdinal = new Map<number, ArchivedMap>();

  const live = db.prepare(
    'SELECT ordinal, map, team_a_score AS a, team_b_score AS b FROM match_live_maps WHERE match_id = ? ORDER BY ordinal',
  ).all(matchId) as ArchivedMap[];
  for (const m of live) byOrdinal.set(m.ordinal, m);

  const demos = db.prepare(
    'SELECT ordinal, map FROM match_demos WHERE match_id = ? ORDER BY ordinal',
  ).all(matchId) as { ordinal: number; map: string }[];
  const nameFromDemo = new Map(demos.map((d) => [d.ordinal, d.map]));

  const current = (db.prepare('SELECT current_map FROM match_live WHERE match_id = ?')
    .get(matchId) as { current_map: string | null } | undefined)?.current_map ?? null;

  // Any ordinal a round or a demo reached that no MAP_RESULT closed: the map
  // the abort interrupted. current_map names the last of them while the
  // scratch is still there; after that only the demo scan can. No name, no
  // row, since an ordinal nothing can name is not a map anyone can open.
  const ordinals = [...new Set<number>([...scores.keys(), ...nameFromDemo.keys()])].sort((x, y) => x - y);
  const add = (ordinal: number, map: string) => {
    const s = scores.get(ordinal) ?? { a: 0, b: 0 };
    byOrdinal.set(ordinal, { ordinal, map, a: s.a, b: s.b });
  };
  for (const ordinal of ordinals) {
    if (byOrdinal.has(ordinal)) continue;
    const map = nameFromDemo.get(ordinal) ?? (ordinal === ordinals[ordinals.length - 1] ? current : null);
    if (map) add(ordinal, map);
  }

  // A map that had loaded but whose first round never started reached no
  // ordinal at all. It still earns a row: it is where the match stopped, and
  // it is what a demo scanned later will hang off.
  if (current && ![...byOrdinal.values()].some((m) => m.map === current)) {
    add(byOrdinal.size === 0 ? 0 : Math.max(...byOrdinal.keys()) + 1, current);
  }

  const rows = [...byOrdinal.values()].sort((x, y) => x.ordinal - y.ordinal);
  const ins = db.prepare(
    `INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (match_id, ordinal) DO NOTHING`,
  );
  for (const m of rows) ins.run(matchId, m.ordinal, m.map, m.a, m.b);
  return rows;
}

/**
 * Per-player totals, into `match_players` and `match_player_stats`.
 *
 * `match_live_players` is the running cumulative total and is the right source
 * while it exists. Once it is gone the highest-ordinal snapshot in
 * `match_live_map_stats` is the same number as of the last map that ENDED,
 * which is the best available answer for a backfill and is never worse than
 * the zeros the columns hold today.
 *
 * Stats whose visibility is 'self' never reach the live feed at all (see
 * recordLiveStat), so an aborted match is missing them. That is an honest gap,
 * not something to fill with a zero.
 */
function archivePlayers(db: DB, matchId: number): void {
  let rows = db.prepare('SELECT player_id, stats_json FROM match_live_players WHERE match_id = ?')
    .all(matchId) as { player_id: string; stats_json: string }[];
  if (rows.length === 0) {
    const top = db.prepare(
      'SELECT MAX(ordinal) AS o FROM match_live_map_stats WHERE match_id = ?',
    ).get(matchId) as { o: number | null };
    if (top.o === null) return;
    rows = db.prepare(
      'SELECT player_id, stats_json FROM match_live_map_stats WHERE match_id = ? AND ordinal = ?',
    ).all(matchId, top.o) as { player_id: string; stats_json: string }[];
  }

  const upd = db.prepare(
    `UPDATE match_players SET si_damage = ?, si_kills = ?, common_kills = ?, ff_dealt = ?, revives = ?, stats_json = ?
     WHERE match_id = ? AND player_id = ? AND stats_json = '{}'`,
  );
  const insStat = db.prepare(
    `INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)
     ON CONFLICT (match_id, player_id, stat) DO NOTHING`,
  );
  const onRoster = new Set(
    (db.prepare('SELECT player_id FROM match_players WHERE match_id = ?')
      .all(matchId) as { player_id: string }[]).map((r) => r.player_id),
  );

  for (const r of rows) {
    // foreign_keys is ON, so a steamid off the roster would THROW and roll the
    // whole archive back rather than warn. Skip it, as completeMatch does.
    if (!onRoster.has(r.player_id)) continue;
    let stats: Record<string, number>;
    try {
      stats = JSON.parse(r.stats_json) as Record<string, number>;
    } catch {
      continue;
    }
    const n = (k: string) => (typeof stats[k] === 'number' ? stats[k] : 0);
    upd.run(n('sidmg'), n('sikill'), n('ck'), n('ff'), n('rev'), JSON.stringify(stats), matchId, r.player_id);
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value !== 'number' || !statDef(key)) continue;
      insStat.run(matchId, r.player_id, key, value);
    }
  }
}

/** The match-level scoreline: how far they got. Only ever written onto a
 *  0 - 0 row with no winner, so a voided match (completed first, with a real
 *  result already on it) is never touched. */
function archiveScore(db: DB, matchId: number, maps: ArchivedMap[]): void {
  const a = maps.reduce((acc, m) => acc + m.a, 0);
  const b = maps.reduce((acc, m) => acc + m.b, 0);
  db.prepare(
    `UPDATE matches SET team_a_score = ?, team_b_score = ?
     WHERE id = ? AND winner IS NULL AND team_a_score = 0 AND team_b_score = 0`,
  ).run(a, b, matchId);
}
