import type { DB } from '../db.js';
import * as B from '../bookings/bookings.js';
import { addTournamentSub } from '../bookings/tournamentGames.js';
import { completedPug } from '../matchKinds.js';
import { hasUnsafeChars } from '../profileFields.js';
import { currentSeasonId, getPlayer } from '../players.js';
import { seasonSr } from '../rating.js';
import { inGoodStanding } from '../standing.js';
import { competitiveAccess } from '../teams/access.js';
import { activeMembers, getTeam, normalizeName, normalizeTag } from '../teams/teams.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as R from './entryRules.js';
import * as Room from './room.js';
import * as V from './validate.js';

/**
 * Every write to event_entries and event_entry_players (tournaments plan
 * T1b), and the entry list's lock on events.locked_at. Same shape as
 * src/events/events.ts: each mutation is one transaction that re-reads, checks
 * inside, writes, and adds exactly one event_log row before it commits; a
 * refusal writes nothing. tests/eventLogGuard.test.ts pins both.
 *
 * An entry is not a team membership: a player keeps one place across the
 * event's active entries (status not dropped or disqualified), and the team
 * caps never see entries.
 */

export type EntryStatus = 'registered' | 'checked_in' | 'dropped' | 'disqualified' | 'eliminated' | 'placed';
export interface EntryRow {
  id: number; event_id: number; team_id: number | null; name: string; tag: string; logo_key: string | null; seed: number | null;
  status: EntryStatus; placement: number | null; registered_by: string; created_at: string;
  checked_in_at: string | null; checked_in_by: string | null; dropped_at: string | null; drop_reason: R.DropReason | null; additions: number;
  /** A draft entry's captain (drafts plan D2a); NULL on a team entry. */
  captain_steamid: string | null;
}
export interface PlaceRow { id: number; entry_id: number; steamid: string; role: R.Role; added_at: string; removed_at: string | null }
export type Added = { steamid: string; role: R.Role }[];

const iso = (now?: Date): string => (now ?? new Date()).toISOString();
export const isActive = (e: EntryRow): boolean => e.status !== 'dropped' && e.status !== 'disqualified';
/** Event statuses a roster may change in (Ruling 6). */
const ROSTER_OPEN: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['registration', 'checkin', 'live']);
/** Event statuses a player may leave a roster in (Ruling 7). */
const LEAVE_OPEN: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['registration', 'checkin']);

export function getEntry(db: DB, id: number): EntryRow | undefined {
  return db.prepare('SELECT * FROM event_entries WHERE id = ?').get(id) as EntryRow | undefined;
}
/** Every entry of the event, dropped ones included, in registration order. */
export function entriesOf(db: DB, eventId: number): EntryRow[] {
  return db.prepare('SELECT * FROM event_entries WHERE event_id = ? ORDER BY created_at, id').all(eventId) as EntryRow[];
}
export function placesOf(db: DB, entryId: number): PlaceRow[] {
  return db.prepare(
    `SELECT * FROM event_entry_players WHERE entry_id = ? AND removed_at IS NULL
     ORDER BY CASE role WHEN 'starter' THEN 0 WHEN 'sub' THEN 1 ELSE 2 END, added_at, id`,
  ).all(entryId) as PlaceRow[];
}
export function rosterOf(db: DB, entryId: number): R.Roster {
  const p = placesOf(db, entryId);
  return {
    starters: p.filter((r) => r.role === 'starter').map((r) => r.steamid),
    subs: p.filter((r) => r.role === 'sub').map((r) => r.steamid),
    coach: p.find((r) => r.role === 'coach')?.steamid ?? null,
  };
}
export function entryOfTeam(db: DB, eventId: number, teamId: number): EntryRow | undefined {
  return db.prepare("SELECT * FROM event_entries WHERE event_id = ? AND team_id = ? AND status NOT IN ('dropped','disqualified')")
    .get(eventId, teamId) as EntryRow | undefined;
}
/** event_entries_team_active excludes every status but 'dropped', so a
 *  disqualified entry still holds the team's slot at the database level even
 *  though entryOfTeam (active entries only, for its other callers) does not
 *  see it. registerEntry and restoreEntry check this so a disqualified
 *  team's slot gives a clean already_entered instead of a raw unique
 *  constraint error. exceptEntryId lets restoreEntry ignore the entry it is
 *  restoring (which may itself be the disqualified one). myEventView uses
 *  it too, so such a team is not offered Register. */
