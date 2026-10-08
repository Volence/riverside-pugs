import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { addNote } from '../admin/players.js';
import { getPlayer } from '../players.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as ST from './standins.js';
import * as V from './validate.js';
import { STANDIN_OFFER_MINUTES } from './draftRules.js';
import { tellStandinFilled, tellStandinOffer, tellStandinUnfilled, type NoticeDeps } from './notices.js';

/** How often the tick runs: expiries move on within this long of the window's end. */
export const STANDIN_TICK_MS = 15_000;
/** After a mid-chapter refusal the offer runs at least this long, so the bench player can press again between chapters. */
export const STANDIN_RETRY_MINUTES = 2;
export type StandinAccept = Omit<N.StandinPlaceInput, 'now' | 'check' | 'boxTook'>;
export interface StandinDeps extends NoticeDeps {
  /** The series engine: a placement that touches a game on a box asks the box first (Task 4). */
  series?: { standinPlace(o: StandinAccept): Promise<V.Checked<N.StandinPlaced>> };
  /** The room clock: match rooms refresh after a change made without the series engine. */
  rooms?: { pushChange(matchId: number): void };
  now?: () => number;
}

type Refusal = { ok: false; error: V.EventError; detail?: V.EntryProblem[] };

/** Refusals that mean the request no longer stands (Ruling 12): the missing
 *  player was replaced, the team is out, the match or the event is over, or
 *  the request or its offer is gone. The offer fails, the request closes,
 *  and the bench player hears plainly that it is no longer open. */
const REQUEST_GONE: ReadonlySet<V.EventError> = new Set<V.EventError>([
  'replace_not_starter', 'standin_match_over', 'wrong_status', 'entry_out', 'replace_not_possible', 'standin_closed', 'standins_closed', 'standin_offer_gone',
  'standin_captain',
]);
/** Refusals about the player who accepted: the next one is asked. */
const PLAYER_OUT: ReadonlySet<V.EventError> = new Set<V.EventError>(['player_entered', 'replace_ineligible']);

/**
 * Bench stand-ins, end to end (drafts plan D3a): the routes, the Discord
 * buttons and the tick all go through here, so a request made on the desk,
 * the event page or Discord moves the same way. Every database change is a
 * standins.ts or entries.ts mutation; this class only sequences them and
 * tells people after each commit. The offers in flight (an accept waiting on
 * the game server) are held in memory so the tick never expires one under
 * its placement (Review Focus 1); a restart loses nothing but that guard.
 */
export class Standins {
  private readonly inFlight = new Set<number>();
  private ticking = false;

  constructor(private readonly deps: StandinDeps) {}

  private get db(): DB { return this.deps.db; }
  private date(): Date { return new Date((this.deps.now ?? Date.now)()); }

  /** A captain or staff ask (Rulings 1 and 2); the first offer goes out at once. */
  request(o: { eventId: number; entryId: number; out: string; scope: unknown; by: string; staff: boolean }): V.Checked<{ requestId: number }> {
    const r = ST.requestStandin(this.db, { ...o, now: this.date() });
    if (r.ok) this.advance(r.value.requestId);
    return r;
  }

  /** The offered player presses Accept. The window is judged at this press,
   *  however long the game server then takes. */
  async accept(o: { offerId: number; steamid: string }): Promise<V.Checked<N.StandinPlaced>> {
    const acceptedAt = this.date();
    const offer = ST.offerOf(this.db, o.offerId);
    const req = offer ? ST.requestOf(this.db, offer.request_id) : undefined;
    if (!offer || !req || offer.steamid !== o.steamid || offer.answer !== null) return V.fail('standin_offer_gone');
    if (this.inFlight.has(offer.id)) return V.fail('standin_accepting');
    this.inFlight.add(offer.id);
    try {
      const input: StandinAccept = { eventId: req.event_id, requestId: req.id, offerId: offer.id, steamid: o.steamid, acceptedAt };
      const r = this.deps.series ? await this.deps.series.standinPlace(input) : N.placeStandin(this.db, { ...input, now: acceptedAt });
      if (!r.ok) return this.refused(req.id, offer.id, r);
      tellStandinFilled(this.deps, req.event_id, req.id);
      // The series engine pushes the room itself.
      if (!this.deps.series && r.value.subbedInMatch !== null) this.deps.rooms?.pushChange(r.value.subbedInMatch);
      return r;
    } finally {
      this.inFlight.delete(offer.id);
    }
  }

  /** Refused while that player's accept is with the game server, so a
   *  decline never moves the chain on under a placement. */
  decline(o: { offerId: number; steamid: string }): V.Checked<null> {
    if (this.inFlight.has(o.offerId) && ST.offerOf(this.db, o.offerId)?.steamid === o.steamid) return V.fail('standin_accepting');
    const r = ST.declineStandinOffer(this.db, { ...o, now: this.date() });
    const offer = ST.offerOf(this.db, o.offerId);
    if (offer && (r.ok || r.error === 'standin_offer_expired')) this.advance(offer.request_id);
    return r.ok ? V.ok(null) : r;
  }

