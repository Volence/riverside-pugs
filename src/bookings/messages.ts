import type { DB } from '../db.js';
import type { MessagePayload } from '../discord/transport.js';
import { escapeName } from '../identity.js';
import { getPlayer } from '../players.js';
import { getServer } from '../serverPool.js';
import { getBooking, sideName, sidesOf } from './bookings.js';

/** "2026-10-02 20:00 UTC". DMs have no viewer time zone; the site shows local time. */
export const whenUtc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The six booking notice types this module knows how to word. Narrower than
 *  the full NotifyType (which also carries the scrim board's types, worded
 *  elsewhere) so the switch below stays exhaustive as NotifyType grows. */
export type BookingNotifyType =
  'booking_invite' | 'booking_confirmed' | 'booking_starting' | 'booking_ready' | 'booking_cancelled' | 'booking_no_show';

/** The DM for one booking notification, or null for a booking that is gone.
 *  Every player-chosen name goes through escapeName, as in teamButtons.ts. */
export function bookingMessage(
  db: DB, publicUrl: string, bookingId: number, type: BookingNotifyType,
  extra: { minutes?: number; reason?: string | null; addedBy?: string } = {},
): MessagePayload | null {
  const b = getBooking(db, bookingId);
  if (!b) return null;
  const [a, bs] = sidesOf(db, b.id);
  const aName = escapeName(sideName(db, a));
  const vs = `**${aName}** vs **${escapeName(sideName(db, bs))}**`;
  const when = whenUtc(b.starts_at);
  const hours = (Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 3_600_000;
  let content: string;
  switch (type) {
    case 'booking_invite':
      content = extra.addedBy
        ? `${escapeName(getPlayer(db, extra.addedBy)?.name ?? 'Someone')} added you to a booked server: ${vs}, ${when}. Accept it on the site to get the connect details.`
        : `${aName} wants a scrim: ${vs}, ${when}, ${hours} h. Confirm or decline it on the site.`;
      break;
    case 'booking_confirmed':
      content = `Your booking is confirmed: ${vs}, ${when}.`;
      break;
    case 'booking_starting':
      content = `${vs} starts in ${extra.minutes ?? 15} minutes (${when}).`;
      break;
    case 'booking_ready': {
      const s = b.server_id !== null ? getServer(db, b.server_id) : undefined;
      content = s
        ? `Your server for ${vs} is ready. In the game console:\n\`connect ${s.host}:${s.port}; password ${b.password}\``
        : `Your server for ${vs} is ready.`;
      break;
    }
    case 'booking_cancelled':
      content = `${vs} on ${when} is cancelled${extra.reason ? `: ${escapeName(extra.reason)}` : '.'}`;
      break;
    case 'booking_no_show':
      content = `Your side was recorded as a no-show for ${vs} on ${when}.`;
      break;
  }
  return {
    content,
    embeds: [],
    components: [[{ kind: 'link', url: `${publicUrl}/booking/${b.id}`, label: 'Open the booking' }]],
    mentionUserIds: [],
  };
}
