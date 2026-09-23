import type { DB } from '../db.js';
import { logAdmin } from '../admin/audit.js';
import { playerByDiscordId } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { claimTicket, closeTicket } from '../tickets/actions.js';
import { canSeeTicket, getTicketRow, hasStaffFlag, ticketIsQuiet, type TicketRow } from '../tickets/store.js';
import { reporterLabel, reporterThreadsOf } from '../tickets/reporterChat.js';
import { closeModal } from './ticketCard.js';
import type { ReporterChats } from './reporterChats.js';
import type { BotInteraction, InteractionReply } from './transport.js';

export interface TicketButtonDeps {
  db: DB;
  publicUrl: string;
  chats?: () => ReporterChats | null;
}

const say = (content: string, components: InteractionReply['payload']['components'] = []): InteractionReply => ({
  ephemeral: true,
  payload: { content, embeds: [], components, mentionUserIds: [] },
});
const link = (content: string, url: string, label: string) => say(content, [[{ kind: 'link', url, label }]]);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STAFF_ONLY = 'Staff only.';
/** One answer for "no such ticket" and "not one you may see", on purpose. */
const NO_TICKET = 'No such ticket.';

/** Buttons that answer with a modal. The transport has to know before it
 *  runs the handler, because a modal must be the first response to a press. */
export const opensTicketModal = (customId: string): boolean => /^t:\d+:close$/.test(customId);

/**
 * Who is pressing, and may they touch this ticket. Checked from scratch on
 * every press: a button sits in Discord for months, and the person pressing
 * it may have been demoted, banned or unlinked since the card was posted.
 * Being able to see the thread proves nothing here.
 *
 * "Active staff" is makeRequireMod's rule, to the letter: a staff flag AND
 * inGoodStanding, which asks the bans table as well as players.status (the
 * status of a moderator banned a minute ago still says active until the
 * reaper writes it) and refuses a SteamID merged into another account.
 */
function resolve(
  deps: TicketButtonDeps, userId: string, ticketId: number,
): { me: string; ticket: TicketRow } | { reply: InteractionReply } {
  const p = playerByDiscordId(deps.db, userId);
  // Staff first, before the ticket is so much as looked up: the two refusals
  // read differently, so anyone who is not staff must always get the same one,
  // whatever ticket id they press. Otherwise the pair is a probe for which
  // ticket ids exist.
  if (!p || (p.is_admin !== 1 && p.is_mod !== 1) || !inGoodStanding(deps.db, p.steamid)) return { reply: say(STAFF_ONLY) };
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket || !canSeeTicket(deps.db, ticket, p.steamid)) return { reply: say(NO_TICKET) };
  return { me: p.steamid, ticket };
}

/**
 * custom_id scheme: t:<ticketId>:claim, t:<ticketId>:close. Each calls
 * exactly what the site's route calls, so the two surfaces cannot disagree
 * about who may do what, and each is audited like the route, with
 * `via: 'discord'`, quietly for a restricted ticket or one about staff.
 */
export async function handleTicketButton(
  deps: TicketButtonDeps, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const m = /^t:(\d+):(claim|close|contact|join|endchat)(?::(\d+))?$/.exec(i.customId);
  if (!m) return say('That button no longer does anything.');
  const id = Number(m[1]);
  const who = resolve(deps, i.userId, id);
  if ('reply' in who) return who.reply;
  const { me, ticket } = who;

  if (m[2] === 'contact' || m[2] === 'join' || m[2] === 'endchat') {
    return chatAction(deps, m[2], ticket, me, m[3] === undefined ? null : Number(m[3]));
  }

  if (m[2] === 'close') {
    if (ticket.status !== 'open') return say('This ticket is already closed.');
    // The payload is what is said if the modal cannot be shown.
    return { ...say(`Close it on the site: ${deps.publicUrl}/admin/people/tickets/${id}`), modal: closeModal(id) };
  }

  // As the site's button does: an unclaimed ticket is claimed, a claimed one
  // is released, whoever holds it.
  const claim = ticket.claimed_by === null;
  const r = claimTicket(deps.db, id, me, claim);
  if (!r.ok) return say(capitalise(r.error));
  logAdmin(deps.db, me, 'ticket_claim', id, { claim, via: 'discord' }, { quiet: ticketIsQuiet(deps.db, ticket) });
  return say(claim ? `You claimed ticket #${id}.` : `You released ticket #${id}.`);
}

/** The reporter-chat buttons on the staff post. Each calls what the site's
 *  route calls, and is audited the same way, quietly per ticketIsQuiet. */
