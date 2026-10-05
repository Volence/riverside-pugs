import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { ModerationOps } from '../discord/transport.js';
import { getSession } from '../session.js';
import { appellantFromDiscord, appellantFromSteam } from '../appeals/rules.js';
import { answerQuestion, fileAppeal } from '../appeals/store.js';
import { playerView } from '../appeals/views.js';
import { clearAppealSession, readAppealSession } from '../appeals/appealSession.js';
import type { AppealRef, AppealSource, Appellant } from '../appeals/types.js';
import { makeRequireAdmin, makeRequireMod } from './guards.js';
import { fileViewer } from '../admin/fileAccess.js';
import { logAdmin } from '../admin/audit.js';
import { publishAdminEvent } from '../adminFeed.js';
import { askQuestion, getAppeal, mootAppeal, recordDecision, targetInForce } from '../appeals/store.js';
import { appealIsQuiet, canSeeAppeal, decideCheck } from '../appeals/access.js';
import { decideBanAppeal } from '../appeals/decide.js';
import { staffAppeal, staffAppeals } from '../appeals/views.js';
import { publishAppealSignal } from '../appeals/signals.js';
import { recordLift } from '../tickets/discordSanctions.js';

export interface AppealRouteOpts {
  db: DB;
  moderation: () => ModerationOps | null;
}