export function disqualifiedSlotHeld(db: DB, eventId: number, teamId: number, exceptEntryId: number | null): boolean {
  return !!db.prepare(
    "SELECT 1 FROM event_entries WHERE event_id = ? AND team_id = ? AND status = 'disqualified' AND id IS NOT ?",
  ).get(eventId, teamId, exceptEntryId);
}
/** The active entry this player holds a place on in this event, if any. */
export function entryOfPlayer(db: DB, eventId: number, steamid: string): EntryRow | undefined {
  return db.prepare(
    `SELECT e.* FROM event_entries e JOIN event_entry_players p ON p.entry_id = e.id AND p.removed_at IS NULL
     WHERE e.event_id = ? AND p.steamid = ? AND e.status NOT IN ('dropped','disqualified') LIMIT 1`,
  ).get(eventId, steamid) as EntryRow | undefined;
}
export function placementOf(db: DB, ev: E.EventRow): R.Placement {
  return R.placeEntries(entriesOf(db, ev.id), capOf(ev));
}
/** The team cap that applies: none for a draft event, whose team count comes
 *  from the cut, so a cap stored before the rule changed never waitlists one. */
export function capOf(ev: Pick<E.EventRow, 'entry_kind' | 'team_cap'>): number | null {
  return ev.entry_kind === 'draft' ? null : ev.team_cap;
}
/** A team's captain and co-captains right now. */
export function managersOf(db: DB, teamId: number | null): string[] {
  if (teamId === null) return [];
  return activeMembers(db, teamId).filter((m) => m.role === 'captain' || m.role === 'cocaptain').map((m) => m.steamid);
}
/** Who runs this entry (drafts plan D2a Ruling 8): a team entry's team
 *  managers right now, exactly as managersOf gives them, or a draft entry's
 *  captain (team_id NULL). The match room, the series pick, prep, check-in,
 *  withdrawal, the notices and the views ask it, so a draft captain is a full
 *  captain there. setEntryRoster alone stays team-only: a draft entry's four
 *  are made by staff, so its captain does not edit the roster. */
export function entryManagers(db: DB, entry: { team_id: number | null; captain_steamid: string | null }): string[] {
  if (entry.team_id !== null) return managersOf(db, entry.team_id);
  return entry.captain_steamid !== null ? [entry.captain_steamid] : [];
}

export function playerFacts(db: DB, steamid: string, now = new Date()): R.PlayerFacts {
  const pugs = (db.prepare(
    `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND ${completedPug('m')} AND m.voided_at IS NULL`,
  ).get(steamid) as { n: number }).n;
  return {
    open: competitiveAccess(db, steamid),
    good: inGoodStanding(db, steamid, now),
    pugs,
    discord: !!getPlayer(db, steamid)?.discord_id,
    sr: seasonSr(db, steamid, currentSeasonId(db)),
  };
}

/** A starting four's SR: the average current-season SR of the active starters. */
export function entrySr(db: DB, entryId: number): number {
  const season = currentSeasonId(db);
  return R.averageSr(rosterOf(db, entryId).starters.map((s) => seasonSr(db, s, season)));
}

/**
 * Everything that keeps this roster out, inside the caller's transaction.
 * New players (not on `previous`) must be on the team unless staff are
 * adding them. Then every player, old and new, is checked against the
 * one-entry rule and the eligibility rules, so a player who stopped being
 * eligible since registering blocks the save until removed.
 */
function checkRoster(
  db: DB, ev: E.EventRow,
  o: { entryId: number | null; teamId: number | null; roster: R.Roster; previous: R.Roster | null; staff: boolean; now: Date },
): V.Checked<null> {
  const elig = E.fieldsOf(ev).eligibility;
  const list = R.rosterList(o.roster);
  const before = new Set(o.previous ? R.rosterList(o.previous).map((p) => p.steamid) : []);
  const members = new Set(o.teamId === null ? [] : activeMembers(db, o.teamId).map((m) => m.steamid));
  if (!o.staff && list.some((p) => !before.has(p.steamid) && !members.has(p.steamid))) return V.fail('not_on_team');
  const elsewhere: V.EntryProblem[] = [];
  const problems: V.EntryProblem[] = [];
  for (const p of list) {
    const other = entryOfPlayer(db, ev.id, p.steamid);
    if (other && other.id !== o.entryId) elsewhere.push({ steamid: p.steamid, problems: [`Already on ${other.name}'s roster`] });
    const facts = playerFacts(db, p.steamid, o.now);
    const found = R.problemsOf(elig, facts, p.role);
    if (found.length > 0) problems.push({ steamid: p.steamid, problems: found.map((k) => R.problemText(k, elig, facts)) });
  }
  if (elsewhere.length > 0) return V.fail('player_entered', elsewhere);
  if (problems.length > 0) return V.fail('player_ineligible', problems);
  return V.ok(null);
}

function addPlace(db: DB, entryId: number, steamid: string, role: R.Role, at: string): void {
  db.prepare('INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, ?, ?)').run(entryId, steamid, role, at);
}

/** Ruling 5: registration is open only in `registration`, before the start
 *  and before the list is final. */
function registrationOpen(ev: E.EventRow, at: string): boolean {
  return ev.status === 'registration' && ev.locked_at === null && at < ev.starts_at;
}

