import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { DiscordApi } from '../discord/api.js';
import { applyGate } from '../discord/gate.js';
import { getSession } from '../session.js';
import { consumeLinkCode, getPlayer, linkDiscord, unlinkDiscord } from '../players.js';

export interface DiscordAuthOpts { config: Config; db: DB; api: DiscordApi | null }

const STATE_TTL_MS = 10 * 60 * 1000;

/** OAuth state bound to the session's steamid. Without the binding, anyone
 *  could walk a logged-in player through a callback that attaches the
 *  attacker's Discord account to the victim's player row. */
function signState(secret: string, steamid: string, ts: number): string {
  const mac = createHmac('sha256', secret).update(`${steamid}:${ts}`).digest('hex');
  return `${mac}:${ts}`;
}

function verifyState(secret: string, steamid: string, state: string, now = Date.now()): boolean {
  const [mac, tsRaw] = state.split(':');
  const ts = Number(tsRaw);
  if (!mac || !Number.isFinite(ts) || now - ts > STATE_TTL_MS || ts > now + 60_000) return false;
  const want = Buffer.from(signState(secret, steamid, ts).split(':')[0], 'hex');
  const got = Buffer.from(mac, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function discordAuthRoutes(app: FastifyInstance, opts: DiscordAuthOpts): Promise<void> {
  const { config, db, api } = opts;
  const discord = config.discord;
  const redirectUri = `${config.publicUrl}/auth/discord/callback`;

  /** 404 when Discord is unconfigured, 401 without a session; else the steamid. */
  const guard = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!discord || !api) {
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

  app.get('/auth/discord', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    const params = new URLSearchParams({
      client_id: discord!.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify',
      state: signState(config.cookieSecret, steamid, Date.now()),
    });
    return reply.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/auth/discord/callback', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || !verifyState(config.cookieSecret, steamid, state)) {
      return reply.code(400).send('Discord link failed: invalid state. Start again from your profile.');
    }
    const back = (result: string) => reply.redirect(`/player/${steamid}?discord=${result}`);
    let user: { id: string; username: string; globalName: string | null };
    try {
      const { accessToken } = await api!.exchangeCode(code, redirectUri);
      user = await api!.getCurrentUser(accessToken);
    } catch (err) {
      console.error('[discord] oauth callback failed:', err);
      return back('failed');
    }
    const linked = linkDiscord(db, steamid, user.id, user.globalName ?? user.username);
    if (!linked.ok) return back('taken');
    await applyGate(db, api!, steamid);
    return back('linked');
  });

  app.post('/api/discord/link-code', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    const { code } = (req.body ?? {}) as { code?: string };
    if (typeof code !== 'string') return reply.code(400).send({ error: 'invalid_code' });
    // Check ownership before spending the code, so a player who hits "taken"
    // can sort it out and retry with the same link instead of asking the bot
    // for another.
    const peek = db.prepare('SELECT discord_id FROM discord_link_codes WHERE code = ?').get(code) as
      | { discord_id: string } | undefined;
    if (peek) {
      const owner = db.prepare('SELECT steamid FROM players WHERE discord_id = ?').get(peek.discord_id) as
        | { steamid: string } | undefined;
      if (owner && owner.steamid !== steamid) return reply.code(409).send({ error: 'discord_taken' });
    }
    const spent = consumeLinkCode(db, code);
    if (!spent) return reply.code(400).send({ error: 'invalid_code' });
    const linked = linkDiscord(db, steamid, spent.discordId, spent.discordName);
    if (!linked.ok) return reply.code(409).send({ error: 'discord_taken' });
    const active = await applyGate(db, api!, steamid);
    return { ok: true, active, discordName: spent.discordName };
  });

  app.post('/api/discord/unlink', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    unlinkDiscord(db, steamid);
    return { ok: true };
  });
}
