import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireActive, makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { getTicketRow } from '../tickets/store.js';
import { fileReport, myReports, openStaffTicket } from '../tickets/filing.js';
import { addAccess, banFromTicket, claimTicket, closeTicket, reopenTicket, setRestricted, type ActionResult } from '../tickets/actions.js';
import { listTickets, ticketDetail, type TicketFilter } from '../tickets/views.js';
import { caseFile } from '../tickets/caseFile.js';

export interface TicketRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
  broadcast: (event: string) => void;
  adminSteamIds: string[];
}

/** Filing under /api/reports for any active player; everything under
 *  /api/mod for staff. Each mutation ends with logAdmin, quiet when the
 *  ticket is restricted. */
export async function ticketRoutes(app: FastifyInstance, opts: TicketRouteOpts): Promise<void> {
  const { db, matchmaker, broadcast, adminSteamIds } = opts;
  const requireActive = makeRequireActive(db);
  const requireMod = makeRequireMod(db);
  const filing = { adminSteamIds };

  app.post('/api/reports', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    const r = fileReport(db, steamid, (req.body ?? {}) as object, filing);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    broadcast('refresh');
    // Deliberately nothing about the ticket: a reporter must not learn
    // whether others have reported the same player.
    return { ok: true };
  });

  app.get('/api/reports/mine', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    return { reports: myReports(db, steamid) };
  });

  app.get('/api/mod/tickets', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const filter = String((req.query as { filter?: string }).filter ?? 'open');
    if (!['open', 'mine', 'closed'].includes(filter)) return reply.code(400).send({ error: 'bad filter' });
    return { tickets: listTickets(db, me, filter as TicketFilter) };
  });

  app.post('/api/mod/tickets', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const r = openStaffTicket(db, me, (req.body ?? {}) as object, filing);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, 'ticket_open', r.ticketId, {}, { quiet: getTicketRow(db, r.ticketId)?.restricted === 1 });
    broadcast('refresh');
    return { ok: true, ticketId: r.ticketId };
  });

  app.get('/api/mod/tickets/:id', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const d = ticketDetail(db, Number((req.params as { id: string }).id), me);
    if (!d) return reply.code(404).send({ error: 'no such ticket' });
    return { ...d, caseFile: caseFile(db, d.ticket.targetId, me) };
  });

  /** Shared tail of every mutation: run it, answer, audit, nudge open pages. */
  const act = (
    action: string,
    run: (id: number, me: string, body: Record<string, unknown>) => ActionResult,
    detail: (body: Record<string, unknown>) => object = () => ({}),
  ) => async (req: FastifyRequest, reply: FastifyReply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = run(id, me, body);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, action, id, detail(body), { quiet: getTicketRow(db, id)?.restricted === 1 });
    broadcast('refresh');
    return { ok: true };
  };

  app.post('/api/mod/tickets/:id/claim', act('ticket_claim', (id, me, b) => claimTicket(db, id, me, b.claim !== false), (b) => ({ claim: b.claim !== false })));
  app.post('/api/mod/tickets/:id/restrict', act('ticket_restrict', (id, me, b) => setRestricted(db, id, me, b.restricted === true, adminSteamIds), (b) => ({ restricted: b.restricted === true })));
  app.post('/api/mod/tickets/:id/access', act('ticket_access', (id, me, b) => addAccess(db, id, me, String(b.steamid ?? '')), (b) => ({ steamid: String(b.steamid ?? '') })));
  app.post('/api/mod/tickets/:id/close', act('ticket_close', (id, me, b) => closeTicket(db, id, me, b.outcome, b.note), (b) => ({ outcome: b.outcome })));
  app.post('/api/mod/tickets/:id/reopen', act('ticket_reopen', (id, me) => reopenTicket(db, id, me)));
  app.post('/api/mod/tickets/:id/ban', act('ticket_ban', (id, me, b) => {
    const r = banFromTicket(db, id, me, b.reason, b.minutes);
    // Out of the queue at once, as the Players tab ban does.
    if (r.ok) matchmaker.leave(getTicketRow(db, id)!.target_id);
    return r;
  }, (b) => ({ reason: b.reason, minutes: b.minutes ?? null })));
}
