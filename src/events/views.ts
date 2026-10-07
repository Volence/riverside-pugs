import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { parseRules, rulesForKind, type MatchRules } from '../rulesets.js';
import { activeMembers, getTeam, myTeams } from '../teams/teams.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as N from './entries.js';
import * as R from './entryRules.js';
import type * as V from './validate.js';
import { STAGE_LABEL, chaptersLabel, rulesLines, stageSummary } from './format.js';
import { vetoSummary } from './vetoConfig.js';
import { stagePlayViews, type StagePlayView } from './playViews.js';

/** What the public event list and event page show (spec section 7). */

export interface EventListItem {
  slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; official: boolean; startsAt: string; bannerKey: string | null;
  format: string[]; entries: number;
}
export interface EventStageView {
  ordinal: number; type: V.StageType; summary: string; veto: string; chapters: string; scheduling: V.Scheduling;
  rulesetName: string | null; rules: string[]; gameConfig: string; campaigns: { slug: string; name: string }[];
}
export interface EventEntryView { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; status: string; waitlist: number | null; placement: number | null }
export interface EventView {
  slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; official: boolean; organizerName: string | null;
  bannerKey: string | null; startsAt: string; description: string; teamCap: number | null;
  eligibility: V.Eligibility; checkin: V.Checkin; roster: V.RosterRules;
  stages: EventStageView[]; entries: EventEntryView[]; play: StagePlayView[];
  finishedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  lockedAt: string | null; checkinOpensAt: string | null; checkinClosesAt: string | null;
  /** Draft-kind events only (plan D1 Ruling 9): the signup count and names in
   *  signup order. Never SR, notes or captain preference. */
  draft: EventDraftView | null;
}
export interface EventDraftView {
  signupsCloseAt: string; draftAt: string; signups: number; names: string[];
  /** The published cut as names in signup order (Ruling 9); null before publish. */
  cut: { captains: string[]; pool: string[]; bench: string[] } | null;
}

const OVER: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['finished', 'cancelled']);

/** Team events count placed entries; a draft-kind event has none, so the
 *  list shows its active signups instead (the web words it "signups"). */
function entryCount(db: DB, ev: E.EventRow): number {
  if (ev.entry_kind === 'draft') return D.activeSignups(db, ev.id).length;
  return N.placementOf(db, ev).placed.length;
}

/** Open events soonest first, then finished and cancelled ones newest first.
 *  Drafts only for staff, admins and mods (Ruling 14). */
export function eventListItems(db: DB, o: { staff: boolean }): EventListItem[] {
  const rows = (db.prepare('SELECT * FROM events ORDER BY starts_at, id').all() as E.EventRow[])
    .filter((e) => o.staff || e.status !== 'draft');
  const ordered = [...rows.filter((e) => !OVER.has(e.status)), ...rows.filter((e) => OVER.has(e.status)).reverse()];
  return ordered.map((e) => ({
    slug: e.slug, name: e.name, status: e.status, entryKind: e.entry_kind, official: e.official === 1, startsAt: e.starts_at,
    bannerKey: e.banner_key,
    format: E.stagesOf(db, e.id).map((s) => STAGE_LABEL[s.type]),
    entries: entryCount(db, e),
  }));
}

/** The snapshot once published; before that (a draft an admin previews), the
 *  chosen ruleset as a tournament would play it. */
function stageRules(db: DB, s: E.StageRow): MatchRules | null {
  const json = s.rules_json
    ?? (db.prepare('SELECT rules_json FROM rulesets WHERE id = ?').get(s.ruleset_id) as { rules_json: string } | undefined)?.rules_json;
  if (!json) return null;
  try {
    return rulesForKind('tournament', parseRules(json));
  } catch {
    return null;
  }
}

/** Ruling 12: active entries (disqualified ones too, marked), in seed order
 *  once the list is final and in registration order before, with the
 *  waitlist position of each entry past the cap. Never SR. */
