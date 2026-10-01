import type { DB } from '../db.js';
import type { MessagePayload } from '../discord/transport.js';
import { escapeName } from '../identity.js';
import { getPlayer } from '../players.js';
import { activeMembers, getTeam } from '../teams/teams.js';
import { whenUtc } from '../bookings/messages.js';
import { getAccept, getPost, type AcceptRow, type PostRow } from './scrims.js';

/** The five scrim board notice types this module knows how to word (the
 *  scrim half of NotifyType; the booking half is worded in
 *  src/bookings/messages.ts). */
export type ScrimNotifyType = 'scrim_challenge' | 'scrim_accepted' | 'scrim_booked' | 'scrim_taken' | 'scrim_declined';

type SideRef = Pick<PostRow, 'team_id' | 'captain_steamid'>;

/** A team's current captain and co-captains, for a direct challenge notice
 *  and the one rule scrimSideManagers shares with it below. The same rule as
 *  scrims.ts's own (private) managersOf, and src/bookings/runner.ts's
 *  sideManagers; duplicated here because neither is exported for a route or
 *  a tick to call. */
export function teamManagers(db: DB, teamId: number): string[] {
  return activeMembers(db, teamId).filter((m) => m.role === 'captain' || m.role === 'cocaptain').map((m) => m.steamid);
}

/** Everyone who manages a side right now: a team's current managers
 *  (teamManagers), or the pickup captain alone. */
export function scrimSideManagers(db: DB, s: SideRef): string[] {
  return s.team_id !== null ? teamManagers(db, s.team_id) : [s.captain_steamid];
}

function sideLabel(db: DB, s: SideRef): string {
  if (s.team_id !== null) return escapeName(getTeam(db, s.team_id)?.name ?? 'A team');
  return escapeName(getPlayer(db, s.captain_steamid)?.name ?? 'Someone');
}

/** The DM for one scrim board notification, or null for a post or acceptance
 *  that is gone. Every player-chosen name goes through escapeName, as in
 *  src/bookings/messages.ts. */
export function scrimMessage(
  db: DB, publicUrl: string, postId: number, type: ScrimNotifyType,
  extra: { acceptId?: number; bookingId?: number; reason?: string; nearestSlot?: string | null } = {},
): MessagePayload | null {
  const p = getPost(db, postId);
  if (!p) return null;
  const posterLabel = sideLabel(db, p);
  const when = whenUtc(p.starts_at);
  const postLink = `${publicUrl}/scrims?post=${p.id}`;
  let content: string;
  let link = postLink;
  switch (type) {
    case 'scrim_challenge':
      content = `${posterLabel} challenges you to a scrim: ${when}, ${p.block_minutes} min. Accept or decline it on the site.`;
      break;
    case 'scrim_accepted': {
      const a: AcceptRow | undefined = extra.acceptId !== undefined ? getAccept(db, extra.acceptId) : undefined;
      const accepterLabel = a ? sideLabel(db, a) : 'Someone';
      content = `${accepterLabel} accepted your scrim post for ${when}. Pick one acceptance on the site.`;
      break;
    }
    case 'scrim_booked':
      content = `Your scrim is booked: ${when}.`;
      link = extra.bookingId !== undefined ? `${publicUrl}/booking/${extra.bookingId}` : postLink;
      break;
    case 'scrim_taken':
      content = `Another side was chosen for ${posterLabel}'s scrim post (${when}); this acceptance is closed.`;
      break;
    case 'scrim_declined': {
      if (extra.nearestSlot !== undefined) {
        content = extra.nearestSlot
          ? `The slot for ${posterLabel}'s scrim post is no longer free. The nearest free slot is ${whenUtc(extra.nearestSlot)}; the poster can re-post it.`
          : `The slot for ${posterLabel}'s scrim post is no longer free, and no nearby slot is open either. The poster can re-post it for another time.`;
        break;
      }
      const why = extra.reason ?? 'the poster declined it';
      content = `Your scrim accept for ${posterLabel}'s post (${when}) is closed: ${escapeName(why)}.`;
      break;
    }
  }
  return {
    content,
    embeds: [],
    components: [[{ kind: 'link', url: link, label: 'Open it' }]],
    mentionUserIds: [],
  };
}
