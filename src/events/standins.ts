import type { DB } from '../db.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as N from './entries.js';
import * as R from './entryRules.js';
import { standinMarginOf, standinOrder, type BenchCandidate } from './draftRules.js';
import * as V from './validate.js';

/**
 * Bench stand-ins (drafts plan D3a): every write to draft_standins and
 * draft_standin_offers. Same shape as src/events/drafts.ts: each mutation is
 * one transaction that re-reads, checks, writes and adds exactly one
 * event_log row; a refusal writes nothing (declineStandinOffer's late answer
 * records the expiry, as D1's answerOffer does). markPlaced and markEnded are
 * write helpers for src/events/entries.ts, called only inside its own logged
 * transactions (placeStandin, endStandin).
 *
 * A request is one missing starter of one draft team: 'match' for the team's
 * next unfinished match (stored in match_id), 'event' for the rest of the
 * event. The bench is offered one player at a time (Rulings 3 and 5).
 */

export type StandinScope = 'match' | 'event';
export const STANDIN_SCOPES: readonly StandinScope[] = ['match', 'event'];
export type StandinStatus = 'open' | 'filled' | 'unfilled' | 'cancelled' | 'ended';
export interface StandinRow {
  id: number; event_id: number; entry_id: number; out_steamid: string; scope: StandinScope; match_id: number | null;
  margin: number; margin_off: number; status: StandinStatus; requested_by: string; requested_at: string;
  filled_by: string | null; closed_at: string | null;
}
export interface StandinOfferRow {
  id: number; request_id: number; steamid: string; offered_at: string; expires_at: string;
  answer: 'accept' | 'decline' | 'expired' | 'stopped' | 'failed' | null; answered_at: string | null;
}
/** What offerNextStandin did: an offer made, the request closed unfilled (nobody left), or cancelled (it no longer stands, with why). */
export interface StandinStep { offerId: number | null; offered: string | null; unfilled: boolean; cancelled: V.EventError | null }

/** Event statuses stand-ins are open in, once the teams are made. */
const STANDIN_OPEN: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['registration', 'checkin', 'live']);
/** Whether stand-ins can be asked for or offered in this event right now (the one definition every caller uses). */
export function standinsOpen(ev: { status: V.EventStatus; teams_made_at: string | null }): boolean {
  return ev.teams_made_at !== null && STANDIN_OPEN.has(ev.status);
}
const RESOLVED_SQL = "('done','forfeit','bye')";

// ---------- reads ----------

export function requestOf(db: DB, id: number): StandinRow | undefined {
  return db.prepare('SELECT * FROM draft_standins WHERE id = ?').get(id) as StandinRow | undefined;
}
export function offerOf(db: DB, id: number): StandinOfferRow | undefined {
  return db.prepare('SELECT * FROM draft_standin_offers WHERE id = ?').get(id) as StandinOfferRow | undefined;
}
export function openOfferOf(db: DB, requestId: number): StandinOfferRow | undefined {
  return db.prepare('SELECT * FROM draft_standin_offers WHERE request_id = ? AND answer IS NULL').get(requestId) as StandinOfferRow | undefined;
}
export function openRequestFor(db: DB, entryId: number, out: string): StandinRow | undefined {
  return db.prepare("SELECT * FROM draft_standins WHERE entry_id = ? AND out_steamid = ? AND status = 'open'").get(entryId, out) as StandinRow | undefined;
}
export function requestsOf(db: DB, eventId: number): StandinRow[] {
  return db.prepare('SELECT * FROM draft_standins WHERE event_id = ? ORDER BY id').all(eventId) as StandinRow[];
}
export function offersOf(db: DB, requestId: number): StandinOfferRow[] {
  return db.prepare('SELECT * FROM draft_standin_offers WHERE request_id = ? ORDER BY id').all(requestId) as StandinOfferRow[];
}
/** Every open request, for the tick. */
export function openRequests(db: DB): StandinRow[] {
  return db.prepare("SELECT * FROM draft_standins WHERE status = 'open' ORDER BY id").all() as StandinRow[];
}
/** Filled match stand-ins whose match is over (done, forfeit, bye, or gone)
 *  or whose event ended: the tick ends them (Ruling 7). */
