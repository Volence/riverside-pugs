import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { verifyLogin as VerifyFn, fetchPersona as PersonaFn } from '../steamAuth.js';
import { loginUrl, steamReturnUrl } from '../steamAuth.js';
import { getSession, setSession } from '../session.js';
import { activatePlayer, getPlayer, upsertPlayer } from '../players.js';
import { getSetting } from '../settings.js';
import type { DiscordApi } from '../discord/api.js';
import { applyGate } from '../discord/gate.js';
import type { GuildMembership } from '../discord/membership.js';
import { publishAdminEvent } from '../adminFeed.js';
import { activeBan } from '../admin/players.js';
import { resolveAlias } from '../aliases.js';
import { MERGED_MESSAGE } from '../standing.js';

const NEXT_COOKIE = 'pug_next';

/** A whole page, because this is the end of a full-page redirect from Steam
 *  and there is no app on screen to show a message in. Static text only. */
const MERGED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Riverside PUG</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem;">
<h1>This account cannot sign in</h1>
<p>${MERGED_MESSAGE}</p>
<p><a href="/">Back to the site</a></p>
</body></html>`;

/** Only same-site paths, so the return-to can never become an open redirect.
 *  Said as what IS allowed rather than as a list of tricks: "/" alone, or a
 *  slash followed by an ordinary path character. That refuses the
 *  protocol-relative `//x` by construction. Backslashes and control
 *  characters are refused anywhere, because a browser rewrites both before
 *  it resolves the URL: `/\x` becomes `//x`, and tab, CR and LF are deleted,
 *  so `/<tab>/x` becomes `//x` as well. */
function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  if (/[\x00-\x1f\\]/.test(raw)) return null;
  return raw === '/' || /^\/[A-Za-z0-9_-]/.test(raw) ? raw : null;
}

export interface AuthRouteOpts {
  config: Config;
  db: DB;
  verifyLogin: typeof VerifyFn;
  fetchPersona: typeof PersonaFn;
  discordApi: DiscordApi | null;
  membership?: GuildMembership;
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
    const steamid = await opts.verifyLogin(req.query as Record<string, string>, steamReturnUrl(config.publicUrl));
    if (!steamid) return reply.code(403).send('Steam login failed');
    // A SteamID that was merged into another account is not an identity any
    // more. Letting it in made a fresh `invited` row, and the alt was a
    // separate player again. Refused outright rather than signed in as the
    // main: the alias says the two are one person, but proving you hold the
    // alt must never be enough to become the main.
    if (resolveAlias(db, steamid) !== steamid) {
      return reply.code(403).type('text/html; charset=utf-8').send(MERGED_PAGE);
    }
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
    let player = getPlayer(db, steamid);
    if (!player) return reply.code(401).send({ error: 'unknown player' });
    // Self-heal: linked and in the server but still invited (the join event
    // was missed while the site restarted). Only when no role is required,
    // since roles are not in the member list.
    if (player.status === 'invited' && player.discord_id && opts.membership?.isMember(player.discord_id)
      && !(getSetting(db, 'discord_required_role_id') ?? '')) {
      activatePlayer(db, steamid);
      publishAdminEvent({ kind: 'account', steamid, what: 'activated' });
      player = getPlayer(db, steamid)!;
    }
    return {
      steamid: player.steamid,
      name: player.name,
      avatar: player.avatar,
      status: player.status,
      isAdmin: player.is_admin === 1,
      discordEnabled: config.discord !== null,
      discord: player.discord_id ? { id: player.discord_id, name: player.discord_name ?? '' } : null,
      // Only your own session ever sees your twitch id. Everywhere public it
      // is the login and nothing else; here it is harmless and lets the edit
      // panel tell "linked" from "not linked" without a second request.
      twitchEnabled: config.twitch !== null,
      twitch: player.twitch_id ? { id: player.twitch_id, name: player.twitch_name ?? '' } : null,
      ban: player.status === 'banned' ? (() => {
        const b = activeBan(db, steamid);
        return b ? { reason: b.reason, expiresAt: b.expiresAt } : null;
      })() : null,
      // null: not linked, or the member list is not loaded yet.
      discordMember: player.discord_id ? opts.membership?.isMember(player.discord_id) ?? null : null,
    };
  });

  /** Public site facts the signup checklist and How to play need. */
  app.get('/api/site', async () => ({
    discordEnabled: config.discord !== null,
    discordInviteUrl: getSetting(db, 'discord_invite_url') || null,
    requireDiscord: config.discord !== null && getSetting(db, 'require_discord_to_queue') === '1',
  }));

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
