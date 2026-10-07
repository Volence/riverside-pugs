import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import * as N from './entries.js';
import * as P from './play.js';
import { eventMessage, type EventNotifyType, type RescheduleNotice, type SignupRemoval, type StaffAction } from './messages.js';
import { getProposal } from './schedule.js';
import type { CutRole } from './draftRules.js';
import type { ReplaceReason } from './entries.js';
import { openOffer } from './drafts.js';

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
  for (const e of N.entriesOf(d.db, eventId).filter(N.isActive)) tell(d, N.entryManagers(d.db, e), eventId, 'event_checkin_open', { entryId: e.id });
}

/** The list went final: each dropped entry's managers, with its reason. */
export function tellDropped(d: NoticeDeps, eventId: number, dropped: N.LockResult['dropped']): void {
  for (const x of dropped) {
    const entry = N.getEntry(d.db, x.entryId);
    if (entry) tell(d, N.entryManagers(d.db, entry), eventId, 'event_dropped', { entryId: x.entryId, reason: x.reason });
  }
}

/** Players someone else put on a roster, each told their role. */
export function tellRosterAdded(d: NoticeDeps, eventId: number, entryId: number, by: string, added: N.Added): void {
  for (const p of added) {
    if (p.steamid !== by) tell(d, [p.steamid], eventId, 'event_roster_added', { entryId, by, role: p.role });
  }
}

/** Everyone on either roster of a match: starters, subs and coach (plan T3a
 *  Ruling 2). */
function rostersOf(d: NoticeDeps, matchId: number): string[] {
  const m = P.getMatch(d.db, matchId);
  if (!m) return [];
  return [m.entry_a, m.entry_b].flatMap((id) => {
    if (id === null) return [];
    const r = N.rosterOf(d.db, id);
    return [...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])];
  });
}

/** A match room opened: both rosters. */
export function tellRoomOpen(d: NoticeDeps, eventId: number, matchId: number): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_room', { matchId });
}
/** A match ended as a forfeit at the ready deadline, at the end of the
 *  grace to connect (why 'server', plan T3b), or at a window's end (why
 *  'window', plan T4): both rosters. */
export function tellReadyForfeit(d: NoticeDeps, eventId: number, matchId: number, why: 'ready' | 'server' | 'window' = 'ready'): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_forfeit', { matchId, why });
}
/** The connect line: only the booking's accepted people (the eight and the roster spectators), never a whole roster (T3b Global Constraints). */
export function tellConnect(d: NoticeDeps, eventId: number, matchId: number, to: string[]): void {
  tell(d, to, eventId, 'event_match_connect', { matchId });
}
/** The series is over and its confirm window open: both rosters. */
export function tellSeriesResult(d: NoticeDeps, eventId: number, matchId: number): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_result', { matchId });
}
/** A desk action (plan T3c Ruling 17): both rosters, one sentence. */
export function tellStaffAction(d: NoticeDeps, eventId: number, matchId: number, what: StaffAction, detail?: string): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_staff', { matchId, what, detail });
}
/** A proposal moved (plan T4 Ruling 11): the managers of the side that
 *  must act. A proposal, a counter and the reminder go to the other side;
 *  a decline to the side that proposed; a withdrawal to both, since the
 *  other side was waiting on it (Task 4 ruling). */
export function tellReschedule(d: NoticeDeps, eventId: number, matchId: number, what: RescheduleNotice, proposalId: number): void {
  const m = P.getMatch(d.db, matchId);
  const p = getProposal(d.db, proposalId);
  if (!m || !p || m.entry_a === null || m.entry_b === null) return;
  const sides: ('a' | 'b')[] = what === 'withdrawn' ? ['a', 'b'] : [what === 'declined' ? p.side : p.side === 'a' ? 'b' : 'a'];
  const to = sides.flatMap((side) => {
    const entry = N.getEntry(d.db, side === 'a' ? m.entry_a! : m.entry_b!);
    return entry ? N.entryManagers(d.db, entry) : [];
  });
  tell(d, [...new Set(to)], eventId, 'event_reschedule', { matchId, what, proposalId });
}
/** A time locked (accepted, auto-accepted or set by staff): both rosters. */
export function tellTimeLocked(d: NoticeDeps, eventId: number, matchId: number, staff = false): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_time', { matchId, ...(staff ? { what: 'staff' as const } : {}) });
}
/** Staff removed a draft signup (drafts plan D1 Ruling 11): that player, with why. */
export function tellSignupRemoved(d: NoticeDeps, eventId: number, steamid: string, reason: SignupRemoval): void {
  tell(d, [steamid], eventId, 'draft_signup_removed', { removal: reason });
}
/** The cut is published (drafts plan D1 Ruling 11): every active signup,
 *  told their role and the draft time. */
export function tellCutRole(d: NoticeDeps, eventId: number, cut: Record<'captains' | 'pool' | 'bench', string[]>): void {
  const groups: [CutRole, string[]][] = [['captain', cut.captains], ['pool', cut.pool], ['bench', cut.bench]];
  for (const [cutRole, to] of groups) tell(d, to, eventId, 'draft_cut_role', { cutRole });
}
/** A captaincy offer went out (drafts plan D1 Ruling 11): the event's open
 *  offer, read after it committed, so the DM names its expiry. */
export function tellCaptainOffer(d: NoticeDeps, eventId: number): void {
  const o = openOffer(d.db, eventId);
  if (o) tell(d, [o.steamid], eventId, 'draft_captain_offer', { expiresAt: o.expires_at });
}
/** Staff replaced a draft player (drafts plan D2c Ruling 6): the removed
 *  player (the reason in a few words, never the note), the replacement (the
 *  team, its captain and the event link) and the captain (who for whom). */
export function tellPlayerReplaced(d: NoticeDeps, eventId: number, entryId: number, out: string, inn: string, reason: ReplaceReason): void {
  const entry = N.getEntry(d.db, entryId);
  if (!entry || entry.captain_steamid === null) return;
  tell(d, [out], eventId, 'draft_player_removed', { entryId, replaceReason: reason });
  tell(d, [inn], eventId, 'draft_player_added', { entryId });
  tell(d, [entry.captain_steamid], eventId, 'draft_roster_changed', { entryId, out, in: inn });
}
/** A draft's teams are published (drafts plan D2a Ruling 6): every starter
 *  of each new entry, the captain with their three named, the rest with the
 *  team and its captain. */
export function tellTeamMade(d: NoticeDeps, eventId: number, entries: number[]): void {
  for (const id of entries) {
    const entry = N.getEntry(d.db, id);
    if (!entry || entry.captain_steamid === null) continue;
    const captain = entry.captain_steamid;
    tell(d, [captain], eventId, 'draft_team_made', { entryId: id, captain: true });
    tell(d, N.rosterOf(d.db, id).starters.filter((s) => s !== captain), eventId, 'draft_team_made', { entryId: id });
  }
}
