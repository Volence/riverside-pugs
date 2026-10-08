import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { casterAvatars } from '../cast/casterAvatars.js';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { CommunityStore } from '../community/store.js';
import { logAdmin } from '../admin/audit.js';
import { getPlayer } from '../players.js';
import { makeRequireAdmin, makeRequireCaster } from './guards.js';
import { overlayKey, readOverlayKey } from '../cast/key.js';
import { bumpKeyGen, getStudio, saveStudio, cleanState } from '../cast/studio.js';
import {
  canCastBooking, canCastMatch, mayCast, pickableBookings, pickableMatches, resolveOnAir,
} from '../cast/access.js';
import { buildMatchView } from '../cast/matchView.js';
import { LiveRoundReader } from '../cast/liveRound.js';
import { applyLiveHud, liveHudStore, type LiveHudStore } from '../cast/liveHud.js';
import { prepSheet } from '../cast/prep.js';
import { obsCollection, obsSceneName } from '../cast/obsCollection.js';
import { SCENES, LAYERS, type OverlayFeed } from '../cast/types.js';

/**
 * The caster studio (docs/superpowers/plans/2026-10-02-caster-studio.md).
 *
 * /api/cast/studio*: the producer panel, behind the same gate as /cast.
 * /api/overlay/*: what OBS browser sources read, with an overlay key in the
 * query instead of a session (ruling 1). Every overlay read asks again
 * whether the key's owner may still cast and may still see the match on air.
 */

/** Overlays poll once a second each; a caster with a dozen sources and no
 *  SharedWorker would otherwise build the same feed a dozen times. */
const FEED_CACHE_MS = 900;