export function endableStandins(db: DB): StandinRow[] {
  return db.prepare(
    `SELECT r.* FROM draft_standins r JOIN events e ON e.id = r.event_id LEFT JOIN event_matches m ON m.id = r.match_id
      WHERE r.status = 'filled' AND r.scope = 'match'
        AND (m.id IS NULL OR m.status IN ${RESOLVED_SQL} OR e.status IN ('finished','cancelled')) ORDER BY r.id`,
  ).all() as StandinRow[];
}
/** The filled match stand-ins of this team for this match: who sits out, who plays. */
export function matchStandins(db: DB, matchId: number, entryId: number): { out: string; in: string }[] {
  return db.prepare(
    "SELECT out_steamid AS out, filled_by AS \"in\" FROM draft_standins WHERE match_id = ? AND entry_id = ? AND scope = 'match' AND status = 'filled' ORDER BY id",
  ).all(matchId, entryId) as { out: string; in: string }[];
}
/** Ruling 2: the team's next unfinished match (stage order, round, id), or null. */
export function nextMatchOf(db: DB, eventId: number, entryId: number): number | null {
  const row = db.prepare(
    `SELECT m.id FROM event_matches m JOIN event_stages s ON s.id = m.stage_id
      WHERE m.event_id = ? AND (m.entry_a = ? OR m.entry_b = ?) AND m.status NOT IN ${RESOLVED_SQL}
      ORDER BY s.ordinal, m.round, m.id LIMIT 1`,
  ).get(eventId, entryId, entryId) as { id: number } | undefined;
  return row?.id ?? null;
}
/** How many times this request has gone unfilled (Ruling 10: the stranded note is written the first time only). */
export function unfilledCount(db: DB, requestId: number): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM event_log WHERE action = 'standin_unfilled' AND json_extract(detail, '$.requestId') = ?",
  ).get(requestId) as { n: number }).n;
}
/** Ruling 7: a four with each missing player swapped for their stand-in, never putting a player in twice. */
export function withStandins(four: readonly string[], swaps: readonly { out: string; in: string }[]): string[] {
  return four.map((s) => swaps.find((x) => x.out === s && !four.includes(x.in))?.in ?? s);
}

// ---------- mutations ----------

/** Why an open request no longer stands, or null. Inside the caller's transaction. */
function requestGone(db: DB, req: StandinRow): V.EventError | null {
  const ev = E.getEvent(db, req.event_id);
  if (!ev || !standinsOpen(ev)) return 'standins_closed';
  const entry = N.getEntry(db, req.entry_id);
  if (!entry || !N.isActive(entry)) return 'entry_out';
  if (!N.placesOf(db, entry.id).some((p) => p.steamid === req.out_steamid && p.role === 'starter')) return 'replace_not_starter';
  if (req.scope === 'match') {
    const m = db.prepare('SELECT status FROM event_matches WHERE id = ?').get(req.match_id) as { status: string } | undefined;
    if (!m || ['done', 'forfeit', 'bye'].includes(m.status)) return 'standin_match_over';
  }
  return null;
}

/** Ruling 3: the next bench player for this request, or null. */
function pickStandin(db: DB, req: StandinRow, now: Date): string | null {
  const ev = E.getEvent(db, req.event_id)!;
  const elig = E.fieldsOf(ev).eligibility;
  const busy = new Set((db.prepare(
    `SELECT o.steamid FROM draft_standin_offers o JOIN draft_standins r ON r.id = o.request_id
      WHERE r.event_id = ? AND o.answer IS NULL`,
  ).all(ev.id) as { steamid: string }[]).map((r) => r.steamid));
  const bench: BenchCandidate[] = D.activeSignups(db, ev.id).flatMap((s, order) => {
    if (s.role !== 'bench') return [];
    const facts = N.playerFacts(db, s.steamid, now);
    return [{
      steamid: s.steamid, sr: facts.sr, order,
      eligible: R.problemsOf(elig, facts, 'starter').length === 0,
      busy: busy.has(s.steamid) || N.entryOfPlayer(db, ev.id, s.steamid) !== undefined,
    }];
  });
  const offered = new Set(offersOf(db, req.id).map((x) => x.steamid));
  const outSr = N.playerFacts(db, req.out_steamid, now).sr;
  return standinOrder(bench, outSr, req.margin_off === 1 ? null : req.margin, offered)[0] ?? null;
}

/** Rulings 1 and 2: a captain (or staff) asks the bench for a stand-in for
 *  one starter of a draft team, any time from teams made until the event ends. */
