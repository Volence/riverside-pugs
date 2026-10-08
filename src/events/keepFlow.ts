import * as T from '../teams/teams.js';
import * as K from './keepTeam.js';
import * as V from './validate.js';
import { tellKeepAsk, tellKeepJoined, tellKeepSettled, type NoticeDeps } from './notices.js';

/**
 * Keep this team, sequenced for the routes and the Discord buttons (drafts
 * plan D3b): each keepTeam.ts mutation, then its DMs after the commit. An
 * accept tries to make the team at once (Ruling 3); the minute tick tries
 * again for keeps still waiting.
 */
export function startKeepFlow(d: NoticeDeps, o: { entryId: number; steamid: string; name: unknown; tag: unknown; now: Date }): V.Checked<{ keepId: number }> {
  const r = K.startKeep(d.db, o);
  if (r.ok) tellKeepAsk(d, K.keepOf(d.db, r.value.keepId)!.event_id, r.value.keepId);
  return r;
}

export function answerKeepFlow(d: NoticeDeps, o: { keepId: number; steamid: string; accept: boolean; now: Date }): V.Checked<{ joined: boolean; teamSlug: string | null }> {
  const r = K.answerKeep(d.db, o);
  if (!r.ok) return r;
  const k = K.keepOf(d.db, o.keepId)!;
  let joined = r.value.joined;
  if (joined) tellKeepJoined(d, k.event_id, k.id, o.steamid);
  if (o.accept && k.status === 'voting') {
    const s = K.settleKeep(d.db, { keepId: k.id, now: o.now });
    if (s.ok) {
      tellKeepSettled(d, k.event_id, k.id, s.value);
      joined = s.value.made && s.value.joined.includes(o.steamid);
    }
  }
  const after = K.keepOf(d.db, k.id)!;
  const team = after.team_id !== null ? T.getTeam(d.db, after.team_id) : undefined;
  return V.ok({ joined, teamSlug: joined ? team?.slug ?? null : null });
}