export async function castStudioRoutes(
  app: FastifyInstance,
  opts: {
    db: DB; config: Pick<Config, 'cookieSecret' | 'publicUrl' | 'replayDir' | 'replayLiveDir'>; store: () => CommunityStore;
    /** The LIVEHUD lines; the process-wide store unless a test passes one. */
    hud?: LiveHudStore;
  },
): Promise<void> {
  const { db, config } = opts;
  const requireCaster = makeRequireCaster(db);
  const requireAdmin = makeRequireAdmin(db);
  const reader = new LiveRoundReader(config.replayDir, config.replayLiveDir ?? '');
  const cache = new Map<string, { at: number; rev: number; feed: OverlayFeed }>();
  const hud = opts.hud ?? liveHudStore;

  const tokenOf = (id: number): string | null =>
    (db.prepare('SELECT token FROM matches WHERE id = ?').get(id) as { token: string | null } | undefined)?.token ?? null;

  const keyFor = (steamid: string): string => overlayKey(config.cookieSecret, steamid, getStudio(db, steamid).keyGen);

  function feedFor(steamid: string, nowMs = Date.now()): OverlayFeed {
    const studio = getStudio(db, steamid);
    const hit = cache.get(steamid);
    if (hit && hit.rev === studio.rev && nowMs - hit.at < FEED_CACHE_MS) return { ...hit.feed, serverNow: nowMs };
    const onAir = resolveOnAir(db, steamid, studio.state);
    const match = onAir.matchId !== null ? buildMatchView(db, onAir.matchId, studio.state, onAir.game) : null;
    const round = match && match.state === 'live' ? reader.read(db, match.id, nowMs) : null;
    const token = match ? tokenOf(match.id) ?? '' : '';
    const live = round ? applyLiveHud(round, hud.get(token, nowMs), round.half === 2 ? hud.reach(token, round.ordinal, 1) : null) : null;
    // The recaps hang off the match, not the live round: a wipe ends the
    // round its tank card belongs to.
    const liveMatch = match && match.state === 'live' ? match : null;
    const names = new Map(liveMatch ? [...liveMatch.teams.a.players, ...liveMatch.teams.b.players].map((p) => [p.steamid, p.name]) : []);
    const nameOf = (id: string | null): string | null => (id ? names.get(id) ?? null : null);
    const rows = (players: { steamid: string; dmg: number }[]) => {
      const total = players.reduce((n, p) => n + p.dmg, 0);
      return players
        .map((p) => ({ name: names.get(p.steamid) ?? p.steamid, dmg: p.dmg, share: total > 0 ? Math.round((p.dmg / total) * 100) : 0 }))
        .sort((x, y) => y.dmg - x.dmg);
    };
    const tank = liveMatch ? hud.tank(token, nowMs) : null;
    const witch = liveMatch ? hud.witch(token, nowMs) : null;
    const feed: OverlayFeed = {
      rev: studio.rev, serverNow: nowMs, studio: studio.state, match, live,
      tankRecap: tank ? {
        agoMs: tank.agoMs, aliveS: tank.recap.aliveS, dealt: tank.recap.dealt, tanks: tank.recap.tanks, passes: tank.recap.passes,
        end: tank.recap.end, controller: nameOf(tank.recap.controller), players: rows(tank.recap.players),
      } : null,
      casterAvatars: casterAvatars(db, studio.state.casters),
      draft: null,
      witchRecap: witch ? {
        agoMs: witch.agoMs, aliveS: witch.recap.aliveS, crown: witch.recap.crown, incaps: witch.recap.incaps,
        startled: nameOf(witch.recap.startled), killer: nameOf(witch.recap.killer), players: rows(witch.recap.players),
      } : null,
    };
    cache.set(steamid, { at: nowMs, rev: studio.rev, feed });
    return feed;
  }

  /** The panel's own view: state, key, and what may be put on air. */
  function panel(steamid: string) {
    const s = getStudio(db, steamid);
    return {
      studio: s.state, rev: s.rev, key: keyFor(steamid),
      matches: pickableMatches(db, steamid), bookings: pickableBookings(db, steamid),
      scenes: [...SCENES], layers: [...LAYERS],
      obsScenes: Object.fromEntries([...SCENES, 'program' as const].map((k) => [k, obsSceneName(k)])),
    };
  }

  app.get('/api/cast/studio', async (req, reply) => {
    const me = requireCaster(req, reply);
    if (!me) return reply;
    return panel(me);
  });

  app.put('/api/cast/studio', async (req, reply) => {
    const me = requireCaster(req, reply);
    if (!me) return reply;
    const next = cleanState(req.body);
    // Only what this caster may see can go on air: the same rule the feed
    // applies on every read, checked here too so the panel hears about it.
    if (next.matchId !== null && !canCastMatch(db, me, next.matchId)) return reply.code(403).send({ error: 'not_castable' });
    if (next.bookingId !== null && !canCastBooking(db, me, next.bookingId)) return reply.code(403).send({ error: 'not_castable' });
    // A save never touches the callout: it is fired and cleared only through
    // its own routes below. The panel debounces saves, so a save that left
    // before a fire can land after it, and must not clear or move it.
    next.callout = getStudio(db, me).state.callout;
    const saved = saveStudio(db, me, next);
    return { studio: saved.state, rev: saved.rev };
  });

  app.post('/api/cast/studio/callout', async (req, reply) => {
    const me = requireCaster(req, reply);
    if (!me) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cur = getStudio(db, me).state;
    const saved = saveStudio(db, me, { ...cur, callout: { ...body, at: new Date().toISOString() } });
    if (!saved.state.callout) return reply.code(400).send({ error: 'A callout needs a title.' });
    return { studio: saved.state, rev: saved.rev };
  });

  app.post('/api/cast/studio/callout/clear', async (req, reply) => {
    const me = requireCaster(req, reply);
    if (!me) return reply;
    const saved = saveStudio(db, me, { ...getStudio(db, me).state, callout: null });
    return { studio: saved.state, rev: saved.rev };
  });

  app.post('/api/cast/studio/key', async (req, reply) => {
    const me = requireCaster(req, reply);
    if (!me) return reply;
    bumpKeyGen(db, me);
    cache.delete(me);
    return { key: keyFor(me) };
  });

  app.get('/api/cast/studio/feed', async (req, reply) => {
    const me = requireCaster(req, reply);
    if (!me) return reply;
    return reply.header('Cache-Control', 'no-store').send(feedFor(me));
  });

  app.get('/api/cast/studio/prep/:matchId', async (req, reply) => {
    const me = requireCaster(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { matchId: string }).matchId);
    if (!Number.isInteger(id) || !canCastMatch(db, me, id)) return reply.code(404).send({ error: 'no such match' });
    return prepSheet(db, id);
  });

  app.get('/api/cast/studio/obs-collection', async (req, reply) => {
    const me = requireCaster(req, reply);
    if (!me) return reply;
    const key = keyFor(me);
    const base = originOf(req, config.publicUrl);
    const body = obsCollection({
      overlayUrl: (scene) => `${base}/overlay/${scene}?k=${encodeURIComponent(key)}`,
      casters: getStudio(db, me).state.casters,
    });
    return reply
      .header('Content-Disposition', 'attachment; filename="riverside-cast-obs.json"')
      .header('Cache-Control', 'no-store')
      .type('application/json').send(JSON.stringify(body, null, 2));
  });

  /** Staff: kill a caster's overlay URLs (ruling 1). Clearing the caster flag
   *  cuts them off too; this is for a leaked URL. */
  app.post('/api/admin/players/:steamid/cast-key/revoke', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return reply;
    const steamid = (req.params as { steamid: string }).steamid;
    if (!getPlayer(db, steamid)) return reply.code(404).send({ error: 'no such player' });
    const gen = bumpKeyGen(db, steamid);
    cache.delete(steamid);
    logAdmin(db, admin, 'revoke_cast_key', steamid, { generation: gen });
    return { ok: true };
  });

  /** The key's owner if it verifies, is the current generation and its owner
   *  may still cast; otherwise the refusal is sent and null returned. */
  function overlayOwner(req: FastifyRequest, reply: FastifyReply): string | null {
    const k = (req.query as { k?: unknown }).k;
    const read = readOverlayKey(config.cookieSecret, k);
    if (!read || read.gen !== getStudio(db, read.steamid).keyGen) {
      reply.code(401).send({ error: 'This overlay link is not valid. Copy a fresh one from the caster studio.' });
      return null;
    }
    if (!mayCast(db, read.steamid)) {
      reply.code(403).send({ error: 'This overlay link belongs to someone who is no longer a caster.' });
      return null;
    }
    return read.steamid;
  }

  app.get('/api/overlay/feed', async (req, reply) => {
    const owner = overlayOwner(req, reply);
    if (!owner) return reply;
    return reply.header('Cache-Control', 'no-store').send(feedFor(owner));
  });

  /** A team logo for the scorebug: the teams route needs a session, which
   *  OBS has not got. Only a logo of a team on the match on air is served. */
  app.get('/api/overlay/logo/:file', async (req, reply) => {
    const owner = overlayOwner(req, reply);
    if (!owner) return reply;
    const m = /^([0-9a-f]{64})\.png$/.exec((req.params as { file: string }).file);
    const feed = feedFor(owner);
    const onAir = [feed.match?.teams.a.logoUrl, feed.match?.teams.b.logoUrl];
    if (!m || !onAir.includes(`${m[1]}.png`)) return reply.code(404).send({ error: 'not found' });
    const bytes = opts.store().readLogo(m[1]!);
    if (!bytes) return reply.code(404).send({ error: 'not found' });
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=600')
      .type('image/png').send(bytes);
  });
}

/** Where overlay URLs point: the configured public URL, else the host the
 *  panel was opened on (a dev server or a LAN box). */
function originOf(req: FastifyRequest, publicUrl: string): string {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  if (typeof host === 'string' && host && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    return `${proto}://${host}`;
  }
  return publicUrl.replace(/\/+$/, '');
}
