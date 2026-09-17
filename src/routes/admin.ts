import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireAdmin } from './guards.js';
import type { ServerReleaser } from '../serverRelease.js';
import { getServer } from '../serverPool.js';
import { abortMatch, adminOverview, voidMatch } from '../admin/matches.js';
import { SETTINGS_SCHEMA, settingDef, validateSetting } from '../settingsSchema.js';
import { getSetting, setSetting } from '../settings.js';
import { logAdmin, recentActions } from '../admin/audit.js';
import {
  activeBan, addNote, banPlayer, playerDetail, searchPlayers, unbanPlayer,
} from '../admin/players.js';
import { activatePlayer, getPlayer, unlinkDiscord } from '../players.js';
import { CAMPAIGNS } from '../campaigns.js';

export interface AdminRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
  releaser: ServerReleaser;
  broadcast: (event: string) => void;
}

/** Everything under /api/admin. Each route starts with requireAdmin and each
 *  mutation ends with logAdmin. */
export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOpts): Promise<void> {
  const { db, matchmaker, releaser, broadcast } = opts;
  const requireAdmin = makeRequireAdmin(db);

  app.get('/api/admin/players', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const q = String((req.query as { q?: string }).q ?? '').trim().slice(0, 100);
    return { players: searchPlayers(db, q) };
  });

  app.get('/api/admin/players/:steamid', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const detail = playerDetail(db, (req.params as { steamid: string }).steamid);
    if (!detail) return reply.code(404).send({ error: 'no such player' });
    return detail;
  });

  /** Shared preamble for per-player mutations: admin, then the target exists. */
  const target = (req: FastifyRequest, reply: FastifyReply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return null;
    const steamid = (req.params as { steamid: string }).steamid;
    if (!getPlayer(db, steamid)) {
      reply.code(404).send({ error: 'no such player' });
      return null;
    }
    return { adminId, steamid };
  };

  app.post('/api/admin/players/:steamid/ban', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { reason, minutes } = (req.body ?? {}) as { reason?: unknown; minutes?: unknown };
    if (t.steamid === t.adminId) return reply.code(400).send({ error: 'you cannot ban yourself' });
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
      return reply.code(400).send({ error: 'a reason is required (up to 500 characters)' });
    }
    let mins: number | null = null;
    if (minutes !== undefined && minutes !== null && minutes !== '') {
      mins = Number(minutes);
      if (!Number.isInteger(mins) || mins <= 0 || mins > 60 * 24 * 365) {
        return reply.code(400).send({ error: 'minutes must be a whole number between 1 and 525600' });
      }
    }
    banPlayer(db, t.steamid, t.adminId, reason.trim(), mins);
    matchmaker.leave(t.steamid);
    logAdmin(db, t.adminId, 'ban', t.steamid, { reason: reason.trim(), minutes: mins });
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/unban', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    unbanPlayer(db, t.steamid, t.adminId);
    logAdmin(db, t.adminId, 'unban', t.steamid);
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/activate', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    if (activeBan(db, t.steamid) || getPlayer(db, t.steamid)?.status === 'banned') {
      return reply.code(409).send({ error: 'player is banned; unban instead' });
    }
    activatePlayer(db, t.steamid);
    logAdmin(db, t.adminId, 'activate', t.steamid);
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/admin', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { isAdmin } = (req.body ?? {}) as { isAdmin?: unknown };
    if (typeof isAdmin !== 'boolean') return reply.code(400).send({ error: 'isAdmin must be true or false' });
    if (t.steamid === t.adminId && !isAdmin) return reply.code(400).send({ error: 'you cannot remove your own admin' });
    db.prepare('UPDATE players SET is_admin = ? WHERE steamid = ?').run(isAdmin ? 1 : 0, t.steamid);
    logAdmin(db, t.adminId, 'set_admin', t.steamid, { isAdmin });
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/unlink-discord', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const before = getPlayer(db, t.steamid)?.discord_name ?? null;
    unlinkDiscord(db, t.steamid);
    logAdmin(db, t.adminId, 'unlink_discord', t.steamid, { was: before });
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/notes', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
      return reply.code(400).send({ error: 'a note needs text (up to 2000 characters)' });
    }
    addNote(db, t.steamid, t.adminId, text.trim());
    logAdmin(db, t.adminId, 'note', t.steamid);
    return { ok: true };
  });

  app.get('/api/admin/overview', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { ...adminOverview(db), queue: matchmaker.publicQueue().players };
  });

  app.post('/api/admin/matches/:id/abort', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const r = abortMatch(db, releaser, id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'abort_match', id);
    broadcast('refresh');
    return { ok: true };
  });

  app.post('/api/admin/matches/:id/void', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const { reason } = (req.body ?? {}) as { reason?: unknown };
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
      return reply.code(400).send({ error: 'a reason is required (up to 500 characters)' });
    }
    const r = voidMatch(db, id, reason.trim());
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'void_match', id, { reason: reason.trim() });
    broadcast('refresh');
    return { ok: true };
  });

  app.post('/api/admin/servers/:id/idle', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!getServer(db, id)) return reply.code(404).send({ error: 'no such server' });
    releaser.release(id);
    logAdmin(db, adminId, 'server_idle', id);
    broadcast('refresh');
    return { ok: true };
  });

  app.post('/api/admin/queue/remove', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { steamid } = (req.body ?? {}) as { steamid?: unknown };
    if (typeof steamid !== 'string') return reply.code(400).send({ error: 'steamid required' });
    matchmaker.leave(steamid);
    logAdmin(db, adminId, 'queue_remove', steamid);
    return { ok: true };
  });

  app.get('/api/admin/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return {
      settings: SETTINGS_SCHEMA.map((d) => ({ ...d, value: getSetting(db, d.key) ?? '' })),
      campaigns: Object.entries(CAMPAIGNS).map(([slug, c]) => ({ slug, name: c.name })),
    };
  });

  app.put('/api/admin/settings/:key', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { key } = req.params as { key: string };
    const def = settingDef(key);
    if (!def) return reply.code(404).send({ error: 'unknown setting' });
    const v = validateSetting(key, (req.body as { value?: unknown } | undefined)?.value);
    if (!v.ok) return reply.code(400).send({ error: `${def.label} ${v.error}` });
    const from = getSetting(db, key) ?? '';
    setSetting(db, key, v.value);
    logAdmin(db, adminId, 'setting', key, def.secret ? { changed: true } : { from, to: v.value });
    return { ok: true, value: v.value };
  });

  app.get('/api/admin/audit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { actions: recentActions(db) };
  });
}
