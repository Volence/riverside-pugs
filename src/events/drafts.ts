import type { DB } from '../db.js';
import * as E from './events.js';
import { playerFacts } from './entries.js';
import * as R from './entryRules.js';
import { cleanNote, cutProblems, defaultRoles, maxTeams, nextOfferee, type CutProblem } from './draftRules.js';
import { settingNumber } from '../settings.js';
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

/** The statuses a draft-kind event sits in before the draft: staff work on
 *  signups and the cut only then, never on a cancelled or finished event. */
const CUT_STATUSES: ReadonlySet<string> = new Set(['registration', 'checkin']);

/** Staff take a signup off, with a reason the player is told, until the cut
 *  is published (Ruling 4), and only while the event is before its draft.
 *  Signups need not be open. */
export function removeSignup(
  db: DB, o: { eventId: number; steamid: string; reason: 'removed' | 'ineligible'; actor: string; now: Date },
): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = draftEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.cut_at !== null) return V.fail('cut_published');
    if (!CUT_STATUSES.has(ev.status)) return V.fail('wrong_status');
    const s = signupOf(db, ev.id, o.steamid);
    if (!s) return V.fail('not_signed_up');
    db.prepare('UPDATE draft_signups SET withdrawn_at = ?, withdraw_reason = ? WHERE id = ?').run(at, o.reason, s.id);
    // Their open captaincy offer, if any, is stopped, so the runner moves on
    // at the next tick instead of waiting out the window (Ruling 6).
    db.prepare("UPDATE draft_captain_offers SET answer = 'stopped', answered_at = ? WHERE event_id = ? AND steamid = ? AND answer IS NULL").run(at, ev.id, o.steamid);
    E.logEvent(db, ev.id, o.actor, 'draft_signup_removed', at, { steamid: o.steamid, reason: o.reason });
    return V.ok(null);
  })();
}

/** Signups close: by staff, or by the minute tick at signupsCloseAt (actor
 *  null). Sets locked_at; the event stays in registration. The desk opens on
 *  the spec's default cut: floor(active / 4) teams, no captains, and pool and
 *  bench by signup order (Ruling 5). */
export function closeSignups(db: DB, o: { eventId: number; actor: string | null; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = draftEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.status !== 'registration' || ev.locked_at !== null) return V.fail('closed');
    const n = activeSignups(db, ev.id).length;
    db.prepare('UPDATE events SET locked_at = ?, draft_teams = ?, updated_at = ? WHERE id = ?').run(at, maxTeams(n), at, ev.id);
    recompute(db, ev.id, maxTeams(n));
    E.logEvent(db, ev.id, o.actor, 'draft_signups_closed', at, { by: o.actor ?? 'clock', signups: n });
    return V.ok(null);
  })();
}

/**
 * The cut (Rulings 4 and 5). The working cut is each active signup's role
 * plus events.draft_teams; nobody but staff sees it until publishCut stamps
 * cut_at. Changing the team count or a captain recomputes pool and bench from
 * signup order and clears hand swaps; a swap marks both players role_manual.
 */

/** A closed, unpublished draft whose cut staff may work on. */
function cutOpen(db: DB, eventId: number): V.Checked<E.EventRow> {
  const found = draftEvent(db, eventId);
  if (!found.ok) return found;
  const ev = found.value;
  if (ev.cut_at !== null) return V.fail('cut_published');
  if (ev.locked_at === null) return V.fail('not_closed');
  if (!CUT_STATUSES.has(ev.status)) return V.fail('wrong_status');
  return V.ok(ev);
}

/** Ruling 5: defaultRoles over the active signups with the current captains
 *  (role 'captain'), every role_manual back to 0. */
function recompute(db: DB, eventId: number, teams: number): void {
  const all = activeSignups(db, eventId);
  const roles = defaultRoles(all, new Set(all.filter((s) => s.role === 'captain').map((s) => s.steamid)), teams);
  const set = db.prepare('UPDATE draft_signups SET role = ?, role_manual = 0 WHERE id = ?');
  for (const s of all) set.run(roles.get(s.steamid)!, s.id);
}

/** setCaptain's change, inside the caller's transaction (answerOffer's
 *  accept runs it too, so that is one log row): the role, then pool and
 *  bench recomputed from signup order. */
