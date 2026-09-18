import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireAdmin } from './guards.js';
import type { ServerReleaser } from '../serverRelease.js';
import { getServer, setEnabled } from '../serverPool.js';
import { abortMatch, adminOverview, voidMatch } from '../admin/matches.js';
import { SETTINGS_SCHEMA, settingDef, validateSetting } from '../settingsSchema.js';
import { getSetting, setSetting } from '../settings.js';
import { logAdmin, recentActions } from '../admin/audit.js';
import {
  activeBan, addNote, banPlayer, playerDetail, searchPlayers, unbanPlayer,
} from '../admin/players.js';
import { activatePlayer, getPlayer, unlinkDiscord } from '../players.js';
import { campaignRegistry } from '../campaignRegistry.js';
import { clearPenalties } from '../penalties.js';
import { listReports, resolveReport } from '../reports.js';
import { listSeasons, renameSeason, startNewSeason } from '../seasons.js';
import { integrityBoard, integrityPlayer } from '../admin/integrity.js';
import { setReview } from '../integrity/store.js';
import { matchInFlight, pendingRoundCount, type IntegrityJobs, type JobMode } from '../integrity/job.js';

export interface AdminRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
  releaser: ServerReleaser;
  broadcast: (event: string) => void;
  /** Absent on an install with no replay directory, where there is nothing to
   *  analyse and the panel says so rather than offering a button that cannot
   *  work. */
  integrityJobs?: IntegrityJobs;
}

/** Everything under /api/admin. Each route starts with requireAdmin and each
 *  mutation ends with logAdmin. */