function entryViews(db: DB, ev: E.EventRow): EventEntryView[] {
  const place = N.placementOf(db, ev);
  const rows = N.entriesOf(db, ev.id).filter((e) => e.status !== 'dropped');
  if (ev.locked_at !== null) rows.sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.id - b.id);
  return rows.map((e) => {
    const w = place.waitlist.indexOf(e.id);
    return {
      id: e.id, name: e.name, tag: e.tag, logoKey: e.logo_key, seed: ev.locked_at !== null ? e.seed : null, status: e.status,
      waitlist: w >= 0 ? w + 1 : null, placement: e.placement,
    };
  });
}

export function eventView(db: DB, ev: E.EventRow): EventView {
  const f = E.fieldsOf(ev);
  const rulesetName = db.prepare('SELECT name FROM rulesets WHERE id = ?');
  const configLabel = db.prepare('SELECT label FROM game_configs WHERE key = ?');
  return {
    slug: ev.slug, name: ev.name, status: ev.status, entryKind: ev.entry_kind, official: ev.official === 1,
    organizerName: getPlayer(db, ev.organizer_steamid)?.name ?? null, bannerKey: ev.banner_key,
    startsAt: ev.starts_at, description: ev.description, teamCap: ev.team_cap,
    eligibility: f.eligibility, checkin: f.checkin, roster: f.roster,
    stages: E.stagesOf(db, ev.id).map((s) => {
      const st = E.stageSettingsOf(s);
      const rules = stageRules(db, s);
      return {
        ordinal: s.ordinal, type: st.type, summary: stageSummary(st.type, st.config, st.advanceCount),
        veto: vetoSummary(st.veto, st.campaignPool.length), chapters: chaptersLabel(st.chapters), scheduling: st.scheduling,
        rulesetName: (rulesetName.get(st.rulesetId) as { name: string } | undefined)?.name ?? null,
        rules: rules ? rulesLines(rules) : [],
        gameConfig: (configLabel.get(st.gameConfig) as { label: string } | undefined)?.label ?? st.gameConfig,
        campaigns: st.campaignPool.map((slug) => ({ slug, name: campaignDisplayName(db, slug) })),
      };
    }),
    entries: entryViews(db, ev),
    play: stagePlayViews(db, ev),
    finishedAt: ev.finished_at, cancelledAt: ev.cancelled_at, cancelReason: ev.cancel_reason,
    lockedAt: ev.locked_at,
    ...(f.checkin.enabled
      ? (() => { const t = R.checkinTimes(ev.starts_at, f.checkin); return { checkinOpensAt: t.opensAt, checkinClosesAt: t.closesAt }; })()
      : { checkinOpensAt: null, checkinClosesAt: null }),
    draft: draftView(db, ev, f),
  };
}

function draftView(db: DB, ev: E.EventRow, f: V.EventFields): EventDraftView | null {
  if (ev.entry_kind !== 'draft' || !f.draft) return null;
  const all = D.activeSignups(db, ev.id).map((s) => ({ role: s.role, name: getPlayer(db, s.steamid)?.name ?? s.steamid }));
  const names = all.map((s) => s.name);
  const of = (r: D.SignupRow['role']) => all.filter((s) => s.role === r).map((s) => s.name);
  const cut = ev.cut_at !== null ? { captains: of('captain'), pool: of('pool'), bench: of('bench') } : null;
  return { signupsCloseAt: f.draft.signupsCloseAt, draftAt: f.draft.draftAt, signups: names.length, names, cut };
}

/** The viewer's own signup (plan D1): their preference and note. The role
 *  shows only once the cut is published. */
export interface MySignupView { captainPref: D.CaptainPref; note: string | null; role: D.SignupRow['role'] }
export function signupView(ev: E.EventRow, s: D.SignupRow): MySignupView {
  return { captainPref: s.captain_pref, note: s.note, role: ev.cut_at !== null ? s.role : null };
}

export interface RosterPlaceView { steamid: string; name: string; avatar: string | null; role: R.Role; problems: string[] }
/** onTeam is false for a roster player who has since left the team: the
 *  editor still lists them so a manager can take them off. */
