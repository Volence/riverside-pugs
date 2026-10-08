import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import type { BotInteraction, InteractionReply } from './transport.js';
import { escapeName } from '../identity.js';
import { playerByDiscordId } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { competitiveAccess } from '../teams/access.js';
import * as E from '../events/events.js';
import * as N from '../events/entries.js';
import * as K from '../events/keepTeam.js';
import * as V from '../events/validate.js';
import { answerKeepFlow, startKeepFlow } from '../events/keepFlow.js';

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });

/**
 * The keep buttons (drafts plan D3b). Custom ids: dk:k:<keepId> on the
 * captain's offer DM (Keep with the entry's name and tag as they are; with no
 * tag the captain is sent to the event page), dk:a:<keepId> and
 * dk:d:<keepId> on the others' ask DM. The Discord id resolves to the linked
 * player, and keepTeam.ts checks that player as the site's routes do.
 */
export async function handleKeepButton(
  deps: { db: DB; publicUrl: string; notifier?: Notifier; now?: () => number }, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const [, kind, raw] = i.customId.split(':');
  const player = playerByDiscordId(deps.db, i.userId);
  if (!player || !inGoodStanding(deps.db, player.steamid)) return say(`Link this Discord account to your player on the website first: ${deps.publicUrl}/`);
  if (!competitiveAccess(deps.db, player.steamid)) return say('Teams are not open yet.');
  const k = Number.isInteger(Number(raw)) ? K.keepOf(deps.db, Number(raw)) : undefined;
  const ev = k ? E.getEvent(deps.db, k.event_id) : undefined;
  if (!k || !ev) return say('That button no longer does anything.');
  const link = `${deps.publicUrl}/event/${ev.slug}`;
  const d = { db: deps.db, notifier: deps.notifier, publicUrl: deps.publicUrl };
  const now = new Date((deps.now ?? Date.now)());
  if (kind === 'k') {
    const entry = N.getEntry(deps.db, k.entry_id)!;
    if (k.captain_steamid !== player.steamid) return say(V.EVENT_ERRORS.not_captain.text);
    if (entry.tag === '') return say(`Choose a team name and a tag on the event page first: ${link}`);
    const r = startKeepFlow(d, { entryId: entry.id, steamid: player.steamid, name: entry.name, tag: entry.tag, now });
    return say(r.ok ? `Your three were asked. ${escapeName(entry.name)} becomes a team when 3 of the 4 of you accept.` : `${V.EVENT_ERRORS[r.error].text} ${link}`);
  }
  if (kind === 'a' || kind === 'd') {
    const r = answerKeepFlow(d, { keepId: k.id, steamid: player.steamid, accept: kind === 'a', now });
    if (!r.ok) return say(V.EVENT_ERRORS[r.error].text);
    if (kind === 'd') return say('You declined.');
    if (r.value.closed) return say('This keep was closed and no team was made.');
    return say(r.value.joined && r.value.teamSlug ? `You are on the team: ${deps.publicUrl}/team/${r.value.teamSlug}` : 'You accepted. The team is made when 3 of the 4 of you accept.');
  }
  return say('That button no longer does anything.');
}