export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOpts): Promise<void> {
  const { db, matchmaker, releaser, broadcast, integrityJobs } = opts;
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

  app.post('/api/admin/players/:steamid/clear-penalties', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const n = clearPenalties(db, t.steamid, t.adminId);
    logAdmin(db, t.adminId, 'clear_penalties', t.steamid, { cleared: n });
    return { ok: true, cleared: n };
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

  /** Take a server in or out of the matchmaker's pool.
   *
   *  Separate from /idle, which changes where a box is in a match's lifecycle.
   *  This changes whether it is eligible at all, and deliberately leaves a
   *  running match alone: disabling mid-match lets that match finish. */
  app.post('/api/admin/servers/:id/enabled', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!getServer(db, id)) return reply.code(404).send({ error: 'no such server' });
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    setEnabled(db, id, enabled);
    logAdmin(db, adminId, enabled ? 'server_enable' : 'server_disable', id);
    broadcast('refresh');
    return { ok: true };
  });

  app.post('/api/admin/servers/:id/sourcetv', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!getServer(db, id)) return reply.code(404).send({ error: 'no such server' });
    const { enabled, port, password } = (req.body ?? {}) as { enabled?: unknown; port?: unknown; password?: unknown };
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    let tvPort: number | null = null;
    if (port !== undefined && port !== null && port !== '') {
      tvPort = Number(port);
      if (!Number.isInteger(tvPort) || tvPort < 1024 || tvPort > 65535) {
        return reply.code(400).send({ error: 'port must be between 1024 and 65535' });
      }
    }
    if (enabled && tvPort === null) return reply.code(400).send({ error: 'a port is needed to enable SourceTV' });
    const pw = typeof password === 'string' ? password.trim().slice(0, 64) : '';
    db.prepare('UPDATE servers SET tv_enabled = ?, tv_port = ?, tv_password = ? WHERE id = ?')
      .run(enabled ? 1 : 0, tvPort, pw, id);
    logAdmin(db, adminId, 'server_sourcetv', id, { enabled, port: tvPort });
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
      campaigns: [...campaignRegistry(db).values()]
        .map((c) => ({ slug: c.slug, name: c.name, custom: c.custom })),
    };
  });

  app.put('/api/admin/settings/:key', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { key } = req.params as { key: string };
    const def = settingDef(key);
    if (!def) return reply.code(404).send({ error: 'unknown setting' });
    const v = validateSetting(key, (req.body as { value?: unknown } | undefined)?.value, {
      campaignSlugs: new Set(campaignRegistry(db).keys()),
    });
    if (!v.ok) return reply.code(400).send({ error: `${def.label} ${v.error}` });
    const from = getSetting(db, key) ?? '';
    setSetting(db, key, v.value);
    logAdmin(db, adminId, 'setting', key, def.secret ? { changed: true } : { from, to: v.value });
    return { ok: true, value: v.value };
  });

  app.get('/api/admin/reports', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const status = String((req.query as { status?: string }).status ?? 'open');
    if (!['open', 'resolved', 'dismissed', 'all'].includes(status)) return reply.code(400).send({ error: 'bad status' });
    return { reports: listReports(db, status) };
  });

  app.post('/api/admin/reports/:id/resolve', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const { status, note } = (req.body ?? {}) as { status?: unknown; note?: unknown };
    if (status !== 'resolved' && status !== 'dismissed') return reply.code(400).send({ error: 'status must be resolved or dismissed' });
    const text = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
    if (!resolveReport(db, id, adminId, status, text)) return reply.code(404).send({ error: 'no such report' });
    logAdmin(db, adminId, 'resolve_report', id, { status, note: text });
    return { ok: true };
  });

  const REVIEW_STATES = new Set(['new', 'reviewed', 'dismissed']);

  app.get('/api/admin/integrity', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const raw = (req.query as { season?: string }).season;
    const seasonId = raw === undefined || raw === '' ? null : Number(raw);
    if (seasonId !== null && !Number.isInteger(seasonId)) return reply.code(400).send({ error: 'bad season' });
    return { players: integrityBoard(db, seasonId) };
  });

  /**
   * The analysis job: its state, and starting one.
   *
   * GET is safe to poll; the panel does while a run is going. `pending` is the
   * count of indexed rounds nothing has measured, which is what tells an admin
   * whether pressing the button would do anything.
   */
  app.get('/api/admin/integrity/backfill', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!integrityJobs) return { available: false as const };
    return {
      available: true as const,
      job: integrityJobs.snapshot(),
      pending: pendingRoundCount(db),
      matchInFlight: matchInFlight(db),
    };
  });

  app.post('/api/admin/integrity/backfill', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!integrityJobs) return reply.code(409).send({ error: 'no replay directory is configured' });
    const body = (req.body ?? {}) as { mode?: string; force?: boolean };
    const mode: JobMode = body.mode === 'pending' ? 'pending' : 'full';
    const started = integrityJobs.start(mode, { force: body.force === true });
    if (!started.ok) return reply.code(409).send({ error: started.reason });
    // Logged with the force flag: overriding the in-flight guard is exactly
    // the decision someone will later want to know was made deliberately.
    logAdmin(db, adminId, 'integrity_backfill', mode, { force: body.force === true });
    return { job: integrityJobs.snapshot() };
  });

  app.get('/api/admin/integrity/:steamid', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { steamid } = req.params as { steamid: string };
    return integrityPlayer(db, steamid);
  });

  app.post('/api/admin/integrity/:matchId/:ordinal/:half/:slot/review', async (req, reply) => {
    // requireAdmin RETURNS the acting admin steamid (src/routes/guards.ts:47), or
    // null having already sent the 401/403. That id is what the audit log needs.
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const p = req.params as { matchId: string; ordinal: string; half: string; slot: string };
    const body = (req.body ?? {}) as { state?: string; note?: string };
    const state = String(body.state ?? '');
    if (!REVIEW_STATES.has(state)) return reply.code(400).send({ error: 'unknown review state' });
    const key = { matchId: Number(p.matchId), ordinal: Number(p.ordinal), half: Number(p.half) };
    const slot = Number(p.slot);
    if (![key.matchId, key.ordinal, key.half, slot].every(Number.isInteger)) {
      return reply.code(400).send({ error: 'bad round' });
    }
    const note = String(body.note ?? '').slice(0, 500);
    setReview(db, key, slot, state, note, adminId);
    logAdmin(db, adminId, 'integrity_review', `${key.matchId}/${key.ordinal}/${key.half}/${slot}`, { state, note });
    return { ok: true };
  });

  const seasonName = (raw: unknown): string | null =>
    typeof raw === 'string' && raw.trim() && raw.trim().length <= 60 ? raw.trim() : null;

  app.get('/api/admin/seasons', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { seasons: listSeasons(db) };
  });

  app.post('/api/admin/seasons/:id/rename', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const name = seasonName((req.body as { name?: unknown } | undefined)?.name);
    if (!name) return reply.code(400).send({ error: 'a season name of up to 60 characters is required' });
    if (!renameSeason(db, id, name)) return reply.code(404).send({ error: 'no such season' });
    logAdmin(db, adminId, 'rename_season', id, { name });
    broadcast('refresh');
    return { ok: true };
  });

  app.post('/api/admin/seasons/new', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const name = seasonName((req.body as { name?: unknown } | undefined)?.name);
    if (!name) return reply.code(400).send({ error: 'a season name of up to 60 characters is required' });
    const r = startNewSeason(db, name);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    logAdmin(db, adminId, 'new_season', r.id, { name });
    broadcast('refresh');
    return { ok: true, id: r.id };
  });

  app.get('/api/admin/audit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { actions: recentActions(db) };
  });
}