export interface MemberOptionView { steamid: string; name: string; avatar: string | null; problems: string[]; elsewhere: string | null; onTeam: boolean }
export interface MyEntryView {
  id: number; name: string; tag: string; logoKey: string | null; status: string; seed: number | null; waitlist: number | null;
  checkedInAt: string | null; manage: boolean; onRoster: boolean; roster: RosterPlaceView[];
  rosterLocked: boolean; additionsLeft: number | null;
  canEditRoster: boolean; canCheckIn: boolean; canWithdraw: boolean; canLeave: boolean;
  /** The viewer is a starter and the list is final: leaving goes through staff. */
  leaveNeedsStaff: boolean;
  /** The roster editor's rows, managers only: the team's current members,
   *  then any roster player no longer on the team (onTeam false). */
  members: MemberOptionView[];
}
export interface RegisterOptionView { teamId: number; name: string; tag: string; logoKey: string | null; members: MemberOptionView[] }
export interface MyEventView {
  entries: MyEntryView[]; register: RegisterOptionView[]; canRegister: boolean;
  /** A draft-kind event: the viewer's active signup, or null. */
  signup: MySignupView | null;
  /** A draft-kind event: the viewer's own open captaincy offer, or null.
   *  Never anyone else's (Global Constraints, privacy). */
  offer: { expiresAt: string } | null;
  /** A draft captain's own entry identity (drafts plan D2a), or null. */
  captainOf: { entryId: number; name: string; tag: string; logoKey: string | null; editable: boolean } | null;
}

/** What one signed-in player can do on this event page: the entries they
 *  manage or are on, and the teams they could register. Problems are the
 *  sentences of src/events/entryRules.ts problemText for the role a player
 *  has (members not yet on a roster are judged as starters). */
export function myEventView(db: DB, ev: E.EventRow, viewer: string, now = new Date()): MyEventView {
  const at = now.toISOString();
  const f = E.fieldsOf(ev);
  const place = N.placementOf(db, ev);
  const problems = (steamid: string, role: R.Role) => {
    const facts = N.playerFacts(db, steamid, now);
    return R.problemsOf(f.eligibility, facts, role).map((p) => R.problemText(p, f.eligibility, facts));
  };
  const person = (steamid: string) => { const p = getPlayer(db, steamid); return { name: p?.name ?? steamid, avatar: p?.avatar ?? null }; };
  const option = (steamid: string, role: R.Role, onTeam: boolean, entryId: number | null): MemberOptionView => {
    const other = N.entryOfPlayer(db, ev.id, steamid);
    return { steamid, ...person(steamid), problems: problems(steamid, role), elsewhere: other && other.id !== entryId ? other.name : null, onTeam };
  };
  const memberOptions = (teamId: number, entryId: number | null, places: N.PlaceRow[] = []): MemberOptionView[] => {
    const current = activeMembers(db, teamId).map((m) => option(m.steamid, 'starter', true, entryId));
    const on = new Set(current.map((m) => m.steamid));
    return [...current, ...places.filter((p) => !on.has(p.steamid)).map((p) => option(p.steamid, p.role, false, entryId))];
  };
  const rosterOpen = ev.status === 'registration' || ev.status === 'checkin' || ev.status === 'live';
  const locked = R.rosterLocked(f.roster.lock, at);
  const preFinal = ev.locked_at === null && (ev.status === 'registration' || ev.status === 'checkin');

  const mine = N.entriesOf(db, ev.id).filter(N.isActive).filter((e) =>
    N.entryManagers(db, e).includes(viewer) || N.placesOf(db, e.id).some((p) => p.steamid === viewer));
  const entries: MyEntryView[] = mine.map((e) => {
    const manage = N.entryManagers(db, e).includes(viewer);
    const places = N.placesOf(db, e.id);
    const w = place.waitlist.indexOf(e.id);
    const mine = places.find((p) => p.steamid === viewer);
    const leaveOpen = !!mine && (ev.status === 'registration' || ev.status === 'checkin');
    const starterLocked = mine?.role === 'starter' && ev.locked_at !== null;
    return {
      id: e.id, name: e.name, tag: e.tag, logoKey: e.logo_key, status: e.status, seed: ev.locked_at !== null ? e.seed : null,
      waitlist: w >= 0 ? w + 1 : null, checkedInAt: e.checked_in_at, manage, onRoster: places.some((p) => p.steamid === viewer),
      roster: places.map((p) => ({ steamid: p.steamid, ...person(p.steamid), role: p.role, problems: problems(p.steamid, p.role) })),
      rosterLocked: locked,
      additionsLeft: f.roster.maxAdditions === null ? null : Math.max(0, f.roster.maxAdditions - e.additions),
      canEditRoster: manage && e.team_id !== null && rosterOpen && !locked,
      canCheckIn: manage && ev.status === 'checkin' && ev.locked_at === null && e.status === 'registered',
      canWithdraw: manage && preFinal,
      canLeave: leaveOpen && !starterLocked,
      leaveNeedsStaff: leaveOpen && starterLocked,
      members: manage && e.team_id !== null ? memberOptions(e.team_id, e.id, places) : [],
    };
  });

  const canRegister = ev.entry_kind === 'team' && ev.status === 'registration' && ev.locked_at === null && at < ev.starts_at;
  const register: RegisterOptionView[] = canRegister
    ? myTeams(db, viewer).filter((t) => (t.role === 'captain' || t.role === 'cocaptain')
      && !N.entryOfTeam(db, ev.id, t.id) && !N.disqualifiedSlotHeld(db, ev.id, t.id, null))
      .map((t) => ({ teamId: t.id, name: t.name, tag: t.tag, logoKey: t.logo_key, members: memberOptions(t.id, null) }))
    : [];
  const own = ev.entry_kind === 'draft' ? D.signupOf(db, ev.id, viewer) : null;
  // Only before the draft: a cancelled event's open offer row is left as it
  // was (cancelEvent may not write the draft tables), so it is never shown.
  const offerLive = ev.entry_kind === 'draft' && ev.cut_at === null && (ev.status === 'registration' || ev.status === 'checkin');
  const open = offerLive ? D.openOffer(db, ev.id) : null;
  const offer = open && open.steamid === viewer ? { expiresAt: open.expires_at } : null;
  const cap = ev.entry_kind === 'draft'
    ? N.entriesOf(db, ev.id).find((e) => N.isActive(e) && e.captain_steamid === viewer)
    : undefined;
  const captainOf = cap
    ? { entryId: cap.id, name: cap.name, tag: cap.tag, logoKey: cap.logo_key, editable: N.identityOpen(ev) }
    : null;
  return { entries, register, canRegister, signup: own ? signupView(ev, own) : null, offer, captainOf };
}

