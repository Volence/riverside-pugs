import type { DB } from '../db.js';
import type { BotInteraction, InteractionReply } from './transport.js';
import { escapeName } from '../identity.js';
import { playerByDiscordId } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { competitiveAccess } from '../teams/access.js';
import * as E from '../events/events.js';
import * as N from '../events/entries.js';
import * as V from '../events/validate.js';
import type { Standins } from '../events/standinFlow.js';

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });
const refusal = (r: { error: V.EventError; detail?: V.EntryProblem[] }): string =>
  [V.EVENT_ERRORS[r.error].text, ...(r.detail ?? []).flatMap((p) => p.problems)].join(' ');

/**
 * The stand-in buttons (drafts plan D3a). Custom ids: ds:a:<offerId> and
 * ds:d:<offerId> on a bench player's offer DM; ds:r:<entryId>:<steamid> on a
 * captain's team DM (a stand-in for that player's next match). The Discord id
 * authorises nothing by itself: it resolves to the linked player, and the
 * flow checks that player exactly as the site's routes do, so a forwarded DM
 * does nothing.
 */
export async function handleStandinButton(
  deps: { db: DB; publicUrl: string; standins: () => Standins | null }, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const [, kind, a, b] = i.customId.split(':');
  // With no flow there is nothing to check the press against.
  const standins = deps.standins();
  if (!standins) return say('Stand-ins are starting up. Try again in a minute.');
  const player = playerByDiscordId(deps.db, i.userId);
  if (!player || !inGoodStanding(deps.db, player.steamid)) return say(`Link this Discord account to your player on the website first: ${deps.publicUrl}/`);
  if (!competitiveAccess(deps.db, player.steamid)) return say('Events are not open yet.');
  if (kind === 'a' || kind === 'd') {
    const offerId = Number(a);
    if (!Number.isInteger(offerId)) return say('That button no longer does anything.');
    if (kind === 'd') {
      const r = standins.decline({ offerId, steamid: player.steamid });
      return say(r.ok ? 'You declined. The next bench player is asked.' : refusal(r));
    }
    const r = await standins.accept({ offerId, steamid: player.steamid });
    if (!r.ok) return say(refusal(r));
    const entry = N.getEntry(deps.db, r.value.entryId);
    const ev = entry ? E.getEvent(deps.db, entry.event_id) : undefined;
    const what = r.value.scope === 'match' ? 'for their next match' : 'for the rest of the event';
    return say(`You are in: standing in on ${escapeName(entry?.name ?? 'the team')} ${what}.${ev ? ` ${deps.publicUrl}/event/${ev.slug}` : ''}`);
  }
  if (kind === 'r') {
    const entry = N.getEntry(deps.db, Number(a));
    if (!entry || typeof b !== 'string' || b === '') return say('That button no longer does anything.');
    const r = standins.request({ eventId: entry.event_id, entryId: entry.id, out: b, scope: 'match', by: player.steamid, staff: false });
    if (!r.ok) return say(refusal(r));
    return say('The bench is being asked, closest SR first. You get a DM when someone accepts, or if nobody does. Cancel on the event page if you pressed this by mistake.');
  }
  return say('That button no longer does anything.');
}
