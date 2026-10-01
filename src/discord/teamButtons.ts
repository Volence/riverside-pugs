import type { DB } from '../db.js';
import type { BotInteraction, InteractionReply, MessagePayload } from './transport.js';
import { playerByDiscordId } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { escapeName } from '../identity.js';
import { competitiveAccess } from '../teams/access.js';
import { getInvite, getTeam, respondInvite, TEAM_ERRORS } from '../teams/teams.js';

/** Custom ids: tm:<inviteId>:a (accept), tm:<inviteId>:d (decline). */
export const TEAM_BUTTON_PREFIX = 'tm:';

/** teamName and invitedByName both come from player input (a team's name is
 *  nothing but a slur-filtered string, see teams.ts). Unescaped, a name like
 *  "[Nitro](https://evil)" would render as a masked link in the DM, so both
 *  are escaped with the same escapeName used everywhere else a player-chosen
 *  name reaches Discord markdown. The tag is not: normalizeTag restricts it
 *  to ASCII letters and digits, which escapeName has nothing to do to. */
export function teamInviteDm(o: { inviteId: number; teamName: string; tag: string; invitedByName: string; url: string }): MessagePayload {
  return {
    content: `${escapeName(o.invitedByName)} invited you to join **[${o.tag}] ${escapeName(o.teamName)}**.`,
    embeds: [],
    components: [[
      { kind: 'button', customId: `${TEAM_BUTTON_PREFIX}${o.inviteId}:a`, label: 'Accept', style: 'success' },
      { kind: 'button', customId: `${TEAM_BUTTON_PREFIX}${o.inviteId}:d`, label: 'Decline', style: 'secondary' },
      { kind: 'link', url: o.url, label: 'Team page' },
    ]],
  };
}

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });

/**
 * The invite DM's buttons. The Discord id alone authorises nothing: it is
 * resolved to the LINKED player, and respondInvite checks that player against
 * the invite like the website's route does, so a forwarded DM does nothing.
 */
export async function handleTeamButton(
  deps: { db: DB; publicUrl: string }, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const [, rawId, choice] = i.customId.split(':');
  const inviteId = Number(rawId);
  if (!Number.isInteger(inviteId) || (choice !== 'a' && choice !== 'd')) return say('That button no longer does anything.');
  const player = playerByDiscordId(deps.db, i.userId);
  if (!player || !inGoodStanding(deps.db, player.steamid)) {
    return say(`Link this Discord account to your player on the website first: ${deps.publicUrl}/`);
  }
  if (!competitiveAccess(deps.db, player.steamid)) return say('Teams are not open yet.');
  const inv = getInvite(deps.db, inviteId);
  if (inv && inv.steamid !== player.steamid) return say('That invite is not for you.');
  const r = respondInvite(deps.db, { inviteId, steamid: player.steamid, accept: choice === 'a' });
  if (!r.ok) return say(TEAM_ERRORS[r.error].text);
  const team = getTeam(deps.db, r.value.teamId);
  const name = team ? escapeName(team.name) : 'the team';
  return choice === 'a'
    ? say(`You joined ${name}: ${deps.publicUrl}/team/${r.value.slug}`)
    : say(`You declined the invite to ${name}.`);
}