export function registerEntry(
  db: DB, o: { eventId: number; teamId: number; by: string; roster: unknown; now?: Date },
): V.Checked<{ entry: EntryRow; added: Added }> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<{ entry: EntryRow; added: Added }> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev || ev.status === 'draft') return V.fail('not_found');
    if (ev.entry_kind !== 'team') return V.fail('draft_signups_later');
    if (!registrationOpen(ev, at)) return V.fail('not_registration');
    const team = getTeam(db, o.teamId);
    if (!team || team.disbanded_at !== null) return V.fail('team_not_found');
    if (!managersOf(db, team.id).includes(o.by)) return V.fail('not_manager');
    if (entryOfTeam(db, ev.id, team.id)) return V.fail('already_entered');
    if (disqualifiedSlotHeld(db, ev.id, team.id, null)) return V.fail('already_entered');
    const roster = R.parseEntryRoster(o.roster, E.fieldsOf(ev).roster);
    if (!roster.ok) return roster;
    const check = checkRoster(db, ev, { entryId: null, teamId: team.id, roster: roster.value, previous: null, staff: false, now });
    if (!check.ok) return check;
    const id = Number(db.prepare(
      'INSERT INTO event_entries (event_id, team_id, name, tag, logo_key, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(ev.id, team.id, team.name, team.tag, team.logo_key, o.by, at).lastInsertRowid);
    const added = R.rosterList(roster.value);
    for (const p of added) addPlace(db, id, p.steamid, p.role, at);
    E.logEvent(db, ev.id, o.by, 'entry_registered', at, { entryId: id, teamId: team.id, name: team.name });
    return V.ok({ entry: getEntry(db, id)!, added });
  })();
}

export function setEntryRoster(
  db: DB, o: { entryId: number; by: string; roster: unknown; staff?: boolean; now?: Date },
): V.Checked<{ entry: EntryRow; added: Added }> {
  const now = o.now ?? new Date();
  const at = iso(now);
  const staff = o.staff === true;
  return db.transaction((): V.Checked<{ entry: EntryRow; added: Added }> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    const ev = E.getEvent(db, entry.event_id)!;
    if (!ROSTER_OPEN.has(ev.status)) return V.fail('wrong_status');
    const f = E.fieldsOf(ev);
    // Team managers only (managersOf gives a draft entry nobody): a draft
    // entry's roster is staff's to change (drafts plan D2a).
    if (!staff && !managersOf(db, entry.team_id).includes(o.by)) return V.fail('not_manager');
    if (!staff && R.rosterLocked(f.roster.lock, at)) return V.fail('roster_locked');
    const parsed = R.parseEntryRoster(o.roster, f.roster);
    if (!parsed.ok) return parsed;
    const previous = rosterOf(db, entry.id);
    const prevRole = new Map(R.rosterList(previous).map((p) => [p.steamid, p.role]));
    const next = R.rosterList(parsed.value);
    const nextIds = new Set(next.map((p) => p.steamid));
    const added = next.filter((p) => !prevRole.has(p.steamid));
    const removed = [...prevRole.keys()].filter((s) => !nextIds.has(s));
    const moved = next.filter((p) => prevRole.has(p.steamid) && prevRole.get(p.steamid) !== p.role);
    if (added.length === 0 && removed.length === 0 && moved.length === 0) return V.ok({ entry, added: [] });
    if (!staff && f.roster.maxAdditions !== null && entry.additions + added.length > f.roster.maxAdditions) return V.fail('additions_used');
    const check = checkRoster(db, ev, { entryId: entry.id, teamId: entry.team_id, roster: parsed.value, previous, staff, now });
    if (!check.ok) return check;
    const close = db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ? AND removed_at IS NULL');
    for (const s of removed) close.run(at, entry.id, s);
    const role = db.prepare('UPDATE event_entry_players SET role = ? WHERE entry_id = ? AND steamid = ? AND removed_at IS NULL');
    for (const p of moved) role.run(p.role, entry.id, p.steamid);
    for (const p of added) addPlace(db, entry.id, p.steamid, p.role, at);
    if (!staff && added.length > 0) db.prepare('UPDATE event_entries SET additions = additions + ? WHERE id = ?').run(added.length, entry.id);
    E.logEvent(db, ev.id, o.by, 'roster_changed', at, {
      entryId: entry.id, added: added.map((p) => p.steamid), removed, moved: moved.map((p) => ({ steamid: p.steamid, role: p.role })), staff,
    });
    return V.ok({ entry: getEntry(db, entry.id)!, added });
  })();
}

/** Ruling 7. Before the list is final, a starter leaving a checked-in entry
 *  undoes the check-in. Once it is final a starter cannot leave (staff take
 *  them off instead), so a final list never loses a check-in; a sub or the
 *  coach still can. */
