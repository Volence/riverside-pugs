import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import type * as E from './events.js';
import * as N from './entries.js';
import * as S from './standins.js';
import { standinMarginOf } from './draftRules.js';

/** What a captain, a bench player and the desk see of stand-ins (plan D3a
 *  Ruling 14). A captain never learns who was asked or declined, and only
 *  staff see SR. */
export interface StandinRequestView {
  id: number; out: { steamid: string; name: string }; scope: S.StandinScope; status: S.StandinStatus;
  /** How many bench players were asked so far; never who. */
  asked: number; standin: string | null; requestedAt: string; marginOff: boolean;
}
export interface MyStandinView {
  /** The viewer's own open stand-in offer. */
  offer: { offerId: number; team: string; out: string; scope: S.StandinScope; expiresAt: string } | null;
  /** The viewer captains a draft team of this event. canMatch: the team has a match left. */
  captain: { entryId: number; team: string; starters: { steamid: string; name: string; captain: boolean }[];
    requests: StandinRequestView[]; open: boolean; canMatch: boolean } | null;
}
export interface AdminStandinOfferView { steamid: string; name: string; sr: number; answer: string | null; offeredAt: string; expiresAt: string }
export interface AdminStandinView extends StandinRequestView { entryId: number; team: string; margin: number; offers: AdminStandinOfferView[] }

const nameOf = (db: DB, s: string): string => getPlayer(db, s)?.name ?? s;
const standinsOpen = (ev: E.EventRow): boolean => ev.entry_kind === 'draft' && S.standinsOpen(ev);

function requestView(db: DB, r: S.StandinRow): StandinRequestView {
  return {
    id: r.id, out: { steamid: r.out_steamid, name: nameOf(db, r.out_steamid) }, scope: r.scope, status: r.status,
    asked: S.offersOf(db, r.id).length, standin: r.filled_by ? nameOf(db, r.filled_by) : null, requestedAt: r.requested_at, marginOff: r.margin_off === 1,
  };
}

export function myStandinView(db: DB, ev: E.EventRow, viewer: string): MyStandinView {
  const open = standinsOpen(ev);
  const requests = S.requestsOf(db, ev.id);
  let offer: MyStandinView['offer'] = null;
  for (const r of requests) {
    const o = r.status === 'open' ? S.openOfferOf(db, r.id) : undefined;
    if (o && o.steamid === viewer) {
      offer = { offerId: o.id, team: N.getEntry(db, r.entry_id)?.name ?? '', out: nameOf(db, r.out_steamid), scope: r.scope, expiresAt: o.expires_at };
      break;
    }
  }
  const cap = ev.entry_kind === 'draft' && ev.teams_made_at !== null
    ? N.entriesOf(db, ev.id).find((e) => N.isActive(e) && e.captain_steamid === viewer)
    : undefined;
  const captain = cap ? {
    entryId: cap.id, team: cap.name,
    starters: N.rosterOf(db, cap.id).starters.map((s) => ({ steamid: s, name: nameOf(db, s), captain: s === cap.captain_steamid })),
    requests: requests.filter((r) => r.entry_id === cap.id).map((r) => requestView(db, r)),
    open, canMatch: open && S.nextMatchOf(db, ev.id, cap.id) !== null,
  } : null;
  return { offer, captain };
}

/** The desk's "Ask the bench for a team" form: each active draft team and its starters. */
export interface AdminStandinTeamView { entryId: number; name: string; starters: { steamid: string; name: string }[] }

export function adminStandinViews(db: DB, ev: E.EventRow): { margin: number; open: boolean; teams: AdminStandinTeamView[]; requests: AdminStandinView[] } {
  return {
    margin: standinMarginOf(ev.draft_json), open: standinsOpen(ev),
    teams: N.entriesOf(db, ev.id).filter((e) => N.isActive(e) && e.captain_steamid !== null).map((e) => ({
      entryId: e.id, name: e.name, starters: N.rosterOf(db, e.id).starters.map((x) => ({ steamid: x, name: nameOf(db, x) })),
    })),
    requests: S.requestsOf(db, ev.id).map((r) => ({
      ...requestView(db, r), entryId: r.entry_id, team: N.getEntry(db, r.entry_id)?.name ?? '', margin: r.margin,
      offers: S.offersOf(db, r.id).map((o) => ({
        steamid: o.steamid, name: nameOf(db, o.steamid), sr: N.playerFacts(db, o.steamid).sr, answer: o.answer, offeredAt: o.offered_at, expiresAt: o.expires_at,
      })),
    })),
  };
}
