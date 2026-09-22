import { createReadStream, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireActive, makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { publishAdminEvent } from '../adminFeed.js';
import { allowedType, attachmentPath } from '../tickets/attachments.js';
import type { AttachmentRow } from '../tickets/messages.js';
import { canSeeTicket, getTicketRow, ticketIsQuiet } from '../tickets/store.js';
import { removeMessage } from '../tickets/removal.js';
import { fileReport, myReports, openStaffTicket } from '../tickets/filing.js';
import { addAccess, banFromTicket, claimTicket, closeTicket, reopenTicket, setRestricted, type ActionResult } from '../tickets/actions.js';
import { listTickets, ticketCounts, ticketDetail, type TicketFilter } from '../tickets/views.js';
import { checkDiscordSanction, checkLift, recordDiscordSanction, recordLift } from '../tickets/discordSanctions.js';
import { caseFile } from '../tickets/caseFile.js';
import { fileViewer } from '../admin/fileAccess.js';
import { playerFileSummary } from '../admin/playerFileSummary.js';
import type { ModerationOps } from '../discord/transport.js';

/** Why Discord said no, in the words the site shows, for APPLYING a
 *  sanction. Lifting a timeout has its own wording for not_member (see the
 *  lift route below): the bot cannot end a timeout for someone who is no
 *  longer in the server, which is a different situation from having nobody
 *  to time out in the first place. */
const refusalText = (why: 'hierarchy' | 'not_member' | 'unknown_user' | 'other'): string => ({
  hierarchy: 'Discord refused: their role is above the bot\'s, or they are an administrator',
  not_member: 'they are no longer in the Discord server, so there is nothing to time out; an admin can still ban them',
  unknown_user: 'Discord has no account with that id',
  other: 'Discord refused the action; try again, or do it by hand in Discord',
})[why];

export interface TicketRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
  broadcast: (event: string) => void;
  adminSteamIds: string[];
  /** The Discord server, for links to threads. Null when Discord is not configured. */
  guildId: string | null;
  /** config.ticketAttachmentsDir. */
  attachmentsDir: string;
  /** Called after a removal committed: pokes the bot, if it is running, to
   *  delete the message in Discord. Never awaited by the route. */
  afterRemove: () => void;
  /** The running bot's moderation surface, or null when Discord is not
   *  connected. Read per call, like the bot itself: a route dialled before
   *  the bot finishes logging in, or after it drops, must see null rather
   *  than a stale reference. */
  moderation: () => ModerationOps | null;
}

/** Filing under /api/reports for any active player; everything under
 *  /api/mod for staff. Each mutation ends with logAdmin, quiet when the
 *  ticket is restricted or about staff (ticketIsQuiet). */