export function leaveEntry(db: DB, o: { entryId: number; steamid: string; now?: Date }): V.Checked<EntryRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    const ev = E.getEvent(db, entry.event_id)!;
    if (!LEAVE_OPEN.has(ev.status)) return V.fail('wrong_status');
    const place = placesOf(db, entry.id).find((p) => p.steamid === o.steamid);
    if (!place) return V.fail('not_on_entry');
    if (place.role === 'starter' && ev.locked_at !== null) return V.fail('entries_locked');
    db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE id = ?').run(at, place.id);
    if (place.role === 'starter' && entry.status === 'checked_in') {
      db.prepare("UPDATE event_entries SET status = 'registered', checked_in_at = NULL, checked_in_by = NULL WHERE id = ?").run(entry.id);
    }
    E.logEvent(db, ev.id, o.steamid, 'roster_left', at, { entryId: entry.id, role: place.role });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Ruling 8: until the list is final. */
export function withdrawEntry(db: DB, o: { entryId: number; by: string; now?: Date }): V.Checked<EntryRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    if (!entryManagers(db, entry).includes(o.by)) return V.fail('not_manager');
    const ev = E.getEvent(db, entry.event_id)!;
    if (ev.locked_at !== null) return V.fail('entries_locked');
    if (ev.status !== 'registration' && ev.status !== 'checkin') return V.fail('wrong_status');
    db.prepare("UPDATE event_entries SET status = 'dropped', dropped_at = ?, drop_reason = 'withdrawn' WHERE id = ?").run(at, entry.id);
    E.logEvent(db, ev.id, o.by, 'entry_withdrawn', at, { entryId: entry.id });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Ruling 2: a captain or co-captain, during check-in, with 4 starters who
 *  all pass now. Pressing it again changes nothing and writes nothing. */
export function checkInEntry(db: DB, o: { entryId: number; by: string; now?: Date }): V.Checked<EntryRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    if (!entryManagers(db, entry).includes(o.by)) return V.fail('not_manager');
    const ev = E.getEvent(db, entry.event_id)!;
    if (ev.status !== 'checkin' || ev.locked_at !== null) return V.fail('not_checkin');
    if (entry.status === 'checked_in') return V.ok(entry);
    const roster = rosterOf(db, entry.id);
    if (roster.starters.length !== R.STARTERS) return V.fail('need_starters');
    const check = checkRoster(db, ev, { entryId: entry.id, teamId: entry.team_id, roster, previous: roster, staff: true, now });
    if (!check.ok) return check;
    db.prepare("UPDATE event_entries SET status = 'checked_in', checked_in_at = ?, checked_in_by = ? WHERE id = ?").run(at, o.by, entry.id);
    E.logEvent(db, ev.id, o.by, 'entry_checked_in', at, { entryId: entry.id });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

export interface LockResult { kept: number[]; dropped: { entryId: number; reason: R.DropReason }[] }

/**
 * Make the entry list final (Ruling 4). With check-in on (event in checkin):
 * entries not checked in drop as no_checkin. With it off (event in
 * registration): entries short of 4 starters drop as incomplete. Then the
 * ready entries past the cap, in registration order, drop as over_cap; the
 * kept ones take a fresh name, tag and logo from their team (Ruling 13) and
 * seeds by average starter SR. kept is in seed order.
 */
export function lockEntries(db: DB, o: { eventId: number; by: string | null; now?: Date }): V.Checked<LockResult> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<LockResult> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    const f = E.fieldsOf(ev);
    if (ev.status !== (f.checkin.enabled ? 'checkin' : 'registration') || ev.locked_at !== null) return V.fail('wrong_status');
    const active = entriesOf(db, ev.id).filter(isActive);
    const dropped: LockResult['dropped'] = [];
    const ready = active.filter((e) => {
      const fine = f.checkin.enabled ? e.status === 'checked_in' : rosterOf(db, e.id).starters.length === R.STARTERS;
      if (!fine) dropped.push({ entryId: e.id, reason: f.checkin.enabled ? 'no_checkin' : 'incomplete' });
      return fine;
    });
    const place = R.placeEntries(ready, capOf(ev));
    for (const id of place.waitlist) dropped.push({ entryId: id, reason: 'over_cap' });
    const drop = db.prepare("UPDATE event_entries SET status = 'dropped', dropped_at = ?, drop_reason = ? WHERE id = ?");
    for (const d of dropped) drop.run(at, d.reason, d.entryId);
    const snap = db.prepare('UPDATE event_entries SET name = ?, tag = ?, logo_key = ? WHERE id = ?');
    for (const id of place.placed) {
      const e = getEntry(db, id)!;
      const team = e.team_id !== null ? getTeam(db, e.team_id) : undefined;
      if (team && team.disbanded_at === null) snap.run(team.name, team.tag, team.logo_key, id);
    }
    const kept = R.seedOrder(place.placed.map((id) => ({ id, sr: entrySr(db, id), created_at: getEntry(db, id)!.created_at })));
    const seed = db.prepare('UPDATE event_entries SET seed = ? WHERE id = ?');
    kept.forEach((id, i) => seed.run(i + 1, id));
    db.prepare('UPDATE events SET locked_at = ?, updated_at = ? WHERE id = ?').run(at, at, ev.id);
    E.logEvent(db, ev.id, o.by, 'entries_locked', at, { kept: kept.length, dropped });
    return V.ok({ kept, dropped });
  })();
}

