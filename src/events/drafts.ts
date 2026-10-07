import type { DB } from '../db.js';
import * as E from './events.js';
import { playerFacts } from './entries.js';
import * as R from './entryRules.js';
import { cleanNote } from './draftRules.js';
import * as V from './validate.js';

/**
 * Every write to draft_signups and draft_captain_offers, and to the draft
 * columns of events (locked_at for a draft-kind event, draft_teams, cut_at,
 * offers_on), for drafts plan D1. Same shape as src/events/entries.ts: each
 * mutation is one transaction that re-reads, checks inside, writes, and adds
 * exactly one event_log row before it commits; a refusal writes nothing.
 * tests/eventLogGuard.test.ts pins both.
 *
 * Only draft-kind events (entry_kind 'draft') go through here. Signups are
 * open while the event is in registration, its locked_at is NULL and the
 * clock is before signupsCloseAt (Ruling 2): the clock check is made here
 * too, so a late minute tick never lets a signup in after the close.
 */

export type CaptainPref = 'want' | 'willing' | 'no';
export const CAPTAIN_PREFS: readonly CaptainPref[] = ['want', 'willing', 'no'];
export interface SignupRow {
  id: number; event_id: number; steamid: string; captain_pref: CaptainPref; note: string | null; created_at: string;
  withdrawn_at: string | null; withdraw_reason: 'withdrawn' | 'removed' | 'ineligible' | null;
  role: 'captain' | 'pool' | 'bench' | null; role_manual: number;
}

/** Active signups in signup order (created_at, then id). */
export function activeSignups(db: DB, eventId: number): SignupRow[] {
  return db.prepare('SELECT * FROM draft_signups WHERE event_id = ? AND withdrawn_at IS NULL ORDER BY created_at, id').all(eventId) as SignupRow[];
}

/** The player's active signup, if any. */
export function signupOf(db: DB, eventId: number, steamid: string): SignupRow | null {
  return (db.prepare('SELECT * FROM draft_signups WHERE event_id = ? AND steamid = ? AND withdrawn_at IS NULL')
    .get(eventId, steamid) as SignupRow | undefined) ?? null;
}

/** A published draft-kind event, or the refusal. */
function draftEvent(db: DB, eventId: number): V.Checked<E.EventRow> {
  const ev = E.getEvent(db, eventId);
  if (!ev || ev.status === 'draft') return V.fail('not_found');
  if (ev.entry_kind !== 'draft') return V.fail('not_draft');
  return V.ok(ev);
}

/** Ruling 2: open in registration, before the list is locked and before the
 *  signup close time. */
function signupsOpen(ev: E.EventRow, now: Date): boolean {
  const close = E.fieldsOf(ev).draft?.signupsCloseAt;
  return ev.status === 'registration' && ev.locked_at === null && !!close && now.getTime() < Date.parse(close);
}

export function signUp(
  db: DB, o: { eventId: number; steamid: string; captainPref: CaptainPref; note: string | null; now: Date },
): V.Checked<SignupRow> {
  const at = o.now.toISOString();
  if (!CAPTAIN_PREFS.includes(o.captainPref)) return V.fail('bad_captain_pref');
  const note = cleanNote(o.note);
  if (note === 'bad') return V.fail('bad_note');
  return db.transaction((): V.Checked<SignupRow> => {
    const found = draftEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (!signupsOpen(ev, o.now)) return V.fail('closed');
    const elig = E.fieldsOf(ev).eligibility;
    const facts = playerFacts(db, o.steamid, o.now);
    const problems = R.problemsOf(elig, facts, 'starter');
    if (problems.length > 0) return V.fail('ineligible', [{ steamid: o.steamid, problems: problems.map((p) => R.problemText(p, elig, facts)) }]);
    if (signupOf(db, ev.id, o.steamid)) return V.fail('already_signed_up');
    const id = Number(db.prepare(
      'INSERT INTO draft_signups (event_id, steamid, captain_pref, note, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(ev.id, o.steamid, o.captainPref, note, at).lastInsertRowid);
    // The note is private (Ruling 10), so it stays out of the log.
    E.logEvent(db, ev.id, o.steamid, 'draft_signup', at, { steamid: o.steamid, captainPref: o.captainPref });
    return V.ok(db.prepare('SELECT * FROM draft_signups WHERE id = ?').get(id) as SignupRow);
  })();
}

/** The player's own withdrawal, while signups are open. */
export function withdrawSignup(db: DB, o: { eventId: number; steamid: string; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = draftEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (!signupsOpen(ev, o.now)) return V.fail('closed');
    const s = signupOf(db, ev.id, o.steamid);
    if (!s) return V.fail('not_signed_up');
    db.prepare("UPDATE draft_signups SET withdrawn_at = ?, withdraw_reason = 'withdrawn' WHERE id = ?").run(at, s.id);
    E.logEvent(db, ev.id, o.steamid, 'draft_withdraw', at, { steamid: o.steamid });
    return V.ok(null);
  })();
}

/** Staff take a signup off, with a reason the player is told, until the cut
 *  is published (Ruling 4). Signups need not be open. */
export function removeSignup(
  db: DB, o: { eventId: number; steamid: string; reason: 'removed' | 'ineligible'; actor: string; now: Date },
): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = draftEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.cut_at !== null) return V.fail('cut_published');
    const s = signupOf(db, ev.id, o.steamid);
    if (!s) return V.fail('not_signed_up');
    db.prepare('UPDATE draft_signups SET withdrawn_at = ?, withdraw_reason = ? WHERE id = ?').run(at, o.reason, s.id);
    E.logEvent(db, ev.id, o.actor, 'draft_signup_removed', at, { steamid: o.steamid, reason: o.reason });
    return V.ok(null);
  })();
}

/** Signups close: by staff, or by the minute tick at signupsCloseAt (actor
 *  null). Sets locked_at; the event stays in registration. */
export function closeSignups(db: DB, o: { eventId: number; actor: string | null; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = draftEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.status !== 'registration' || ev.locked_at !== null) return V.fail('closed');
    db.prepare('UPDATE events SET locked_at = ?, updated_at = ? WHERE id = ?').run(at, at, ev.id);
    E.logEvent(db, ev.id, o.actor, 'draft_signups_closed', at, { by: o.actor ?? 'clock', signups: activeSignups(db, ev.id).length });
    return V.ok(null);
  })();
}
