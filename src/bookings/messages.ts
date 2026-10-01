import type { DB } from '../db.js';
import type { MessagePayload } from '../discord/transport.js';
import { escapeName } from '../identity.js';
import { getPlayer } from '../players.js';
import { getServer } from '../serverPool.js';
import { getBooking, sideName, sidesOf, type Side } from './bookings.js';

/** "2026-10-02 20:00 UTC". DMs have no viewer time zone; the site shows local time. */
export const whenUtc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Added to a late cancel's notice for the side that was cancelled on. */
export const LATE_CANCEL_LINE = 'This is a late cancel. If it is fine with you, excuse it on the booking page so it does not count against them.';

/** The six booking notice types this module knows how to word. Narrower than
 *  the full NotifyType (which also carries the scrim board's types, worded
 *  elsewhere) so the switch below stays exhaustive as NotifyType grows. */
export type BookingNotifyType =
  'booking_invite' | 'booking_confirmed' | 'booking_starting' | 'booking_ready' | 'booking_recovered' | 'booking_cancelled' | 'booking_no_show';

/** The DM for one booking notification, or null for a booking that is gone.
 *  Every player-chosen name goes through escapeName, as in teamButtons.ts. */
export function bookingMessage(
  db: DB, publicUrl: string, bookingId: number, type: BookingNotifyType,
  extra: { minutes?: number; reason?: string | null; addedBy?: string; lateCancel?: boolean; moved?: boolean; restored?: string | null } = {},
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
      // Only the other side's people are sent this one (runner.onCancelled).
      if (extra.lateCancel) content += `\n${LATE_CANCEL_LINE}`;
      break;
    case 'booking_no_show':
      content = `Your side was recorded as a no-show for ${vs} on ${when}.`;
      break;
    case 'booking_recovered': {
      const s = b.server_id !== null ? getServer(db, b.server_id) : undefined;
      const head = extra.moved
        ? `The server for ${vs} went down, so the booking moved to another server.`
        : `The server for ${vs} restarted and is set up again.`;
      const game = extra.restored ? ` ${escapeName(extra.restored)}.` : '';
      content = s ? `${head}${game} Reconnect in the game console:\n\`connect ${s.host}:${s.port}; password ${b.password}\`` : `${head}${game}`;
      break;
    }
  }
  const page = `${publicUrl}/booking/${b.id}`;
  const links = [{ kind: 'link' as const, url: page, label: 'Open the booking' }];
  // The reminder's Cancel (plan 2 Ruling 3) is a link to the cancel confirm,
  // so cancelling stays in one place.
  if (type === 'booking_starting') links.push({ kind: 'link', url: `${page}?cancel=1`, label: 'Cancel' });
  return {
    content,
    embeds: [],
    components: [links],
    mentionUserIds: [],
  };
}

/** The private review ask (plan 2 Ruling 5) for one side's managers, naming
 *  the other side; null for a booking that is gone. Sent once per booking by
 *  the runner's settle. */
export function reviewAskMessage(db: DB, publicUrl: string, bookingId: number, side: Side): MessagePayload | null {
  const b = getBooking(db, bookingId);
  if (!b) return null;
  const other = sidesOf(db, b.id).find((s) => s.side !== side);
  if (!other) return null;
  return {
    content: `How was ${escapeName(sideName(db, other))}? Leave a quick private review on the booking page. Only staff see single reviews.`,
    embeds: [],
    components: [[{ kind: 'link', url: `${publicUrl}/booking/${b.id}`, label: 'Open the booking' }]],
    mentionUserIds: [],
  };
}
