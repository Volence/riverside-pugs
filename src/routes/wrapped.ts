import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { getSession } from '../session.js';
import { logAdmin } from '../admin/audit.js';
import { finalStandings } from '../seasons.js';
import { computeWrapped, freezeSeasonWrapped, frozenCommunity, frozenPlayer, wrappedSeasons } from '../seasonWrapped.js';
import { makeRequireAdmin } from './guards.js';

/**
 * Season Wrapped (src/seasonWrapped.ts). Public, like the profile it is built
 * from: a deck is for sharing. Only frozen decks are served, so nothing
 * shows until a season has closed; staff can preview a season still open.
 */
export async function wrappedRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const seasonOf = (req: FastifyRequest): number | null => {
    const raw = (req.params as { season: string }).season;
    return /^\d{1,6}$/.test(raw) ? Number(raw) : null;
  };
  const steamOf = (req: FastifyRequest): string | null => {
    const raw = (req.params as { steamid: string }).steamid;
    return /^\d{17}$/.test(raw) ? raw : null;
  };

  app.get('/api/wrapped', async () => ({ seasons: wrappedSeasons(db) }));

  /** The community deck, plus the viewer's own when they are logged in and
   *  played that season. */
  app.get('/api/wrapped/:season', async (req, reply) => {
    const season = seasonOf(req);
    const community = season === null ? null : frozenCommunity(db, season);
    if (!community) return reply.code(404).send({ error: 'no Wrapped for that season' });
    const me = getSession(req, db);
    return { community, me: me ? frozenPlayer(db, season!, me) : null, loggedIn: !!me };
  });

  app.get('/api/wrapped/:season/:steamid', async (req, reply) => {
    const season = seasonOf(req);
    const steamid = steamOf(req);
    const community = season === null ? null : frozenCommunity(db, season);
    const player = community && steamid ? frozenPlayer(db, season!, steamid) : null;
    if (!community || !player) return reply.code(404).send({ error: 'no Wrapped for that player' });
    return { community, player };
  });

  /** Staff preview of any season, computed now and not stored. An open
   *  season uses today's standings, so it shows what the close would freeze. */
  app.get('/api/admin/wrapped/:season/:steamid', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const season = seasonOf(req);
    const steamid = steamOf(req);
    if (season === null || !steamid) return reply.code(400).send({ error: 'bad season or player' });
    const open = db.prepare('SELECT ended_at FROM seasons WHERE id = ?').get(season) as { ended_at: string | null } | undefined;
    if (!open) return reply.code(404).send({ error: 'no such season' });
    const { community, players } = computeWrapped(db, season, new Date(), open.ended_at === null ? { standings: finalStandings(db, season) } : {});
    const player = players.find((p) => p.steamid === steamid) ?? null;
    if (!player) return reply.code(404).send({ error: 'that player has no Wrapped for this season (no completed PUGs, or banned)' });
    return { community, player, preview: true };
  });

  /** Build a closed season's Wrapped again (the close does it on its own). */
  app.post('/api/admin/wrapped/:season/rebuild', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const season = seasonOf(req);
    const row = season === null ? undefined : db.prepare('SELECT ended_at FROM seasons WHERE id = ?').get(season) as { ended_at: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'no such season' });
    if (row.ended_at === null) return reply.code(409).send({ error: 'the season is still open; Wrapped is built when it closes' });
    const players = freezeSeasonWrapped(db, season!);
    logAdmin(db, adminId, 'wrapped_rebuild', season!, { players });
    return { ok: true, players };
  });
}
