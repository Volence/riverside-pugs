import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { DiscordApi } from '../discord/api.js';
import { applyGate } from '../discord/gate.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getSession } from '../session.js';
import {
  consumeLinkCode, getPlayer, linkDiscord, peekLinkCode, unlinkDiscord, type LinkResult,
} from '../players.js';
import { hasActiveBan } from '../banState.js';
import { activeTimeout } from '../penalties.js';

export interface DiscordAuthOpts {
  config: Config;
  db: DB;
  api: DiscordApi | null;
  /** Everyone in the queue or in a lobby right now. Both live only in the
   *  matchmaker's memory, so this is the way to ask. */
  engaged?: () => string[];
}

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
    const steamid = getSession(req, db);
    if (!steamid || !getPlayer(db, steamid)) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    return steamid;
  };

  /** What every successful link does next, whichever way it was made. */
  const announceLink = (steamid: string, discordName: string, linked: Extract<LinkResult, { ok: true }>): void => {
    publishAdminEvent({ kind: 'account', steamid, what: 'linked', discordName });
    if (linked.movedFrom) {
      const was = getPlayer(db, linked.movedFrom.steamid);
      publishAdminEvent({
        kind: 'problem',
        text: `Discord account ${discordName} was linked to ${getPlayer(db, steamid)?.name ?? steamid} (${steamid}), and until ${linked.movedFrom.unlinkedAt} it was linked to a different Steam account, ${was?.name ?? 'unknown'} (${linked.movedFrom.steamid}). One Discord account moving between Steam accounts is what an alt looks like.`,
      });
    }
  };

  /**
   * Why this player may not let go of their Discord right now, or null.
   *
   * The Discord account is what ties a person to one Steam account. Dropping
   * it while banned or timed out frees it to vouch for the next account, and
   * dropping it while queued or on a roster pulls it out from under a ready
   * check, a team voice channel or a match password that were all addressed
   * to it. An admin can still unlink anyone from the panel.
   */
  const unlinkBlock = (steamid: string): string | null => {
    if (getPlayer(db, steamid)?.status === 'banned' || hasActiveBan(db, steamid)) {
      return 'you cannot disconnect Discord while you are banned; contact an admin';
    }
    if (activeTimeout(db, steamid)) return 'you cannot disconnect Discord during a queue timeout';
    if (opts.engaged?.().includes(steamid)) return 'leave the queue before disconnecting Discord';
    const inMatch = db.prepare(
      `SELECT 1 FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.player_id = ? AND m.state IN ('configuring','live') LIMIT 1`,
    ).get(steamid);
    return inMatch ? 'you cannot disconnect Discord while you are in a match' : null;
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
    const linked = linkDiscord(db, steamid, user.id, user.globalName ?? user.username, { adminSteamIds: config.adminSteamIds });
    if (!linked.ok) return back(linked.error === 'discord_taken' ? 'taken' : linked.error);
    announceLink(steamid, user.globalName ?? user.username, linked);
    await applyGate(db, api!, steamid);
    return back('linked');
  });

  /** Whose Discord a link code is for, without spending it. The link page
   *  shows this next to the signed-in Steam persona and only spends the code
   *  when the player presses the button: a code that spent itself on page load
   *  let anyone attach THEIR Discord to whoever opened the URL. */
  app.get('/api/discord/link-code', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    const { code } = req.query as { code?: string };
    const pending = typeof code === 'string' ? peekLinkCode(db, code) : null;
    if (!pending) return reply.code(400).send({ error: 'invalid_code' });
    return pending;
  });

  app.post('/api/discord/link-code', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    const { code } = (req.body ?? {}) as { code?: string };
    if (typeof code !== 'string') return reply.code(400).send({ error: 'invalid_code' });
    // Link first and spend the code only once that has worked, so a player
    // who hits "taken" or "already linked" can sort it out and retry with the
    // same link instead of asking the bot for another. Nothing between the
    // read and the spend awaits, so the two cannot be interleaved.
    const spent = peekLinkCode(db, code);
    if (!spent) return reply.code(400).send({ error: 'invalid_code' });
    const linked = linkDiscord(db, steamid, spent.discordId, spent.discordName, { adminSteamIds: config.adminSteamIds });
    if (!linked.ok) return reply.code(409).send({ error: linked.error });
    consumeLinkCode(db, code);
    announceLink(steamid, spent.discordName, linked);
    const active = await applyGate(db, api!, steamid);
    return { ok: true, active, discordName: spent.discordName };
  });

  app.post('/api/discord/unlink', async (req, reply) => {
    const steamid = guard(req, reply);
    if (!steamid) return reply;
    const block = unlinkBlock(steamid);
    if (block) return reply.code(409).send({ error: block });
    unlinkDiscord(db, steamid);
    return { ok: true };
  });
}