export function requestStandin(db: DB, o: { eventId: number; entryId: number; out: string; scope: unknown; by: string; staff: boolean; now: Date }): V.Checked<{ requestId: number }> {
  if (!STANDIN_SCOPES.includes(o.scope as StandinScope)) return V.fail('standin_scope');
  const scope = o.scope as StandinScope;
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ requestId: number }> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev || ev.status === 'draft') return V.fail('not_found');
    const entry = N.getEntry(db, o.entryId);
    if (!entry || entry.event_id !== ev.id) return V.fail('entry_not_found');
    if (ev.entry_kind !== 'draft' || entry.captain_steamid === null) return V.fail('replace_not_draft');
    if (!standinsOpen(ev)) return V.fail('standins_closed');
    if (!N.isActive(entry)) return V.fail('entry_out');
    if (!o.staff && !N.entryManagers(db, entry).includes(o.by)) return V.fail('not_manager');
    if (!N.placesOf(db, entry.id).some((p) => p.steamid === o.out && p.role === 'starter')) return V.fail('replace_not_starter');
    if (scope === 'event' && o.out === entry.captain_steamid) return V.fail('standin_captain');
    const matchId = scope === 'match' ? nextMatchOf(db, ev.id, entry.id) : null;
    if (scope === 'match' && matchId === null) return V.fail('standin_no_match');
    if (openRequestFor(db, entry.id, o.out)) return V.fail('standin_open');
    const id = Number(db.prepare(
      `INSERT INTO draft_standins (event_id, entry_id, out_steamid, scope, match_id, margin, status, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(ev.id, entry.id, o.out, scope, matchId, standinMarginOf(ev.draft_json), o.by, at).lastInsertRowid);
    E.logEvent(db, ev.id, o.by, 'standin_requested', at, { requestId: id, entryId: entry.id, out: o.out, scope, matchId, staff: o.staff });
    return V.ok({ requestId: id });
  })();
}

/** The chain's step (Ruling 5): while the request is open and has no open
 *  offer, offer the next bench player for `minutes`; with nobody left, close
 *  it unfilled; when it no longer stands (the player left the team, the match
 *  or the event is over), close it cancelled. */
export function offerNextStandin(db: DB, o: { requestId: number; now: Date; minutes: number }): V.Checked<StandinStep> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<StandinStep> => {
    const req = requestOf(db, o.requestId);
    if (!req || req.status !== 'open') return V.fail('standin_closed');
    if (openOfferOf(db, req.id)) return V.fail('standin_offer_open');
    const gone = requestGone(db, req);
    if (gone) {
      db.prepare("UPDATE draft_standins SET status = 'cancelled', closed_at = ? WHERE id = ?").run(at, req.id);
      E.logEvent(db, req.event_id, null, 'standin_cancelled', at, { requestId: req.id, why: gone });
      return V.ok({ offerId: null, offered: null, unfilled: false, cancelled: gone });
    }
    const next = pickStandin(db, req, o.now);
    if (next) {
      const offerId = Number(db.prepare('INSERT INTO draft_standin_offers (request_id, steamid, offered_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(req.id, next, at, new Date(o.now.getTime() + o.minutes * 60_000).toISOString()).lastInsertRowid);
      E.logEvent(db, req.event_id, null, 'standin_offered', at, { requestId: req.id, steamid: next });
      return V.ok({ offerId, offered: next, unfilled: false, cancelled: null });
    }
    db.prepare("UPDATE draft_standins SET status = 'unfilled', closed_at = ? WHERE id = ?").run(at, req.id);
    E.logEvent(db, req.event_id, null, 'standin_unfilled', at, { requestId: req.id, entryId: req.entry_id, out: req.out_steamid, scope: req.scope });
    return V.ok({ offerId: null, offered: null, unfilled: true, cancelled: null });
  })();
}

/** The tick: the request's open offer, once due, is expired. */
export function expireStandinOffer(db: DB, o: { requestId: number; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const open = openOfferOf(db, o.requestId);
    if (!open || Date.parse(open.expires_at) > o.now.getTime()) return V.fail('standin_offer_gone');
    const req = requestOf(db, open.request_id)!;
    db.prepare("UPDATE draft_standin_offers SET answer = 'expired', answered_at = ? WHERE id = ?").run(at, open.id);
    E.logEvent(db, req.event_id, null, 'standin_offer_expired', at, { requestId: req.id, steamid: open.steamid });
    return V.ok(null);
  })();
}

/** The offered player says no. An answer at or after the window that the
 *  tick has not expired yet is refused standin_offer_expired, and the expiry
 *  is recorded here, as the tick would have (D1's answerOffer does the same). */
export function declineStandinOffer(db: DB, o: { offerId: number; steamid: string; now: Date }): V.Checked<{ requestId: number }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ requestId: number }> => {
    const offer = offerOf(db, o.offerId);
    if (!offer || offer.steamid !== o.steamid || offer.answer !== null) return V.fail('standin_offer_gone');
    const req = requestOf(db, offer.request_id)!;
    if (o.now.getTime() >= Date.parse(offer.expires_at)) {
      db.prepare("UPDATE draft_standin_offers SET answer = 'expired', answered_at = ? WHERE id = ?").run(at, offer.id);
      E.logEvent(db, req.event_id, null, 'standin_offer_expired', at, { requestId: req.id, steamid: offer.steamid, answered: true });
      return V.fail('standin_offer_expired');
    }
    db.prepare("UPDATE draft_standin_offers SET answer = 'decline', answered_at = ? WHERE id = ?").run(at, offer.id);
    E.logEvent(db, req.event_id, o.steamid, 'standin_declined', at, { requestId: req.id, steamid: o.steamid });
    return V.ok({ requestId: req.id });
  })();
}

/** The captain (or staff) no longer needs it: the request closes and its open offer stops. */
export function cancelStandin(db: DB, o: { requestId: number; by: string; staff: boolean; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const req = requestOf(db, o.requestId);
    if (!req || req.status !== 'open') return V.fail('standin_closed');
    const entry = N.getEntry(db, req.entry_id);
    if (!o.staff && (!entry || !N.entryManagers(db, entry).includes(o.by))) return V.fail('not_manager');
    db.prepare("UPDATE draft_standins SET status = 'cancelled', closed_at = ? WHERE id = ?").run(at, req.id);
    db.prepare("UPDATE draft_standin_offers SET answer = 'stopped', answered_at = ? WHERE request_id = ? AND answer IS NULL").run(at, req.id);
    E.logEvent(db, req.event_id, o.by, 'standin_cancelled', at, { requestId: req.id, why: 'asked', staff: o.staff });
    return V.ok(null);
  })();
}

/** Ruling 4: staff lift the SR limit on one request. An unfilled request
 *  reopens (the flow then offers at once). */
export function setStandinMarginOff(db: DB, o: { requestId: number; actor: string; now: Date }): V.Checked<{ reopened: boolean }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ reopened: boolean }> => {
    const req = requestOf(db, o.requestId);
    if (!req || (req.status !== 'open' && req.status !== 'unfilled')) return V.fail('standin_closed');
    if (req.margin_off === 1) return V.fail('standin_margin_off');
    const reopened = req.status === 'unfilled';
    if (reopened && openRequestFor(db, req.entry_id, req.out_steamid)) return V.fail('standin_open');
    db.prepare("UPDATE draft_standins SET margin_off = 1, status = 'open', closed_at = NULL WHERE id = ?").run(req.id);
    E.logEvent(db, req.event_id, o.actor, 'standin_margin_lifted', at, { requestId: req.id, reopened });
    return V.ok({ reopened });
  })();
}

/** Ruling 12: an accept the placement refused. The offer is failed; with
 *  cancel (the refusal was about the request) the request closes too. */
export function failStandinOffer(db: DB, o: { offerId: number; why: V.EventError; cancel: boolean; now: Date }): V.Checked<null> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<null> => {
    const offer = offerOf(db, o.offerId);
    if (!offer || offer.answer !== null) return V.fail('standin_offer_gone');
    const req = requestOf(db, offer.request_id)!;
    db.prepare("UPDATE draft_standin_offers SET answer = 'failed', answered_at = ? WHERE id = ?").run(at, offer.id);
    if (o.cancel && req.status === 'open') db.prepare("UPDATE draft_standins SET status = 'cancelled', closed_at = ? WHERE id = ?").run(at, req.id);
    E.logEvent(db, req.event_id, null, 'standin_offer_failed', at, { requestId: req.id, steamid: offer.steamid, why: o.why, cancelled: o.cancel });
    return V.ok(null);
  })();
}

// ---------- write helpers for entries.ts (never on their own) ----------

/** Inside placeStandin's transaction: the offer accepted and the request
 *  filled. An event stand-in is done with; a match stand-in stays filled
 *  until endStandin. */
export function markPlaced(db: DB, o: { requestId: number; offerId: number; steamid: string; at: string }): void {
  db.prepare("UPDATE draft_standin_offers SET answer = 'accept', answered_at = ? WHERE id = ?").run(o.at, o.offerId);
  db.prepare("UPDATE draft_standins SET status = 'filled', filled_by = ?, closed_at = CASE scope WHEN 'event' THEN ? ELSE NULL END WHERE id = ?")
    .run(o.steamid, o.at, o.requestId);
}

/** Inside endStandin's transaction: a match stand-in is over. */
export function markEnded(db: DB, o: { requestId: number; at: string }): void {
  db.prepare("UPDATE draft_standins SET status = 'ended', closed_at = ? WHERE id = ?").run(o.at, o.requestId);
}
