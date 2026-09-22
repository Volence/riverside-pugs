import { createReadStream, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireActive, makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { allowedType, attachmentPath } from '../tickets/attachments.js';
import type { AttachmentRow } from '../tickets/messages.js';
import { canSeeTicket, getTicketRow } from '../tickets/store.js';
import { fileReport, myReports, openStaffTicket } from '../tickets/filing.js';
import { addAccess, banFromTicket, claimTicket, closeTicket, reopenTicket, setRestricted, type ActionResult } from '../tickets/actions.js';
import { listTickets, ticketCounts, ticketDetail, type TicketFilter } from '../tickets/views.js';
import { caseFile } from '../tickets/caseFile.js';
import { fileViewer } from '../admin/fileAccess.js';
import { playerFileSummary } from '../admin/playerFileSummary.js';

export interface TicketRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
  broadcast: (event: string) => void;
  adminSteamIds: string[];
  /** The Discord server, for links to threads. Null when Discord is not configured. */
  guildId: string | null;
  /** config.ticketAttachmentsDir. */
  attachmentsDir: string;
}

/** Filing under /api/reports for any active player; everything under
 *  /api/mod for staff. Each mutation ends with logAdmin, quiet when the
 *  ticket is restricted. */
export async function ticketRoutes(app: FastifyInstance, opts: TicketRouteOpts): Promise<void> {
  const { db, matchmaker, broadcast, adminSteamIds, guildId, attachmentsDir } = opts;
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
    return { tickets: listTickets(db, me, filter as TicketFilter), counts: ticketCounts(db, me) };
  });

  app.post('/api/mod/tickets', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const r = openStaffTicket(db, me, (req.body ?? {}) as object, filing);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    // auditId goes in the log and nowhere else: ticketId is null when the
    // opener is off a restricted ticket's access list, and telling them the
    // id would be telling them the ticket exists.
    logAdmin(db, me, 'ticket_open', r.auditId, {}, { quiet: getTicketRow(db, r.auditId)?.restricted === 1 });
    broadcast('refresh');
    return { ok: true, ticketId: r.ticketId };
  });

  app.get('/api/mod/tickets/:id', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const d = ticketDetail(db, Number((req.params as { id: string }).id), me, { guildId });
    if (!d) return reply.code(404).send({ error: 'no such ticket' });
    // One builder for the accused's record, shared with the Player File, so
    // a new evidence source appears in both places the day it lands.
    // caseFile stays alongside for good: a moderator added to a restricted
    // ticket about a colleague gets summary.fileUrl null, so caseFile is the
    // only detailed record that viewer can see at all.
    return {
      ...d,
      caseFile: caseFile(db, d.ticket.targetId, me),
      summary: playerFileSummary(db, d.ticket.targetId, fileViewer(db, me)),
    };
  });

  /**
   * The only way a stored file leaves the box.
   *
   * After requireMod, every refusal is the same 404 with the same body: no
   * such ticket, a ticket this viewer may not see, a file that belongs to a
   * different ticket, one that was never stored, one that was removed. The
   * route cannot be used to ask whether any of those exist.
   *
   * The headers assume the file is hostile, because a stranger chose it. The
   * content type is OURS for the extension, never what Discord or the
   * uploader claimed; nosniff stops a browser second-guessing it; the
   * sandboxing policy means that even opened in a tab of its own it runs
   * nothing and loads nothing. Only images and video may show in place.
   */
  app.get('/api/mod/tickets/:id/attachments/:aid', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { id, aid } = req.params as { id: string; aid: string };
    const gone = () => reply.code(404).send({ error: 'no such file' });
    const t = getTicketRow(db, Number(id));
    if (!t || !canSeeTicket(db, t, me)) return gone();
    const a = db.prepare(
      `SELECT a.* FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id
       WHERE a.id = ? AND m.ticket_id = ? AND m.removed_at IS NULL`,
    ).get(Number(aid), t.id) as AttachmentRow | undefined;
    if (!a || a.removed_at !== null || a.stored_name === null) return gone();
    const type = allowedType(a.filename);
    const path = attachmentPath(attachmentsDir, a.stored_name);
    if (!type || !path) return gone();
    let bytes: number;
    try {
      bytes = statSync(path).size;
    } catch {
      return gone();
    }
    // Nothing but these survives into the header: a name is user input.
    const safeName = a.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Content-Disposition', `${type.inline ? 'inline' : 'attachment'}; filename="${safeName}"`)
      // A removed file must not live on in a browser cache.
      .header('Cache-Control', 'private, no-store')
      .header('Content-Length', bytes)
      .type(type.mime)
      .send(createReadStream(path));
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
    // Out of the queue AND out of any ready check or vote in progress, as the
    // Players tab ban does. leave() only knows about the queue.
    if (r.ok) matchmaker.remove(getTicketRow(db, id)!.target_id);
    return r;
  }, (b) => ({ reason: b.reason, minutes: b.minutes ?? null })));
}
