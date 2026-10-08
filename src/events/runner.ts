import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import { getTeam } from '../teams/teams.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as N from './entries.js';
import * as R from './entryRules.js';
import { settleEvent, startEventFlow } from './flow.js';
import * as K from './keepTeam.js';
import { KEEP_OFFER_DAYS } from './draftRules.js';
import { tellCaptainOffer, tellCheckinOpen, tellDropped, tellKeepCaptainCap, tellKeepLapsed, tellKeepOffer, tellKeepSettled } from './notices.js';
import { publishAdminEvent } from '../adminFeed.js';

export const TICK_MS = 60_000;

/**
 * The events minute tick (plan T1b Ruling 4), and, from plan T2, start
 * events at their start time and settle live ones (play). For every team
 * event in registration or check-in whose list is not final: drop entries of
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
      const now = new Date(this.now());
      this.step(now);
      await this.play(now);
    } catch (err) {
      console.error('[events] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Plan T2 Rulings 5 and 6: start every team event whose list is final and
   * whose start time has come (one with fewer than 2 entries just waits), then
   * settle every live event. Each event is caught on its own. A draft event
   * starts the same way once its teams are made (drafts plan D2a Ruling 10);
   * one without teams waits.
   */
  async play(now: Date): Promise<void> {
    const { db } = this.deps;
    const due = db.prepare(
      `SELECT id FROM events WHERE (entry_kind = 'team' OR (entry_kind = 'draft' AND teams_made_at IS NOT NULL)) AND status IN ('registration','checkin')
       AND locked_at IS NOT NULL AND starts_at <= ? ORDER BY id`,
    ).all(now.toISOString()) as { id: number }[];
    for (const { id } of due) {
      try {
        await startEventFlow(db, { eventId: id, by: null, now });
      } catch (err) {
        console.error(`[events] start of event ${id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    const live = db.prepare("SELECT id FROM events WHERE status = 'live' ORDER BY id").all() as { id: number }[];
    for (const { id } of live) {
      try {
        await settleEvent(db, { eventId: id, now });
      } catch (err) {
        console.error(`[events] settle of event ${id} failed:`, err instanceof Error ? err.message : err);
      }
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
    // Drafts plan D1 Ruling 2: close signups of draft-kind events at their
    // signupsCloseAt. A late tick closes them late, but signUp checks the
    // time itself, so nobody gets in after it.
    const drafts = db.prepare(
      "SELECT * FROM events WHERE entry_kind = 'draft' AND status = 'registration' AND locked_at IS NULL ORDER BY id",
    ).all() as E.EventRow[];
    for (const ev of drafts) {
      try {
        const close = E.fieldsOf(ev).draft?.signupsCloseAt;
        if (close && Date.parse(close) <= now.getTime()) D.closeSignups(db, { eventId: ev.id, actor: null, now });
      } catch (err) {
        console.error(`[events] closing signups of event ${ev.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    // Drafts plan D1 Ruling 6: move each running captaincy offer chain along.
    // Two mutations a tick: expire a due offer, then offer the next. Either
    // refuses quietly when it has nothing to do, so a second tick in the same
    // minute finds the offer open and makes none.
    const offering = db.prepare(
      "SELECT id, name FROM events WHERE entry_kind = 'draft' AND status IN ('registration','checkin') AND offers_on = 1 AND cut_at IS NULL ORDER BY id",
    ).all() as { id: number; name: string }[];
    for (const ev of offering) {
      try {
        this.stepOffers(ev, now);
      } catch (err) {
        console.error(`[events] captaincy offers of event ${ev.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    this.stepKeeps(now);
  }

  /** Drafts plan D3b: offer Keep this team to each finished draft team's
   *  captain within KEEP_OFFER_DAYS of the finish, close keeps past their
   *  window (telling the four when a vote ran out), and make the team for a
   *  vote that can now be made (an accepter left a team since); a vote held
   *  up by its captain's team cap tells the captain once. Each keep is caught
   *  on its own. */
  private stepKeeps(now: Date): void {
    const { db } = this.deps;
    const since = new Date(now.getTime() - KEEP_OFFER_DAYS * 86_400_000).toISOString();
    const finished = db.prepare(
      "SELECT id FROM events WHERE entry_kind = 'draft' AND status = 'finished' AND finished_at > ? ORDER BY id",
    ).all(since) as { id: number }[];
    for (const { id } of finished) {
      for (const e of N.entriesOf(db, id)) {
        if (!N.isActive(e) || e.captain_steamid === null || K.keepOfEntry(db, e.id)) continue;
        try {
          const r = K.offerKeep(db, { entryId: e.id, now });
          if (r.ok) tellKeepOffer(this.deps, id, r.value.keepId);
        } catch (err) {
          console.error(`[events] keep offer for entry ${e.id} failed:`, err instanceof Error ? err.message : err);
        }
      }
    }
    for (const k of K.openKeeps(db)) {
      try {
        if (Date.parse(k.expires_at) <= now.getTime()) {
          const c = K.closeKeep(db, { keepId: k.id, now });
          if (c.ok && c.value.from === 'voting') tellKeepLapsed(this.deps, k.event_id, k.id);
          continue;
        }
        if (k.status !== 'voting') continue;
        const s = K.settleKeep(db, { keepId: k.id, now });
        if (s.ok) tellKeepSettled(this.deps, k.event_id, k.id, s.value);
        // A captain at the team cap holds the team up: told once per keep.
        else if (s.error === 'keep_captain_cap' && K.noteKeepCaptainCap(db, { keepId: k.id, now }).ok) tellKeepCaptainCap(this.deps, k.event_id, k.id);
      } catch (err) {
        console.error(`[events] keep ${k.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private stepOffers(ev: { id: number; name: string }, now: Date): void {
    const { db } = this.deps;
    D.expireDueOffer(db, { eventId: ev.id, now });
    const r = D.offerNext(db, { eventId: ev.id, now, minutes: D.draftOfferMinutes(db) });
    if (!r.ok) return;
    if (r.value.offered) {
      tellCaptainOffer(this.deps, ev.id);
      return;
    }
    if (r.value.stopped !== 'exhausted') return;
    const row = E.getEvent(db, ev.id);
    const captains = D.activeSignups(db, ev.id).filter((s) => s.role === 'captain').length;
    publishAdminEvent({
      kind: 'problem',
      text: `Draft ${ev.name}: no more signups willing to captain; ${captains} of ${row?.draft_teams ?? 0} captains chosen.`,
      link: { label: 'Open the draft desk', path: `/admin/events/${ev.id}` },
    });
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
        if (E.openCheckin(db, { eventId: ev.id, by: null, now }).ok) tellCheckinOpen(this.deps, ev.id);
        return;
      }
      if (ev.status === 'checkin' && at >= closesAt) this.lock(ev, now);
      return;
    }
    if (ev.status === 'registration' && at >= ev.starts_at) this.lock(ev, now);
  }

  private lock(ev: E.EventRow, now: Date): void {
    const r = N.lockEntries(this.deps.db, { eventId: ev.id, by: null, now });
    if (r.ok) tellDropped(this.deps, ev.id, r.value.dropped);
  }
}