function makeCaptain(db: DB, ev: E.EventRow, s: SignupRow, captain: boolean): void {
  if (captain) db.prepare("UPDATE draft_signups SET role = 'captain' WHERE id = ?").run(s.id);
  else if (s.role === 'captain') db.prepare('UPDATE draft_signups SET role = NULL WHERE id = ?').run(s.id);
  recompute(db, ev.id, ev.draft_teams ?? 0);
}

export function setDraftTeams(db: DB, o: { eventId: number; teams: number; actor: string; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = cutOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (!Number.isInteger(o.teams) || o.teams < 2 || o.teams > maxTeams(activeSignups(db, ev.id).length)) return V.fail('bad_team_count');
    db.prepare('UPDATE events SET draft_teams = ?, updated_at = ? WHERE id = ?').run(o.teams, at, ev.id);
    recompute(db, ev.id, o.teams);
    E.logEvent(db, ev.id, o.actor, 'draft_teams_set', at, { teams: o.teams, from: ev.draft_teams });
    return V.ok(null);
  })();
}

/** Staff make a signup a captain or take it back (Ruling 1: anyone, whatever
 *  their preference). */
export function setCaptain(db: DB, o: { eventId: number; steamid: string; captain: boolean; actor: string; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = cutOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    const s = signupOf(db, ev.id, o.steamid);
    if (!s) return V.fail('not_signed_up');
    makeCaptain(db, ev, s, o.captain);
    E.logEvent(db, ev.id, o.actor, 'draft_captain_set', at, { steamid: o.steamid, captain: o.captain });
    return V.ok(null);
  })();
}

/** One pool player to the bench and one bench player into the pool, by hand.
 *  It lasts until the next team-count or captain change (Ruling 5). */
export function swapPoolBench(db: DB, o: { eventId: number; poolSteamid: string; benchSteamid: string; actor: string; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = cutOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    const out = signupOf(db, ev.id, o.poolSteamid);
    const into = signupOf(db, ev.id, o.benchSteamid);
    if (!out || !into) return V.fail('not_signed_up');
    if (out.role !== 'pool' || into.role !== 'bench') return V.fail('bad_swap');
    const set = db.prepare('UPDATE draft_signups SET role = ?, role_manual = 1 WHERE id = ?');
    set.run('bench', out.id);
    set.run('pool', into.id);
    E.logEvent(db, ev.id, o.actor, 'draft_swap', at, { toBench: o.poolSteamid, toPool: o.benchSteamid });
    return V.ok(null);
  })();
}

/** The working cut's counts and what keeps it from publishing. Eligibility is
 *  T1b's starter rule (Ruling 7), read fresh at `now`. */
export interface CutState {
  teams: number | null; maxTeams: number; active: number; captains: number; pool: number; poolNeeded: number; bench: number;
  unassigned: number; ineligible: V.EntryProblem[]; problems: CutProblem[];
}
export function cutState(db: DB, eventId: number, now: Date): CutState {
  const ev = E.getEvent(db, eventId);
  if (!ev) throw new Error(`no event ${eventId}`);
  const elig = E.fieldsOf(ev).eligibility;
  const all = activeSignups(db, ev.id);
  const count = (r: SignupRow['role']) => all.filter((s) => s.role === r).length;
  const ineligible = all.flatMap((s): V.EntryProblem[] => {
    const facts = playerFacts(db, s.steamid, now);
    const p = R.problemsOf(elig, facts, 'starter');
    return p.length > 0 ? [{ steamid: s.steamid, problems: p.map((k) => R.problemText(k, elig, facts)) }] : [];
  });
  const c = {
    teams: ev.draft_teams, maxTeams: maxTeams(all.length), active: all.length,
    captains: count('captain'), pool: count('pool'), poolNeeded: (ev.draft_teams ?? 0) * 3, bench: count('bench'), unassigned: count(null),
  };
  return { ...c, ineligible, problems: cutProblems({ ...c, ineligible: ineligible.length }) };
}

export interface PublishedCut { captains: string[]; pool: string[]; bench: string[] }
/** publishCut's refusal when the cut is not publishable: the problems and
 *  counts, re-derived inside its transaction (Review Focus 3). */
export interface CutChanged { ok: false; error: 'cut_changed'; cut: CutState }

/** Publish the cut once (Ruling 4): every check again inside the
 *  transaction, then cut_at, the offer chain off and any open offer stopped.
 *  The route DMs every signup their role after it commits. */
