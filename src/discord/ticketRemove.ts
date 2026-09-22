import type { DB } from '../db.js';
import { logAdmin } from '../admin/audit.js';
import { playerByDiscordId } from '../players.js';
import { messageByDiscordId } from '../tickets/messages.js';
import { removeMessage } from '../tickets/removal.js';
import { publishTicketSignal } from '../tickets/signals.js';
import { addTicketEvent, canSeeTicket, getTicketRow } from '../tickets/store.js';
import { threadByDiscordId } from '../tickets/threads.js';
import type { TicketMirror } from './ticketMirror.js';
import type { BotInteraction, InteractionReply } from './transport.js';

/** As it reads in Discord: right-click a message, Apps, Remove from ticket. */
export const REMOVE_COMMAND = 'Remove from ticket';

export interface TicketRemoveDeps {
  db: DB;
  attachmentsDir: string;
  /** The running mirror. A getter, because the mirror is made when the bot
   *  connects, after this handler has been handed to it. */
  mirror: () => TicketMirror | null;
}

const say = (content: string): InteractionReply => ({
  ephemeral: true,
  payload: { content, embeds: [], components: [], mentionUserIds: [] },
});
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STAFF_ONLY = 'Staff only.';
/** One answer for "this is not a ticket thread", "not a ticket you may see"
 *  and "that message is not in this thread", on purpose. */
const NOT_HERE = 'This only works on a message inside a ticket thread you have access to.';

/**
 * Remove, from wherever the moderator happens to be. It acts at once, with
 * no confirmation, and answers privately.
 *
 * The command shows under Apps on every message in the server, for everyone,
 * so everything is checked here from scratch: the person (a Discord account
 * linked to an active moderator or admin), the place (a thread listed in
 * ticket_threads), and the ticket (canSeeTicket). Only ids arrive; what the
 * message says is never handed to this function.
 */
export async function handleRemoveCommand(
  deps: TicketRemoveDeps, i: Extract<BotInteraction, { kind: 'message_command' }>,
): Promise<InteractionReply> {
  const { db } = deps;
  const p = playerByDiscordId(db, i.userId);
  // Staff first, as ticketButtons does it: whoever is not staff gets the same
  // answer wherever they press, so the pair of refusals is not a probe for
  // which threads are ticket threads.
  if (!p || p.status !== 'active' || (p.is_admin !== 1 && p.is_mod !== 1)) return say(STAFF_ONLY);
  const thread = threadByDiscordId(db, i.channelId);
  const ticket = thread ? getTicketRow(db, thread.ticket_id) : undefined;
  if (!thread || !ticket || !canSeeTicket(db, ticket, p.steamid)) return say(NOT_HERE);
  if (i.messageId === thread.card_message_id) return say('That is the ticket\'s own card. It is not part of the discussion, so there is nothing to remove.');
  const quiet = ticket.restricted === 1;

  const m = messageByDiscordId(db, i.messageId);
  if (m && m.thread_id !== i.channelId) return say(NOT_HERE);
  if (!m) {
    // Never copied to the site: written while the bot was away and not yet
    // backfilled, or one of the bot's own lines. There is no site copy and no
    // file to destroy, but it can still be made to go from Discord, which is
    // what the moderator is asking for.
    await deps.mirror()?.removeInDiscord(i.channelId, i.messageId);
    addTicketEvent(db, ticket.id, p.steamid, 'removed', { mirrored: false });
    logAdmin(db, p.steamid, 'ticket_remove', ticket.id, { mirrored: false, via: 'discord' }, { quiet });
    publishTicketSignal({ kind: 'ticket', ticketId: ticket.id });
    return say('Deleted. That message had not been copied to the site, so there was nothing else to remove.');
  }

  const r = removeMessage(db, deps.attachmentsDir, ticket.id, m.id, p.steamid, '');
  if (!r.ok) return say(capitalise(r.error));
  logAdmin(db, p.steamid, 'ticket_remove', ticket.id, { messageId: m.id, files: r.files, via: 'discord' }, { quiet });
  await deps.mirror()?.sweepRemovals();
  const files = r.files === 0 ? '' : ` and ${r.files} file${r.files === 1 ? '' : 's'}`;
  return say(`Removed for good: the text, its edit history${files} are deleted from the site, and the message is deleted here. This cannot be undone.`);
}