export interface AdminEntryView {
  id: number; teamSlug: string | null; name: string; tag: string; status: string; dropReason: string | null; seed: number | null;
  waitlist: number | null; sr: number; checkedInAt: string | null; createdAt: string; registeredByName: string; roster: RosterPlaceView[];
}

/** The desk's list (Ruling 10): every entry, dropped and disqualified ones
 *  after the rest, with average starter SR, which the public never sees. */
export function adminEntryViews(db: DB, ev: E.EventRow): AdminEntryView[] {
  const f = E.fieldsOf(ev);
  const place = N.placementOf(db, ev);
  const rows = N.entriesOf(db, ev.id);
  const ordered = [...rows.filter(N.isActive), ...rows.filter((e) => !N.isActive(e))];
  return ordered.map((e) => {
    const w = place.waitlist.indexOf(e.id);
    return {
      id: e.id, teamSlug: e.team_id !== null ? getTeam(db, e.team_id)?.slug ?? null : null, name: e.name, tag: e.tag, status: e.status,
      dropReason: e.drop_reason, seed: e.seed, waitlist: w >= 0 ? w + 1 : null, sr: N.entrySr(db, e.id), checkedInAt: e.checked_in_at,
      createdAt: e.created_at, registeredByName: getPlayer(db, e.registered_by)?.name ?? e.registered_by,
      roster: N.placesOf(db, e.id).map((p) => {
        const facts = N.playerFacts(db, p.steamid);
        const pl = getPlayer(db, p.steamid);
        return {
          steamid: p.steamid, name: pl?.name ?? p.steamid, avatar: pl?.avatar ?? null, role: p.role,
          problems: R.problemsOf(f.eligibility, facts, p.role).map((k) => R.problemText(k, f.eligibility, facts)),
        };
      }),
    };
  });
}