const NAME_MAX = 24;
/** The one comparison for a draft entry's name within an event: normalizeName's NFKC lower-case key. */
const keyOf = (name: string): string => name.normalize('NFKC').toLowerCase();
const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join('').trimEnd();

/** Ruling 6's default name: "Team <captain display name>", at most 24
 *  characters, cut on a character (never inside one) with no trailing space,
 *  and passed through the team name rules (normalizeName, slur filter
 *  included); a name that fails them falls back to "Team <seed>". It must
 *  not clash with a name already taken in the event (Ruling 7), compared by
 *  normalizeName's NFKC lower-case key: a clash appends " 2", " 3" and so on,
 *  the base cut first so base and suffix fit 24 characters. */
function draftEntryName(captainName: string, seed: number, taken: Set<string>): string {
  const n = normalizeName(cut(`Team ${captainName}`, NAME_MAX));
  const base = n.ok ? n.name : `Team ${seed}`;
  let name = base;
  for (let k = 2; taken.has(keyOf(name)); k++) name = `${cut(base, NAME_MAX - ` ${k}`.length)} ${k}`;
  taken.add(keyOf(name));
  return name;
}

/**
 * Publish a draft's teams (drafts plan D2a Ruling 6): one entry per captain
 * from the working assignment, in one transaction with one
 * 'draft_teams_published' row. Each entry has no team, the default name, an
 * empty tag and no logo, the captain in captain_steamid, and the captain
 * plus their 3 as starters (no subs). The list is already final (closing
 * signups set locked_at), so the entries take the status a team entry keeps
 * through lockEntries: checked in when the event has check-in on, registered
 * when it is off. Seeds come from average starter SR through seedOrder, as
 * lockEntries gives them, and events.teams_made_at is stamped. A team short
 * of a player, a pool player on no current captain's team, or a captain
 * missing is teams_changed: publishing never makes a short entry. The bench
 * stays a draft_signups bench.
 */
