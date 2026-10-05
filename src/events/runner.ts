import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import { getTeam } from '../teams/teams.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as R from './entryRules.js';
import { eventMessage, type EventNotifyType } from './messages.js';

export const TICK_MS = 60_000;

/**
 * The events minute tick (plan T1b Ruling 4). For every team event in
 * registration or check-in whose list is not final: drop entries of
 * disbanded teams, open check-in when its window starts, and make the list
 * final when check-in closes (or at the start with check-in off). One step
 * per event per tick: an event found past both thresholds after downtime
 * opens check-in now (and says so) and closes on the next tick. Each event
 * is caught on its own, so one bad row cannot stop the rest.
 */
export class EventRunner {
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly deps: { db: DB; notifier: Notifier; publicUrl: string; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.step(new Date(this.now()));
    } catch (err) {
      console.error('[events] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  step(now: Date): void {
    const { db } = this.deps;
    const rows = db.prepare(
      "SELECT * FROM events WHERE entry_kind = 'team' AND status IN ('registration','checkin') AND locked_at IS NULL ORDER BY id",
    ).all() as E.EventRow[];
    for (const ev of rows) {
      try {
        this.stepEvent(ev, now);
      } catch (err) {
        console.error(`[events] tick for event ${ev.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private stepEvent(ev: E.EventRow, now: Date): void {
    const { db } = this.deps;
    const at = now.toISOString();
    for (const e of N.entriesOf(db, ev.id).filter(N.isActive)) {
      const team = e.team_id !== null ? getTeam(db, e.team_id) : undefined;
      if (team && team.disbanded_at !== null) N.dropDisbandedEntry(db, { entryId: e.id, now });
    }
    const f = E.fieldsOf(ev);
    if (f.checkin.enabled) {
      const { opensAt, closesAt } = R.checkinTimes(ev.starts_at, f.checkin);
      if (ev.status === 'registration' && at >= opensAt) {
        if (E.openCheckin(db, { eventId: ev.id, by: null, now }).ok) {
          for (const e of N.entriesOf(db, ev.id).filter(N.isActive)) this.tell(N.managersOf(db, e.team_id), ev.id, 'event_checkin_open', { entryId: e.id });
        }
        return;
      }
      if (ev.status === 'checkin' && at >= closesAt) this.lock(ev, now);
      return;
    }
    if (ev.status === 'registration' && at >= ev.starts_at) this.lock(ev, now);
  }

  private lock(ev: E.EventRow, now: Date): void {
    const r = N.lockEntries(this.deps.db, { eventId: ev.id, by: null, now });
    if (!r.ok) return;
    for (const d of r.value.dropped) {
      const entry = N.getEntry(this.deps.db, d.entryId);
      if (entry) this.tell(N.managersOf(this.deps.db, entry.team_id), ev.id, 'event_dropped', { entryId: d.entryId, reason: d.reason });
    }
  }

  /** A failure to word or send one notice must not stop the rest. */
  private tell(to: string[], eventId: number, type: EventNotifyType, extra: Parameters<typeof eventMessage>[4]): void {
    if (to.length === 0) return;
    try {
      const payload = eventMessage(this.deps.db, this.deps.publicUrl, eventId, type, extra);
      if (payload) this.deps.notifier.send(to, type, payload);
    } catch (err) {
      console.warn(`[events] ${type} notice for event ${eventId} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