export async function appealRoutes(app: FastifyInstance, opts: AppealRouteOpts): Promise<void> {
  const { db } = opts;

  /** A Steam session first (banned players keep theirs), else the appeal
   *  cookie from /appeal's Discord sign-in. Never anything in the body. */
  const appellantOf = (req: FastifyRequest): { who: Appellant; source: AppealSource } | null => {
    const steamid = getSession(req, db);
    if (steamid) return { who: appellantFromSteam(db, steamid), source: 'site' };
    const d = readAppealSession(req);
    return d ? { who: appellantFromDiscord(db, d.discordId, d.name), source: 'appeal_page' } : null;
  };

  const refFrom = (body: unknown): AppealRef | null => {
    const b = (body ?? {}) as { kind?: unknown; id?: unknown };
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return b.kind === 'ban' || b.kind === 'sanction' ? { kind: b.kind, id } : null;
  };

  app.get('/api/appeals/mine', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    return { ...playerView(db, a.who), signedInAs: a.source === 'site' ? 'steam' : 'discord' };
  });

  app.post('/api/appeals', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    const ref = refFrom(req.body);
    if (!ref) return reply.code(400).send({ error: 'Pick what you are appealing.' });
    const b = (req.body ?? {}) as { whatHappened?: unknown; whyLift?: unknown };
    const r = fileAppeal(db, a.who, { ref, whatHappened: b.whatHappened, whyLift: b.whyLift, source: a.source });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });

  app.post('/api/appeals/:id/answer', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    const r = answerQuestion(db, a.who, Number((req.params as { id: string }).id), ((req.body ?? {}) as { answer?: unknown }).answer);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });

  app.post('/api/appeals/sign-out', async (_req, reply) => {
    clearAppealSession(reply);
    return { ok: true };
  });

  const requireMod = makeRequireMod(db);
  const requireAdmin = makeRequireAdmin(db);
  const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id);
  const audit = (me: string, action: string, row: NonNullable<ReturnType<typeof getAppeal>>, detail: object = {}) =>
    logAdmin(db, me, action, row.steamid ?? row.discord_id ?? '', { appealId: row.id, ...detail }, { quiet: appealIsQuiet(db, row) });

  app.get('/api/mod/appeals', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const which = (req.query as { state?: string }).state === 'closed' ? 'closed' : 'open';
    return { appeals: staffAppeals(db, fileViewer(db, me), which) };
  });

  app.get('/api/mod/appeals/:id', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const d = staffAppeal(db, fileViewer(db, me), idOf(req));
    return d ?? reply.code(404).send({ error: 'no such appeal' });
  });

  app.post('/api/mod/appeals/:id/ask', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const row = getAppeal(db, idOf(req));
    const c = row ? decideCheck(db, fileViewer(db, me), row) : { ok: false as const, status: 404, error: 'no such appeal' };
    if (!c.ok) return reply.code(c.status).send({ error: c.error });
    const r = askQuestion(db, row!.id, me, ((req.body ?? {}) as { question?: unknown }).question);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    audit(me, 'appeal_ask', row!);
    return r;
  });

  app.post('/api/mod/appeals/:id/decide', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const row = getAppeal(db, idOf(req));
    const c = row ? decideCheck(db, fileViewer(db, me), row) : { ok: false as const, status: 404, error: 'no such appeal' };
    if (!c.ok) return reply.code(c.status).send({ error: c.error });
    const { outcome, endsAt } = (req.body ?? {}) as { outcome?: unknown; endsAt?: unknown };
    if (outcome !== 'accept' && outcome !== 'shorten' && outcome !== 'deny') return reply.code(400).send({ error: 'outcome is accept, shorten or deny' });
    const a = row!;

    if (a.ban_id !== null) {
      const r = decideBanAppeal(db, a, me, outcome, endsAt);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      audit(me, `appeal_${outcome}`, a, outcome === 'shorten' ? { endsAt } : {});
      return r;
    }

    // A Discord sanction: lifted or kept, never shortened here.
    if (outcome === 'shorten') return reply.code(400).send({ error: 'A Discord timeout or ban is lifted or kept; it cannot be shortened here.' });
    if (!targetInForce(db, a)) {
      mootAppeal(db, a.id);
      return reply.code(409).send({ error: 'The sanction is no longer in force, so the appeal has been closed.' });
    }
    if (outcome === 'deny') {
      if (!recordDecision(db, a.id, me, 'denied', null)) return reply.code(409).send({ error: 'this appeal has already been decided' });
      audit(me, 'appeal_deny', a);
      return { ok: true };
    }
    const s = db.prepare('SELECT id, discord_id, kind, ticket_id FROM discord_sanctions WHERE id = ?').get(a.sanction_id) as
      { id: number; discord_id: string; kind: 'timeout' | 'ban'; ticket_id: number | null };
    const mod = opts.moderation();
    if (!mod) return reply.code(503).send({ error: 'the Discord bot is not running' });
    // Discord first, as the tickets lift route does. A timed-out member who
    // has since left cannot have the timeout removed; it ends on its own, so
    // the appeal is still accepted and the row marked lifted.
    const result = s.kind === 'timeout'
      ? await mod.removeTimeout(s.discord_id, 'appeal accepted')
      : await mod.unban(s.discord_id, 'appeal accepted');
    if (!result.ok && !(s.kind === 'timeout' && result.why === 'not_member')) {
      return reply.code(409).send({ error: `Discord refused: ${result.detail}` });
    }
    if (!recordDecision(db, a.id, me, 'accepted', null)) return reply.code(409).send({ error: 'this appeal has already been decided' });
    try {
      recordLift(db, { sanctionId: s.id, discordId: s.discord_id, kind: s.kind, ticketId: s.ticket_id, restricted: false }, me);
    } catch (err) {
      publishAdminEvent({ kind: 'problem', text: `Appeal #${a.id}: Discord lifted the ${s.kind}, but recording the lift failed: ${String(err)}` });
    }
    audit(me, 'appeal_accept', a);
    return { ok: true };
  });

  /** Admin only: this ban or sanction may not be appealed again. */
  app.post('/api/admin/appeals/:id/final', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return reply;
    const row = getAppeal(db, idOf(req));
    if (!row || !canSeeAppeal(db, fileViewer(db, me), row)) return reply.code(404).send({ error: 'no such appeal' });
    const on = ((req.body ?? {}) as { on?: unknown }).on === true ? 1 : 0;
    if (row.ban_id !== null) db.prepare('UPDATE bans SET no_appeal = ? WHERE id = ?').run(on, row.ban_id);
    else db.prepare('UPDATE discord_sanctions SET no_appeal = ? WHERE id = ?').run(on, row.sanction_id);
    audit(me, on ? 'appeal_final' : 'appeal_unfinal', row);
    publishAppealSignal(row.id);
    return { ok: true };
  });
}
