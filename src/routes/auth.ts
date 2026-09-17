import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { verifyLogin as VerifyFn, fetchPersona as PersonaFn } from '../steamAuth.js';
import { loginUrl } from '../steamAuth.js';
import { getSession, setSession } from '../session.js';
import { activatePlayer, getPlayer, upsertPlayer } from '../players.js';
import { getSetting } from '../settings.js';
import type { DiscordApi } from '../discord/api.js';
import { applyGate } from '../discord/gate.js';

const NEXT_COOKIE = 'pug_next';

/** Only same-site paths. Rejects protocol-relative (`//x`) and backslash
 *  tricks (`/\x`, which browsers normalise to `//x`), so the return-to can
 *  never become an open redirect. */
function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.includes('\\')) return null;
  return raw.length <= 512 ? raw : null;
}

export interface AuthRouteOpts {
  config: Config;
  db: DB;
  verifyLogin: typeof VerifyFn;
  fetchPersona: typeof PersonaFn;
  discordApi: DiscordApi | null;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOpts): Promise<void> {
  const { config, db } = opts;

  app.get('/auth/steam', async (req, reply) => {
    const next = safeNext((req.query as { next?: string }).next);
    if (next) {
      reply.setCookie(NEXT_COOKIE, next, {
        path: '/', httpOnly: true, signed: true, sameSite: 'lax',
        secure: config.publicUrl.startsWith('https://'), maxAge: 10 * 60,
      });
    }
    return reply.redirect(loginUrl(config.publicUrl));
  });

  app.get('/auth/steam/return', async (req, reply) => {
    const steamid = await opts.verifyLogin(req.query as Record<string, string>);
    if (!steamid) return reply.code(403).send('Steam login failed');
    const persona = await opts.fetchPersona(steamid, config.steamApiKey);
    upsertPlayer(db, { steamid, name: persona.name, avatar: persona.avatar }, config.adminSteamIds);
    setSession(reply, steamid, config.publicUrl.startsWith('https://'));
    // Someone already linked who has since joined the guild is activated here
    // rather than having to relink.
    if (opts.discordApi) await applyGate(db, opts.discordApi, steamid);
    const rawNext = req.cookies[NEXT_COOKIE];
    const unsigned = rawNext ? req.unsignCookie(rawNext) : null;
    const next = unsigned?.valid ? safeNext(unsigned.value) : null;
    if (rawNext) reply.clearCookie(NEXT_COOKIE, { path: '/' });
    return reply.redirect(next ?? '/');
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
      discordEnabled: config.discord !== null,
      discord: player.discord_id ? { id: player.discord_id, name: player.discord_name ?? '' } : null,
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
