import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { TwitchApi } from '../twitch/api.js';
import { getSession } from '../session.js';
import { getPlayer, linkTwitch, unlinkTwitch } from '../players.js';
import { inGoodStanding } from '../standing.js';

export interface TwitchAuthOpts { config: Config; db: DB; api: TwitchApi | null }

const STATE_TTL_MS = 10 * 60 * 1000;

/** OAuth state bound to the session's steamid, exactly as discordAuth does it.
 *  Without the binding, anyone could walk a logged-in player through a
 *  callback that attaches the attacker's Twitch channel to the victim's row.
 *
 *  The 'twitch:' prefix keeps this namespace distinct from the Discord one, so
 *  a state issued for one flow cannot be replayed into the other. */
function signState(secret: string, steamid: string, ts: number): string {
  const mac = createHmac('sha256', secret).update(`twitch:${steamid}:${ts}`).digest('hex');
  return `${mac}:${ts}`;
}

function verifyState(secret: string, steamid: string, state: string, now = Date.now()): boolean {
  const [mac, tsRaw] = state.split(':');
  const ts = Number(tsRaw);
  if (!mac || !Number.isFinite(ts) || now - ts > STATE_TTL_MS || ts > now + 60_000) return false;
  // A non-hex mac makes Buffer.from produce a short buffer rather than
  // throwing, so the length comparison below is what rejects it. Checked
  // explicitly anyway, because relying on that is a trap for the next reader.
  if (!/^[0-9a-f]+$/i.test(mac)) return false;
  const want = Buffer.from(signState(secret, steamid, ts).split(':')[0], 'hex');
  const got = Buffer.from(mac, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function twitchAuthRoutes(app: FastifyInstance, opts: TwitchAuthOpts): Promise<void> {
  const { config, db, api } = opts;
  const twitch = config.twitch;
  const redirectUri = `${config.publicUrl}/auth/twitch/callback`;

  /** 404 when Twitch is unconfigured, 401 without a session; else the steamid. */
  const guard = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!twitch || !api) {
      reply.code(404).send({ error: 'not found' });
      return null;
    }
    const steamid = getSession(req);
    if (!steamid || !getPlayer(db, steamid)) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    return steamid;
  };

  /** Linking puts a channel, and with it a title and a thumbnail somebody
   *  else controls, on the public Streams page. That is for members: an
   *  active player with no ban in force, the same test the queue applies.
   *  Unlinking is deliberately NOT behind this. Taking a channel off the site
   *  is never the thing to refuse, least of all to somebody who was banned. */
  const member = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const steamid = guard(req, reply);
    if (!steamid) return null;
    if (!inGoodStanding(db, steamid)) {
      reply.code(403).send({ error: 'not an active player' });
      return null;
    }
    return steamid;
  };

  app.get('/auth/twitch', async (req, reply) => {
    const steamid = member(req, reply);
    if (!steamid) return reply;
    const params = new URLSearchParams({
      client_id: twitch!.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // Empty on purpose. Knowing which account authorised needs no scope, and
      // asking for one we never use is a permission prompt we would have to
      // justify to every player who links.
      scope: '',
      state: signState(config.cookieSecret, steamid, Date.now()),
    });
    return reply.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
  });

  app.get('/auth/twitch/callback', async (req, reply) => {
    const steamid = member(req, reply);
    if (!steamid) return reply;
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || !verifyState(config.cookieSecret, steamid, state)) {
      return reply.code(400).send('Twitch link failed: invalid state. Start again from your profile.');
    }
    const back = (result: string) => reply.redirect(`/player/${steamid}?twitch=${result}`);
    let user: { id: string; login: string };
    try {
      const { accessToken } = await api!.exchangeCode(code, redirectUri);
      user = await api!.getCurrentUser(accessToken);
    } catch (err) {
      console.error('[twitch] oauth callback failed:', err);
      return back('failed');
    }
    const linked = linkTwitch(db, steamid, user.id, user.login);
    if (!linked.ok) return back('taken');
    return back('linked');
  });

  app.post('/api/twitch/unlink', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    unlinkTwitch(db, steamid);
    return { ok: true };
  });
}