export function createDraftEntries(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ entries: number[] }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ entries: number[] }> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev || ev.status === 'draft') return V.fail('not_found');
    if (ev.entry_kind !== 'draft') return V.fail('not_draft');
    if (ev.teams_made_at !== null) return V.fail('teams_made');
    if (ev.status !== 'registration' && ev.status !== 'checkin') return V.fail('wrong_status');
    if (ev.cut_at === null) return V.fail('cut_not_published');
    const teams = D.draftTeamsOf(db, ev.id);
    if (!teams || teams.length < 2 || teams.length !== ev.draft_teams || teams.some((t) => t.players.length !== R.STARTERS - 1)) return V.fail('teams_changed');
    const checkedIn = E.fieldsOf(ev).checkin.enabled;
    // Seeds first (seedOrder over average starter SR, as entrySr gives it,
    // ties in captain order), so a name that falls back to "Team <seed>"
    // can use its seed.
    const season = currentSeasonId(db);
    const fours = teams.map((t) => [t.captain.steamid, ...t.players.map((p) => p.steamid)]);
    const order = R.seedOrder(fours.map((four, i) => ({ id: i, sr: R.averageSr(four.map((s) => seasonSr(db, s, season))), created_at: at })));
    const seedOf = new Map(order.map((i, k) => [i, k + 1]));
    const taken = new Set<string>();
    const insert = db.prepare(
      `INSERT INTO event_entries (event_id, team_id, name, tag, logo_key, seed, status, registered_by, created_at, checked_in_at, checked_in_by, captain_steamid)
       VALUES (?, NULL, ?, '', NULL, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const entries = fours.map((four, i) => {
      const captain = four[0]!;
      const seed = seedOf.get(i)!;
      const name = draftEntryName(getPlayer(db, captain)?.name ?? captain, seed, taken);
      const id = Number(insert.run(
        ev.id, name, seed, checkedIn ? 'checked_in' : 'registered', o.actor, at,
        checkedIn ? at : null, checkedIn ? o.actor : null, captain,
      ).lastInsertRowid);
      for (const s of four) addPlace(db, id, s, 'starter', at);
      return id;
    });
    db.prepare('UPDATE events SET teams_made_at = ?, updated_at = ? WHERE id = ?').run(at, at, ev.id);
    E.logEvent(db, ev.id, o.actor, 'draft_teams_published', at, { entries });
    return V.ok({ entries });
  })();
}

/** Whether a draft entry's identity may still change: until the event goes live. */
export const identityOpen = (ev: { status: V.EventStatus }): boolean => ev.status !== 'live' && ev.status !== 'finished' && ev.status !== 'cancelled';

/** The one gate for an identity change, shared by setEntryIdentity and the
 *  logo routes (which judge it before storing a file). */
export function identityRefusal(ev: E.EventRow, entry: EntryRow, steamid: string, staff: boolean): V.EventError | null {
  if (ev.entry_kind !== 'draft' || entry.captain_steamid === null) return 'not_draft_entry';
  if (!staff && entry.captain_steamid !== steamid) return 'not_captain';
  if (!identityOpen(ev)) return 'identity_locked';
  if (!isActive(entry)) return 'entry_out';
  return null;
}

/**
 * A draft entry's identity (drafts plan D2a Ruling 7): its name, tag and
 * logo, set by its captain (or staff) until the event goes live. The name
 * passes normalizeName and must be unique among the event's active entries by
 * the same key the default names use (an entry's own current name is not a
 * clash); the tag passes normalizeTag, or '' clears it. A field left out is
 * unchanged. One 'entry_identity_set' row.
 */
export function setEntryIdentity(
  db: DB,
  o: { eventId: number; entryId: number; steamid: string; staff: boolean; name?: string; tag?: string; logoKey?: string | null; now: Date },
): V.Checked<null> {
  const at = o.now.toISOString();
  const n = o.name === undefined ? null : normalizeName(o.name);
  if (n && !n.ok) return V.fail(n.error === 'name_not_allowed' ? 'name_not_allowed' : 'bad_entry_name');
  const t = o.tag === undefined || o.tag === '' ? null : normalizeTag(o.tag);
  if (t && !t.ok) return V.fail(t.error === 'tag_not_allowed' ? 'tag_not_allowed' : 'bad_tag');
  if (o.name === undefined && o.tag === undefined && o.logoKey === undefined) return V.fail('bad_request');
  return db.transaction((): V.Checked<null> => {
    const ev = E.getEvent(db, o.eventId);
    const entry = getEntry(db, o.entryId);
    if (!ev || ev.status === 'draft') return V.fail('not_found');
    if (!entry || entry.event_id !== ev.id) return V.fail('entry_not_found');
    const refused = identityRefusal(ev, entry, o.steamid, o.staff);
    if (refused) return V.fail(refused);
    if (n && n.ok) {
      const clash = entriesOf(db, ev.id).some((x) => x.id !== entry.id && isActive(x) && keyOf(x.name) === n.key);
      if (clash) return V.fail('name_taken');
    }
    const name = n && n.ok ? n.name : entry.name;
    const tag = o.tag === undefined ? entry.tag : t && t.ok ? t.tag : '';
    const logoKey = o.logoKey === undefined ? entry.logo_key : o.logoKey;
    db.prepare('UPDATE event_entries SET name = ?, tag = ?, logo_key = ? WHERE id = ?').run(name, tag, logoKey, entry.id);
    E.logEvent(db, ev.id, o.steamid, 'entry_identity_set', at, {
      entryId: entry.id, staff: o.staff, from: { name: entry.name, tag: entry.tag, logoKey: entry.logo_key }, to: { name, tag, logoKey },
    });
    return V.ok(null);
  })();
}

export type ReplaceReason = 'conduct' | 'cheating' | 'no_show' | 'left' | 'other';
export const REPLACE_REASONS: readonly ReplaceReason[] = ['conduct', 'cheating', 'no_show', 'left', 'other'];
/** The staff-only note on a replace (plan D2c Ruling 4). */
export const REPLACE_NOTE_MAX = V.REPLACE_NOTE_MAX;
/** A game of one of the entry's matches on a box right now, with the
 *  removed player on its roster: the box takes the sub before the site does
 *  (plan D2c Ruling 5). */
export interface BoxGame { matchId: number; bookingId: number; gameMatchId: number; token: string; team: 'a' | 'b' }

/** A refusal found after the writes began: thrown so the transaction rolls
 *  back, and turned back into the refusal outside it. */
class Refused extends Error {
  constructor(readonly r: { ok: false; error: V.EventError; detail?: V.EntryProblem[] }) { super(r.error); }
}

/** The removed player's unfinished matches of this entry whose locked
 *  lineup has them, each with its games on a box that roster them. Inside
 *  the caller's transaction. */
function lineupMatches(db: DB, eventId: number, entryId: number, out: string): { matchId: number; bookingId: number | null; onBox: BoxGame[] }[] {
  const rows = db.prepare(
    `SELECT id, booking_id FROM event_matches WHERE event_id = ? AND (entry_a = ? OR entry_b = ?) AND status NOT IN ('done', 'forfeit', 'bye') ORDER BY id`,
  ).all(eventId, entryId, entryId) as { id: number; booking_id: number | null }[];
  return rows.filter((m) => Room.lineupFour(db, m.id, entryId)?.includes(out)).map((m) => ({
    matchId: m.id, bookingId: m.booking_id,
    onBox: Room.gamesOf(db, m.id).filter((g) => g.match_id !== null && g.ended_at === null).flatMap((g) => {
      const x = db.prepare(
        `SELECT m.token, m.booking_id, mp.team FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = ?
          WHERE m.id = ? AND m.state = 'live' AND m.token IS NOT NULL AND m.booking_id IS NOT NULL`,
      ).get(out, g.match_id) as { token: string; booking_id: number; team: 'a' | 'b' } | undefined;
      return x ? [{ matchId: m.id, bookingId: x.booking_id, gameMatchId: g.match_id!, token: x.token, team: x.team }] : [];
    }),
  }));
}

/**
 * Staff remove a draft player and put a replacement in (drafts plan D2c
 * Rulings 4 and 5), in one transaction with one 'entry_player_replaced' row
 * (the note is never in it). Any time from teams made until the event ends.
 * `out` is a starter other than the captain; `in` passes the event's
 * eligibility as a starter and holds no place in the event. When `out` is in
 * a locked lineup of an unfinished match of this entry, the room's
 * substitution path swaps them there too (subPlayer with staff, which never
 * counts against the side's subs), the booking's people follow, and a game
 * on a box rosters the new player.
 *
 * A game on a box must take the sub first (sm_pug_sub, which a box refuses
 * mid-chapter): the series engine calls this with `check` (every rule, no
 * write, the games named in onBox), asks the box, then calls it again with
 * the games that took it in `boxTook`. A game on a box that is not in
 * boxTook is refused as replace_in_game, so this never puts a player in on
 * the site that the box does not have.
 */
export function replaceDraftPlayer(db: DB, o: {
  eventId: number; entryId: number; out: string; in: string; reason: ReplaceReason; note: string | null; actor: string; now: Date;
  check?: boolean; boxTook?: number[];
}): V.Checked<{ subbedInMatch: number | null; onBox?: BoxGame[] }> {
  const at = o.now.toISOString();
  if (!REPLACE_REASONS.includes(o.reason)) return V.fail('replace_bad_reason');
  if (o.note !== null && (typeof o.note !== 'string' || o.note.length > REPLACE_NOTE_MAX || /[\r\n]/.test(o.note) || hasUnsafeChars(o.note))) return V.fail('replace_bad_note');
  try {
    return db.transaction((): V.Checked<{ subbedInMatch: number | null; onBox?: BoxGame[] }> => {
      const ev = E.getEvent(db, o.eventId);
      if (!ev || ev.status === 'draft') return V.fail('not_found');
      const entry = getEntry(db, o.entryId);
      if (!entry || entry.event_id !== ev.id) return V.fail('entry_not_found');
      if (ev.entry_kind !== 'draft' || entry.captain_steamid === null) return V.fail('replace_not_draft');
      if (ev.teams_made_at === null || !ROSTER_OPEN.has(ev.status)) return V.fail('wrong_status');
      if (!isActive(entry)) return V.fail('entry_out');
      if (o.out === entry.captain_steamid) return V.fail('captain_replace');
      const place = placesOf(db, entry.id).find((p) => p.steamid === o.out && p.role === 'starter');
      if (!place) return V.fail('replace_not_starter');
      const other = entryOfPlayer(db, ev.id, o.in);
      if (other) return V.fail('player_entered', [{ steamid: o.in, problems: [`Already on ${other.name}'s roster`] }]);
      const elig = E.fieldsOf(ev).eligibility;
      const facts = playerFacts(db, o.in, o.now);
      const problems = R.problemsOf(elig, facts, 'starter');
      if (problems.length > 0) return V.fail('replace_ineligible', [{ steamid: o.in, problems: problems.map((k) => R.problemText(k, elig, facts)) }]);
      const matches = lineupMatches(db, ev.id, entry.id, o.out);
      const onBox = matches.flatMap((m) => m.onBox);
      const subbedInMatch = matches[0]?.matchId ?? null;
      if (o.check) return V.ok({ subbedInMatch, onBox });
      if (onBox.some((g) => !(o.boxTook ?? []).includes(g.gameMatchId))) {
        return V.fail('replace_in_game', [{ steamid: o.out, problems: ['A game with this player is on a server, and the server was not asked to take the change.'] }]);
      }
      db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE id = ?').run(at, place.id);
      addPlace(db, entry.id, o.in, 'starter', at);
      for (const m of matches) {
        const live = m.onBox[0];
        const gameId = live ? Room.gamesOf(db, m.matchId).find((g) => g.match_id === live.gameMatchId)?.id ?? null : null;
        const s = Room.subPlayer(db, { matchId: m.matchId, by: o.actor, outId: o.out, inId: o.in, limit: 0, gameId, staff: true, now: o.now });
        const inGame = (why: string) => new Refused(V.fail('replace_in_game', [{ steamid: o.out, problems: [why] }]));
        if (!s.ok) {
          const why = `The match room refused it: ${V.EVENT_ERRORS[s.error].text}`;
          // A room state refusal has nothing to do with the box; anything else keeps the in-game label.
          if (s.error === 'entry_out' || s.error === 'not_live' || s.error === 'not_live_phase') throw new Refused(V.fail('replace_not_possible', [{ steamid: o.out, problems: [why] }]));
          throw inGame(why);
        }
        if (m.bookingId !== null) {
          const b = B.getBooking(db, m.bookingId);
          if (b && B.isOpen(b)) {
            const swapped = B.replacePlayer(db, { bookingId: b.id, side: s.value.side, outId: o.out, inId: o.in, by: o.actor, now: o.now });
            if (!swapped.ok) throw inGame(`The booking refused it (${swapped.error}).`);
          }
        }
        for (const g of m.onBox) {
          if (!addTournamentSub(db, { matchId: g.gameMatchId, inId: o.in, team: g.team, now: o.now })) throw inGame(`Game ${g.gameMatchId} is not a tournament game.`);
        }
      }
      E.logEvent(db, ev.id, o.actor, 'entry_player_replaced', at, {
        entryId: entry.id, out: o.out, in: o.in, reason: o.reason, ...(subbedInMatch !== null ? { matchId: subbedInMatch } : {}),
      });
      return V.ok({ subbedInMatch });
    })();
  } catch (err) {
    if (err instanceof Refused) return err.r;
    throw err;
  }
}

