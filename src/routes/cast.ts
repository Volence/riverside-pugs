import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { logAdmin } from '../admin/audit.js';
import { serverPasswordFor } from '../matchToken.js';
import { spectateFor, type SpectateInfo } from '../spectate.js';
import { makeRequireCaster } from './guards.js';

export interface CastMatch {
  id: number;
  campaign: string;
  currentMap: string | null;
  serverName: string | null;
  teamA: string[];
  teamB: string[];
  /** The game server itself, to join as an in-game spectator. Null for a
   *  match started in game: that runs on the box's own sv_password from
   *  secrets.cfg, which the site never knows. */
  connect: { host: string; port: number; password: string } | null;
  spectate: SpectateInfo | null;
}

/**
 * The caster page: how to join every live match's game server as a spectator.
 * SourceTV has no first-person arms, so casters want a seat on the real server,
 * which means the match's sv_password. That is derived from the token exactly
 * as orchestrator.ts sets it, so the two cannot drift.
 *
 * Nothing on the game server keeps an extra spectator out: the plugin never
 * kicks an unrostered client, it only places the rostered eight. So this is
 * website work only.
 *
 * Each caster's first read of a match's password goes in the admin log
 * (quietly, no feed post: the page is polled), so a leaked password has a
 * short list of people who could have seen it.
 */
export async function castRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const requireCaster = makeRequireCaster(db);

  app.get('/api/cast', async (req, reply) => {
    const viewer = requireCaster(req, reply);
    if (!viewer) return reply;

    const rows = db.prepare(
      `SELECT m.id, m.campaign, m.token, m.origin, m.server_id AS serverId, l.current_map AS currentMap,
              s.name AS serverName, s.host, s.port
       FROM matches m
       LEFT JOIN match_live l ON l.match_id = m.id
       LEFT JOIN servers s ON s.id = m.server_id
       WHERE m.state = 'live'
       ORDER BY m.id DESC`,
    ).all() as {
      id: number; campaign: string; token: string | null; origin: string | null; serverId: number | null;
      currentMap: string | null; serverName: string | null; host: string | null; port: number | null;
    }[];
    const teamOf = db.prepare(
      `SELECT p.name FROM match_players mp JOIN players p ON p.steamid = mp.player_id
       WHERE mp.match_id = ? AND mp.team = ? ORDER BY p.name COLLATE NOCASE`,
    );
    const seen = db.prepare(
      "SELECT 1 FROM admin_actions WHERE action = 'cast_connect' AND admin_id = ? AND target = ? LIMIT 1",
    );

    const matches: CastMatch[] = rows.map((r) => {
      const connect = r.origin === 'queue' && r.token && r.host !== null && r.port !== null
        ? { host: r.host, port: r.port, password: serverPasswordFor(r.token) }
        : null;
      if (connect && !seen.get(viewer, String(r.id))) {
        logAdmin(db, viewer, 'cast_connect', r.id, { server: r.serverName }, { quiet: true });
      }
      return {
        id: r.id,
        campaign: r.campaign,
        currentMap: r.currentMap,
        serverName: r.serverName,
        teamA: (teamOf.all(r.id, 'a') as { name: string }[]).map((p) => p.name),
        teamB: (teamOf.all(r.id, 'b') as { name: string }[]).map((p) => p.name),
        connect,
        spectate: spectateFor(db, r.serverId),
      };
    });
    return { matches };
  });
}