export function publishCut(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<PublishedCut> | CutChanged {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<PublishedCut> | CutChanged => {
    const found = cutOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    const state = cutState(db, ev.id, o.now);
    if (state.problems.length > 0) return { ok: false, error: 'cut_changed', cut: state };
    const all = activeSignups(db, ev.id);
    const of = (r: SignupRow['role']) => all.filter((s) => s.role === r).map((s) => s.steamid);
    const cut = { captains: of('captain'), pool: of('pool'), bench: of('bench') };
    db.prepare('UPDATE events SET cut_at = ?, offers_on = 0, updated_at = ? WHERE id = ?').run(at, at, ev.id);
    db.prepare("UPDATE draft_captain_offers SET answer = 'stopped', answered_at = ? WHERE event_id = ? AND answer IS NULL").run(at, ev.id);
    E.logEvent(db, ev.id, o.actor, 'draft_cut_published', at, { captains: cut.captains.length, pool: cut.pool.length, bench: cut.bench.length });
    return V.ok(cut);
  })();
}

/**
 * Captaincy offers (Ruling 6, Review Focus 4). Staff start them once; then
 * the minute tick calls expireDueOffer and offerNext in turn for every draft
 * with offers on and the cut unpublished, so each tick is two mutations of
 * one log row each. One offer is open at a time (the partial unique index
 * draft_offers_open), each to the next nextOfferee, never to anyone offered
 * before in this event. The chain stops when the captains reach the team
 * count (offerNext refuses offers_not_needed and does nothing; publishCut
 * turns offers_on off later), when staff stop it, when nobody is left
 * (offers_on off, and the runner tells the admin feed) or at publish.
 */

/** draft_offer_minutes, read through settingNumber (5 to 240, default 30). */
export function draftOfferMinutes(db: DB): number {
  return settingNumber(db, 'draft_offer_minutes', 30, { min: 5, max: 240, integer: true });
}

type OfferRow = { id: number; steamid: string; expires_at: string };
const openOfferOf = (db: DB, eventId: number): OfferRow | null =>
  (db.prepare('SELECT id, steamid, expires_at FROM draft_captain_offers WHERE event_id = ? AND answer IS NULL').get(eventId) as OfferRow | undefined) ?? null;
const captainCount = (db: DB, eventId: number) => activeSignups(db, eventId).filter((s) => s.role === 'captain').length;

/** nextOfferee over the active signups, with SR and eligibility read fresh. */
function pickOfferee(db: DB, ev: E.EventRow, now: Date): string | null {
  const elig = E.fieldsOf(ev).eligibility;
  const rows = activeSignups(db, ev.id).map((s) => {
    const facts = playerFacts(db, s.steamid, now);
    return { steamid: s.steamid, captainPref: s.captain_pref, sr: facts.sr, role: s.role, eligible: R.problemsOf(elig, facts, 'starter').length === 0 };
  });
  const offered = new Set((db.prepare('SELECT steamid FROM draft_captain_offers WHERE event_id = ?').all(ev.id) as { steamid: string }[]).map((r) => r.steamid));
  return nextOfferee(rows, offered);
}

function insertOffer(db: DB, eventId: number, steamid: string, now: Date, minutes: number): void {
  db.prepare('INSERT INTO draft_captain_offers (event_id, steamid, offered_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(eventId, steamid, now.toISOString(), new Date(now.getTime() + minutes * 60_000).toISOString());
}

/** Staff press Offer captaincy: offers on, and the first offer now, in one
 *  transaction. With nobody willing left, offered is null and offers stay
 *  on, so the next tick's offerNext turns them off and the runner tells the
 *  admin feed, as any other run-out. The route DMs the offeree. */
export function startOffers(db: DB, o: { eventId: number; actor: string; now: Date; minutes: number }): V.Checked<{ offered: string | null }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ offered: string | null }> => {
    const found = cutOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.offers_on === 1) return V.fail('offers_on');
    if (captainCount(db, ev.id) >= (ev.draft_teams ?? 0)) return V.fail('offers_not_needed');
    db.prepare('UPDATE events SET offers_on = 1, updated_at = ? WHERE id = ?').run(at, ev.id);
    const first = openOfferOf(db, ev.id) ? null : pickOfferee(db, ev, o.now);
    if (first) insertOffer(db, ev.id, first, o.now, o.minutes);
    E.logEvent(db, ev.id, o.actor, 'draft_offers_started', at, { first });
    return V.ok({ offered: first });
  })();
}