async function chatAction(
  deps: TicketButtonDeps, action: 'contact' | 'join' | 'endchat', ticket: TicketRow, me: string, extra: number | null,
): Promise<InteractionReply> {
  const { db } = deps;
  const chats = deps.chats?.() ?? null;
  if (!chats) return say('Reporter chats are not available right now. Try again in a few minutes.');
  const quiet = ticketIsQuiet(db, ticket);
  const clip = (s: string) => s.slice(0, 80);

  if (action === 'contact') {
    let reportId = extra;
    if (reportId === null) {
      // One button per reporter, not per report.
      const reporters = db.prepare(
        `SELECT MIN(r.id) AS id, r.reporter_id, r.reporter_discord_id FROM ticket_reports r
         WHERE r.ticket_id = ? GROUP BY COALESCE(r.reporter_id, 'd:' || r.reporter_discord_id) ORDER BY MIN(r.id)`,
      ).all(ticket.id) as { id: number; reporter_id: string | null; reporter_discord_id: string | null }[];
      if (reporters.length === 0) return say('Nobody reported this ticket: it was opened by staff.');
      if (reporters.length > 1) {
        const buttons = reporters.slice(0, 20).map((r) => ({
          kind: 'button' as const, customId: `t:${ticket.id}:contact:${r.id}`, style: 'secondary' as const,
          label: clip(reporterLabel(db, ticket.id, { reporterId: r.reporter_id, reporterDiscordId: r.reporter_discord_id })),
        }));
        const rows = [];
        for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
        return say('Which reporter?', rows);
      }
      reportId = reporters[0].id;
    }
    const r = await chats.contact(ticket.id, reportId, me);
    if (!r.ok) return say(capitalise(r.error));
    logAdmin(db, me, 'ticket_contact', ticket.id, { reportId, via: 'discord' }, { quiet });
    return link('The chat with the reporter is open.', r.url, 'Open the chat');
  }

  if (action === 'join') {
    const r = await chats.join(ticket.id, me);
    if (!r.ok) return say(capitalise(r.error));
    logAdmin(db, me, 'ticket_chat_join', ticket.id, { via: 'discord' }, { quiet });
    return link('You are in the reporter chat.', r.url, 'Open the chat');
  }

  let threadRowId = extra;
  if (threadRowId === null) {
    const open = reporterThreadsOf(db, ticket.id, 'open');
    if (open.length === 0) return say('There is no open reporter chat on this ticket.');
    if (open.length > 1) {
      return say('Which chat?', [open.slice(0, 5).map((th) => ({
        kind: 'button' as const, customId: `t:${ticket.id}:endchat:${th.id}`, style: 'secondary' as const,
        label: clip(reporterLabel(db, ticket.id, { reporterId: th.reporter_id, reporterDiscordId: th.reporter_discord_id })),
      }))]);
    }
    threadRowId = open[0].id;
  }
  const r = await chats.end(ticket.id, threadRowId, me);
  if (!r.ok) return say(capitalise(r.error));
  logAdmin(db, me, 'ticket_chat_end', ticket.id, { threadRowId, via: 'discord' }, { quiet });
  return say('The reporter chat has ended.');
}

export async function handleTicketModal(
  deps: TicketButtonDeps, i: Extract<BotInteraction, { kind: 'modal' }>,
): Promise<InteractionReply> {
  const m = /^t:(\d+):close$/.exec(i.customId);
  if (!m) return say('That form no longer does anything.');
  const id = Number(m[1]);
  const who = resolve(deps, i.userId, id);
  if ('reply' in who) return who.reply;
  const r = closeTicket(deps.db, id, who.me, i.fields.outcome, i.fields.note ?? '', i.fields.tell !== 'no');
  if (!r.ok) return say(capitalise(r.error));
  // The note is internal and stays out of the audit detail, as on the site.
  logAdmin(deps.db, who.me, 'ticket_close', id, { outcome: i.fields.outcome, via: 'discord' }, { quiet: ticketIsQuiet(deps.db, who.ticket) });
  // A ticket about staff has its forum post deleted rather than locked
  // (forbiddenForumThreads, Rule 2): the accused would otherwise still be
  // able to see the post's existence, so the discussion moves to the site.
  const aftermath = hasStaffFlag(deps.db, who.ticket.target_id)
    ? 'The post is removed in a moment; the discussion is kept on the site.'
    : 'The post locks in a moment.';
  return say(`Ticket #${id} is closed. ${aftermath}`);
}