  cancel(o: { requestId: number; by: string; staff: boolean }): V.Checked<null> {
    return ST.cancelStandin(this.db, { ...o, now: this.date() });
  }

  /** Ruling 4: staff lift the SR limit; the next offer goes out at once. */
  marginOff(o: { requestId: number; by: string }): V.Checked<{ reopened: boolean }> {
    const r = ST.setStandinMarginOff(this.db, { requestId: o.requestId, actor: o.by, now: this.date() });
    if (r.ok) this.advance(o.requestId);
    return r;
  }

  /** Every STANDIN_TICK_MS: due offers expire and the next player is asked;
   *  match stand-ins whose match is over leave their team. Each request is
   *  caught on its own. An offer whose accept is with the game server is
   *  left alone: that accept was pressed in time or it is refused there. */
  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.date();
      for (const req of ST.openRequests(this.db)) {
        try {
          const open = ST.openOfferOf(this.db, req.id);
          if (open && (this.inFlight.has(open.id) || Date.parse(open.expires_at) > now.getTime())) continue;
          if (open) ST.expireStandinOffer(this.db, { requestId: req.id, now });
          this.advance(req.id);
        } catch (err) {
          console.error(`[standins] request ${req.id} failed:`, err instanceof Error ? err.message : err);
        }
      }
      for (const req of ST.endableStandins(this.db)) {
        try {
          const r = N.endStandin(this.db, { requestId: req.id, now });
          if (r.ok && req.match_id !== null) this.deps.rooms?.pushChange(req.match_id);
        } catch (err) {
          console.error(`[standins] ending stand-in ${req.id} failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Ruling 12: what a refused accept does to the chain, and what the bench
   *  player is told. A game server that would not take the sub mid-chapter
   *  leaves the offer open, with time for another press between chapters;
   *  any other refusal not listed here leaves it open as it is. */
  private refused(requestId: number, offerId: number, r: Refusal): Refusal {
    const now = this.date();
    if (r.error === 'standin_offer_expired') {
      ST.expireStandinOffer(this.db, { requestId, now });
      this.advance(requestId);
      return r;
    }
    if (PLAYER_OUT.has(r.error)) {
      const f = ST.failStandinOffer(this.db, { offerId, why: r.error, cancel: false, now });
      if (f.ok) this.advance(requestId);
      return r;
    }
    if (REQUEST_GONE.has(r.error)) {
      // The offer may already be answered (a cancel stopped it): then there is nothing left to fail.
      ST.failStandinOffer(this.db, { offerId, why: r.error, cancel: true, now });
      return V.fail('standin_closed');
    }
    if (r.error === 'replace_in_game') {
      // The staff detail (what the box said) is not the bench player's to act on.
      ST.holdStandinOffer(this.db, { offerId, now, minutes: STANDIN_RETRY_MINUTES });
      return V.fail('standin_mid_chapter');
    }
    return r;
  }

  /** Offer the next bench player, or close the request and tell people. */
  private advance(requestId: number): void {
    const step = ST.offerNextStandin(this.db, { requestId, now: this.date(), minutes: STANDIN_OFFER_MINUTES });
    if (!step.ok) return;
    const req = ST.requestOf(this.db, requestId)!;
    if (step.value.offerId !== null) tellStandinOffer(this.deps, req.event_id, step.value.offerId);
    else if (step.value.unfilled) this.unfilled(req);
  }

  /** Rulings 10 and 11: no takers. */
  private unfilled(req: ST.StandinRow): void {
    const ev = E.getEvent(this.db, req.event_id);
    const entry = N.getEntry(this.db, req.entry_id);
    if (!ev || !entry) return;
    const out = getPlayer(this.db, req.out_steamid)?.name ?? req.out_steamid;
    tellStandinUnfilled(this.deps, ev.id, req.id);
    publishAdminEvent({
      kind: 'problem',
      text: `Draft ${ev.name}: nobody on the bench took the stand-in for ${out} on ${entry.name} (${req.scope === 'match' ? 'next match' : 'rest of the event'}). Hold or forfeit the match, or offer without the SR limit.`,
      link: { label: 'Open the Events desk', path: `/admin/events/${ev.id}` },
    });
    if (req.scope !== 'event' || ST.unfilledCount(this.db, req.id) !== 1) return;
    try {
      addNote(this.db, req.out_steamid, 'system', `Left ${entry.name} in ${ev.name} after the draft; no stand-in was found on the bench (stand-in request ${req.id}).`);
    } catch (err) {
      console.error(`[standins] the stranded note for request ${req.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
