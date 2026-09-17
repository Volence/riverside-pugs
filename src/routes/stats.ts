import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { createReadStream } from 'node:fs';
import { makeOptionalViewer } from './guards.js';
import { resolveDemoPath } from '../demos.js';
import { getLiveMatches, mapStatsFor, eventsFor } from '../liveView.js';

/** Every event a finished match can have. A four map night records around a
 *  thousand; the bound exists so a runaway feed cannot become a multi-megabyte
 *  page, not to window anything a real match produces. */
const MATCH_EVENT_LIMIT = 20_000;
import { playerMapBreakdown, mapDetail, mapIndex } from '../playerStats.js';
import { displaySr } from '../rating.js';
import { getPlayer, currentSeasonId } from '../players.js';
import { STAT_DEFS, statDef } from '../statKeys.js';
import { roundAttribution, unrecordedOrdinals } from '../roundStats.js';
import { playerStandings, RANKED_MIN_GAMES } from '../standings.js';

export interface StatsRouteOpts { db: DB; demoDir?: string }

const RECENT_MATCH_LIMIT = 50;
const PROFILE_MATCH_LIMIT = 20;

/** Strip self-only stats unless the requester IS the subject.
 *
 *  Enforced here rather than in the UI on purpose: a value the server sends is
 *  a value the viewer can read, regardless of what the page chooses to render. */
function visibleStats(
  raw: Record<string, number>, subject: string, viewer: string | null,
): Record<string, number> {
  // A null viewer is anonymous, and null never equals a steamid, so every
  // self-only stat is stripped. No special case needed.
  const isSelf = viewer !== null && viewer === subject;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const def = statDef(k);
    if (!def) continue;
    if (def.visibility === 'self' && !isSelf) continue;
    out[k] = v;
  }
  return out;
}

