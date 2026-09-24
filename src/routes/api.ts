import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireActive, makeRequireAdmin } from './guards.js';
import { publicBans } from '../admin/players.js';
import { fileReport, matchReportTargets } from '../tickets/filing.js';
import { streamsView } from '../streamsView.js';

export interface ApiRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
  adminSteamIds: string[];
  broadcast: (event: string) => void;
}

export async function apiRoutes(app: FastifyInstance, opts: ApiRouteOpts): Promise<void> {
  const { db, matchmaker, adminSteamIds, broadcast } = opts;
  const requireActive = makeRequireActive(db);

  /** Who is streaming, in three tiers. Public: a page anyone can open is the
   *  point, and no session changes what it shows. Serialises the Twitch login
   *  and never the Twitch id, because the login is the only Twitch identifier
   *  that is already public. */
  app.get('/api/streams', async (req) => {
    const { all } = req.query as { all?: string };
    return streamsView(db, { engaged: matchmaker.engagedIds(), all: all === '1' });
  });

  app.post('/api/queue/join', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const result = matchmaker.join(steamid);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return { ok: true };
  });

  app.post('/api/queue/leave', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    matchmaker.leave(steamid);
    return { ok: true };
  });

  /** Dismiss the "your ready check failed" notice on the Play page. */
  app.post('/api/lobby/dismiss-notice', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    matchmaker.dismissNotice(steamid);
    return { ok: true };
  });

  app.post('/api/lobby/ready', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const result = matchmaker.ready(steamid);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return { ok: true };
  });

  app.post('/api/lobby/vote', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const { campaign } = (req.body ?? {}) as { campaign?: string };
    if (!campaign || !matchmaker.vote(steamid, campaign)) {
      return reply.code(409).send({ error: 'invalid vote' });
    }
    return { ok: true };
  });

  app.get('/api/state', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    return matchmaker.stateFor(steamid);
  });

  app.get('/api/matches/:id/report-eligibility', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const e = matchReportTargets(db, Number((req.params as { id: string }).id), steamid);
    return e.canReport ? e : { canReport: false, reason: e.reason };
  });

  app.post('/api/matches/:id/reports', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = fileReport(db, steamid, { ...body, matchId: Number((req.params as { id: string }).id) }, { adminSteamIds });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    broadcast('refresh');
    return { ok: true };
  });

  // Public on purpose: the point is that people can watch the queue fill
  // without signing in. Carries nothing viewer-relative and no connect block.
  app.get('/api/queue', async () => matchmaker.publicQueue());

  /** The ban list. Admins only for now (owner's ruling, 2026-09-20): it was
   *  built to be public and publicBans still returns nothing an ordinary
   *  player should not see, so opening it up again is this one guard. */
  app.get('/api/bans', async (req, reply) => {
    const adminId = makeRequireAdmin(db)(req, reply);
    if (!adminId) return reply;
    const { q } = req.query as { q?: string };
    return { bans: publicBans(db, adminId, typeof q === 'string' ? q.slice(0, 64) : '') };
  });
}