export async function ticketRoutes(app: FastifyInstance, opts: TicketRouteOpts): Promise<void> {
  const { db, matchmaker, broadcast, adminSteamIds, guildId, attachmentsDir, afterRemove, moderation } = opts;
  const requireActive = makeRequireActive(db);
  const requireMod = makeRequireMod(db);
  const filing = { adminSteamIds };
  /** Whether a ticket action's audit row stays off the admin feed. A ticket
   *  that has gone by the time the row is written (folded away mid-request)
   *  counts as quiet: this fails closed. */
  const quiet = (id: number): boolean => {
    const t = getTicketRow(db, id);
    return !t || ticketIsQuiet(db, t);
  };

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
    logAdmin(db, me, 'ticket_open', r.auditId, {}, { quiet: quiet(r.auditId) });
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
    // A Discord-only accused has no player row for either builder to read:
    // there is nothing for the case file or the glance summary to show.
    return {
      ...d,
      caseFile: d.ticket.targetId !== null ? caseFile(db, d.ticket.targetId, me) : null,
      summary: d.ticket.targetId !== null ? playerFileSummary(db, d.ticket.targetId, fileViewer(db, me)) : null,
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

  /**
   * Remove a mirrored message for good: text, history and files. The Discord
   * message follows through the bot; this does not wait for it.
   *
   * Not through act(): this one takes a message id as well as a ticket id,
   * and its refusals are removeMessage's own (404 for a ticket this viewer
   * cannot see, 409 for a message already removed).
   */
  app.post('/api/mod/tickets/:id/messages/:mid/remove', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { id, mid } = req.params as { id: string; mid: string };
    const r = removeMessage(db, attachmentsDir, Number(id), Number(mid), me, ((req.body ?? {}) as { reason?: unknown }).reason);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(
      db, me, 'ticket_remove', Number(id),
      // The reason is not in here: it is on the message, where the page reads
      // it from, and an audit detail is read by more people than that.
      { messageId: Number(mid), files: r.files, mirrored: true, via: 'site' },
      { quiet: quiet(Number(id)) },
    );
    afterRemove();
    // No broadcast('refresh'): removeMessage published the ticket signal, and
    // the staff-scoped nudge tells the pages that may see it.
    return { ok: true };
  });

  /**
   * Time out or ban, in Discord, the Discord-only person a ticket is about.
   * Discord first, then the record: checkDiscordSanction decides whether this
   * is allowed at all (caps, reason, admin-vs-mod) before Discord is ever
   * dialled, so a refused check never reaches Discord; a refusal FROM Discord
   * writes nothing here either. Only once Discord has accepted does the row
   * get written, and if that write throws, an admin problem event says the
   * action happened but was not recorded.
   *
   * Not through act(): it awaits Discord before it can decide what, if
   * anything, to write, same as messages/:mid/remove bypasses it for its own
   * reason.
   */
  app.post('/api/mod/tickets/:id/discord-sanction', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { id: string }).id);
    const c = checkDiscordSanction(db, id, me, (req.body ?? {}) as object);
    if (!c.ok) return reply.code(c.status).send({ error: c.error });
    const mod = moderation();
    if (!mod) return reply.code(503).send({ error: 'the Discord bot is not running' });
    const { plan } = c;
    const result = plan.kind === 'timeout'
      ? await mod.timeout(plan.discordId, plan.minutes as number, plan.reason)
      : await mod.ban(plan.discordId, plan.reason);
    if (!result.ok) return reply.code(409).send({ error: refusalText(result.why) });
    // Quietness keyed the same way every other ticket audit site keys it
    // (restricted, or about somebody with a staff flag), not plan.restricted
    // alone: `quiet` fails closed if the ticket row is somehow gone by now.
    const sanctionQuiet = quiet(id);
    try {
      recordDiscordSanction(db, plan, me);
    } catch (err) {
      // The admin feed reaches everyone with feed access, wider than a
      // restricted ticket's own list, so a quiet ticket's problem event must
      // not name who it is about: neutral wording, ticket number only.
      publishAdminEvent({
        kind: 'problem',
        text: sanctionQuiet
          ? `A Discord sanction on restricted ticket #${id} was applied in Discord but could not be recorded; ` +
            'someone on its access list should check it.'
          : `Discord ${plan.kind === 'ban' ? 'banned' : 'timed out'} ${plan.discordId} for ticket #${id}, ` +
            `but recording the sanction failed: ${String(err)}`,
      });
      return reply.code(500).send({ error: 'Discord applied it, but recording it failed; an admin has been told' });
    }
    // The reason is not in the audit detail, as with removals: it is on the
    // ticket (recordDiscordSanction put it in a ticket_events row), and an
    // audit detail is read by more people than that.
    logAdmin(db, me, 'ticket_discord_sanction', id, { kind: plan.kind, minutes: plan.minutes }, { quiet: sanctionQuiet });
    broadcast('refresh');
    return { ok: true };
  });

  /**
   * Lift a Discord sanction. Only an admin, which checkLift enforces (it also
   * answers the same 404 a missing sanction would for one on a restricted
   * ticket the caller cannot see). Discord first, as above.
   *
   * A timeout whose member has since left the server cannot be lifted at
   * all: Discord has nothing to remove a timeout FROM, so removeTimeout comes
   * back not_member, and that gets its own wording here rather than the one
   * checkDiscordSanction's refusalText uses for applying one, because "there
   * is nothing to time out" does not fit a timeout that is already running.
   * Nothing is recorded when this happens; it lapses on its own.
   */
  app.post('/api/mod/discord-sanctions/:sid/lift', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const sid = Number((req.params as { sid: string }).sid);
    const c = checkLift(db, sid, me);
    if (!c.ok) return reply.code(c.status).send({ error: c.error });
    const mod = moderation();
    if (!mod) return reply.code(503).send({ error: 'the Discord bot is not running' });
    const { plan } = c;
    const result = plan.kind === 'timeout'
      ? await mod.removeTimeout(plan.discordId, 'ticket sanction lifted')
      : await mod.unban(plan.discordId, 'ticket sanction lifted');
    if (!result.ok) {
      if (result.why === 'not_member') {
        const row = db.prepare('SELECT until FROM discord_sanctions WHERE id = ?').get(sid) as { until: string | null } | undefined;
        const at = row?.until ? ` at ${new Date(row.until).toUTCString()}` : '';
        return reply.code(409).send({
          error: `they are no longer in the Discord server, so the bot cannot lift the timeout; it ends on its own${at}`,
        });
      }
      return reply.code(409).send({ error: refusalText(result.why) });
    }
    // Same keying as the apply route above: no ticket means nothing to keep
    // quiet about, and quiet fails closed if the ticket row is somehow gone.
    const liftQuiet = plan.ticketId === null ? false : quiet(plan.ticketId);
    // Guards against two admins racing to lift the same sanction: the loser's
    // UPDATE changes nothing, recordLift reports that, and this answers 409
    // rather than writing a second event for a lift that already happened.
    let lifted: boolean;
    try {
      lifted = recordLift(db, plan, me);
    } catch (err) {
      // Same shape as the apply route above: Discord already did it, so an
      // admin problem event says the write failed, with the same restricted
      // wording (no Discord id, ticket number only) for a quiet ticket.
      publishAdminEvent({
        kind: 'problem',
        text: liftQuiet
          ? `A Discord sanction lift on restricted ticket #${plan.ticketId} was applied in Discord but could not be recorded; ` +
            'someone on its access list should check it.'
          : `Discord ${plan.kind === 'ban' ? 'unbanned' : 'ended the timeout for'} ${plan.discordId}` +
            `${plan.ticketId !== null ? ` for ticket #${plan.ticketId}` : ''}, but recording the lift failed: ${String(err)}`,
      });
      return reply.code(500).send({ error: 'Discord applied it, but recording it failed; an admin has been told' });
    }
    if (!lifted) return reply.code(409).send({ error: 'that sanction is no longer in force' });
    logAdmin(db, me, 'ticket_discord_sanction_lift', plan.ticketId ?? 0, { kind: plan.kind, sanctionId: plan.sanctionId }, { quiet: liftQuiet });
    broadcast('refresh');
    return { ok: true };
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
    logAdmin(db, me, action, id, detail(body), { quiet: quiet(id) });
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
    // Players tab ban does. leave() only knows about the queue. banFromTicket
    // refuses a Discord-only target before ok, so target is set whenever r.ok
    // is true; the guard is here anyway so a future change cannot pass null.
    const target = getTicketRow(db, id)?.target_id;
    if (r.ok && target) matchmaker.remove(target);
    return r;
  }, (b) => ({ reason: b.reason, minutes: b.minutes ?? null })));
}