export async function statsRoutes(app: FastifyInstance, opts: StatsRouteOpts): Promise<void> {
  const { db } = opts;
  const demoDir = opts.demoDir ?? '';
  // These are PUBLIC read routes: a leaderboard nobody can see is not a
  // leaderboard, and people want to link results to friends who have not
  // signed up. The viewer is still identified when present, because
  // self-visibility stats depend on it. Everything that MUTATES state, and
  // the personal /api/state dashboard, stays behind requireActive in
  // routes/api.ts.
  const viewerOf = makeOptionalViewer(db);

  app.get('/api/leaderboard', async () => {
    const seasonId = currentSeasonId(db);
    const season = db.prepare('SELECT id, name FROM seasons WHERE id = ?').get(seasonId) as { id: number; name: string };
    const rows = db.prepare(
      `SELECT pr.player_id AS steamid, p.name, p.avatar, pr.mu, pr.sigma, pr.wins, pr.losses,
              (SELECT COUNT(*) FROM rating_history rh WHERE rh.player_id = pr.player_id AND rh.season_id = pr.season_id) AS games
       FROM player_ratings pr JOIN players p ON p.steamid = pr.player_id
       WHERE pr.season_id = ?`,
    ).all(seasonId) as { steamid: string; name: string; avatar: string | null; mu: number; sigma: number; wins: number; losses: number; games: number }[];
    // Per-player season totals, so the leaderboard can be sorted by any stat
    // client side without a request per column. Two queries for the whole
    // table rather than one per player.
    const fixed = db.prepare(
      `SELECT mp.player_id AS steamid,
              COALESCE(SUM(mp.si_damage),0)    AS sidmg,
              COALESCE(SUM(mp.si_kills),0)     AS sikill,
              COALESCE(SUM(mp.common_kills),0) AS ck,
              COALESCE(SUM(mp.ff_dealt),0)     AS ff,
              COALESCE(SUM(mp.revives),0)      AS rev
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE m.season_id = ? AND m.state = 'completed'
       GROUP BY mp.player_id`,
    ).all(seasonId) as Record<string, number | string>[];

    const skill = db.prepare(
      `SELECT mps.player_id AS steamid, mps.stat, SUM(mps.value) AS total
       FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
       WHERE m.season_id = ? AND m.state = 'completed'
       GROUP BY mps.player_id, mps.stat`,
    ).all(seasonId) as { steamid: string; stat: string; total: number }[];

    const statsBy = new Map<string, Record<string, number>>();
    for (const r of fixed) {
      const { steamid, ...rest } = r as { steamid: string } & Record<string, number>;
      statsBy.set(steamid, { ...rest });
    }
    for (const r of skill) {
      // self-visibility stats are never rankable and must not ride along on a
      // public payload, so they are dropped here rather than filtered in the UI.
      if (statDef(r.stat)?.visibility === 'self') continue;
      const bucket = statsBy.get(r.steamid) ?? {};
      bucket[r.stat] = r.total;
      statsBy.set(r.steamid, bucket);
    }

    // How many matches have produced ratings this season. The page used to
    // show the top player's game count under this label, which is only right
    // while everyone has played every match.
    const { matchesRated } = db.prepare(
      'SELECT COUNT(DISTINCT match_id) AS matchesRated FROM rating_history WHERE season_id = ?',
    ).get(seasonId) as { matchesRated: number };

    return {
      season,
      matchesRated,
      rows: rows
        .map((r) => ({
          steamid: r.steamid, name: r.name, avatar: r.avatar,
          sr: displaySr(r.mu, r.sigma), wins: r.wins, losses: r.losses, games: r.games,
          ranked: r.games >= RANKED_MIN_GAMES,
          stats: statsBy.get(r.steamid) ?? {},
        }))
        .sort((x, y) => y.sr - x.sr),
    };
  });

  /** Per-stat ladder. `self`-visibility stats are refused here rather than
   *  filtered later: a "most skeeted" board is exactly what the private
   *  visibility rule exists to prevent, so it must not be reachable by URL. */
  app.get('/api/leaderboard/stat/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const def = statDef(key);
    if (!def || def.visibility !== 'public') return reply.code(404).send({ error: 'unknown stat' });

    const q = req.query as { season?: string; limit?: string };
    const seasonId = q.season ? Number(q.season) : currentSeasonId(db);
    const limit = Math.min(Math.max(Math.trunc(Number(q.limit ?? 25) || 25), 1), 100);

    const rows = db.prepare(
      `SELECT mps.player_id AS steamid, p.name, p.avatar, SUM(mps.value) AS total
       FROM match_player_stats mps
       JOIN matches m ON m.id = mps.match_id
       JOIN players p ON p.steamid = mps.player_id
       WHERE mps.stat = ? AND m.season_id = ? AND m.state = 'completed'
       GROUP BY mps.player_id
       ORDER BY total DESC, p.name ASC
       LIMIT ?`,
    ).all(key, seasonId, limit);

    return { stat: def, seasonId, rows };
  });

  app.get('/api/players/:steamid', async (req, reply) => {
    const viewer = viewerOf(req);
    const { steamid } = req.params as { steamid: string };
    const player = getPlayer(db, steamid);
    if (!player) return reply.code(404).send({ error: 'no such player' });
    const seasonId = currentSeasonId(db);

    const r = db.prepare('SELECT mu, sigma, wins, losses FROM player_ratings WHERE player_id = ? AND season_id = ?')
      .get(steamid, seasonId) as { mu: number; sigma: number; wins: number; losses: number } | undefined;

    const totals = db.prepare(
      `SELECT COUNT(*) AS games, COALESCE(SUM(mp.si_damage),0) AS siDamage, COALESCE(SUM(mp.si_kills),0) AS siKills,
              COALESCE(SUM(mp.common_kills),0) AS commonKills, COALESCE(SUM(mp.ff_dealt),0) AS ffDealt, COALESCE(SUM(mp.revives),0) AS revives
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? AND m.state = 'completed'`,
    ).get(steamid) as { games: number; siDamage: number; siKills: number; commonKills: number; ffDealt: number; revives: number };

    const matches = (db.prepare(
      `SELECT m.id, m.campaign, m.ended_at, m.team_a_score, m.team_b_score, m.winner, mp.team,
              rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       LEFT JOIN rating_history rh ON rh.match_id = m.id AND rh.player_id = mp.player_id
       WHERE mp.player_id = ? AND m.state = 'completed'
       ORDER BY m.id DESC LIMIT ?`,
    ).all(steamid, PROFILE_MATCH_LIMIT) as any[]).map((m) => ({
      id: m.id, campaign: m.campaign, endedAt: m.ended_at,
      teamAScore: m.team_a_score, teamBScore: m.team_b_score, team: m.team,
      result: m.winner === 'draw' ? 'draw' : m.winner === m.team ? 'win' : 'loss',
      srDelta: m.mu_after === null ? 0
        : displaySr(m.mu_after, m.sigma_after) - displaySr(m.mu_before, m.sigma_before),
    }));

    const history = (db.prepare(
      'SELECT match_id, mu_after, sigma_after FROM rating_history WHERE player_id = ? AND season_id = ? ORDER BY id',
    ).all(steamid, seasonId) as any[]).map((h) => ({ matchId: h.match_id, sr: displaySr(h.mu_after, h.sigma_after) }));

    const statRows = db.prepare(
      `SELECT mps.stat, SUM(mps.value) AS total
       FROM match_player_stats mps JOIN matches m ON m.id = mps.match_id
       WHERE mps.player_id = ? AND m.state = 'completed'
       GROUP BY mps.stat`,
    ).all(steamid) as { stat: string; total: number }[];

    const statTotals: Record<string, number> = {};
    const privateTotals: Record<string, number> = {};
    for (const r2 of statRows) {
      const def = statDef(r2.stat);
      if (!def) continue;
      (def.visibility === 'self' ? privateTotals : statTotals)[r2.stat] = r2.total;
    }
    const isSelf = viewer === steamid;

    return {
      player: { steamid: player.steamid, name: player.name, avatar: player.avatar, createdAt: player.created_at },
      rating: r ? { sr: displaySr(r.mu, r.sigma), mu: r.mu, sigma: r.sigma, wins: r.wins, losses: r.losses } : null,
      totals, matches, history,
      statTotals,
      // Top-5 places this season, per match, among ranked players. Keyed like
      // the stat bag plus `winrate` and `boomer_rate`.
      standings: playerStandings(db, seasonId, steamid),
      // How this player does on each map, across every match. Only meaningful
      // once per-map capture exists, so older matches contribute win/loss with
      // an empty stat bag rather than being omitted.
      byMap: playerMapBreakdown(db, steamid),
      // Contract (web/src/api.ts: Profile['privateStatTotals']) is populated-or-
      // null, never an empty object: Profile.tsx gates its private-stats panel
      // on truthiness, and {} is truthy, so a self-viewer with no private stats
      // recorded yet would otherwise render an empty panel.
      privateStatTotals: (isSelf && Object.keys(privateTotals).length > 0) ? privateTotals : null,
      statDefs: STAT_DEFS,
    };
  });

  /** What is being played right now. Public: the whole point is that someone
   *  who is not in the game, and may not have an account, can watch. Carries
   *  no stats, so there is nothing viewer-dependent to redact. */
  app.get('/api/live', async () => ({ matches: getLiveMatches(db) }));

  /** Every map that has been played, so the map pages are discoverable. */
  app.get('/api/maps', async () => ({ maps: mapIndex(db) }));

  /** Everyone's record on one map. Counterpart to the profile's by-map view. */
  app.get('/api/maps/:map', async (req, reply) => {
    const { map } = req.params as { map: string };
    const d = mapDetail(db, map);
    if (!d) return reply.code(404).send({ error: 'no such map' });
    return d;
  });

  app.get('/api/matches', async () => {
    const matches = db.prepare(
      `SELECT id, campaign, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
       FROM matches WHERE state = 'completed' ORDER BY id DESC LIMIT ?`,
    ).all(RECENT_MATCH_LIMIT);
    return { matches };
  });

  app.get('/api/matches/:id', async (req, reply) => {
    const viewer = viewerOf(req);
    const id = Number((req.params as { id: string }).id);
    const match = db.prepare(
      `SELECT id, campaign, state, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
       FROM matches WHERE id = ? AND state = 'completed'`,
    ).get(id);
    if (!match) return reply.code(404).send({ error: 'no such match' });
    // Per-map player stats come from the end-of-map snapshots kept by the
    // live pipeline; the authoritative dump only carries match totals. Absent
    // for any match played before that existed, hence the ?? {}.
    const byMap = mapStatsFor(db, id);
    // `recorded` false means the stored score is not a result (a round the
    // plugin could not attribute or read), and the page must say "not
    // recorded" instead of 0 to 0. See unrecordedOrdinals for the rule.
    const unrecorded = unrecordedOrdinals(db, id);
    const maps = (db.prepare(
      'SELECT ordinal, map, team_a_score AS teamAScore, team_b_score AS teamBScore FROM match_maps WHERE match_id = ? ORDER BY ordinal',
    ).all(id) as { ordinal: number }[]).map((mp) => ({
      ...mp, stats: byMap.get(mp.ordinal) ?? {}, recorded: !unrecorded.has(mp.ordinal),
    }));
    const statRows = db.prepare(
      'SELECT player_id, stat, value FROM match_player_stats WHERE match_id = ?',
    ).all(id) as { player_id: string; stat: string; value: number }[];
    const byPlayer = new Map<string, Record<string, number>>();
    for (const sr of statRows) {
      const bucket = byPlayer.get(sr.player_id) ?? {};
      bucket[sr.stat] = sr.value;
      byPlayer.set(sr.player_id, bucket);
    }
    const players = (db.prepare(
      `SELECT mp.player_id AS steamid, p.name, mp.team, mp.si_damage, mp.si_kills, mp.common_kills, mp.ff_dealt, mp.revives,
              rh.mu_before, rh.sigma_before, rh.mu_after, rh.sigma_after
       FROM match_players mp
       JOIN players p ON p.steamid = mp.player_id
       LEFT JOIN rating_history rh ON rh.match_id = mp.match_id AND rh.player_id = mp.player_id
       WHERE mp.match_id = ?`,
    ).all(id) as any[]).map((p) => ({
      steamid: p.steamid, name: p.name, team: p.team,
      siDamage: p.si_damage, siKills: p.si_kills, commonKills: p.common_kills, ffDealt: p.ff_dealt, revives: p.revives,
      srDelta: p.mu_after === null ? 0
        : displaySr(p.mu_after, p.sigma_after) - displaySr(p.mu_before, p.sigma_before),
      stats: visibleStats(byPlayer.get(p.steamid) ?? {}, p.steamid, viewer),
    }));
    // Per-round side attribution. Derived, not stored: see src/roundStats.ts.
    // teamOf comes from match_players, which is the authoritative roster
    // written at completion, rather than from anything on the live feed.
    const teamOf = new Map(players.map((p) => [p.steamid, p.team as 'a' | 'b']));
    // roundAttribution carries score and endedAt through from the same
    // roundsFor() query it already runs internally. This used to run that
    // query a second time here and join the two results by array index; one
    // query, no positional join.
    const rounds = roundAttribution(db, id, teamOf);

    // Only demos for maps the match actually has. The recorder opens a demo
    // on every map load under the match token, including the post-finale
    // map the server rolls to after the match has ended, so a file can exist
    // for an ordinal match_maps never had. This route serves completed
    // matches only; the live view (getLiveMatches) keeps every demo because
    // its map list is still growing.
    const demos = db.prepare(
      `SELECT d.ordinal, d.map, d.bytes FROM match_demos d
       JOIN match_maps mm ON mm.match_id = d.match_id AND mm.ordinal = d.ordinal
       WHERE d.match_id = ? ORDER BY d.ordinal`,
    ).all(id);

    const nameOf = (sid: string) =>
      (players.find((p) => p.steamid === sid)?.name) ?? sid;
    // The WHOLE feed, with its timing. This used to take eventsFor's default,
    // which is the live page's 40-newest window, and dropped half and tMs on
    // the way out. A completed match is a record, not a ticker: the clear
    // latency table then saw two minutes of finale and did undefined minus
    // undefined for every pair (NaN averages, three players, 2026-09-13).
    const events = eventsFor(db, id, MATCH_EVENT_LIMIT).map((e) => ({
      seq: e.seq, kind: e.kind, mapOrdinal: e.mapOrdinal, half: e.half, tMs: e.tMs, value: e.value,
      actor: { steamid: e.actor, name: nameOf(e.actor) },
      target: e.target ? { steamid: e.target, name: nameOf(e.target) } : null,
    }));

    return { match, maps, players, rounds, demos, events, statDefs: STAT_DEFS };
  });

  /**
   * Download one match demo. Public, at the user's request (2026-09-11).
   *
   * The bytes were behind a login because a demo is 100+ MB served off the
   * same two cores that are holding 100 tick, so anonymous bulk downloading
   * competes with srcds for I/O and bandwidth. That tradeoff has not gone
   * away; it was accepted deliberately so demos can be shared with people who
   * have no account. If the box ever starts struggling under demo traffic,
   * restoring `requireActive` here is the one-line fix.
   */
  app.get('/api/matches/:id/demos/:ordinal', async (req, reply) => {
    const { id, ordinal } = req.params as { id: string; ordinal: string };
    const found = resolveDemoPath(db, Number(id), Number(ordinal), demoDir);
    if (!found) return reply.code(404).send({ error: 'no such demo' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(found.bytes));
    // Served under a SHORT name, not the on-disk one. The stored filename
    // carries a 32-char token, and `playdemo` takes the filename with no
    // extension, so the real name means typing 60+ characters into the Source
    // console with no tab completion. pug8-1 is match 8, map 1.
    const friendly = `pug${Number(id)}-${Number(ordinal) + 1}.dem`;
    reply.header('Content-Disposition', `attachment; filename="${friendly}"`);
    return reply.send(createReadStream(found.path));
  });
}
