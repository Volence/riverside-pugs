import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import * as N from './entries.js';
import { eventMessage, type EventNotifyType } from './messages.js';

/**
 * The event DMs (plan T1b Ruling 11), shared by the minute tick
 * (src/events/runner.ts), the public entry routes and the Events desk, so a
 * step taken by hand on the desk tells the same people as the clock does.
 * Called after the change has committed. A failure to word or send one
 * notice is logged and never stops the rest or fails the caller.
 */
export interface NoticeDeps { db: DB; notifier?: Notifier; publicUrl?: string }

function tell(d: NoticeDeps, to: string[], eventId: number, type: EventNotifyType, extra: Parameters<typeof eventMessage>[4]): void {
  if (!d.notifier || to.length === 0) return;
  try {
    const payload = eventMessage(d.db, d.publicUrl ?? '', eventId, type, extra);
    if (payload) d.notifier.send(to, type, payload);
  } catch (err) {
    console.warn(`[events] ${type} notice for event ${eventId} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Check-in opened: the captain and co-captains of every active entry. */
export function tellCheckinOpen(d: NoticeDeps, eventId: number): void {
  for (const e of N.entriesOf(d.db, eventId).filter(N.isActive)) tell(d, N.managersOf(d.db, e.team_id), eventId, 'event_checkin_open', { entryId: e.id });
}

/** The list went final: each dropped entry's managers, with its reason. */
export function tellDropped(d: NoticeDeps, eventId: number, dropped: N.LockResult['dropped']): void {
  for (const x of dropped) {
    const entry = N.getEntry(d.db, x.entryId);
    if (entry) tell(d, N.managersOf(d.db, entry.team_id), eventId, 'event_dropped', { entryId: x.entryId, reason: x.reason });
  }
}

/** Players someone else put on a roster, each told their role. */
export function tellRosterAdded(d: NoticeDeps, eventId: number, entryId: number, by: string, added: N.Added): void {
  for (const p of added) {
    if (p.steamid !== by) tell(d, [p.steamid], eventId, 'event_roster_added', { entryId, by, role: p.role });
  }
}
