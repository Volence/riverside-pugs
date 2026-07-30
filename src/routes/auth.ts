import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { verifyLogin as VerifyFn, fetchPersona as PersonaFn } from '../steamAuth.js';
import { loginUrl } from '../steamAuth.js';
import { getSession, setSession } from '../session.js';
import { activatePlayer, getPlayer, upsertPlayer } from '../players.js';
import { getSetting } from '../settings.js';

export interface AuthRouteOpts {
  config: Config;
  db: DB;
  verifyLogin: typeof VerifyFn;
  fetchPersona: typeof PersonaFn;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOpts): Promise<void> {
  const { config, db } = opts;

  app.get('/auth/steam', async (_req, reply) => {
    return reply.redirect(loginUrl(config.publicUrl));
  });

  app.get('/auth/steam/return', async (req, reply) => {
    const steamid = await opts.verifyLogin(req.query as Record<string, string>);
    if (!steamid) return reply.code(403).send('Steam login failed');
    const persona = await opts.fetchPersona(steamid, config.steamApiKey);
    upsertPlayer(db, { steamid, name: persona.name, avatar: persona.avatar }, config.adminSteamIds);
    setSession(reply, steamid);
    return reply.redirect('/');
  });

  app.get('/api/me', async (req, reply) => {
    const steamid = getSession(req);
    if (!steamid) return reply.code(401).send({ error: 'not logged in' });
    const player = getPlayer(db, steamid);
    if (!player) return reply.code(401).send({ error: 'unknown player' });
    return {
      steamid: player.steamid,
      name: player.name,
      avatar: player.avatar,
      status: player.status,
      isAdmin: player.is_admin === 1,
    };
  });

  app.post('/api/register', async (req, reply) => {
    const steamid = getSession(req);
    if (!steamid) return reply.code(401).send({ error: 'not logged in' });
    const player = getPlayer(db, steamid);
    if (!player) return reply.code(401).send({ error: 'unknown player' });
    if (player.status === 'banned') return reply.code(403).send({ error: 'banned' });
    if (player.status === 'active') return { ok: true };
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code || code !== getSetting(db, 'invite_code')) {
      return reply.code(403).send({ error: 'bad invite code' });
    }
    activatePlayer(db, steamid);
    return { ok: true };
  });
}
