import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { logAdmin } from '../admin/audit.js';
import { serverPasswordFor } from '../matchToken.js';
import { spectateFor, type SpectateInfo } from '../spectate.js';
import { campaignDisplayName, campaignRegistry } from '../campaignRegistry.js';
import { phaseFor, roundInProgress } from '../liveView.js';
import { makeRequireCaster } from './guards.js';
import { viewerFor } from '../matchVisibility.js';
import { fullyInvited } from '../bookings/casters.js';
import { getBooking } from '../bookings/bookings.js';

export interface CastMatch {
  id: number;
  campaign: string;
  /** Display name, custom campaigns included. */
  campaignName: string;
  currentMap: string | null;
  /** Which chapter is being played, 1-based: the map's place in the campaign
   *  when the registry knows it, else maps finished + 1. */
  mapNumber: number;
  /** Chapters in the campaign, or null when the registry does not know. */
  mapCount: number | null;
  /** Running totals over finished maps, as the Live page shows them. */
  teamAScore: number;
  teamBScore: number;
  /** What the game is doing (live, paused, readyup, roundover, loading), null
   *  before the first heartbeat. */
  phase: string | null;
  /** 1 or 2 while a round is being played, else null. */
  half: number | null;
  serverName: string | null;
  teamA: string[];
  teamB: string[];
  /** The game server itself, to join as an in-game spectator. Null for a
   *  match started in game: that runs on the box's own sv_password from
   *  secrets.cfg, which the site never knows. Always null for a booking's
   *  game: casters never get a booked box's game password. */
  connect: { host: string; port: number; password: string } | null;
  spectate: SpectateInfo | null;
  /** A booking's game: watched through SourceTV only (connect is null). */
  booked: boolean;
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
 * A booking's games (plan 4c) are listed only to staff and to a caster both
 * sides invited (src/bookings/casters.ts), whatever their kind. For those the
 * relay password is the booking's own tv_password, never servers.tv_password,
 * and this route is the only one that ever returns it.
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

    // Casters see every PUG and tournament match. A booking's game (a scrim,
    // or a tournament game on a booked box) only for staff or a caster both
    // sides invited, checked live on every read.
    const staff = viewerFor(db, viewer).staff;
    const rows = (db.prepare(
      `SELECT m.id, m.campaign, m.token, m.origin, m.server_id AS serverId, m.booking_id AS bookingId,
              l.current_map AS currentMap, s.name AS serverName, s.host, s.port
       FROM matches m
       LEFT JOIN match_live l ON l.match_id = m.id
       LEFT JOIN servers s ON s.id = m.server_id
       WHERE m.state = 'live' AND (m.booking_id IS NOT NULL OR m.kind IN ('pug', 'tournament'))
       ORDER BY m.id DESC`,
    ).all() as {
      id: number; campaign: string; token: string | null; origin: string | null; serverId: number | null;
      bookingId: number | null; currentMap: string | null; serverName: string | null; host: string | null; port: number | null;
    }[]).filter((r) => r.bookingId === null || staff || fullyInvited(db, r.bookingId, viewer));
    const teamOf = db.prepare(
      `SELECT p.name FROM match_players mp JOIN players p ON p.steamid = mp.player_id
       WHERE mp.match_id = ? AND mp.team = ? ORDER BY p.name COLLATE NOCASE`,
    );
    const scoresOf = db.prepare(
      `SELECT COUNT(*) AS done, COALESCE(SUM(team_a_score), 0) AS a, COALESCE(SUM(team_b_score), 0) AS b
       FROM match_live_maps WHERE match_id = ?`,
    );
    const registry = campaignRegistry(db);
    const seen = db.prepare(
      "SELECT 1 FROM admin_actions WHERE action = 'cast_connect' AND admin_id = ? AND target = ? LIMIT 1",
    );

    /** The booked box's relay with the booking's own password. */
    const bookingRelay = (serverId: number | null, bookingId: number): SpectateInfo | null => {
      const tv = spectateFor(db, serverId);
      const b = getBooking(db, bookingId);
      return tv && b ? { ...tv, password: b.tv_password } : null;
    };

    const matches: CastMatch[] = rows.map((r) => {
      const connect = r.bookingId === null && r.origin === 'queue' && r.token && r.host !== null && r.port !== null
        ? { host: r.host, port: r.port, password: serverPasswordFor(r.token) }
        : null;
      if (connect && !seen.get(viewer, String(r.id))) {
        logAdmin(db, viewer, 'cast_connect', r.id, { server: r.serverName }, { quiet: true });
      }
      const score = scoresOf.get(r.id) as { done: number; a: number; b: number };
      const chapters = registry.get(r.campaign)?.maps ?? [];
      const at = r.currentMap ? chapters.findIndex((m) => m.toLowerCase() === r.currentMap!.toLowerCase()) : -1;
      return {
        id: r.id,
        campaign: r.campaign,
        campaignName: campaignDisplayName(db, r.campaign),
        currentMap: r.currentMap,
        mapNumber: at >= 0 ? at + 1 : score.done + 1,
        mapCount: chapters.length > 0 ? chapters.length : null,
        teamAScore: score.a,
        teamBScore: score.b,
        phase: phaseFor(db, r.id)?.state ?? null,
        half: roundInProgress(db, r.id)?.half ?? null,
        serverName: r.serverName,
        teamA: (teamOf.all(r.id, 'a') as { name: string }[]).map((p) => p.name),
        teamB: (teamOf.all(r.id, 'b') as { name: string }[]).map((p) => p.name),
        connect,
        booked: r.bookingId !== null,
        spectate: r.bookingId === null ? spectateFor(db, r.serverId) : bookingRelay(r.serverId, r.bookingId),
      };
    });
    return { matches };
  });
}
