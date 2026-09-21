import type { DB } from '../db.js';
import { logAdmin } from '../admin/audit.js';
import { playerByDiscordId } from '../players.js';
import { claimTicket, closeTicket } from '../tickets/actions.js';
import { canSeeTicket, getTicketRow, type TicketRow } from '../tickets/store.js';
import { closeModal } from './ticketCard.js';
import type { BotInteraction, InteractionReply } from './transport.js';

export interface TicketButtonDeps {
  db: DB;
  publicUrl: string;
}

const say = (content: string): InteractionReply => ({
  ephemeral: true,
  payload: { content, embeds: [], components: [], mentionUserIds: [] },
});
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
 */
function resolve(
  deps: TicketButtonDeps, userId: string, ticketId: number,
): { me: string; ticket: TicketRow } | { reply: InteractionReply } {
  const p = playerByDiscordId(deps.db, userId);
  // Staff first, before the ticket is so much as looked up: the two refusals
  // read differently, so anyone who is not staff must always get the same one,
  // whatever ticket id they press. Otherwise the pair is a probe for which
  // ticket ids exist.
  if (!p || p.status !== 'active' || (p.is_admin !== 1 && p.is_mod !== 1)) return { reply: say(STAFF_ONLY) };
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket || !canSeeTicket(deps.db, ticket, p.steamid)) return { reply: say(NO_TICKET) };
  return { me: p.steamid, ticket };
}

/**
 * custom_id scheme: t:<ticketId>:claim, t:<ticketId>:close. Each calls
 * exactly what the site's route calls, so the two surfaces cannot disagree
 * about who may do what, and each is audited like the route, with
 * `via: 'discord'`, quietly for a restricted ticket.
 */
export async function handleTicketButton(
  deps: TicketButtonDeps, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const m = /^t:(\d+):(claim|close)$/.exec(i.customId);
  if (!m) return say('That button no longer does anything.');
  const id = Number(m[1]);
  const who = resolve(deps, i.userId, id);
  if ('reply' in who) return who.reply;
  const { me, ticket } = who;

  if (m[2] === 'close') {
    if (ticket.status !== 'open') return say('This ticket is already closed.');
    // The payload is what is said if the modal cannot be shown.
    return { ...say(`Close it on the site: ${deps.publicUrl}/admin?ticket=${id}`), modal: closeModal(id) };
  }

  // As the site's button does: an unclaimed ticket is claimed, a claimed one
  // is released, whoever holds it.
  const claim = ticket.claimed_by === null;
  const r = claimTicket(deps.db, id, me, claim);
  if (!r.ok) return say(capitalise(r.error));
  logAdmin(deps.db, me, 'ticket_claim', id, { claim, via: 'discord' }, { quiet: ticket.restricted === 1 });
  return say(claim ? `You claimed ticket #${id}.` : `You released ticket #${id}.`);
}

export async function handleTicketModal(
  deps: TicketButtonDeps, i: Extract<BotInteraction, { kind: 'modal' }>,
): Promise<InteractionReply> {
  const m = /^t:(\d+):close$/.exec(i.customId);
  if (!m) return say('That form no longer does anything.');
  const id = Number(m[1]);
  const who = resolve(deps, i.userId, id);
  if ('reply' in who) return who.reply;
  const r = closeTicket(deps.db, id, who.me, i.fields.outcome, i.fields.note ?? '');
  if (!r.ok) return say(capitalise(r.error));
  // The note is internal and stays out of the audit detail, as on the site.
  logAdmin(deps.db, who.me, 'ticket_close', id, { outcome: i.fields.outcome, via: 'discord' }, { quiet: who.ticket.restricted === 1 });
  return say(`Ticket #${id} is closed. The post locks in a moment.`);
}
