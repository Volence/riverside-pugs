import type { DB } from '../db.js';
import type { MessagePayload } from '../discord/transport.js';
import type { DmFn } from '../signonDropNotify.js';
import { getPlayer } from '../players.js';

/**
 * Who gets told what (spec part 1 section 4, Notifications). For now one
 * channel, a Discord DM, sent only to players with Discord linked who have
 * not turned that type off; the site itself shows the same state on the
 * bookings pages. Specs 2-4 add their own types here.
 *
 * Sends are fire-and-forget: a player with DMs closed is logged and skipped,
 * and nothing a DM does can fail the request or tick that caused it.
 */
export type NotifyType =
  | 'booking_invite' | 'booking_confirmed' | 'booking_starting' | 'booking_ready' | 'booking_recovered' | 'booking_cancelled' | 'booking_no_show'
  | 'scrim_challenge' | 'scrim_accepted' | 'scrim_booked' | 'scrim_taken' | 'scrim_declined'
  | 'scrim_review'
  | 'event_checkin_open' | 'event_dropped' | 'event_roster_added' | 'event_match_room' | 'event_match_forfeit'
  | 'event_match_connect' | 'event_match_result' | 'event_match_staff' | 'event_reschedule' | 'event_match_time';

export const NOTIFY_TYPES: readonly { type: NotifyType; label: string }[] = [
  { type: 'booking_invite', label: 'Someone invites me to a booked server' },
  { type: 'booking_confirmed', label: 'The other side confirms my booking' },
  { type: 'booking_starting', label: 'A booking starts in 60 and in 15 minutes' },
  { type: 'booking_ready', label: 'My booked server is ready, with the connect line' },
  { type: 'booking_recovered', label: 'My booked server restarted or moved, with the new connect line' },
  { type: 'booking_cancelled', label: 'A booking I am in is cancelled' },
  { type: 'booking_no_show', label: 'My side is recorded as a no-show' },
  { type: 'scrim_challenge', label: 'A team directly challenges mine to a scrim' },
  { type: 'scrim_accepted', label: 'Someone accepts my looking-for-scrim post' },
  { type: 'scrim_booked', label: 'My scrim accept is confirmed into a booking' },
  { type: 'scrim_taken', label: 'A scrim I accepted goes to another side instead' },
  { type: 'scrim_declined', label: 'My scrim accept is declined or expires' },
  { type: 'scrim_review', label: 'Review my scrim opponent after a booked scrim' },
  { type: 'event_checkin_open', label: 'Check-in opens for an event my team entered' },
  { type: 'event_dropped', label: 'My team\'s event entry is dropped' },
  { type: 'event_roster_added', label: 'Someone puts me on an event roster' },
  { type: 'event_match_room', label: 'My tournament match room opens: ready up and veto' },
  { type: 'event_match_forfeit', label: 'A tournament match of mine is a forfeit because a team did not ready up in the match room or did not show on the server' },
  { type: 'event_match_connect', label: 'My tournament server is ready, with the connect line' },
  { type: 'event_match_result', label: 'A tournament match of mine finished and is in its confirm window' },
  { type: 'event_match_staff', label: 'Staff act on a tournament match of mine (a freeze, a reopened veto, a replayed chapter, a moved server, more time, a released hold)' },
  { type: 'event_reschedule', label: 'A captain proposes, counters, declines or withdraws a time for a tournament match of mine, or a proposal is about to lock' },
  { type: 'event_match_time', label: 'A tournament match of mine has its time set' },
];

export function isNotifyType(v: unknown): v is NotifyType {
  return NOTIFY_TYPES.some((t) => t.type === v);
}

export function wants(db: DB, steamid: string, type: NotifyType): boolean {
  const row = db.prepare('SELECT enabled FROM notification_prefs WHERE steamid = ? AND type = ?').get(steamid, type) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function prefsOf(db: DB, steamid: string): { type: NotifyType; label: string; enabled: boolean }[] {
  return NOTIFY_TYPES.map((t) => ({ ...t, enabled: wants(db, steamid, t.type) }));
}

export function setPref(db: DB, steamid: string, type: NotifyType, enabled: boolean): void {
  db.prepare(`INSERT INTO notification_prefs (steamid, type, enabled) VALUES (?, ?, ?)
    ON CONFLICT (steamid, type) DO UPDATE SET enabled = excluded.enabled`).run(steamid, type, enabled ? 1 : 0);
}

export class Notifier {
  constructor(private readonly deps: { db: DB; dm: () => DmFn | null }) {}

  /** DM each of these players who wants `type` and has Discord linked.
   *  Returns how many DMs were started. Read per call: the bot logs in after
   *  the web starts. */
  send(steamids: Iterable<string>, type: NotifyType, payload: MessagePayload): number {
    const dm = this.deps.dm();
    if (!dm) return 0;
    let n = 0;
    for (const steamid of new Set(steamids)) {
      if (!wants(this.deps.db, steamid, type)) continue;
      const discordId = getPlayer(this.deps.db, steamid)?.discord_id;
      if (!discordId) continue;
      n++;
      void dm(discordId, payload).catch((err) => {
        console.warn(`[notify] ${type} DM to ${steamid} failed:`, err instanceof Error ? err.message : err);
      });
    }
    return n;
  }
}
