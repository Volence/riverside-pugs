import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireActive } from './guards.js';
import { displaySr } from '../rating.js';
import { getPlayer, currentSeasonId } from '../players.js';
import { STAT_DEFS, statDef } from '../statKeys.js';

export interface StatsRouteOpts { db: DB }

const RECENT_MATCH_LIMIT = 50;
const PROFILE_MATCH_LIMIT = 20;

/** Strip self-only stats unless the requester IS the subject.
 *
 *  Enforced here rather than in the UI on purpose: a value the server sends is
 *  a value the viewer can read, regardless of what the page chooses to render. */
function visibleStats(
  raw: Record<string, number>, subject: string, viewer: string,
): Record<string, number> {
  const isSelf = viewer === subject;
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
  const requireActive = makeRequireActive(db);

  app.get('/api/leaderboard', async (req, reply) => {
    if (!requireActive(req, reply)) return;
    const seasonId = currentSeasonId(db);
    const season = db.prepare('SELECT id, name FROM seasons WHERE id = ?').get(seasonId) as { id: number; name: string };
    const rows = db.prepare(
      `SELECT pr.player_id AS steamid, p.name, p.avatar, pr.mu, pr.sigma, pr.wins, pr.losses,
              (SELECT COUNT(*) FROM rating_history rh WHERE rh.player_id = pr.player_id AND rh.season_id = pr.season_id) AS games
       FROM player_ratings pr JOIN players p ON p.steamid = pr.player_id
       WHERE pr.season_id = ?`,
    ).all(seasonId) as { steamid: string; name: string; avatar: string | null; mu: number; sigma: number; wins: number; losses: number; games: number }[];
    return {
      season,
      rows: rows
        .map((r) => ({ steamid: r.steamid, name: r.name, avatar: r.avatar, sr: displaySr(r.mu, r.sigma), wins: r.wins, losses: r.losses, games: r.games }))
        .sort((x, y) => y.sr - x.sr),
    };
  });

  /** Per-stat ladder. `self`-visibility stats are refused here rather than
   *  filtered later: a "most skeeted" board is exactly what the private
   *  visibility rule exists to prevent, so it must not be reachable by URL. */
  app.get('/api/leaderboard/stat/:key', async (req, reply) => {
    if (!requireActive(req, reply)) return;
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
    const viewer = requireActive(req, reply);
    if (!viewer) return;
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
      // Contract (web/src/api.ts: Profile['privateStatTotals']) is populated-or-
      // null, never an empty object: Profile.tsx gates its private-stats panel
      // on truthiness, and {} is truthy, so a self-viewer with no private stats
      // recorded yet would otherwise render an empty panel.
      privateStatTotals: (isSelf && Object.keys(privateTotals).length > 0) ? privateTotals : null,
      statDefs: STAT_DEFS,
    };
  });

  app.get('/api/matches', async (req, reply) => {
    if (!requireActive(req, reply)) return;
    const matches = db.prepare(
      `SELECT id, campaign, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
       FROM matches WHERE state = 'completed' ORDER BY id DESC LIMIT ?`,
    ).all(RECENT_MATCH_LIMIT);
    return { matches };
  });

  app.get('/api/matches/:id', async (req, reply) => {
    const viewer = requireActive(req, reply);
    if (!viewer) return;
    const id = Number((req.params as { id: string }).id);
    const match = db.prepare(
      `SELECT id, campaign, state, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
       FROM matches WHERE id = ? AND state = 'completed'`,
    ).get(id);
    if (!match) return reply.code(404).send({ error: 'no such match' });
    const maps = db.prepare(
      'SELECT ordinal, map, team_a_score AS teamAScore, team_b_score AS teamBScore FROM match_maps WHERE match_id = ? ORDER BY ordinal',
    ).all(id);
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
    return { match, maps, players };
  });
}