/** Staff press Stop offers: offers off, and the open offer, if any, stopped. */
export function stopOffers(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = cutOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.offers_on !== 1) return V.fail('offers_off');
    const open = openOfferOf(db, ev.id);
    db.prepare('UPDATE events SET offers_on = 0, updated_at = ? WHERE id = ?').run(at, ev.id);
    if (open) db.prepare("UPDATE draft_captain_offers SET answer = 'stopped', answered_at = ? WHERE id = ?").run(at, open.id);
    E.logEvent(db, ev.id, o.actor, 'draft_offers_stopped', at, { stopped: open?.steamid ?? null });
    return V.ok(null);
  })();
}

/**
 * The offered player accepts or declines on the event page. An accept makes
 * them a captain even when the count has since been met or lowered (Review
 * Focus 4): publish's too_many_captains then makes staff choose. An answer
 * at or after expires_at that the tick has not yet expired is refused
 * offer_expired, and the expiry is recorded here, the one refusal of this
 * module that writes: the offer reads expired with one draft_offer_expired
 * row, exactly as the tick would have written it.
 */
export function answerOffer(db: DB, o: { eventId: number; steamid: string; accept: boolean; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = cutOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    const open = openOfferOf(db, ev.id);
    const s = signupOf(db, ev.id, o.steamid);
    if (!open || open.steamid !== o.steamid || !s) return V.fail('no_offer');
    if (o.now.getTime() >= Date.parse(open.expires_at)) {
      db.prepare("UPDATE draft_captain_offers SET answer = 'expired', answered_at = ? WHERE id = ?").run(at, open.id);
      E.logEvent(db, ev.id, null, 'draft_offer_expired', at, { steamid: open.steamid, answered: true });
      return V.fail('offer_expired');
    }
    db.prepare('UPDATE draft_captain_offers SET answer = ?, answered_at = ? WHERE id = ?').run(o.accept ? 'accept' : 'decline', at, open.id);
    if (o.accept) makeCaptain(db, ev, s, true);
    E.logEvent(db, ev.id, o.steamid, 'draft_offer_answered', at, { steamid: o.steamid, accept: o.accept });
    return V.ok(null);
  })();
}

/** The tick, first half: the open offer, once due, is expired. no_offer when
 *  there is none or it is not yet due. */
export function expireDueOffer(db: DB, o: { eventId: number; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const found = draftEvent(db, o.eventId);
    if (!found.ok) return found;
    const open = openOfferOf(db, o.eventId);
    if (!open || Date.parse(open.expires_at) > o.now.getTime()) return V.fail('no_offer');
    db.prepare("UPDATE draft_captain_offers SET answer = 'expired', answered_at = ? WHERE id = ?").run(at, open.id);
    E.logEvent(db, o.eventId, null, 'draft_offer_expired', at, { steamid: open.steamid });
    return V.ok(null);
  })();
}

/** The tick, second half: while offers are on, no offer is open and the
 *  captains are fewer than the teams, offer the next willing signup; with
 *  nobody left, offers off and offered null (the runner alerts the admin
 *  feed). A refusal (offers_off, offer_open, offers_not_needed or a cut
 *  refusal) writes nothing and the runner does nothing. */
export function offerNext(db: DB, o: { eventId: number; now: Date; minutes: number }): V.Checked<{ offered: string | null }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ offered: string | null }> => {
    const found = cutOpen(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.offers_on !== 1) return V.fail('offers_off');
    if (openOfferOf(db, ev.id)) return V.fail('offer_open');
    const captains = captainCount(db, ev.id);
    const teams = ev.draft_teams ?? 0;
    if (captains >= teams) return V.fail('offers_not_needed');
    const next = pickOfferee(db, ev, o.now);
    if (next) {
      insertOffer(db, ev.id, next, o.now, o.minutes);
      E.logEvent(db, ev.id, null, 'draft_offer_made', at, { steamid: next });
    } else {
      db.prepare('UPDATE events SET offers_on = 0, updated_at = ? WHERE id = ?').run(at, ev.id);
      E.logEvent(db, ev.id, null, 'draft_offers_exhausted', at, { captains, teams });
    }
    return V.ok({ offered: next });
  })();
}