/** Ruling 9: the tick drops an entry whose team was disbanded, until the list is final. */
export function dropDisbandedEntry(db: DB, o: { entryId: number; now?: Date }): V.Checked<EntryRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    const ev = E.getEvent(db, entry.event_id)!;
    const team = entry.team_id !== null ? getTeam(db, entry.team_id) : undefined;
    if (ev.locked_at !== null || !team || team.disbanded_at === null) return V.fail('wrong_status');
    db.prepare("UPDATE event_entries SET status = 'dropped', dropped_at = ?, drop_reason = 'team_disbanded' WHERE id = ?").run(at, entry.id);
    E.logEvent(db, ev.id, null, 'entry_dropped', at, { entryId: entry.id, reason: 'team_disbanded' });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Ruling 10. The reason is kept in event_log only. The seed goes with the
 *  entry, so a reorder of the rest never shows a number twice. */
export function disqualifyEntry(db: DB, o: { entryId: number; by: string; reason: unknown; now?: Date }): V.Checked<EntryRow> {
  const at = iso(o.now);
  const reason = V.normalizeReason(o.reason);
  if (!reason.ok) return reason;
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    const ev = E.getEvent(db, entry.event_id)!;
    if (ev.status === 'finished' || ev.status === 'cancelled') return V.fail('wrong_status');
    db.prepare("UPDATE event_entries SET status = 'disqualified', dropped_at = ?, seed = NULL, placement = NULL WHERE id = ?").run(at, entry.id);
    E.logEvent(db, ev.id, o.by, 'entry_disqualified', at, { entryId: entry.id, reason: reason.value });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Ruling 10: back to registered, before the list is final, if the team and
 *  every rostered player are still free in this event. */
export function restoreEntry(db: DB, o: { entryId: number; by: string; now?: Date }): V.Checked<EntryRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    const ev = E.getEvent(db, entry.event_id)!;
    if (isActive(entry) || ev.locked_at !== null || (ev.status !== 'registration' && ev.status !== 'checkin')) return V.fail('not_restorable');
    if (entry.team_id !== null && entryOfTeam(db, ev.id, entry.team_id)) return V.fail('already_entered');
    if (entry.team_id !== null && disqualifiedSlotHeld(db, ev.id, entry.team_id, entry.id)) return V.fail('already_entered');
    const roster = rosterOf(db, entry.id);
    const check = checkRoster(db, ev, { entryId: entry.id, teamId: entry.team_id, roster, previous: roster, staff: true, now });
    if (!check.ok) return check;
    db.prepare("UPDATE event_entries SET status = 'registered', dropped_at = NULL, drop_reason = NULL, checked_in_at = NULL, checked_in_by = NULL WHERE id = ?").run(entry.id);
    E.logEvent(db, ev.id, o.by, 'entry_restored', at, { entryId: entry.id });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Spec section 2: staff reorder seeds once the list is final and before the
 *  event goes live. order lists every active seeded entry once. */
export function reorderSeeds(db: DB, o: { eventId: number; by: string; order: unknown; now?: Date }): V.Checked<number[]> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<number[]> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (ev.locked_at === null || V.STAGES_LOCKED.has(ev.status)) return V.fail('seeds_locked');
    const seeded = entriesOf(db, ev.id).filter((e) => isActive(e) && e.seed !== null).map((e) => e.id);
    const order = o.order;
    if (!Array.isArray(order) || order.length !== seeded.length || new Set(order).size !== seeded.length
      || !order.every((x) => typeof x === 'number' && seeded.includes(x))) {
      return V.fail('bad_seed_order');
    }
    const seed = db.prepare('UPDATE event_entries SET seed = ? WHERE id = ?');
    (order as number[]).forEach((id, i) => seed.run(i + 1, id));
    E.logEvent(db, ev.id, o.by, 'seeds_reordered', at, { order });
    return V.ok(order as number[]);
  })();
}
