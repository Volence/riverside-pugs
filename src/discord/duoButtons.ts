import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import type { BotInteraction, InteractionReply } from './transport.js';
import { playerByDiscordId } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { getDuoInvite } from '../duos.js';

/** Accept / Decline on a /duo invite: dq:<inviteId>:a and dq:<inviteId>:d.
 *  Discord lets anyone press a button, so the presser is resolved to their
 *  linked player and must be the invitee. */
export const DUO_BUTTON_PREFIX = 'dq:';

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });

export async function handleDuoButton(
  deps: { db: DB; matchmaker: Matchmaker },
  i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const [, rawId, choice] = i.customId.split(':');
  const inviteId = Number(rawId);
  if (!Number.isInteger(inviteId) || (choice !== 'a' && choice !== 'd')) return say('That button no longer does anything.');
  const player = playerByDiscordId(deps.db, i.userId);
  if (!player) return say('Link this Discord account to your Steam account on the site first.');
  if (!inGoodStanding(deps.db, player.steamid)) return say('You cannot duo right now.');
  const inv = getDuoInvite(deps.db, inviteId);
  if (inv && inv.toId !== player.steamid) return say('That invite is not for you.');
  const r = choice === 'a'
    ? deps.matchmaker.acceptDuo(inviteId, player.steamid)
    : deps.matchmaker.declineDuo(inviteId, player.steamid);
  if (!r.ok) return say(`Could not: ${r.error}.`);
  return say(choice === 'a'
    ? 'You are a duo now. Either of you joining the queue brings the other, and you always play on the same team.'
    : 'Declined.');
}
